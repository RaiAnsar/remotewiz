import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Adapter, AdapterName, AdapterTaskRequest, AdapterTaskUpdate, AppConfig, ApprovalPrompt, RuntimeConfig, UploadRef } from "./types.js";
import { openDatabase, closeDatabase } from "./core/db.js";
import { TaskQueue } from "./core/queue.js";
import { AuditLog } from "./core/audit.js";
import { SessionStore } from "./core/session.js";
import { ApprovalStore } from "./core/approval.js";
import { Summarizer } from "./core/summarizer.js";
import { Worker } from "./core/worker.js";
import { ThreadBindings } from "./core/bindings.js";
import { MetaStore } from "./core/meta.js";
import { UploadStore, uploadsRoot } from "./core/uploads.js";
import { newId, nowTs } from "./utils/ids.js";
import { logWarn } from "./utils/log.js";

export class RemoteWizApp {
  private readonly db;
  private readonly queue;
  private readonly audit;
  private readonly sessions;
  private readonly approvals;
  private readonly bindings;
  private readonly meta;
  private readonly uploads;
  private readonly summarizer;
  private readonly adapters = new Map<AdapterName, Adapter>();
  private readonly worker;

  constructor(
    private readonly appConfig: AppConfig,
    private readonly runtimeConfig: RuntimeConfig,
  ) {
    this.db = openDatabase();
    this.queue = new TaskQueue(this.db, this.runtimeConfig.maxQueuedPerProject);
    this.audit = new AuditLog(this.db);
    this.sessions = new SessionStore(this.db);
    this.approvals = new ApprovalStore(this.db);
    this.bindings = new ThreadBindings(this.db);
    this.meta = new MetaStore(this.db);
    this.uploads = new UploadStore(this.db);
    this.summarizer = new Summarizer(
      this.runtimeConfig.anthropicApiKey,
      this.runtimeConfig.summarizerEnabled,
    );
    this.worker = new Worker(
      this.appConfig,
      this.runtimeConfig,
      this.queue,
      this.audit,
      this.sessions,
      this.approvals,
      this.summarizer,
      async (update) => {
        await this.dispatchTaskUpdate(update);
      },
      async (prompt) => {
        await this.dispatchApprovalPrompt(prompt);
      },
    );
  }

  registerAdapter(adapter: Adapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  async start(): Promise<void> {
    this.sessions.cleanupOlderThan();
    this.uploads.cleanupExpired();
    this.uploads.cleanupOrphanDirs();
    this.checkCliVersion();
    this.logSkipPermissionsProjects();

    await this.worker.start();
    for (const adapter of this.adapters.values()) {
      await adapter.start();
    }
  }

  async stop(): Promise<void> {
    await this.worker.stop();
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.stop();
      } catch {
        // ignore shutdown errors
      }
    }
    closeDatabase(this.db);
  }

  getProjects(): Array<{ alias: string; path: string; description?: string }> {
    return Object.values(this.appConfig.projects).map((project) => ({
      alias: project.alias,
      path: project.path,
      description: project.description,
    }));
  }

  bindThread(threadId: string, projectAlias: string, adapter: AdapterName, actorId: string): void {
    if (!this.appConfig.projects[projectAlias]) {
      throw new Error(`Unknown project alias: ${projectAlias}`);
    }

    this.bindings.upsert(threadId, projectAlias, adapter, actorId);
    this.audit.log({
      timestamp: nowTs(),
      actor: actorId,
      action: "thread_bound",
      threadId,
      projectAlias,
      detail: { adapter },
    });
  }

  getBinding(threadId: string): { projectAlias: string } | undefined {
    const binding = this.bindings.get(threadId);
    if (!binding) {
      return undefined;
    }
    return { projectAlias: binding.projectAlias };
  }

  async enqueueTask(request: AdapterTaskRequest): Promise<{ taskId: string }> {
    const project = this.appConfig.projects[request.projectAlias];
    if (!project) {
      throw new Error(`Unknown project alias: ${request.projectAlias}`);
    }

    const taskId = newId();
    const promptWithResolvedUploads = this.resolveUploadRefsInPrompt(
      request.prompt,
      request.projectAlias,
    );

    const task = this.queue.enqueue({
      id: taskId,
      projectAlias: project.alias,
      projectPath: project.path,
      prompt: promptWithResolvedUploads,
      threadId: request.threadId,
      adapter: request.adapter,
      continueSession: request.continueSession,
      tokenBudget: project.tokenBudget,
    });

    this.audit.log({
      timestamp: nowTs(),
      taskId: task.id,
      projectAlias: task.projectAlias,
      actor: request.actorId,
      action: "task_created",
      detail: {
        continueSession: request.continueSession,
        promptSnippet: promptWithResolvedUploads.slice(0, 200),
      },
      threadId: task.threadId,
    });

    await this.dispatchTaskUpdate({
      taskId,
      threadId: request.threadId,
      status: "queued",
    });

    return { taskId };
  }

  getThreadTaskHistory(threadId: string, limit = 50): Array<{ id: string; status: string; createdAt: number; result?: string; error?: string }> {
    return this.queue.getByThreadId(threadId, limit).map((task) => ({
      id: task.id,
      status: task.status,
      createdAt: task.createdAt,
      result: task.result,
      error: task.error,
    }));
  }

  getProjectTaskHistory(projectAlias: string, limit = 50): Array<{ id: string; status: string; createdAt: number; result?: string; error?: string }> {
    return this.queue.getByProject(projectAlias, limit).map((task) => ({
      id: task.id,
      status: task.status,
      createdAt: task.createdAt,
      result: task.result,
      error: task.error,
    }));
  }

  cancelTask(taskId: string, actorId: string): boolean {
    // Kill the running process first (before updating DB status)
    const task = this.queue.getById(taskId);
    if (task && (task.status === "running" || task.status === "needs_approval")) {
      this.worker.killTaskProcess(taskId);
    }

    const canceled = this.queue.cancel(taskId);
    if (!canceled) {
      return false;
    }

    this.audit.log({
      timestamp: nowTs(),
      taskId,
      projectAlias: task?.projectAlias,
      actor: actorId,
      action: "task_cancelled",
      detail: { by: actorId },
      threadId: task?.threadId,
    });

    if (task?.threadId) {
      void this.dispatchTaskUpdate({
        taskId,
        threadId: task.threadId,
        status: "failed",
        error: "cancelled_by_user",
      });
    }
    return true;
  }

  getQueueStatus(): {
    running: number;
    pending: number;
    byProject: Record<string, { running: number; pending: number }>;
  } {
    const runningTasks = this.queue.getRunning();
    const pendingCounts = this.queue.getPendingCountsByProject();

    const byProject: Record<string, { running: number; pending: number }> = {};

    for (const task of runningTasks) {
      if (!byProject[task.projectAlias]) {
        byProject[task.projectAlias] = { running: 0, pending: 0 };
      }
      byProject[task.projectAlias].running += 1;
    }

    for (const entry of pendingCounts) {
      if (!byProject[entry.projectAlias]) {
        byProject[entry.projectAlias] = { running: 0, pending: 0 };
      }
      byProject[entry.projectAlias].pending = entry.count;
    }

    return {
      running: runningTasks.length,
      pending: pendingCounts.reduce((acc, entry) => acc + entry.count, 0),
      byProject,
    };
  }

  getAudit(projectAlias?: string, limit = 50): unknown[] {
    if (projectAlias) {
      return this.audit.getByProject(projectAlias, limit);
    }
    return this.audit.getRecent(limit);
  }

  async resolveApproval(approvalId: string, actorId: string, action: "approve" | "deny"): Promise<boolean> {
    return this.worker.resolveApproval(approvalId, actorId, action);
  }

  getBudgetToday(projectAlias?: string): { promptTokens: number; totalTokens: number } {
    const dayAgo = nowTs() - 24 * 60 * 60 * 1000;
    return {
      promptTokens: 0,
      totalTokens: this.queue.getTokensUsedSince(dayAgo, projectAlias),
    };
  }

  createUploadReference(projectAlias: string, originalName: string, serverPath: string): UploadRef {
    const ref: UploadRef = {
      id: newId(),
      projectAlias,
      originalName,
      serverPath,
      createdAt: nowTs(),
    };
    this.uploads.saveReference(ref);
    return ref;
  }

  resolveUploadRef(uploadId: string): UploadRef | undefined {
    return this.uploads.getReference(uploadId);
  }

  markUploadConsumed(uploadId: string): void {
    this.uploads.markConsumed(uploadId);
  }

  uploadsRoot(): string {
    const root = uploadsRoot();
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  cleanupTaskUploadDir(projectAlias: string, taskId: string): void {
    const dir = path.join(this.uploadsRoot(), projectAlias, taskId);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  private resolveUploadRefsInPrompt(prompt: string, projectAlias: string): string {
    const pattern = /\[Attached file reference:\s*([^\]\s]+)\]/g;
    return prompt.replace(pattern, (_match, uploadIdRaw: string) => {
      const uploadId = String(uploadIdRaw).trim();
      const ref = this.resolveUploadRef(uploadId);
      if (!ref || ref.projectAlias !== projectAlias) {
        return `[Attached file reference unresolved: ${uploadId}]`;
      }
      this.markUploadConsumed(uploadId);
      return `[Attached file: ${ref.serverPath}]`;
    });
  }

  private checkCliVersion(): void {
    let version = "unknown";

    try {
      version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
    } catch (error) {
      logWarn("Unable to read claude CLI version", error);
      return;
    }

    const previous = this.meta.get("cli_version");
    if (previous && previous !== version) {
      logWarn(`Claude CLI version changed from ${previous} to ${version}`);
      this.audit.log({
        timestamp: nowTs(),
        actor: "system",
        action: "cli_version_changed",
        detail: { previous, current: version },
      });
    }

    this.meta.set("cli_version", version);
  }

  private logSkipPermissionsProjects(): void {
    for (const project of Object.values(this.appConfig.projects)) {
      if (!project.skipPermissions) {
        continue;
      }
      logWarn(
        `skipPermissions enabled for project '${project.alias}'. Reason: ${project.skipPermissionsReason ?? "unspecified"}`,
      );
      this.audit.log({
        timestamp: nowTs(),
        actor: "system",
        action: "project_skip_permissions_enabled",
        projectAlias: project.alias,
        detail: { reason: project.skipPermissionsReason ?? "unspecified" },
      });
    }
  }

  private async dispatchTaskUpdate(update: AdapterTaskUpdate): Promise<void> {
    const task = this.queue.getById(update.taskId);
    if (!task) {
      return;
    }

    const adapter = this.adapters.get(task.adapter);
    if (!adapter) {
      return;
    }

    try {
      await adapter.sendTaskUpdate(update);
    } catch (error) {
      logWarn("Adapter sendTaskUpdate failed", { adapter: adapter.name, error });
    }
  }

  private async dispatchApprovalPrompt(prompt: ApprovalPrompt): Promise<void> {
    const task = this.queue.getById(prompt.taskId);
    if (!task) {
      return;
    }

    const adapter = this.adapters.get(task.adapter);
    if (!adapter) {
      return;
    }

    try {
      await adapter.requestApproval(prompt);
    } catch (error) {
      logWarn("Adapter requestApproval failed", { adapter: adapter.name, error });
    }
  }
}
