import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type DB = Database.Database;

export function openDatabase(cwd = process.cwd()): DB {
  const dataDir = path.join(cwd, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "remotewiz.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  initializeSchema(db);
  return db;
}

function initializeSchema(db: DB): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS thread_bindings (
  thread_id TEXT PRIMARY KEY,
  project_alias TEXT NOT NULL,
  adapter TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_alias TEXT NOT NULL,
  project_path TEXT NOT NULL,
  prompt TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  continue_session INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  token_budget INTEGER,
  worker_pid INTEGER,
  worker_pid_start INTEGER,
  checkpoint TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status_created ON tasks(project_alias, status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_thread_created ON tasks(thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  thread_id TEXT PRIMARY KEY,
  project_alias TEXT NOT NULL,
  session_id TEXT NOT NULL,
  last_used INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status_requested ON approvals(status, requested_at);

CREATE TABLE IF NOT EXISTS upload_refs (
  id TEXT PRIMARY KEY,
  project_alias TEXT NOT NULL,
  original_name TEXT NOT NULL,
  server_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_upload_refs_project_created ON upload_refs(project_alias, created_at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  task_id TEXT,
  project_alias TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  thread_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_task_ts ON audit_log(task_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_project_ts ON audit_log(project_alias, timestamp DESC);

CREATE TRIGGER IF NOT EXISTS audit_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE not allowed');
END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: DELETE not allowed');
END;
  `);
}

export function closeDatabase(db: DB): void {
  db.close();
}
