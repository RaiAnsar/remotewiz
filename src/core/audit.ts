import type { DB } from "./db.js";
import type { AuditEntry } from "../types.js";
import { redactUnknown } from "../utils/redact.js";

export class AuditLog {
  constructor(private readonly db: DB) {}

  log(entry: AuditEntry): void {
    const redacted = redactUnknown(entry.detail);
    this.db
      .prepare(
        `INSERT INTO audit_log (timestamp, task_id, project_alias, actor, action, detail, thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.timestamp,
        entry.taskId ?? null,
        entry.projectAlias ?? null,
        entry.actor,
        entry.action,
        redacted === undefined ? null : JSON.stringify(redacted),
        entry.threadId ?? null,
      );
  }

  getByTask(taskId: string): AuditEntry[] {
    return this.mapRows(
      this.db.prepare(`SELECT * FROM audit_log WHERE task_id = ? ORDER BY id DESC`).all(taskId) as Record<
        string,
        unknown
      >[],
    );
  }

  getByProject(projectAlias: string, limit = 50): AuditEntry[] {
    return this.mapRows(
      this.db
        .prepare(`SELECT * FROM audit_log WHERE project_alias = ? ORDER BY id DESC LIMIT ?`)
        .all(projectAlias, limit) as Record<string, unknown>[],
    );
  }

  getRecent(limit = 50): AuditEntry[] {
    return this.mapRows(
      this.db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`).all(limit) as Record<
        string,
        unknown
      >[],
    );
  }

  private mapRows(rows: Record<string, unknown>[]): AuditEntry[] {
    return rows.map((row) => {
      let detail: unknown;
      if (typeof row.detail === "string" && row.detail.length > 0) {
        try {
          detail = JSON.parse(row.detail);
        } catch {
          detail = row.detail;
        }
      }
      return {
        id: Number(row.id),
        timestamp: Number(row.timestamp),
        taskId: (row.task_id as string | null) ?? undefined,
        projectAlias: (row.project_alias as string | null) ?? undefined,
        actor: String(row.actor),
        action: String(row.action),
        detail,
        threadId: (row.thread_id as string | null) ?? undefined,
      };
    });
  }
}
