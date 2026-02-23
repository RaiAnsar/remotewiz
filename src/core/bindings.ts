import type { DB } from "./db.js";
import type { AdapterName, ThreadBinding } from "../types.js";
import { nowTs } from "../utils/ids.js";

export class ThreadBindings {
  constructor(private readonly db: DB) {}

  upsert(threadId: string, projectAlias: string, adapter: AdapterName, createdBy: string): void {
    this.db
      .prepare(
        `INSERT INTO thread_bindings (thread_id, project_alias, adapter, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id)
         DO UPDATE SET project_alias = excluded.project_alias,
                       adapter = excluded.adapter,
                       created_by = excluded.created_by,
                       created_at = excluded.created_at`,
      )
      .run(threadId, projectAlias, adapter, createdBy, nowTs());
  }

  get(threadId: string): ThreadBinding | undefined {
    const row = this.db.prepare(`SELECT * FROM thread_bindings WHERE thread_id = ?`).get(threadId) as
      | {
          thread_id: string;
          project_alias: string;
          adapter: AdapterName;
          created_by: string;
          created_at: number;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      threadId: row.thread_id,
      projectAlias: row.project_alias,
      adapter: row.adapter,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  list(limit = 100): ThreadBinding[] {
    const rows = this.db
      .prepare(`SELECT * FROM thread_bindings ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as {
      thread_id: string;
      project_alias: string;
      adapter: AdapterName;
      created_by: string;
      created_at: number;
    }[];

    return rows.map((row) => ({
      threadId: row.thread_id,
      projectAlias: row.project_alias,
      adapter: row.adapter,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
  }
}
