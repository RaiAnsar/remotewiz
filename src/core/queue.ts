import type { DB } from "./db.js";
import type { EnqueueTaskInput, TaskRecord, TaskStatus } from "../types.js";
import { nowTs } from "../utils/ids.js";

function mapTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    projectAlias: String(row.project_alias),
    projectPath: String(row.project_path),
    prompt: String(row.prompt),
    threadId: String(row.thread_id),
    adapter: row.adapter as TaskRecord["adapter"],
    continueSession: Number(row.continue_session) === 1,
    status: row.status as TaskStatus,
    result: (row.result as string | null) ?? undefined,
    error: (row.error as string | null) ?? undefined,
    tokensUsed: Number(row.tokens_used ?? 0),
    tokenBudget: (row.token_budget as number | null) ?? undefined,
    workerPid: (row.worker_pid as number | null) ?? undefined,
    workerPidStart: (row.worker_pid_start as number | null) ?? undefined,
    checkpoint: (row.checkpoint as string | null) ?? undefined,
    createdAt: Number(row.created_at),
    startedAt: (row.started_at as number | null) ?? undefined,
    completedAt: (row.completed_at as number | null) ?? undefined,
  };
}

export class TaskQueue {
  constructor(
    private readonly db: DB,
    private readonly maxQueuedPerProject: number,
  ) {}

  enqueue(input: EnqueueTaskInput): TaskRecord {
    const queuedCountRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE project_alias = ? AND status = 'queued'`)
      .get(input.projectAlias) as { c: number };

    if (queuedCountRow.c >= this.maxQueuedPerProject) {
      throw new Error("queue_full");
    }

    const createdAt = nowTs();

    this.db
      .prepare(
        `INSERT INTO tasks (
          id, project_alias, project_path, prompt, thread_id, adapter,
          continue_session, status, token_budget, created_at, tokens_used
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0)`,
      )
      .run(
        input.id,
        input.projectAlias,
        input.projectPath,
        input.prompt,
        input.threadId,
        input.adapter,
        input.continueSession ? 1 : 0,
        input.tokenBudget ?? null,
        createdAt,
      );

    return this.getById(input.id)!;
  }

  dequeueNext(): TaskRecord | undefined {
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT t.*
           FROM tasks t
           WHERE t.status = 'queued'
             AND NOT EXISTS (
               SELECT 1 FROM tasks r
               WHERE r.project_alias = t.project_alias
                 AND r.status IN ('running', 'needs_approval')
             )
           ORDER BY t.created_at ASC
           LIMIT 1`,
        )
        .get() as Record<string, unknown> | undefined;

      if (!row) {
        return undefined;
      }

      const startedAt = nowTs();
      this.db
        .prepare(`UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?`)
        .run(startedAt, String(row.id));

      const updated = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(String(row.id)) as
        | Record<string, unknown>
        | undefined;

      return updated ? mapTask(updated) : undefined;
    });

    return transaction();
  }

  getById(taskId: string): TaskRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapTask(row) : undefined;
  }

  getByThreadId(threadId: string, limit = 50): TaskRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(threadId, limit) as Record<string, unknown>[];
    return rows.map(mapTask);
  }

  getByProject(projectAlias: string, limit = 50): TaskRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE project_alias = ? ORDER BY created_at DESC LIMIT ?`)
      .all(projectAlias, limit) as Record<string, unknown>[];
    return rows.map(mapTask);
  }

  getRunning(): TaskRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE status IN ('running', 'needs_approval') ORDER BY started_at ASC`)
      .all() as Record<string, unknown>[];
    return rows.map(mapTask);
  }

  getRunningOrphans(): TaskRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE status = 'running' ORDER BY started_at ASC`)
      .all() as Record<string, unknown>[];
    return rows.map(mapTask);
  }

  getTokensUsedSince(sinceTs: number, projectAlias?: string): number {
    const row = projectAlias
      ? (this.db
          .prepare(`SELECT COALESCE(SUM(tokens_used), 0) AS total FROM tasks WHERE created_at >= ? AND project_alias = ?`)
          .get(sinceTs, projectAlias) as { total: number })
      : (this.db
          .prepare(`SELECT COALESCE(SUM(tokens_used), 0) AS total FROM tasks WHERE created_at >= ?`)
          .get(sinceTs) as { total: number });
    return Number(row.total);
  }

  getPendingCountsByProject(): Array<{ projectAlias: string; count: number }> {
    const rows = this.db
      .prepare(`SELECT project_alias, COUNT(*) AS c FROM tasks WHERE status = 'queued' GROUP BY project_alias`)
      .all() as { project_alias: string; c: number }[];
    return rows.map((row) => ({ projectAlias: row.project_alias, count: Number(row.c) }));
  }

  updateStatus(taskId: string, status: TaskStatus, result?: string, error?: string): void {
    const completedAt = status === "done" || status === "failed" ? nowTs() : null;
    this.db
      .prepare(
        `UPDATE tasks
         SET status = ?,
             result = COALESCE(?, result),
             error = COALESCE(?, error),
             completed_at = COALESCE(?, completed_at)
         WHERE id = ?`,
      )
      .run(status, result ?? null, error ?? null, completedAt, taskId);
  }

  markFailed(taskId: string, error: string): void {
    this.db
      .prepare(`UPDATE tasks SET status = 'failed', error = ?, completed_at = ?, worker_pid = NULL, worker_pid_start = NULL WHERE id = ?`)
      .run(error, nowTs(), taskId);
  }

  markDone(taskId: string, summary: string): void {
    this.db
      .prepare(`UPDATE tasks SET status = 'done', result = ?, completed_at = ?, worker_pid = NULL, worker_pid_start = NULL WHERE id = ?`)
      .run(summary, nowTs(), taskId);
  }

  cancel(taskId: string): boolean {
    const result = this.db
      .prepare(`UPDATE tasks SET status = 'failed', error = 'cancelled_by_user', completed_at = ? WHERE id = ? AND status IN ('queued','running','needs_approval')`)
      .run(nowTs(), taskId);
    return result.changes > 0;
  }

  updateTokensUsed(taskId: string, tokensUsed: number): void {
    this.db.prepare(`UPDATE tasks SET tokens_used = ? WHERE id = ?`).run(tokensUsed, taskId);
  }

  setCheckpoint(taskId: string, checkpoint: string): void {
    this.db.prepare(`UPDATE tasks SET checkpoint = ? WHERE id = ?`).run(checkpoint, taskId);
  }

  setWorkerPid(taskId: string, pid: number, pidStart: number): void {
    this.db.prepare(`UPDATE tasks SET worker_pid = ?, worker_pid_start = ? WHERE id = ?`).run(pid, pidStart, taskId);
  }

  clearWorkerPid(taskId: string): void {
    this.db.prepare(`UPDATE tasks SET worker_pid = NULL, worker_pid_start = NULL WHERE id = ?`).run(taskId);
  }
}
