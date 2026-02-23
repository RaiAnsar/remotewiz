import type { DB } from "./db.js";
import type { SessionRecord } from "../types.js";
import { nowTs } from "../utils/ids.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class SessionStore {
  constructor(private readonly db: DB) {}

  put(threadId: string, projectAlias: string, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (thread_id, project_alias, session_id, last_used)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id)
         DO UPDATE SET project_alias = excluded.project_alias,
                       session_id = excluded.session_id,
                       last_used = excluded.last_used`,
      )
      .run(threadId, projectAlias, sessionId, nowTs());
  }

  get(threadId: string): SessionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE thread_id = ?`).get(threadId) as
      | {
          thread_id: string;
          project_alias: string;
          session_id: string;
          last_used: number;
        }
      | undefined;
    if (!row) {
      return undefined;
    }

    return {
      threadId: row.thread_id,
      projectAlias: row.project_alias,
      sessionId: row.session_id,
      lastUsed: row.last_used,
    };
  }

  touch(threadId: string): void {
    this.db.prepare(`UPDATE sessions SET last_used = ? WHERE thread_id = ?`).run(nowTs(), threadId);
  }

  cleanupOlderThan(ttlMs = DEFAULT_TTL_MS): number {
    const cutoff = nowTs() - ttlMs;
    const result = this.db.prepare(`DELETE FROM sessions WHERE last_used < ?`).run(cutoff);
    return result.changes;
  }
}
