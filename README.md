# RemoteWiz

Run [Claude Code](https://docs.anthropic.com/en/docs/claude-code) remotely from **Discord threads** or a **web UI** — with per-project routing, task queues, approval gates, token budgets, session continuity, and an append-only audit log.

```
You (Discord/Web) ──► RemoteWiz ──► Claude CLI ──► Your Codebase
                         │
                    SQLite DB
               (queue, sessions, audit)
```

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/raiansar/remotewiz/main/install.sh | bash
```

The installer checks prerequisites, clones to `~/.remote-wiz`, builds, auto-generates a `WEB_AUTH_TOKEN`, and links the `remotewiz` command.

### Prerequisites

| Dependency | Version | Install |
|-----------|---------|---------|
| Node.js | 22+ | [nodejs.org](https://nodejs.org) |
| Claude Code CLI | latest | `npm install -g @anthropic-ai/claude-code` |
| git | any | Pre-installed on most systems |

### Quick start

```bash
# 1. Install
curl -fsSL https://raw.githubusercontent.com/raiansar/remotewiz/main/install.sh | bash

# 2. Add your keys
nano ~/.remote-wiz/.env

# 3. Add your projects
nano ~/.remote-wiz/config.json

# 4. Run
remotewiz
```

Open `http://127.0.0.1:3456` and enter the auto-generated `WEB_AUTH_TOKEN` from `.env`.

### Upgrade

Re-run the same curl command. Your `.env` and `config.json` are preserved.

### Custom install location

```bash
REMOTEWIZ_HOME=/opt/remotewiz curl -fsSL https://raw.githubusercontent.com/raiansar/remotewiz/main/install.sh | bash
```

---

## Configuration

### `config.json` — Project mapping

```json
{
  "projects": {
    "my-api": {
      "path": "/home/user/projects/my-api",
      "description": "Backend REST API",
      "tokenBudget": 150000,
      "timeout": 600000,
      "skipPermissions": false
    },
    "my-frontend": {
      "path": "/home/user/projects/my-frontend",
      "description": "React frontend",
      "tokenBudget": 100000
    }
  }
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `path` | Yes | — | Absolute path to the project repo |
| `description` | No | — | Human-readable label |
| `tokenBudget` | No | `100000` | Max tokens per task (kills process if exceeded) |
| `timeout` | No | `600000` | Hard timeout in ms (10 min default) |
| `skipPermissions` | No | `false` | Auto-approve all permission requests |
| `skipPermissionsReason` | If skip=true | — | Required justification when skipping |

### `.env` — Environment variables

<details>
<summary>Full variable reference</summary>

**Discord adapter**

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_TOKEN` | — | Discord bot token |
| `DISCORD_GUILD_ID` | — | Server ID for slash command registration |
| `DISCORD_CHANNEL_IDS` | *(all)* | Comma-separated allowed channel IDs |
| `DISCORD_ALLOWED_USERS` | *(all)* | Comma-separated allowed user IDs |

**Web adapter**

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_PORT` | `3456` | HTTP/WebSocket port |
| `WEB_BIND_HOST` | `127.0.0.1` | Bind address (localhost only by default) |
| `WEB_AUTH_TOKEN` | — | Bearer token for API/WebSocket auth |

**Anthropic**

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | API key for the Haiku summarizer |

**Worker tuning**

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONCURRENT_TASKS` | `3` | Global concurrent Claude processes |
| `MAX_QUEUED_PER_PROJECT` | `5` | Max pending tasks per project |
| `DEFAULT_TOKEN_BUDGET` | `100000` | Fallback token budget |
| `DEFAULT_TIMEOUT_MS` | `600000` | Hard timeout (10 min) |
| `SILENCE_TIMEOUT_MS` | `90000` | Kill if no output for 90s |
| `APPROVAL_TIMEOUT_MS` | `1800000` | Auto-deny if unresolved after 30 min |
| `REPLAY_TIMEOUT_MS` | `120000` | Timeout for approved replays |

**Summarizer**

| Variable | Default | Description |
|----------|---------|-------------|
| `SUMMARIZER_ENABLED` | `true` | Use Haiku to summarize task output |

</details>

---

## Discord Commands

| Command | Description |
|---------|-------------|
| `/projects` | List all configured projects with paths and descriptions |
| `/bind <alias>` | Bind the current thread to a project — all messages become tasks |
| `/continue <message>` | Send a task that resumes the previous Claude session in this thread |
| `/status` | Show running and pending task counts per project |
| `/cancel` | Cancel the active task in the current thread |
| `/audit [project] [limit]` | View recent audit log entries (default: last 20) |
| `/budget [project]` | Show token usage in the last 24 hours |

**Thread workflow:**
1. Create a thread in an allowed channel
2. `/bind my-api` — locks this thread to the `my-api` project
3. Type a message — it becomes a queued task
4. Watch real-time streaming output in the thread
5. `/continue fix the failing test` — resumes the previous session

---

## Web API

All routes except `/health` require `Authorization: Bearer <WEB_AUTH_TOKEN>`.

### Endpoints

```
GET  /health                         →  { status: "ok" }
GET  /api/projects                   →  { projects: [{ alias, path, description }] }
GET  /api/tasks?project=my-api       →  { tasks: [{ id, status, createdAt, result, error }] }
GET  /api/tasks?threadId=abc-123     →  (same, filtered by thread)
GET  /api/audit?project=my-api&limit=50  →  { entries: [AuditEntry] }

POST /api/tasks
  Body: { project, prompt, threadId?, actorId?, continue? }
  →  { ok: true, taskId: "..." }

POST /api/approvals/:id
  Body: { action: "approve" | "deny", actorId? }
  →  { ok: true }

POST /api/upload
  Multipart: project (field) + file (max 10 MB)
  →  { id: "...", originalName: "screenshot.png" }
```

### WebSocket

Connect to `ws://127.0.0.1:3456` and authenticate:

```json
→ { "type": "auth", "token": "your-token" }
← { "type": "authed" }
```

**Send a task:**
```json
→ { "type": "message", "project": "my-api", "prompt": "add input validation", "threadId": "t1" }
← { "type": "queued", "taskId": "abc-123" }
← { "type": "task_update", "taskId": "abc-123", "status": "running", ... }
← { "type": "task_update", "taskId": "abc-123", "status": "done", "summary": "..." }
```

**Handle approvals:**
```json
← { "type": "approval_needed", "approvalId": "apv-1", "description": "rm -rf dist/" }
→ { "type": "approval", "approvalId": "apv-1", "action": "approve" }
← { "type": "approval_ack", "approvalId": "apv-1" }
```

---

## How It Works

### Task lifecycle

```
prompt received
    │
    ▼
  queued ──► running ──► done
                │          │
                ▼          ▼
         needs_approval  failed
                │
          approve/deny
                │
            ▼       ▼
          replay   failed
```

1. A prompt arrives via Discord or Web API
2. Task enters the per-project queue (capped at `MAX_QUEUED_PER_PROJECT`)
3. Worker polls every 2s, picks next task if project has no running task
4. Spawns `claude --print --output-format stream-json` with `shell: false`
5. Streams output back in real-time to the originating thread/WebSocket
6. If a permission request is detected → pauses, asks for approval
7. On completion, Haiku generates a structured summary
8. Session ID saved for `/continue` resumption

### Approval gates

When Claude requests a potentially destructive action, RemoteWiz pauses and asks:

- **Auto-classified actions:** `file_delete`, `git_push`, `git_force`, `destructive_cmd`, `install_package`, `external_request`
- **Approve** → replays the task with `--force-skip-permissions`
- **Deny** → task marked failed
- **Timeout** (30 min) → auto-denied

Set `skipPermissions: true` in config to auto-approve for a project (requires `skipPermissionsReason`).

### Session continuity

- Each task's Claude session ID is stored per-thread
- `/continue` resumes the previous session with `--resume <sessionId>`
- If resume fails, falls back to a fresh session with context from the last 3 tasks
- Sessions auto-expire after 24 hours

### Token budget enforcement

- Real-time estimation: `rawOutputBytes / 4`
- Process killed via `SIGTERM` if budget exceeded mid-task
- `/budget` command shows 24-hour aggregate per project

### Summarizer

When `SUMMARIZER_ENABLED=true` and `ANTHROPIC_API_KEY` is set, completed tasks get a Haiku-generated summary:

```
Status: success
Changes: src/api/validate.ts (new), src/api/routes.ts (modified)
Verified: tests passing, build clean
Issues: none
Next: add integration tests for edge cases
Tokens: 12,450 / 100,000 budget used
```

Falls back to a raw output excerpt if the API is unavailable.

### File uploads

Upload images or text files to reference in prompts:

```bash
curl -X POST http://127.0.0.1:3456/api/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "project=my-api" \
  -F "file=@screenshot.png"
```

- Max size: 10 MB
- Allowed types: images, plain text, markdown, JSON, CSV
- Content-validated (MIME sniffing, binary detection, path traversal checks)
- Auto-cleaned after 1 hour

---

## Security

| Layer | Protection |
|-------|-----------|
| Network | Binds to `127.0.0.1` by default — not exposed to network |
| Auth | Bearer token on all API/WebSocket routes |
| Discord | User allowlist + channel allowlist |
| Process | `shell: false` — no shell injection possible |
| Uploads | MIME sniffing, binary detection, symlink/path escape prevention |
| Secrets | Auto-redacted in audit logs (API keys, tokens, passwords) |
| Audit | DB-enforced append-only (triggers block UPDATE/DELETE) |
| Resources | Token budgets, silence timeouts, queue caps, concurrency limits |
| PID safety | Timestamp-verified kill to prevent hitting reused PIDs |

---

## Manual Setup (without installer)

```bash
git clone https://github.com/raiansar/remotewiz.git
cd remotewiz
cp .env.example .env        # edit with your keys
npm install
npm run build
npm start
```

---

## Development

```bash
npm run dev          # watch mode with tsx
npm run build        # compile TypeScript
npm run typecheck    # type-check without emitting
npm test             # build + run tests
```

---

## License

MIT — see [LICENSE](LICENSE).
