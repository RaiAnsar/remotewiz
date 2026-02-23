import type { DB } from "./db.js";
import type { ApprovalActionType, ApprovalRecord, ApprovalStatus } from "../types.js";
import { newId, nowTs } from "../utils/ids.js";

function mapApproval(row: {
  id: string;
  task_id: string;
  action_type: ApprovalActionType;
  description: string;
  status: ApprovalStatus;
  requested_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}): ApprovalRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    actionType: row.action_type,
    description: row.description,
    status: row.status,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
  };
}

export class ApprovalStore {
  constructor(private readonly db: DB) {}

  create(taskId: string, actionType: ApprovalActionType, description: string): ApprovalRecord {
    const id = newId();
    const requestedAt = nowTs();
    this.db
      .prepare(
        `INSERT INTO approvals (id, task_id, action_type, description, status, requested_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, taskId, actionType, description, requestedAt);

    return {
      id,
      taskId,
      actionType,
      description,
      status: "pending",
      requestedAt,
    };
  }

  getById(approvalId: string): ApprovalRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(approvalId) as
      | {
          id: string;
          task_id: string;
          action_type: ApprovalActionType;
          description: string;
          status: ApprovalStatus;
          requested_at: number;
          resolved_at: number | null;
          resolved_by: string | null;
        }
      | undefined;
    return row ? mapApproval(row) : undefined;
  }

  getPendingByTask(taskId: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1`)
      .get(taskId) as
      | {
          id: string;
          task_id: string;
          action_type: ApprovalActionType;
          description: string;
          status: ApprovalStatus;
          requested_at: number;
          resolved_at: number | null;
          resolved_by: string | null;
        }
      | undefined;
    return row ? mapApproval(row) : undefined;
  }

  resolve(approvalId: string, status: "approved" | "denied", resolvedBy: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE approvals
         SET status = ?, resolved_at = ?, resolved_by = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, nowTs(), resolvedBy, approvalId);
    return result.changes > 0;
  }

  expireOlderThan(ms: number): string[] {
    const cutoff = nowTs() - ms;
    const ids = (this.db
      .prepare(`SELECT id FROM approvals WHERE status = 'pending' AND requested_at < ?`)
      .all(cutoff) as { id: string }[]).map((row) => row.id);

    if (ids.length === 0) {
      return ids;
    }

    this.db
      .prepare(`UPDATE approvals SET status = 'denied', resolved_at = ?, resolved_by = 'system_timeout' WHERE status = 'pending' AND requested_at < ?`)
      .run(nowTs(), cutoff);
    return ids;
  }
}
