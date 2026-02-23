# RemoteWiz — Full Implementation Plan (v6)

## Context

RemoteWiz is a lightweight tool that lets you control Claude Code remotely from Discord (or a simple web UI) while traveling, lying in bed, or away from your dev machine. Each Discord thread maps to a project directory, and messages spawn Claude Code CLI sessions that do the actual work. A Haiku summarizer condenses verbose output into phone-friendly responses.

This replaces the need for OpenClaw (bloated, uses its own agent runtime) or SSH-from-phone workflows.

### Design Principles

- **Task-scoped execution** — fresh CLI spawn per message, not one giant context chat. No token burning.
- **Deterministic routing first** — thread name = project. No AI classification needed for routing.
- **Security by default** — approval gates for risky actions, audit trail, no skip-permissions unless explicitly enabled per project.
- **Lean runtime** — SQLite for everything, 7 deps, one process. Not a microservice zoo.
- **Buildable in a weekend, reliable for daily use.**

---

## Architecture

```
Discord Thread / Web UI Chat
         ↓
┌──────────────────────────────────┐
│  Adapter Layer                    │
│  (Discord.js / Express+WS)       │
│  Maps thread → project            │
│  Validates user identity          │
└──────────┬───────────────────────┘
           ↓
┌──────────────────────────────────┐
│  Task Queue (SQLite)              │
│  Persists tasks, enforces         │
│  per-project locking,             │
│  tracks token budget              │
└──────────┬───────────────────────┘
           ↓
┌──────────────────────────────────┐
│  Worker                           │
│  Spawns Claude Code CLI           │
│  Monitors for approval requests   │
│  Enforces timeout + token budget  │
└──────────┬───────────────────────┘
           ↓
     ┌─────┴──────┐
     ▼            ▼
┌──────────┐  ┌──────────────────┐
│ Approval │  │ Haiku Summarizer │
│ Gate     │  │ Structured output│
│ (if      │  │ + audit log      │
│ needed)  │  │                  │
└────┬─────┘  └────────┬─────────┘
     ▼                 ▼
  User approves →  Reply in thread / web chat
  or denies
```

---

## Directory Structure

```
remote-wiz-claude/
├── package.json
├── tsconfig.json
├── .env.example              # Discord token, Anthropic API key, auth secret
├── config.json               # Project aliases → paths + per-project settings
├── src/
│   ├── index.ts              # Entry point — boots adapters + worker
│   ├── config.ts             # Loads config.json + .env, Zod validation
│   ├── types.ts              # Shared types/interfaces
│   ├── core/
│   │   ├── queue.ts          # SQLite task queue (enqueue, dequeue, status, budget tracking)
│   │   ├── worker.ts         # Spawns Claude Code CLI, collects output, enforces limits
│   │   ├── session.ts        # Tracks session IDs per thread/project for /continue
│   │   ├── summarizer.ts     # Haiku summarizer with structured output format
│   │   ├── approval.ts       # Approval gate — terminate-and-replay flow for sensitive actions
│   │   └── audit.ts          # Append-only audit log (SQLite)
│   ├── adapters/
│   │   ├── base.ts           # Adapter interface (onMessage, sendReply, requestApproval)
│   │   ├── discord.ts        # Discord bot — thread handling, slash commands, approvals
│   │   └── web.ts            # Express + WebSocket simple chat UI
│   └── web/
│       └── index.html        # Single-file chat UI (vanilla HTML/CSS/JS)
└── data/                     # Created at runtime
    └── remotewiz.db          # SQLite database (queue, sessions, bindings, audit)
```

---

## Data Model (all SQLite)

### Tables

```sql
-- Project-thread bindings
thread_bindings (
  thread_id    TEXT PRIMARY KEY,
  project_alias TEXT NOT NULL,
  adapter      TEXT NOT NULL,        -- 'discord' | 'web'
  created_by   TEXT NOT NULL,        -- user ID
  created_at   INTEGER NOT NULL
)

-- Task queue
tasks (
  id              TEXT PRIMARY KEY,
  project_alias   TEXT NOT NULL,
  project_path    TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  thread_id       TEXT NOT NULL,
  adapter         TEXT NOT NULL,
  continue_session INTEGER DEFAULT 0,
  status          TEXT NOT NULL,      -- queued | running | needs_approval | done | failed
  result          TEXT,
  error           TEXT,
  tokens_used     INTEGER DEFAULT 0,
  token_budget    INTEGER,            -- per-task cap (NULL = use project default)
  worker_pid      INTEGER,            -- PID of spawned Claude Code process (for zombie cleanup)
  worker_pid_start INTEGER,           -- process start timestamp (for PID reuse detection)
  checkpoint      TEXT,               -- JSON: saved state for terminate-and-replay approval flow
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER
)

-- Session continuity
sessions (
  thread_id       TEXT PRIMARY KEY,
  project_alias   TEXT NOT NULL,
  session_id      TEXT NOT NULL,      -- Claude Code conversation ID
  last_used       INTEGER NOT NULL
)

-- Approval requests
approvals (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  action_type     TEXT NOT NULL,      -- file_delete | git_push | destructive_cmd | etc.
  description     TEXT NOT NULL,      -- human-readable "Claude wants to delete 3 files"
  status          TEXT NOT NULL,      -- pending | approved | denied
  requested_at    INTEGER NOT NULL,
  resolved_at     INTEGER,
  resolved_by     TEXT               -- user ID who approved/denied
)

-- Key-value metadata (CLI version tracking, etc.)
meta (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
)

-- Audit log (append-only, DB-enforced via triggers)
audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       INTEGER NOT NULL,
  task_id         TEXT,
  project_alias   TEXT,
  actor           TEXT NOT NULL,      -- 'system' | 'worker' | user ID
  action          TEXT NOT NULL,      -- task_created | task_started | approval_requested | etc.
  detail          TEXT,               -- JSON blob with context
  thread_id       TEXT
)

-- DB-enforced append-only: block UPDATE and DELETE on audit_log
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE not allowed');
END;

CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: DELETE not allowed');
END;
```

---

## Implementation Steps

### Step 1: Project scaffolding
- Initialize `package.json` with dependencies (see Dependencies section)
- TypeScript config (`tsconfig.json`) targeting ES2022, NodeNext module resolution
- `.env.example` with required keys
- `config.json` with example project mappings
- Build: `tsx` for dev, `tsc` for production
- Scripts: `dev`, `build`, `start`

### Step 2: Types and config (`types.ts`, `config.ts`)
- `Project` type:
  ```ts
  { alias: string, path: string, description?: string,
    skipPermissions?: boolean,        // default false — must be explicitly opted in
    skipPermissionsReason?: string,   // REQUIRED if skipPermissions is true (Zod enforced)
    tokenBudget?: number,             // max tokens per task, default 100_000
    timeout?: number }                // ms, default 600_000 (10 min)
  ```
- `Task`, `Approval`, `AuditEntry` types matching the SQL schema
- `Config` type with Zod validation
- Config loader: reads `config.json`, validates project paths exist on disk, merges with .env

### Step 3: Audit log (`core/audit.ts`)
- Append-only SQLite writes — enforced at DB level with BEFORE UPDATE and BEFORE DELETE triggers that RAISE(ABORT). Not just policy, the DB physically rejects mutations.
- Methods: `log(entry)`, `getByTask(taskId)`, `getByProject(alias, limit)`, `getRecent(limit)`
- Every significant action gets logged: task created, started, completed, failed, approval requested/resolved, session resumed
- Detail field stores JSON with relevant context (prompt snippet, files changed, error message)
- **Redaction**: detail field is passed through `redactSecrets()` before writing — strips patterns matching API keys, tokens, passwords (regex: `sk-...`, `ghp_...`, `xoxb-...`, `Bearer ...`, etc.)
- Query interface for `/audit` command

### Step 4: Task queue (`core/queue.ts`)
- SQLite table as defined in data model
- Methods: `enqueue(task)`, `dequeueNext()`, `updateStatus(id, status, result?)`, `getByThreadId(threadId)`, `getRunning()`, `cancel(id)`
- **Per-project locking**: only one task runs per project at a time; different projects run in parallel
- **Queue capacity**: max `MAX_QUEUED_PER_PROJECT` (default 5) pending tasks per project. `enqueue()` rejects with `queue_full` if limit hit. Prevents unbounded queue growth from rapid-fire messages.
- **Token budget tracking**: `tokens_used` updated from Claude Code output; if budget exceeded, task is stopped
- Auto-creates `data/` directory and DB on first run
- Logs all state transitions to audit

### Step 5: Session manager (`core/session.ts`)
- SQLite table as defined in data model
- When Claude Code completes, parse session/conversation ID from JSON output, store it
- For `/continue` — look up last session for that thread, pass `--resume <session_id>` flag
- Clean up sessions older than 24h (configurable)
- **Context bounding**: when resuming, inject a compact summary of previous runs (stored in audit log) rather than relying solely on Claude Code's internal history
- **Best-effort resume** (critical design decision): session resume is treated as a convenience, not a guarantee. Degradation path:
  1. Try `--resume <session_id>` first
  2. If CLI returns error (session not found, format changed, `.claude` dir cleared), catch the failure
  3. Fall back to fresh session with the prompt prefixed: `"[Context: continuing from previous task in this thread. Previous task summary: {audit_summary}] {user_prompt}"`
  4. Notify user: "Couldn't resume session — started fresh with context summary instead."
  5. Log `session_resume_failed` to audit with reason
  - This ensures `/continue` always works, even if Claude Code's internal session store gets wiped, the CLI updates, or the process runs in Docker without a persistent `.claude` volume

### Step 6: Approval gate (`core/approval.ts`)
- **When triggered**: worker detects Claude Code exiting due to a permission denial in its JSON output stream (tool use denied, permission prompt unanswered)
- **Action classes** that require approval:
  - `file_delete` — deleting files
  - `git_push` — pushing to remote
  - `git_force` — force push, reset, etc.
  - `destructive_cmd` — rm -rf, DROP TABLE, etc.
  - `external_request` — API calls to external services
  - `install_package` — npm install, pip install
- **Terminate-and-replay architecture** (critical design — NOT pause/resume):
  Claude Code `--print` mode is a one-shot process. When it hits a permission denial without `--dangerously-skip-permissions`, it exits (non-zero or with a permission-denied event in output). You cannot "pause" and "resume" a dead process. The correct flow is:
  1. Worker runs Claude Code normally (no `--dangerously-skip-permissions`)
  2. Claude Code hits a sensitive action → outputs permission-denied event → **process exits**
  3. Worker detects the permission denial in output, saves a **checkpoint**: the original prompt + a summary of what Claude accomplished before the denial (extracted from stream output)
  4. Worker sets task status to `needs_approval`, creates approval record in DB
  5. Sends approval request to adapter (Discord embed with Approve/Deny buttons, or WS message)
  6. **If approved**: worker spawns a NEW Claude Code process with `--dangerously-skip-permissions` and a **tightly scoped replay prompt**:
     ```
     "[APPROVED ACTION ONLY] The user approved: {action_description}.
     Previous progress: {checkpoint_summary}.
     Perform the approved action, then continue the original task: {original_prompt}"
     ```
     - Uses `--resume <session_id>` if available for maximum context continuity
     - If resume fails, uses the checkpoint summary as context prefix
     - **Replay timeout is reduced** to `REPLAY_TIMEOUT_MS` (default 120s / 2 min) — shorter than normal task timeout to limit the blast radius of the global skip-permissions grant
     - **Every action during replay is logged** to audit with tag `replay_action` including tool names and file paths touched
     - **Summary explicitly lists all replay actions**: the Haiku summarizer receives a flag to call out "Actions during approved replay: {list}" so the user sees exactly what happened with elevated permissions
  7. **If denied**: task marked as failed with `approval_denied`
  8. All approval actions logged to audit with checkpoint details
  - **Known trade-off (documented)**: replay runs with global `--dangerously-skip-permissions` because the CLI has no per-action permission grant. This means Claude could perform additional sensitive actions beyond the approved one. Mitigations: scoped prompt, reduced timeout, full audit logging, explicit summary callout. If this is unacceptable for a project, keep `skipPermissions: false` and accept that approval-requiring tasks may need multiple approval rounds (each round = one deny/approve/replay cycle).
- **Per-project override**: `skipPermissions` requires BOTH `skipPermissions: true` AND a `skipPermissionsReason` string in project config (e.g., `"reason": "sandbox project, no prod data"`). Config validation rejects `skipPermissions: true` without a reason — forces you to think about it. At startup, logs a prominent warning for every project with skip enabled. All skipped approvals logged as `auto_approved` in audit with the reason string attached.
- **Timeout**: approval requests expire after 30 minutes (configurable), task fails with `approval_timeout`

### Step 7: Worker (`core/worker.ts`)
- Polls queue every 2 seconds for pending tasks
- **Spawn safety rules** (non-negotiable):
  - Always use `child_process.spawn()` with `shell: false` and an explicit arg array — NEVER pass prompt as interpolated string in a shell command
  - `cwd` must be validated with `fs.realpathSync()` against the configured project path — reject if resolved path doesn't match (prevents symlink escape)
  - Minimal inherited env: only pass `PATH`, `HOME`, `NODE_ENV`, `ANTHROPIC_API_KEY` (if needed). Strip everything else to prevent secret bleed from worker env to Claude Code subprocess.
  - Example:
    ```ts
    spawn('claude', ['--print', '--output-format', 'stream-json', '-p', prompt], {
      cwd: realpathSync(projectPath),
      shell: false,
      env: { PATH: process.env.PATH, HOME: process.env.HOME }
    })
    ```
- **CLI invocation** (fresh):
  ```
  claude --print --output-format stream-json -p "<prompt>"
  ```
  With `cwd` set to realpath-validated project path
- **CLI invocation** (continue):
  ```
  claude --print --output-format stream-json --resume <session_id> -p "<prompt>"
  ```
- **Permission handling**: by default runs WITHOUT `--dangerously-skip-permissions`. Claude Code will exit on permission denials → triggers terminate-and-replay approval flow (Step 6).
  - If project has `skipPermissions: true`, adds `--dangerously-skip-permissions` flag instead.
- **Stream parsing**: reads JSONL from stdout in real-time:
  - Track `assistant` messages for final result text
  - Track `tool_use` / `tool_result` for file changes and actions taken
  - Track token usage from response metadata
  - Detect permission-denied events for approval routing
- **Schema-unknown fallback mode**: Claude Code's `stream-json` output format may change between CLI versions. The worker must NOT hard-depend on specific field names/nesting:
  - Parser wraps every line parse in try/catch — malformed lines are collected as raw text, not fatal. Failed-parse lines also written to `data/debug/{taskId}.log` for post-mortem debugging (e.g., ANSI escape codes, progress indicators, non-JSON heartbeats)
  - If expected fields (`type`, `message`, `tool_use`) are missing, fall back to treating entire stdout as plain text result
  - Session ID extraction: try known fields first (`session_id`, `conversation_id`), if missing, log warning and disable `/continue` for that task (don't crash)
  - Token counting: if usage metadata is absent, estimate from output byte length (1 token ≈ 4 chars) and log that estimate was used
  - On CLI version mismatch (unrecognized schema), log a `schema_drift` warning to audit with the raw first line for debugging, but still complete the task with whatever text was captured
  - This ensures RemoteWiz degrades gracefully on Claude Code updates instead of breaking entirely
- **Timeout**: kills process after configured timeout, updates task as failed
- **Silence timeout**: if stdout has no new data for 90 seconds (configurable via `SILENCE_TIMEOUT_MS`, default 90000), assume process is hung in an interactive prompt or waiting for stdin. SIGTERM it and mark as `failed` with error `silence_timeout`. This catches the case where Claude Code enters an interactive state that isn't a formal permission request. Silence timer resets on every stdout data event.
- **Token budget enforcement**: if cumulative `tokens_used` exceeds task budget, sends SIGTERM, logs reason
- **Zombie process cleanup**: PIDs are persisted in DB (tasks table has `worker_pid INTEGER` + `worker_pid_start INTEGER` columns), NOT in-memory maps that die on restart. Flow:
  - When worker spawns a Claude Code process, immediately write `worker_pid` AND `worker_pid_start` (process start timestamp) to the task row
  - **PID reuse protection** (critical): before sending any signal to a stored PID, verify the process identity:
    1. Check PID exists: `process.kill(pid, 0)`
    2. Check process command matches `claude` or `node`: run `ps -p {pid} -o comm=` and verify
    3. Check process start time is close to stored `worker_pid_start`: run `ps -p {pid} -o lstart=` and compare (allow 5s drift)
    4. Only kill if ALL THREE checks pass. If any fail, the PID was reused by another process — just mark task as `failed` without killing.
  - On each poll cycle, query for tasks with status `running` whose PID is no longer the current worker's child
  - **On startup recovery**: query all tasks with status `running` — these are orphans from a previous worker crash. For each, run the 3-step identity check → SIGKILL only if confirmed ours, then mark as `failed` with error `worker_crashed_recovery`. Log `zombie_killed` or `zombie_pid_reused` to audit.
  - On timeout/budget kill: SIGTERM → wait 5s → SIGKILL if still alive, using identity-verified PID
  - This survives worker restarts, container reboots, SIGKILL, AND PID reuse
- **CLI version detection**: at startup, run `claude --version` and store the result. On each subsequent startup, compare with stored version. If changed, log `[WARNING] Claude Code CLI updated from X to Y — stream-json schema may have changed` and write `cli_version_changed` to audit. Stored in SQLite `meta` table (key-value).
- **Concurrency**: runs up to `MAX_CONCURRENT_TASKS` in parallel (one per project)
- **Error classification**:
  - `timeout` — task took too long
  - `silence_timeout` — no stdout output for 90s, process likely hung
  - `budget_exceeded` — token budget hit
  - `approval_denied` — user rejected sensitive action
  - `approval_timeout` — user didn't respond to approval in time
  - `cli_error` — Claude Code process crashed or returned non-zero
  - `parse_error` — couldn't parse Claude Code output
- On completion: logs to audit, passes output to summarizer, calls adapter reply callback

### Step 8: Haiku summarizer (`core/summarizer.ts`)
- Uses `@anthropic-ai/sdk` to call `claude-haiku-4-5-20251001`
- **Structured output prompt**:
  ```
  Summarize this Claude Code output for someone reading on their phone.
  Use exactly this format:

  **Status**: success | partial | failed
  **Changes**: bullet list of files modified/created/deleted
  **Verified**: what was tested or checked (build, lint, tests)
  **Issues**: any errors, warnings, or skipped items
  **Next**: suggested follow-up actions if any
  **Tokens**: X / Y budget used

  Keep total response under 300 words.
  ```
- Input: raw Claude Code output (result text + tool use summaries extracted by worker)
- Output: structured summary string
- Fallback: if Haiku call fails, extract last assistant message from Claude Code output, truncate to 2000 chars
- Cost: ~$0.001 per call
- **Rate limiting**: simple token bucket — max 10 summarizer calls per minute. If rate limit hit, fall back to raw output truncation for that task. Prevents API key lockout from burst task completions.
- Configurable: can be disabled in config (`SUMMARIZER_ENABLED=false` → pass through raw output, truncated)

### Step 9: Discord adapter (`adapters/discord.ts`)
- Bot setup with `discord.js` Client, GatewayIntentBits for guilds, messages, message content
- **Thread model**:
  - Designated channel(s) configured in .env (e.g., `#remotewiz`)
  - User creates a thread → thread name should match a project alias for auto-binding
  - OR user sends `/bind <alias>` to bind thread to project
  - Thread-to-project binding stored in `thread_bindings` table
- **Message handling**:
  - On message in a bound thread → enqueue task as fresh session
  - Show typing indicator while task is running
  - Reply with structured summary when done
  - If result > 2000 chars (Discord limit), split into multiple messages or upload as `.md` file attachment
- **Slash commands** (all registered as proper Discord Application Commands — no text prefix parsing):
  - `/projects` — list all configured projects with paths and descriptions
  - `/bind <alias>` — bind current thread to a project
  - `/continue <message>` — resume last session in this thread with a new prompt. Registered as a slash command with a required `message` string parameter to avoid ambiguity with regular messages.
  - `/status` — show current queue (running/pending tasks across all projects)
  - `/cancel` — cancel running task in current thread
  - `/audit [project] [limit]` — show recent audit entries
  - `/budget [project]` — show token usage for project today
- **Approval UX**:
  - When approval is needed, bot sends an embed with action description + two buttons: Approve / Deny
  - Only whitelisted users can click approve/deny
  - On button click: immediately `deferUpdate()`, then show "Resuming..." or "Cancelling..." disabled state on the button (prevents double-tap while worker relaunches CLI)
  - Embed updates to show final resolution status once new CLI run completes or abort confirms
- **Discord interaction timeout handling** (critical):
  - Discord invalidates interaction tokens after **3 seconds** if not acknowledged
  - All slash commands must call `interaction.deferReply()` immediately before doing any work
  - All button clicks (approve/deny) must call `interaction.deferUpdate()` immediately
  - After work completes, use `interaction.editReply()` or `message.edit()` to update with results
  - Prefer editing the deferred reply, but if task takes longer than 15 minutes (interaction token expiry), catch the `Unknown Interaction` error from `editReply()` and fall back to `channel.send()` as a new message in the thread. This handles extreme-duration tasks gracefully.
- **Security**:
  - Only respond to whitelisted user IDs (configured in .env as `DISCORD_ALLOWED_USERS`)
  - Only operate in designated guild + channels
  - Ignore all messages from other users (don't even acknowledge)
- **Status updates**:
  - React with clock emoji when task queued
  - React with gear emoji when task starts running
  - React with checkmark when done, X on failure, warning on needs_approval
  - Edit status message with result

### Step 10: Web adapter (`adapters/web.ts`)
- Express server on configurable port (default 3456), **bound to `WEB_BIND_HOST` (default `127.0.0.1`)** — loopback-only by default for security. Set to `0.0.0.0` explicitly to expose publicly (must use reverse proxy with HTTPS in that case).
- Bearer token auth via `Authorization` header (from .env `WEB_AUTH_TOKEN`)
- **REST endpoints**:
  - `GET /api/projects` — list projects
  - `GET /api/tasks?project=x` — get task history for a project
  - `GET /api/audit?project=x&limit=50` — get audit entries
  - `POST /api/tasks` — create a task `{ project, prompt, continue? }`
  - `POST /api/approvals/:id` — approve or deny `{ action: 'approve' | 'deny' }`
  - `POST /api/upload` — multipart file upload with strict security:
    - Max 10MB per file
    - Allowed MIME types validated by content sniffing (not just extension): `image/*`, `text/plain`, `text/markdown`, `application/json`, `text/csv`
    - **Server-side random filenames**: original filename is discarded. Saved as `{uuid4}.{detected_extension}` (e.g., `a1b2c3d4.png`). Prevents path traversal via `../../etc/passwd` filenames.
    - **Directory confinement**: uploads saved to `data/uploads/{project_alias}/{uuid}/` — path validated with `realpathSync()` after write to confirm it didn't escape the uploads dir
    - **API returns reference only**: `{ id: "uuid", originalName: "screenshot.png" }` — never exposes the internal server filesystem path to the client. The actual path (`data/uploads/{project}/{uuid}/{uuid}.{ext}`) is resolved internally by the worker when constructing the Claude Code prompt.
    - **Auto-cleanup**: uploads dir for a task is deleted after task completes (success or failure). Startup also cleans orphaned upload dirs older than 1h.
  - `GET /health` — health check (no auth required)
- **WebSocket** for real-time updates:
  - Auth: first message must be `{ type: 'auth', token: '...' }`
  - Client sends: `{ type: 'message', project: 'alias', prompt: 'text', continue?: true }`
  - Server sends: `{ type: 'queued', taskId }`, `{ type: 'running', taskId }`, `{ type: 'approval_needed', taskId, approvalId, description }`, `{ type: 'result', taskId, summary }`, `{ type: 'error', taskId, error }`
- Serves static `web/index.html`

### Step 11: Web UI (`web/index.html`)
- Single HTML file, no build step, vanilla JS + CSS
- **Layout**: mobile-first responsive
  - Top bar: project selector dropdown + status indicator
  - Main area: chat-like message list per selected project
  - Bottom: input box with send button + "Continue" toggle + file attach button
- **Features**:
  - Project list fetched from API on load
  - Messages show: user prompt → structured bot response
  - Approval requests render as cards with Approve/Deny buttons
  - Real-time status via WebSocket (queued → running → done)
  - Task history loaded on project switch
  - **File upload**: attach images/files from phone (screenshots, reference docs). Files uploaded via `POST /api/upload` → returns reference ID (no server path exposed) → when task runs, worker resolves reference to actual path and injects into Claude Code prompt. Auto-cleanup after task completes + orphan cleanup on startup. Max 10MB, content-sniffed MIME validation.
- **Auth**: prompt for token on first load, store in localStorage
- **Theme**: dark theme default (easy on eyes for bed/travel use)
- **No framework**: vanilla HTML/CSS/JS, under 500 lines

### Step 12: Entry point (`index.ts`)
- Load and validate config
- Initialize SQLite database (auto-create all tables + triggers)
- **Startup recovery**:
  - Recover orphan tasks: query tasks with status `running` from DB → check PIDs → SIGKILL zombies → mark as `failed`
  - Clean orphan uploads: delete `data/uploads/` dirs older than 1 hour (leftover from crashed tasks)
  - CLI version check: run `claude --version`, compare with stored value, warn if changed
- Start worker (queue poller)
- Start Discord adapter (if `DISCORD_TOKEN` configured)
- Start Web adapter (if `WEB_PORT` configured)
- Log startup summary: loaded projects, active adapters, queue status, any warnings (skipPermissions projects, CLI version changes, recovered orphans)
- Graceful shutdown: SIGINT/SIGTERM → stop accepting tasks, wait for running tasks (up to 30s), disconnect Discord, close Express, close DB

---

## Config Format

### `.env`
```env
# Discord
DISCORD_TOKEN=your_discord_bot_token
DISCORD_GUILD_ID=your_server_id
DISCORD_CHANNEL_IDS=channel1_id,channel2_id
DISCORD_ALLOWED_USERS=your_user_id

# Anthropic (for Haiku summarizer)
ANTHROPIC_API_KEY=your_api_key

# Web UI
WEB_PORT=3456
WEB_BIND_HOST=127.0.0.1
WEB_AUTH_TOKEN=a_random_secret_string

# Worker
MAX_CONCURRENT_TASKS=3
MAX_QUEUED_PER_PROJECT=5
DEFAULT_TOKEN_BUDGET=100000
DEFAULT_TIMEOUT_MS=600000
SILENCE_TIMEOUT_MS=90000
APPROVAL_TIMEOUT_MS=1800000
REPLAY_TIMEOUT_MS=120000

# Summarizer
SUMMARIZER_ENABLED=true
```

### `config.json`
```json
{
  "projects": {
    "raiansar": {
      "path": "/Users/rai/Desktop/Work/Projects/Vibe/raiansar-nextjs",
      "description": "Next.js portfolio site",
      "tokenBudget": 150000,
      "timeout": 600000,
      "skipPermissions": false
    },
    "acefina": {
      "path": "/path/to/Acefina",
      "description": "Acefina project",
      "skipPermissions": true,
      "skipPermissionsReason": "sandbox project, no production data, safe to auto-approve"
    }
  }
}
```

---

## User Flow Examples

### Discord: Fresh task
1. User creates thread "raiansar" in #remotewiz channel
2. Types: "update the hero section colors to blue gradient"
3. Bot reacts with clock (queued), then gear (running), shows typing
4. Worker spawns `claude --print --output-format stream-json -p "update the hero section colors to blue gradient"` in project dir
5. Claude Code edits files, runs checks
6. Haiku summarizes with structured format:
   > **Status**: success
   > **Changes**: Modified `components/Hero.tsx` — gradient from purple-pink to blue-cyan
   > **Verified**: Build passes, no lint errors
   > **Issues**: None
   > **Next**: Check mobile viewport for gradient rendering
7. Bot replies with summary, reacts with checkmark
8. Audit log records: task_created, task_started, task_completed with details

### Discord: Approval flow (terminate-and-replay)
1. User types: "clean up old migration files" in bound thread
2. Claude Code runs, identifies 5 files to delete → hits permission denial → **process exits**
3. Worker saves checkpoint (what Claude accomplished so far + the blocked action)
4. Bot sends embed: "Claude wants to delete 5 files: `migrations/001.sql`, `migrations/002.sql`... [Approve] [Deny]"
5. User clicks Approve → button immediately shows "Resuming..."
6. Worker spawns a **new** Claude Code process (scoped replay, 2min timeout, `--dangerously-skip-permissions`) with context: "Approved action: delete 5 migration files. Previous progress: {checkpoint}. Continue original task."
7. Claude Code completes deletion in the new process
8. Summary sent back with explicit replay callout: "During approved replay: deleted 5 files. No additional sensitive actions."
9. Embed updated to "Approved by @user"
10. Audit log records: approval_requested, approval_granted, task_replayed (with all replay_action entries), task_completed

### Discord: Continue session
1. In same thread, user types: `/continue actually make it darker blue`
2. Worker spawns `claude --print --resume <session_id> -p "actually make it darker blue"`
3. Claude Code has context from previous run, makes targeted change
4. Structured summary sent back

### Discord: Token budget exceeded
1. User types: "refactor the entire authentication system"
2. Worker starts, Claude Code begins working
3. At 100k tokens, worker sends SIGTERM
4. Bot replies: "Task stopped — token budget exceeded (100k). Partial work may have been saved. Use `/continue` to resume from where it left off, or increase budget in config."

### Web UI: From phone
1. Open `https://your-server:3456` on phone
2. Enter auth token
3. Select "raiansar" from dropdown
4. Type: "fix the mobile nav menu"
5. See real-time status updates → structured result
6. If approval needed, approve directly from phone

---

## Security Model

### Identity & Access
- **Discord**: strict allowlist of user IDs. Messages from unknown users are silently ignored.
- **Web UI**: bearer token auth on every request + WebSocket handshake.
- **No multi-user roles for MVP** — this is a personal tool. Single owner.

### Execution Safety
- **Default: permissions enforced** — Claude Code runs without `--dangerously-skip-permissions`. Sensitive actions trigger approval flow.
- **Opt-in skip**: per-project `skipPermissions: true` requires a mandatory `skipPermissionsReason` string. Zod rejects config without it. Startup logs a `[WARNING]` for each skip-enabled project. All auto-approvals logged with reason in audit.
- **Workspace allowlist**: only configured project paths can be targeted. No arbitrary path execution.
- **Timeout + budget**: every task has hard limits. Runaway processes are killed.
- **Queue backpressure**: max pending tasks per project prevents message flooding from filling disk/memory.

### Secrets & Redaction
- API keys only in `.env` (never in config.json, never in Discord messages)
- **`redactSecrets()` utility** applied at output boundaries (NOT on every stream chunk — performance matters for large outputs like `git log` or `npm list`). Runs on: final saved result text, summarizer input, parse_error raw attachments, Discord messages, web API responses, audit log details. Regex patterns: `sk-[a-zA-Z0-9]{20,}`, `ghp_[a-zA-Z0-9]+`, `xoxb-[a-zA-Z0-9-]+`, `Bearer [a-zA-Z0-9._-]+`, `ANTHROPIC_API_KEY=.*`, `password["\s:=]+\S+`, and generic high-entropy strings (base64 blocks > 40 chars). Replaced with `[REDACTED]`.
- Audit log stores prompt snippets (first 200 chars), not full prompts with potential secrets
- **parse_error path**: raw output is redacted BEFORE attaching as file — no secret leakage even when structured parsing fails

### Audit Trail
- Every action logged with timestamp, actor, task ID, project
- **DB-enforced append-only** — SQLite BEFORE UPDATE and BEFORE DELETE triggers RAISE(ABORT) on audit_log. Not just policy, the database physically rejects mutations.
- Queryable via `/audit` command in Discord or `/api/audit` in web
- Retention: keep forever (SQLite is cheap), or configure max rows

---

## Failure Handling

| Error Type | Worker Action | User Message |
|---|---|---|
| `timeout` | SIGTERM → SIGKILL after 5s | "Task timed out after {X}min. Partial work may be saved. `/continue` to resume." |
| `silence_timeout` | SIGTERM | "Process went silent for 90s (likely hung). Killed. Use `/continue` to retry." |
| `budget_exceeded` | SIGTERM | "Token budget exceeded ({X}k). Use `/continue` to resume or increase budget." |
| `approval_denied` | Abort task | "Task cancelled — you denied the action." |
| `approval_timeout` | Abort task | "Task cancelled — approval request expired after 30min." |
| `cli_error` | Log stderr | "Claude Code crashed: {first 500 chars of stderr}" |
| `parse_error` | Redact raw output, then return | "Couldn't parse output. Redacted result attached as file." |
| `queue_full` | Reject | "Queue full for {project}. Wait for current task to finish." |

All failures logged to audit with full error context.

---

## Verification Plan

### Automated Tests
1. **Config validation** — invalid paths, missing keys, Zod rejects bad config
2. **Queue operations** — enqueue, dequeue, per-project locking, concurrent projects
3. **Worker with mock CLI** — stub `child_process.spawn`, verify correct flags, timeout handling, budget enforcement
4. **Approval flow** — mock worker terminates on permission denial, saves checkpoint, creates approval record; on approve spawns scoped replay; on deny marks failed
5. **Summarizer** — mock Anthropic SDK, verify structured prompt, fallback on failure
6. **Audit log** — append-only enforcement, query by task/project

### Integration Tests
7. **End-to-end** — enqueue → worker → Claude Code (mock) → summarize → result callback
8. **Approval E2E** — enqueue → worker detects permission denial → process exits → checkpoint saved → approval created → approved → scoped replay spawned → completed

### Manual Tests
9. **Discord** — create thread, bind project, send message, verify structured reply, test approval buttons
10. **Web UI** — open on phone, auth, select project, send message, verify real-time updates, test approval cards

### Targeted Tests
11. **Redaction stress test** — create a file with dummy secrets (`sk-ant-api03-fake...`, `ghp_faketoken123`, `Bearer eyJhbGci...`), ask Claude to cat it, verify Discord/Web output and audit log all show `[REDACTED]`
12. **Zombie process test** — start a task, manually kill the worker mid-run (SIGKILL), restart worker, verify it detects orphan PID and force-kills it
13. **Discord 3s timeout test** — trigger a slash command and approval button, verify `deferReply()`/`deferUpdate()` fires before any DB/worker calls
14. **Session resume degradation test** — delete `.claude` session data, try `/continue`, verify it falls back to fresh session with context summary and notifies user

### Quality Gates (before daily use)
- No task can execute outside configured project paths
- Approval-required actions cannot proceed without explicit approval
- Token budget is enforced — verified with a prompt that generates verbose output
- No cross-thread context leakage — two threads for different projects never share state
- Audit log captures every state transition
- Redaction passes on all output paths (summarizer, raw fallback, audit, Discord, Web API)
- No zombie Claude Code processes survive after task failure/timeout

---

## Dependencies

```json
{
  "dependencies": {
    "discord.js": "^14.16.0",
    "better-sqlite3": "^11.0.0",
    "@anthropic-ai/sdk": "^0.39.0",
    "express": "^4.21.0",
    "ws": "^8.18.0",
    "dotenv": "^16.4.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/express": "^4.17.0",
    "@types/ws": "^8.5.0"
  }
}
```

**7 runtime deps, 6 dev deps.** Still lean. No PostgreSQL, no Redis, no microservices.

---

## Deployment

### Option A: Bare metal (Mac/Linux — simplest)
```bash
cd remote-wiz-claude
cp .env.example .env  # fill in tokens
vim config.json       # add your projects
npm install && npm run build
npm start             # or: node dist/index.js
```

For auto-restart on crash / boot:

**macOS (launchd)**:
```xml
<!-- ~/Library/LaunchAgents/com.remotewiz.plist -->
<plist version="1.0">
<dict>
  <key>Label</key><string>com.remotewiz</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/remote-wiz-claude/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/remote-wiz-claude</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/remotewiz.log</string>
  <key>StandardErrorPath</key><string>/tmp/remotewiz.err</string>
</dict>
</plist>
```

**Linux (systemd)**:
```ini
# /etc/systemd/system/remotewiz.service
[Unit]
Description=RemoteWiz - Remote Claude Code Controller
After=network.target

[Service]
Type=simple
User=rai
WorkingDirectory=/path/to/remote-wiz-claude
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### Option B: Docker
```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
COPY web/ ./web/
CMD ["node", "dist/index.js"]
```

```yaml
# docker-compose.yml
services:
  remotewiz:
    build: .
    restart: always
    env_file: .env
    volumes:
      - ./data:/app/data          # SQLite persistence
      - ./config.json:/app/config.json
      - ~/.claude:/root/.claude   # Claude CLI session persistence (critical for --resume)
    ports:
      - "3456:3456"
```

**Critical Docker notes**:
- The `~/.claude` volume mount is mandatory if you want `/continue` (session resume) to work. Without it, session IDs stored in SQLite will reference conversations that don't exist in the container's ephemeral filesystem. The best-effort fallback (Step 5) handles this gracefully, but mounting the volume gives the full experience.
- If project directories have strict permissions, add `user: "${UID}:${GID}"` to the compose file or use `--user $(id -u):$(id -g)` with `docker run` to match host file ownership. Otherwise Claude Code may fail to read/write project files.

### Network Access
- **Local only**: bind Express to `127.0.0.1` + use Tailscale/WireGuard for remote access (recommended)
- **Public**: reverse proxy (Caddy/nginx) with HTTPS + `WEB_AUTH_TOKEN` enforcement
- Discord bot needs outbound HTTPS only (no inbound ports required)
