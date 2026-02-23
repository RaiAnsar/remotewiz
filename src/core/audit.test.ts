import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "./db.js";
import { AuditLog } from "./audit.js";
import { nowTs } from "../utils/ids.js";

test("AuditLog is append-only at DB level", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "remotewiz-audit-"));
  const db = openDatabase(cwd);
  try {
    const audit = new AuditLog(db);
    audit.log({
      timestamp: nowTs(),
      actor: "test",
      action: "created",
      detail: { token: "sk-testsecretvalue1234567890" },
    });

    const row = db.prepare(`SELECT id, detail FROM audit_log LIMIT 1`).get() as { id: number; detail: string };
    assert.ok(row.id > 0);
    assert.match(row.detail, /\[REDACTED\]/);

    assert.throws(() => {
      db.prepare(`UPDATE audit_log SET actor = 'changed' WHERE id = ?`).run(row.id);
    }, /append-only/i);

    assert.throws(() => {
      db.prepare(`DELETE FROM audit_log WHERE id = ?`).run(row.id);
    }, /append-only/i);
  } finally {
    closeDatabase(db);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
