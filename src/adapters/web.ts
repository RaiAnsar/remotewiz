import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import Busboy from "busboy";
import { WebSocketServer, type WebSocket } from "ws";
import type { Adapter, AdapterTaskUpdate, ApprovalPrompt, RuntimeConfig } from "../types.js";
import type { RemoteWizApp } from "../app.js";
import { logInfo, logWarn } from "../utils/log.js";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_TEXT_MIME = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
]);

function requireWebAuth(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!token) {
      res.status(503).json({ error: "WEB_AUTH_TOKEN not configured" });
      return;
    }

    const auth = req.header("authorization") || "";
    const presented = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";

    if (!presented || presented !== token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    next();
  };
}

export class WebAdapter implements Adapter {
  name = "web" as const;

  private readonly appServer = express();
  private readonly httpServer = http.createServer(this.appServer);
  private readonly wsServer = new WebSocketServer({ server: this.httpServer });
  private readonly clients = new Set<WebSocket>();
  private readonly subscriptions = new Map<WebSocket, Set<string>>();
  private started = false;

  constructor(
    private readonly app: RemoteWizApp,
    private readonly runtimeConfig: RuntimeConfig,
  ) {
    this.configureHttp();
    this.configureWs();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.httpServer.listen(this.runtimeConfig.webPort, this.runtimeConfig.webBindHost, () => {
        this.started = true;
        const base = `http://${this.runtimeConfig.webBindHost}:${this.runtimeConfig.webPort}`;
        logInfo(`Web adapter listening on ${base}`);
        if (this.runtimeConfig.webAuthToken) {
          logInfo(`Web UI: ${base}?token=${this.runtimeConfig.webAuthToken}`);
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }

    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
    this.started = false;
  }

  async sendTaskUpdate(update: AdapterTaskUpdate): Promise<void> {
    this.broadcastToThread(update.threadId, { type: "task_update", ...update });
  }

  async requestApproval(prompt: ApprovalPrompt): Promise<void> {
    this.broadcastToThread(prompt.threadId, {
      type: "approval_needed",
      taskId: prompt.taskId,
      approvalId: prompt.approvalId,
      threadId: prompt.threadId,
      description: prompt.description,
    });
  }

  private configureHttp(): void {
    this.appServer.use(express.json({ limit: "12mb" }));

    this.appServer.get("/health", (_req, res) => {
      res.json({ status: "ok" });
    });

    const staticDirCandidates = [
      path.join(process.cwd(), "src", "web"),
      path.join(process.cwd(), "dist", "web"),
    ];
    const staticDir = staticDirCandidates.find((candidate) => fs.existsSync(candidate));
    if (staticDir) {
      this.appServer.use(express.static(staticDir));
    }

    const auth = requireWebAuth(this.runtimeConfig.webAuthToken);

    this.appServer.get("/api/projects", auth, (_req, res) => {
      res.json({ projects: this.app.getProjects() });
    });

    this.appServer.get("/api/tasks", auth, (req, res) => {
      const project = String(req.query.project || "").trim();
      const threadId = String(req.query.threadId || "").trim();

      if (project) {
        res.json({ tasks: this.app.getProjectTaskHistory(project, 100) });
        return;
      }

      if (threadId) {
        res.json({ tasks: this.app.getThreadTaskHistory(threadId, 100) });
        return;
      }

      res.status(400).json({ error: "provide project or threadId" });
    });

    this.appServer.get("/api/audit", auth, (req, res) => {
      const project = String(req.query.project || "").trim();
      const limitRaw = Number.parseInt(String(req.query.limit || "50"), 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;
      res.json({ entries: this.app.getAudit(project || undefined, limit) });
    });

    this.appServer.post("/api/tasks", auth, async (req, res) => {
      const projectAlias = String(req.body?.project || "").trim();
      const prompt = String(req.body?.prompt || "").trim();
      const continueSession = Boolean(req.body?.continue);
      const threadId = String(req.body?.threadId || `web:${projectAlias}`).trim();
      const actorId = String(req.body?.actorId || "web-user").trim();

      if (!projectAlias || !prompt) {
        res.status(400).json({ error: "project and prompt are required" });
        return;
      }

      try {
        const result = await this.app.enqueueTask({
          projectAlias,
          prompt,
          threadId,
          adapter: "web",
          continueSession,
          actorId,
        });
        res.json({ ok: true, taskId: result.taskId });
      } catch (error) {
        if (error instanceof Error && error.message === "queue_full") {
          res.status(429).json({ error: "queue_full" });
          return;
        }
        res.status(400).json({ error: error instanceof Error ? error.message : "enqueue_failed" });
      }
    });

    this.appServer.post("/api/approvals/:id", auth, async (req, res) => {
      const id = req.params.id;
      const action = req.body?.action === "approve" ? "approve" : req.body?.action === "deny" ? "deny" : null;
      const actorId = String(req.body?.actorId || "web-user").trim();

      if (!action) {
        res.status(400).json({ error: "action must be approve or deny" });
        return;
      }

      const ok = await this.app.resolveApproval(id, actorId, action);
      if (!ok) {
        res.status(404).json({ error: "approval_not_found_or_closed" });
        return;
      }

      res.json({ ok: true });
    });

    this.appServer.post("/api/upload", auth, (req, res) => {
      const contentType = String(req.headers["content-type"] || "").toLowerCase();
      if (!contentType.includes("multipart/form-data")) {
        res.status(400).json({ error: "multipart_form_required" });
        return;
      }

      const busboy = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: MAX_UPLOAD_BYTES, fields: 8 },
      });

      let projectAlias = "";
      let originalName = "upload.bin";
      let declaredMime = "application/octet-stream";
      let fileBuffer: Buffer | undefined;
      let fileSeen = false;
      let parseError: string | undefined;
      let responded = false;

      busboy.on("field", (fieldName, value) => {
        if (fieldName === "project") {
          projectAlias = String(value || "").trim();
        }
      });

      busboy.on("file", (fieldName, stream, info) => {
        if (fieldName !== "file") {
          stream.resume();
          return;
        }

        if (fileSeen) {
          parseError = "only_one_file_allowed";
          stream.resume();
          return;
        }
        fileSeen = true;

        const fileInfo = info as { filename?: string; mimeType?: string };
        originalName = sanitizeFilename(fileInfo.filename || "upload.bin");
        declaredMime = String(fileInfo.mimeType || "application/octet-stream").toLowerCase();

        const chunks: Buffer[] = [];
        let totalSize = 0;

        stream.on("data", (chunk: Buffer) => {
          totalSize += chunk.byteLength;
          if (totalSize > MAX_UPLOAD_BYTES) {
            parseError = "invalid_size";
            stream.resume();
            return;
          }
          chunks.push(chunk);
        });

        stream.on("limit", () => {
          parseError = "invalid_size";
        });

        stream.on("end", () => {
          if (parseError) {
            return;
          }
          fileBuffer = Buffer.concat(chunks);
        });
      });

      busboy.on("error", () => {
        if (responded) {
          return;
        }
        responded = true;
        res.status(400).json({ error: "invalid_multipart" });
      });

      busboy.on("finish", () => {
        if (responded) {
          return;
        }
        if (parseError) {
          responded = true;
          res.status(400).json({ error: parseError });
          return;
        }
        if (!projectAlias || !fileBuffer || fileBuffer.byteLength === 0) {
          responded = true;
          res.status(400).json({ error: "project and file are required" });
          return;
        }

        const projectExists = this.app.getProjects().some((project) => project.alias === projectAlias);
        if (!projectExists) {
          responded = true;
          res.status(400).json({ error: "unknown_project" });
          return;
        }

        const sniffedMime = sniffMime(fileBuffer);
        const normalizedMime = normalizeMime(declaredMime, sniffedMime);

        if (!isAllowedMime(normalizedMime)) {
          responded = true;
          res.status(400).json({ error: "mime_not_allowed" });
          return;
        }
        if (sniffedMime && !mimeMatches(normalizedMime, sniffedMime)) {
          responded = true;
          res.status(400).json({ error: "mime_sniff_mismatch" });
          return;
        }
        if (!sniffedMime && normalizedMime.startsWith("image/")) {
          responded = true;
          res.status(400).json({ error: "image_signature_unrecognized" });
          return;
        }
        if (ALLOWED_TEXT_MIME.has(normalizedMime) && !looksLikeText(fileBuffer)) {
          responded = true;
          res.status(400).json({ error: "text_content_invalid" });
          return;
        }

        const uploadScopeId = crypto.randomUUID();
        const extension = extensionForMime(sniffedMime || normalizedMime);
        const root = this.app.uploadsRoot();
        const taskDir = path.join(root, projectAlias, uploadScopeId);
        fs.mkdirSync(taskDir, { recursive: true });
        const filename = `${crypto.randomUUID()}.${extension}`;
        const filePath = path.join(taskDir, filename);

        fs.writeFileSync(filePath, fileBuffer);

        const resolvedRoot = fs.realpathSync(root);
        const resolvedFile = fs.realpathSync(filePath);
        if (!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
          fs.rmSync(taskDir, { recursive: true, force: true });
          responded = true;
          res.status(400).json({ error: "upload_path_escape_detected" });
          return;
        }

        const ref = this.app.createUploadReference(projectAlias, originalName, filePath);
        responded = true;
        res.json({ id: ref.id, originalName: ref.originalName });
      });

      req.pipe(busboy);
    });

    this.appServer.use((_req, res) => {
      res.status(404).json({ error: "not_found" });
    });
  }

  private configureWs(): void {
    this.wsServer.on("connection", (socket) => {
      let authed = false;
      this.clients.add(socket);
      this.subscriptions.set(socket, new Set());

      socket.on("message", async (raw) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(String(raw));
        } catch {
          socket.send(JSON.stringify({ type: "error", error: "invalid_json" }));
          return;
        }

        const type = String(message.type || "");

        if (!authed) {
          if (type !== "auth") {
            socket.send(JSON.stringify({ type: "error", error: "auth_required" }));
            return;
          }
          const token = String(message.token || "");
          if (!this.runtimeConfig.webAuthToken || token !== this.runtimeConfig.webAuthToken) {
            socket.send(JSON.stringify({ type: "error", error: "unauthorized" }));
            return;
          }
          authed = true;
          socket.send(JSON.stringify({ type: "authed" }));
          return;
        }

        if (type === "message") {
          const projectAlias = String(message.project || "").trim();
          const prompt = String(message.prompt || "").trim();
          const continueSession = Boolean(message.continue);
          const threadId = String(message.threadId || `web:${projectAlias}`);
          const actorId = String(message.actorId || "web-user");

          if (!projectAlias || !prompt) {
            socket.send(JSON.stringify({ type: "error", error: "project and prompt required" }));
            return;
          }

          try {
            const subscription = this.subscriptions.get(socket);
            subscription?.add(threadId);

            const result = await this.app.enqueueTask({
              projectAlias,
              prompt,
              threadId,
              adapter: "web",
              continueSession,
              actorId,
            });

            socket.send(JSON.stringify({ type: "queued", taskId: result.taskId }));
          } catch (error) {
            const reason = error instanceof Error ? error.message : "enqueue_failed";
            socket.send(JSON.stringify({ type: "error", error: reason }));
          }
          return;
        }

        if (type === "subscribe") {
          const threadId = String(message.threadId || "").trim();
          if (threadId) {
            const subscription = this.subscriptions.get(socket);
            subscription?.add(threadId);
            socket.send(JSON.stringify({ type: "subscribed", threadId }));
          }
          return;
        }

        if (type === "approval") {
          const approvalId = String(message.approvalId || "");
          const action = String(message.action || "");
          const actorId = String(message.actorId || "web-user");
          if (!approvalId || !["approve", "deny"].includes(action)) {
            socket.send(JSON.stringify({ type: "error", error: "invalid_approval_payload" }));
            return;
          }

          const ok = await this.app.resolveApproval(approvalId, actorId, action as "approve" | "deny");
          socket.send(JSON.stringify({ type: ok ? "approval_ack" : "error", approvalId, error: ok ? undefined : "approval_not_found_or_closed" }));
          return;
        }

        socket.send(JSON.stringify({ type: "error", error: "unknown_message_type" }));
      });

      socket.on("close", () => {
        this.clients.delete(socket);
        this.subscriptions.delete(socket);
      });

      socket.on("error", (error) => {
        this.clients.delete(socket);
        this.subscriptions.delete(socket);
        logWarn("websocket client error", error);
      });
    });
  }

  private broadcastToThread(threadId: string, payload: unknown): void {
    const serialized = JSON.stringify(payload);
    for (const client of this.clients) {
      const subscription = this.subscriptions.get(client);
      if (!subscription || !subscription.has(threadId)) {
        continue;
      }
      if (client.readyState === client.OPEN) {
        client.send(serialized);
      }
    }
  }
}

function extensionForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "text/markdown":
      return "md";
    case "application/json":
      return "json";
    case "text/csv":
      return "csv";
    case "text/plain":
      return "txt";
    default:
      return "bin";
  }
}

function isAllowedMime(mime: string): boolean {
  return mime.startsWith("image/") || ALLOWED_TEXT_MIME.has(mime);
}

function normalizeMime(declared: string, sniffed: string | undefined): string {
  const trimmed = declared.trim().toLowerCase();
  if (trimmed.length > 0 && trimmed !== "application/octet-stream") {
    return trimmed;
  }
  return sniffed ?? "text/plain";
}

function mimeMatches(normalized: string, sniffed: string): boolean {
  if (normalized === sniffed) {
    return true;
  }
  return normalized === "image/jpg" && sniffed === "image/jpeg";
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name.trim());
  const cleaned = base.replace(/[^a-zA-Z0-9._ -]/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "upload.bin";
}

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let binaryHits = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
    const isControl = byte < 0x09 || (byte > 0x0d && byte < 0x20);
    if (isControl) {
      binaryHits += 1;
      if (binaryHits > 8) {
        return false;
      }
    }
  }
  return true;
}

function sniffMime(buffer: Buffer): string | undefined {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString("ascii") === "GIF89a" ||
      buffer.subarray(0, 6).toString("ascii") === "GIF87a")
  ) {
    return "image/gif";
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  // Text-like content can pass through without strict signature.
  return undefined;
}
