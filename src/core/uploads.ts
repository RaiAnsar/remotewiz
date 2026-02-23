import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.js";
import type { UploadRef } from "../types.js";
import { nowTs } from "../utils/ids.js";

const UPLOAD_ROOT = "data/uploads";

export function uploadsRoot(cwd = process.cwd()): string {
  return path.join(cwd, UPLOAD_ROOT);
}

export class UploadStore {
  constructor(private readonly db: DB, private readonly cwd = process.cwd()) {}

  saveReference(ref: UploadRef, ttlMs = 3_600_000): void {
    this.db
      .prepare(
        `INSERT INTO upload_refs (id, project_alias, original_name, server_path, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ref.id, ref.projectAlias, ref.originalName, ref.serverPath, ref.createdAt, ref.createdAt + ttlMs);
  }

  getReference(id: string): UploadRef | undefined {
    const row = this.db.prepare(`SELECT * FROM upload_refs WHERE id = ?`).get(id) as
      | {
          id: string;
          project_alias: string;
          original_name: string;
          server_path: string;
          created_at: number;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      projectAlias: row.project_alias,
      originalName: row.original_name,
      serverPath: row.server_path,
      createdAt: row.created_at,
    };
  }

  markConsumed(id: string): void {
    this.db.prepare(`UPDATE upload_refs SET consumed_at = ? WHERE id = ?`).run(nowTs(), id);
  }

  cleanupExpired(): number {
    const cutoff = nowTs();
    const rows = this.db
      .prepare(`SELECT id, server_path FROM upload_refs WHERE expires_at IS NOT NULL AND expires_at < ?`)
      .all(cutoff) as { id: string; server_path: string }[];

    for (const row of rows) {
      try {
        fs.rmSync(row.server_path, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }

    const result = this.db.prepare(`DELETE FROM upload_refs WHERE expires_at IS NOT NULL AND expires_at < ?`).run(cutoff);
    return result.changes;
  }

  cleanupOrphanDirs(maxAgeMs = 3_600_000): number {
    const root = uploadsRoot(this.cwd);
    if (!fs.existsSync(root)) {
      return 0;
    }

    const cutoff = nowTs() - maxAgeMs;
    let deleted = 0;

    const projects = fs.readdirSync(root, { withFileTypes: true });
    for (const projEntry of projects) {
      if (!projEntry.isDirectory()) {
        continue;
      }
      const projPath = path.join(root, projEntry.name);
      for (const taskEntry of fs.readdirSync(projPath, { withFileTypes: true })) {
        if (!taskEntry.isDirectory()) {
          continue;
        }
        const taskPath = path.join(projPath, taskEntry.name);
        const stat = fs.statSync(taskPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(taskPath, { recursive: true, force: true });
          deleted += 1;
        }
      }
    }

    return deleted;
  }
}
