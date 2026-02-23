import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { AppConfig, ApprovalActionType, ApprovalPrompt, ParsedStreamOutcome, RuntimeConfig, TaskRecord, TaskResult } from "../types.js";
import { nowTs } from "../utils/ids.js";
import { logError, logInfo, logWarn } from "../utils/log.js";
import { redactSecrets } from "../utils/redact.js";
import { TaskQueue } from "./queue.js";
import { AuditLog } from "./audit.js";
import { SessionStore } from "./session.js";
import { ApprovalStore } from "./approval.js";
import { Summarizer } from "./summarizer.js";

type TaskUpdateListener = (update: {
  taskId: string;
  threadId: string;
  status: TaskRecord["status"];
  summary?: string;
  error?: string;
}) => Promise<void>;

type ApprovalListener = (prompt: ApprovalPrompt) => Promise<void>;

const PROCESS_EXIT_WAIT_MS = 5_000;

type RunContext = {
  replayMode: boolean;
  replayApprovedAction?: string;
  replayCheckpointSummary?: string;
  forceSkipPermissions: boolean;
  timeoutMs: number;
  allowResume?: boolean;
};

export class Worker {
  private pollTimer?: NodeJS.Timeout;
  private running = false;
  private inFlight = new Set<string>();

  constructor(
    private readonly appConfig: AppConfig,
    private readonly runtimeConfig: RuntimeConfig,
    private readonly queue: TaskQueue,
    private readonly audit: AuditLog,
    private readonly sessions: SessionStore,
    private readonly approvals: ApprovalStore,
    private readonly summarizer: Summarizer,
    private readonly onTaskUpdate: TaskUpdateListener,
    private readonly onApprovalRequested: ApprovalListener,
  ) {}

  /** Kill a running task's Claude Code process by task ID. Returns true if killed. */
  killTaskProcess(taskId: string): boolean {
    const task = this.queue.getById(taskId);
    if (!task || !task.workerPid) {
      return false;
    }
    const pid = task.workerPid;

    const verified = task.workerPidStart
      ? verifyProcessIdentity(pid, task.workerPidStart)
      : verifyProcessCommand(pid);
    if (!verified.ok) {
      logWarn("Cancel: skipping kill, PID identity check failed", { pid, reason: verified.reason });
      return false;
    }

    try {
      process.kill(pid, "SIGTERM");
      setTimeout(() => {
        const latest = this.queue.getById(taskId);
        if (!latest || latest.workerPid !== pid) {
          return;
        }
        const stillVerified = latest.workerPidStart
          ? verifyProcessIdentity(pid, latest.workerPidStart)
          : verifyProcessCommand(pid);
        if (!stillVerified.ok || !pidExists(pid)) {
          return;
        }
        try {
          process.kill(pid, "SIGKILL");
          this.audit.log({
            timestamp: nowTs(),
            taskId,
            projectAlias: latest.projectAlias,
            actor: "worker",
            action: "task_cancel_sigkill",
            detail: { pid },
            threadId: latest.threadId,
          });
        } catch {
          // ignore
        }
      }, PROCESS_EXIT_WAIT_MS);
      return true;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.recoverOrphans();
    this.pollTimer = setInterval(() => {
      void this.tick();
    }, 2000);
    await this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (!this.running) {
      return;
    }

    const expiredApprovalIds = this.approvals.expireOlderThan(this.runtimeConfig.approvalTimeoutMs);
    for (const approvalId of expiredApprovalIds) {
      const approval = this.approvals.getById(approvalId);
      if (!approval) {
        continue;
      }
      this.queue.markFailed(approval.taskId, "approval_timeout");
      const task = this.queue.getById(approval.taskId);
      if (task) {
        this.audit.log({
          timestamp: nowTs(),
          taskId: task.id,
          projectAlias: task.projectAlias,
          actor: "system",
          action: "approval_timeout",
          detail: { approvalId },
          threadId: task.threadId,
        });
        await this.onTaskUpdate({
          taskId: task.id,
          threadId: task.threadId,
          status: "failed",
          error: "approval_timeout",
        });
      }
    }

    while (this.inFlight.size < this.runtimeConfig.maxConcurrentTasks) {
      const next = this.queue.dequeueNext();
      if (!next) {
        break;
      }
      this.inFlight.add(next.id);
      void this.runTask(next, {
        replayMode: false,
        forceSkipPermissions: false,
        timeoutMs: this.resolveTimeout(next, false),
        allowResume: true,
      }).finally(() => {
        this.inFlight.delete(next.id);
      });
    }
  }

  async resolveApproval(approvalId: string, actorId: string, action: "approve" | "deny"): Promise<boolean> {
    const approval = this.approvals.getById(approvalId);
    if (!approval || approval.status !== "pending") {
      return false;
    }

    const ok = this.approvals.resolve(approvalId, action === "approve" ? "approved" : "denied", actorId);
    if (!ok) {
      return false;
    }

    const task = this.queue.getById(approval.taskId);
    if (!task) {
      return false;
    }

    this.audit.log({
      timestamp: nowTs(),
      taskId: task.id,
      projectAlias: task.projectAlias,
      actor: actorId,
      action: action === "approve" ? "approval_granted" : "approval_denied",
      detail: { approvalId, actionType: approval.actionType, description: approval.description },
      threadId: task.threadId,
    });

    if (action === "deny") {
      this.queue.markFailed(task.id, "approval_denied");
      await this.onTaskUpdate({
        taskId: task.id,
        threadId: task.threadId,
        status: "failed",
        error: "approval_denied",
      });
      return true;
    }

    // Approved: terminate-and-replay with elevated permissions.
    this.queue.updateStatus(task.id, "running");
    this.inFlight.add(task.id);

    const checkpoint = task.checkpoint ? safeJsonParse(task.checkpoint) : undefined;

    void this.runTask(task, {
      replayMode: true,
      replayApprovedAction: approval.description,
      replayCheckpointSummary: typeof checkpoint?.summary === "string" ? checkpoint.summary : undefined,
      forceSkipPermissions: true,
      timeoutMs: this.runtimeConfig.replayTimeoutMs,
      allowResume: true,
    }).finally(() => {
      this.inFlight.delete(task.id);
    });

    return true;
  }

  private resolveTimeout(task: TaskRecord, replayMode: boolean): number {
    if (replayMode) {
      return this.runtimeConfig.replayTimeoutMs;
    }
    const project = this.appConfig.projects[task.projectAlias];
    return project?.timeout ?? this.runtimeConfig.defaultTimeoutMs;
  }

  private async runTask(task: TaskRecord, ctx: RunContext): Promise<void> {
    const project = this.appConfig.projects[task.projectAlias];
    if (!project) {
      this.queue.markFailed(task.id, "unknown_project");
      await this.onTaskUpdate({
        taskId: task.id,
        threadId: task.threadId,
        status: "failed",
        error: "unknown_project",
      });
      return;
    }

    const effectiveBudget = task.tokenBudget ?? project.tokenBudget ?? this.runtimeConfig.defaultTokenBudget;

    await this.onTaskUpdate({ taskId: task.id, threadId: task.threadId, status: "running" });

    this.audit.log({
      timestamp: nowTs(),
      taskId: task.id,
      projectAlias: task.projectAlias,
      actor: "worker",
      action: ctx.replayMode ? "task_replayed" : "task_started",
      detail: {
        continueSession: task.continueSession,
        replayMode: ctx.replayMode,
      },
      threadId: task.threadId,
    });

    if (project.skipPermissions && !ctx.forceSkipPermissions) {
      this.audit.log({
        timestamp: nowTs(),
        taskId: task.id,
        projectAlias: task.projectAlias,
        actor: "worker",
        action: "auto_approved",
        detail: { reason: project.skipPermissionsReason ?? "unspecified" },
        threadId: task.threadId,
      });
    }

    const runResult = await this.executeClaude(task, project.path, effectiveBudget, ctx);

    const latest = this.queue.getById(task.id);
    if (!latest || (latest.status === "failed" && latest.error === "cancelled_by_user")) {
      this.queue.clearWorkerPid(task.id);
      this.audit.log({
        timestamp: nowTs(),
        taskId: task.id,
        projectAlias: task.projectAlias,
        actor: "worker",
        action: "task_cancelled_ack",
        detail: { reason: "cancelled_by_user" },
        threadId: task.threadId,
      });
      await this.onTaskUpdate({
        taskId: task.id,
        threadId: task.threadId,
        status: "failed",
        error: "cancelled_by_user",
      });
      return;
    }

    this.queue.updateTokensUsed(task.id, runResult.tokensUsed);
    this.queue.clearWorkerPid(task.id);

    if (runResult.status === "needs_approval") {
      this.queue.updateStatus(task.id, "needs_approval");
      this.queue.setCheckpoint(
        task.id,
        JSON.stringify({
          originalPrompt: task.prompt,
          summary: runResult.summary,
          replayActions: runResult.replayActions,
        }),
      );

      const pending = this.approvals.create(
        task.id,
        runResult.approvalActionType ?? "unknown",
        runResult.summary,
      );

      this.audit.log({
        timestamp: nowTs(),
        taskId: task.id,
        projectAlias: task.projectAlias,
        actor: "worker",
        action: "approval_requested",
        detail: {
          approvalId: pending.id,
          actionType: pending.actionType,
          description: pending.description,
        },
        threadId: task.threadId,
      });

      await this.onTaskUpdate({
        taskId: task.id,
        threadId: task.threadId,
        status: "needs_approval",
        summary: runResult.summary,
      });

      await this.onApprovalRequested({
        approvalId: pending.id,
        taskId: task.id,
        threadId: task.threadId,
        description: pending.description,
      });
      return;
    }

    if (runResult.status === "failed") {
      this.queue.markFailed(task.id, runResult.errorCode ?? "cli_error");
      this.audit.log({
        timestamp: nowTs(),
        taskId: task.id,
        projectAlias: task.projectAlias,
        actor: "worker",
        action: "task_failed",
        detail: { error: runResult.errorCode, summary: runResult.summary },
        threadId: task.threadId,
      });

      await this.onTaskUpdate({
        taskId: task.id,
        threadId: task.threadId,
        status: "failed",
        error: runResult.errorCode,
        summary: runResult.summary,
      });
      return;
    }

    if (runResult.sessionId) {
      this.sessions.put(task.threadId, task.projectAlias, runResult.sessionId);
    }

    this.queue.markDone(task.id, runResult.summary);

    this.audit.log({
      timestamp: nowTs(),
      taskId: task.id,
      projectAlias: task.projectAlias,
      actor: "worker",
      action: "task_completed",
      detail: {
        tokensUsed: runResult.tokensUsed,
        replayActions: runResult.replayActions,
      },
      threadId: task.threadId,
    });

    await this.onTaskUpdate({
      taskId: task.id,
      threadId: task.threadId,
      status: "done",
      summary: runResult.summary,
    });
  }

  private async executeClaude(
    task: TaskRecord,
    projectPath: string,
    tokenBudget: number,
    ctx: RunContext,
  ): Promise<TaskResult> {
    const realCwd = this.validateWorkingDir(projectPath);

    const args = ["--print", "--output-format", "stream-json"];

    // Use --resume for continue sessions and replay mode unless explicitly disabled after a resume failure.
    const allowResume = ctx.allowResume !== false;
    const session = allowResume && (task.continueSession || ctx.replayMode) ? this.sessions.get(task.threadId) : undefined;
    if (session?.sessionId) {
      args.push("--resume", session.sessionId);
    }

    const prompt = this.buildPrompt(task, ctx);
    args.push("-p", prompt);

    const project = this.appConfig.projects[task.projectAlias];
    const skipPermissions = ctx.forceSkipPermissions || project?.skipPermissions === true;
    if (skipPermissions) {
      args.push("--dangerously-skip-permissions");
    }

    const child = spawn("claude", args, {
      cwd: realCwd,
      shell: false,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: process.env.NODE_ENV,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pid = child.pid;
    const pidStart = nowTs();
    if (typeof pid === "number") {
      this.queue.setWorkerPid(task.id, pid, pidStart);
    }

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let accumulatedRaw = "";
    let parseFailures: string[] = [];

    let silenceTimer: NodeJS.Timeout | undefined;
    let killedBySilenceTimeout = false;
    let killedByHardTimeout = false;
    let killedByBudget = false;

    const resetSilenceTimeout = () => {
      if (silenceTimer) {
        clearTimeout(silenceTimer);
      }
      silenceTimer = setTimeout(() => {
        killedBySilenceTimeout = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }, this.runtimeConfig.silenceTimeoutMs);
    };

    resetSilenceTimeout();

    const timeoutTimer = setTimeout(() => {
      killedByHardTimeout = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, ctx.timeoutMs);

    let parsedOutcome: ParsedStreamOutcome = {
      assistantText: "",
      toolSummary: [],
      replayActions: [],
      parseWarnings: [],
    };

    let estimatedTokens = 0;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      resetSilenceTimeout();
      stdoutBuffer += chunk;
      accumulatedRaw += chunk;

      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.length > 0) {
          const parsed = this.consumeStreamLine(line, parsedOutcome, ctx.replayMode);
          parsedOutcome = parsed.next;
          if (parsed.failedLine) {
            parseFailures.push(parsed.failedLine);
          }
        }
        newline = stdoutBuffer.indexOf("\n");
      }

      estimatedTokens = Math.floor(accumulatedRaw.length / 4);
      this.queue.updateTokensUsed(task.id, parsedOutcome.tokenUsage ?? estimatedTokens);

      if ((parsedOutcome.tokenUsage ?? estimatedTokens) > tokenBudget) {
        killedByBudget = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      accumulatedRaw += chunk;
    });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });

    if (silenceTimer) {
      clearTimeout(silenceTimer);
    }
    clearTimeout(timeoutTimer);

    await this.ensureExit(child.pid ?? 0, pidStart);

    if (parseFailures.length > 0) {
      this.writeDebugParseFailures(task.id, parseFailures);
      if (parsedOutcome.assistantText.trim().length === 0 && parsedOutcome.toolSummary.length === 0) {
        this.audit.log({
          timestamp: nowTs(),
          taskId: task.id,
          projectAlias: task.projectAlias,
          actor: "worker",
          action: "schema_drift",
          detail: {
            reason: "stream_json_parse_failures",
            firstLine: redactSecrets(parseFailures[0] ?? "").slice(0, 400),
            parseFailureCount: parseFailures.length,
          },
          threadId: task.threadId,
        });
      }
    }

    const tokensUsed = parsedOutcome.tokenUsage ?? estimatedTokens;

    const permissionDenied = parsedOutcome.permissionDenied;
    if (permissionDenied && !ctx.forceSkipPermissions) {
      return {
        status: "needs_approval",
        summary: permissionDenied.description,
        tokensUsed,
        replayActions: parsedOutcome.replayActions,
        approvalActionType: permissionDenied.actionType,
      };
    }

    if (killedBySilenceTimeout) {
      return {
        status: "failed",
        summary: "Process went silent and was terminated.",
        tokensUsed,
        replayActions: parsedOutcome.replayActions,
        errorCode: "silence_timeout",
      };
    }

    if (killedByHardTimeout) {
      return {
        status: "failed",
        summary: "Task timed out and was terminated.",
        tokensUsed,
        replayActions: parsedOutcome.replayActions,
        errorCode: "timeout",
      };
    }

    if (killedByBudget) {
      return {
        status: "failed",
        summary: `Token budget exceeded (${tokenBudget}).`,
        tokensUsed,
        replayActions: parsedOutcome.replayActions,
        errorCode: "budget_exceeded",
      };
    }

    const finalText = parsedOutcome.assistantText || accumulatedRaw || stderrBuffer;

    if ((exit.code ?? 0) !== 0 && session?.sessionId) {
      const combinedOutput = `${stderrBuffer}\n${finalText}`;
      if (looksLikeResumeFailure(combinedOutput)) {
        this.audit.log({
          timestamp: nowTs(),
          taskId: task.id,
          projectAlias: task.projectAlias,
          actor: "worker",
          action: "session_resume_failed",
          detail: {
            sessionId: session.sessionId,
            reason: redactSecrets(combinedOutput).slice(0, 400),
          },
          threadId: task.threadId,
        });

        const fallbackTask: TaskRecord = task.continueSession
          ? {
              ...task,
              continueSession: false,
              prompt: this.buildResumeFallbackPrompt(task.threadId, task.prompt),
            }
          : task;

        const rerun = await this.executeClaude(
          fallbackTask,
          projectPath,
          tokenBudget,
          { ...ctx, allowResume: false },
        );
        if (rerun.status === "done" || rerun.status === "failed") {
          const prefix = task.continueSession
            ? "Couldn't resume previous session; started fresh with thread context summary."
            : "Couldn't resume previous session for replay; continued with checkpoint context.";
          rerun.summary = `${prefix}\n\n${rerun.summary}`;
        }
        return rerun;
      }
    }

    if ((exit.code ?? 0) !== 0 && finalText.trim().length === 0) {
      return {
        status: "failed",
        summary: redactSecrets(stderrBuffer).slice(0, 500) || "Claude Code exited with an error.",
        tokensUsed,
        replayActions: parsedOutcome.replayActions,
        errorCode: "cli_error",
      };
    }

    const summary = await this.summarizer.summarize({
      rawText: finalText,
      toolSummary: parsedOutcome.toolSummary,
      tokensUsed,
      tokenBudget,
      replayActions: parsedOutcome.replayActions,
    });

    return {
      status: "done",
      summary,
      tokensUsed,
      sessionId: parsedOutcome.detectedSessionId,
      replayActions: parsedOutcome.replayActions,
    };
  }

  private consumeStreamLine(
    line: string,
    current: ParsedStreamOutcome,
    replayMode: boolean,
  ): { next: ParsedStreamOutcome; failedLine?: string } {
    let next = { ...current };
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const type = typeof parsed.type === "string" ? parsed.type : "";
      const role = typeof parsed.role === "string" ? parsed.role : "";
      const text = typeof parsed.text === "string" ? parsed.text : typeof parsed.message === "string" ? parsed.message : "";

      const chunkText = extractAnyText(parsed);
      if (role === "assistant" || type.includes("assistant")) {
        if (chunkText) {
          next.assistantText = `${next.assistantText}${chunkText}\n`;
        }
      }

      if (type.includes("tool") || hasToolLikeFields(parsed)) {
        const summary = summarizeTool(parsed, chunkText);
        if (summary) {
          next.toolSummary = [...next.toolSummary, summary];
          if (replayMode || summary.toLowerCase().includes("replay")) {
            next.replayActions = [...next.replayActions, summary];
          }
        }
      }

      if (typeof parsed.session_id === "string") {
        next.detectedSessionId = parsed.session_id;
      } else if (typeof parsed.conversation_id === "string") {
        next.detectedSessionId = parsed.conversation_id;
      }

      const usage = parsed.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)) {
        next.tokenUsage = usage.total_tokens;
      }

      const permission = detectPermissionDenied(parsed, text || chunkText || line);
      if (permission) {
        next.permissionDenied = permission;
      }
    } catch {
      next.parseWarnings = [...next.parseWarnings, "json_parse_failed"];
      return { next, failedLine: line };
    }

    return { next };
  }

  private buildPrompt(task: TaskRecord, ctx: RunContext): string {
    if (ctx.replayMode) {
      const replayContext = [
        `[APPROVED ACTION ONLY] The user approved: ${ctx.replayApprovedAction ?? "sensitive action"}.`,
        ctx.replayCheckpointSummary ? `Previous progress: ${ctx.replayCheckpointSummary}` : "",
        `Perform the approved action, then continue the original task: ${task.prompt}`,
      ]
        .filter(Boolean)
        .join("\n");
      return replayContext;
    }

    if (task.continueSession) {
      const existing = this.sessions.get(task.threadId);
      if (!existing) {
        return this.buildResumeFallbackPrompt(task.threadId, task.prompt);
      }
    }

    return task.prompt;
  }

  private buildResumeFallbackPrompt(threadId: string, originalPrompt: string): string {
    const contextSummary = this.buildThreadContextSummary(threadId);
    return `[Context: continuing from previous task in this thread. Previous task summary: ${contextSummary}] ${originalPrompt}`;
  }

  private buildThreadContextSummary(threadId: string): string {
    const history = this.queue
      .getByThreadId(threadId, 6)
      .filter((task) => task.status === "done" || task.status === "failed")
      .slice(0, 3);

    if (history.length === 0) {
      return "unavailable";
    }

    const lines = history.map((task) => {
      const when = new Date(task.createdAt).toISOString();
      const detail = task.status === "done" ? task.result : task.error;
      const compact = redactSecrets((detail ?? "no detail").replace(/\s+/g, " ").trim()).slice(0, 160);
      return `${when} ${task.status}: ${compact}`;
    });

    return lines.join(" | ").slice(0, 700);
  }

  private validateWorkingDir(projectPath: string): string {
    const configured = path.resolve(projectPath);
    const resolved = fs.realpathSync(configured);
    if (resolved !== configured) {
      throw new Error(`Working directory must be an explicit real path. configured=${configured} resolved=${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Configured project path is not a directory: ${resolved}`);
    }
    return resolved;
  }

  private async ensureExit(pid: number, pidStartTs?: number): Promise<void> {
    if (!pid || pid <= 0) {
      return;
    }

    const start = nowTs();
    while (nowTs() - start < PROCESS_EXIT_WAIT_MS) {
      if (!pidExists(pid)) {
        return;
      }
      await sleep(100);
    }

    // Verify process identity before SIGKILL to prevent killing a reused PID
    if (pidStartTs !== undefined) {
      const verified = verifyProcessIdentity(pid, pidStartTs);
      if (!verified.ok) {
        logWarn("Skipping SIGKILL: PID reused by another process", { pid, reason: verified.reason });
        return;
      }
    }

    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }

  private writeDebugParseFailures(taskId: string, lines: string[]): void {
    const debugDir = path.join(process.cwd(), "data", "debug");
    fs.mkdirSync(debugDir, { recursive: true });
    const target = path.join(debugDir, `${taskId}.log`);
    fs.writeFileSync(target, lines.join("\n\n"), "utf8");
  }

  private async recoverOrphans(): Promise<void> {
    const running = this.queue.getRunningOrphans();
    for (const task of running) {
      const pid = task.workerPid;
      const startTs = task.workerPidStart;
      if (!pid || !startTs) {
        this.queue.markFailed(task.id, "worker_crashed_recovery");
        continue;
      }

      const verified = verifyProcessIdentity(pid, startTs);
      if (verified.ok) {
        try {
          process.kill(pid, "SIGKILL");
          this.audit.log({
            timestamp: nowTs(),
            taskId: task.id,
            projectAlias: task.projectAlias,
            actor: "system",
            action: "zombie_killed",
            detail: { pid },
            threadId: task.threadId,
          });
        } catch (error) {
          logWarn("Failed to kill orphan process", { pid, error });
        }
      } else {
        this.audit.log({
          timestamp: nowTs(),
          taskId: task.id,
          projectAlias: task.projectAlias,
          actor: "system",
          action: "zombie_pid_reused",
          detail: { pid, reason: verified.reason },
          threadId: task.threadId,
        });
      }

      this.queue.markFailed(task.id, "worker_crashed_recovery");
      await this.onTaskUpdate({
        taskId: task.id,
        threadId: task.threadId,
        status: "failed",
        error: "worker_crashed_recovery",
      });
    }
  }
}

function safeJsonParse(input: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractAnyText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => extractAnyText(entry)).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    if (typeof objectValue.text === "string") {
      return objectValue.text;
    }
    if (typeof objectValue.content === "string") {
      return objectValue.content;
    }
    if (Array.isArray(objectValue.content)) {
      return objectValue.content.map((entry) => extractAnyText(entry)).filter(Boolean).join("\n");
    }
  }
  return "";
}

function hasToolLikeFields(parsed: Record<string, unknown>): boolean {
  return (
    typeof parsed.tool_name === "string" ||
    typeof parsed.toolName === "string" ||
    typeof parsed.name === "string"
  );
}

function summarizeTool(parsed: Record<string, unknown>, text: string): string | undefined {
  const toolName =
    (typeof parsed.tool_name === "string" && parsed.tool_name) ||
    (typeof parsed.toolName === "string" && parsed.toolName) ||
    (typeof parsed.name === "string" && parsed.name) ||
    "tool";
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return undefined;
  }
  return `${toolName}: ${cleaned.slice(0, 180)}`;
}

function detectPermissionDenied(
  parsed: Record<string, unknown>,
  textCandidate: string,
): { actionType: ApprovalActionType; description: string } | undefined {
  const text = textCandidate.toLowerCase();
  const type = typeof parsed.type === "string" ? parsed.type.toLowerCase() : "";

  if (!text.includes("permission") && !type.includes("permission") && !text.includes("denied")) {
    return undefined;
  }

  const actionType = classifyActionType(text);
  const description = extractPermissionDescription(textCandidate);
  return { actionType, description };
}

function classifyActionType(text: string): ApprovalActionType {
  if (text.includes("delete") || text.includes("rm ")) {
    return "file_delete";
  }
  if (text.includes("force push") || text.includes("git reset")) {
    return "git_force";
  }
  if (text.includes("git push")) {
    return "git_push";
  }
  if (text.includes("rm -rf") || text.includes("drop table")) {
    return "destructive_cmd";
  }
  if (text.includes("npm install") || text.includes("pip install")) {
    return "install_package";
  }
  if (text.includes("http") || text.includes("api")) {
    return "external_request";
  }
  return "unknown";
}

function extractPermissionDescription(input: string): string {
  const cleaned = input.replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 300);
}

function looksLikeResumeFailure(input: string): boolean {
  const text = input.toLowerCase();
  if (!text.includes("resume") && !text.includes("session") && !text.includes("conversation")) {
    return false;
  }
  return (
    text.includes("session not found") ||
    text.includes("conversation not found") ||
    text.includes("unknown session") ||
    text.includes("invalid session") ||
    text.includes("unable to resume") ||
    text.includes("failed to resume") ||
    text.includes("no such conversation")
  );
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function verifyProcessIdentity(pid: number, expectedStartTs: number): { ok: boolean; reason?: string } {
  if (!pidExists(pid)) {
    return { ok: false, reason: "pid_missing" };
  }

  try {
    const comm = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
    }).trim();

    if (!(comm.includes("claude") || comm.includes("node"))) {
      return { ok: false, reason: `unexpected_comm:${comm}` };
    }

    const lstart = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
    const startedAt = Date.parse(lstart);
    if (Number.isFinite(startedAt)) {
      const diff = Math.abs(startedAt - expectedStartTs);
      if (diff > 5_000) {
        return { ok: false, reason: "pid_reused_start_mismatch" };
      }
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `ps_failed:${String(error)}` };
  }
}

function verifyProcessCommand(pid: number): { ok: boolean; reason?: string } {
  if (!pidExists(pid)) {
    return { ok: false, reason: "pid_missing" };
  }

  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
    if (!command.toLowerCase().includes("claude")) {
      return { ok: false, reason: `unexpected_command:${command}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `ps_failed:${String(error)}` };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
