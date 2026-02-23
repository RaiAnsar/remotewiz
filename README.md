# RemoteWiz

RemoteWiz lets you run Claude Code remotely from Discord threads or a lightweight web UI, with per-project routing, approval gates, queueing, and audit logs.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/raiansar/remotewiz/main/install.sh | bash
```

### Prerequisites

- **Node.js 22+** — [nodejs.org](https://nodejs.org)
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`
- **git**

### Quick start

```bash
# 1. Install
curl -fsSL https://raw.githubusercontent.com/raiansar/remotewiz/main/install.sh | bash

# 2. Add your keys
edit ~/.remote-wiz/.env          # DISCORD_TOKEN, ANTHROPIC_API_KEY

# 3. Configure projects
edit ~/.remote-wiz/config.json   # map aliases to repo paths

# 4. Run
remotewiz
```

The web UI is available at `http://127.0.0.1:3456` (use the auto-generated `WEB_AUTH_TOKEN` from `.env`).

### Upgrade

Re-run the same curl command. Config files (`.env`, `config.json`) are preserved.

### Custom install location

```bash
REMOTEWIZ_HOME=/opt/remotewiz curl -fsSL https://raw.githubusercontent.com/raiansar/remotewiz/main/install.sh | bash
```

## What it does

- Maps a thread/project to a configured local repo path
- Queues tasks with per-project locking and queue caps
- Runs `claude --print --output-format stream-json` safely (`shell: false`)
- Supports `/continue` session attempts with automatic fallback if resume fails
- Uses approval gates for sensitive actions (terminate-and-replay flow)
- Persists queue, sessions, approvals, bindings, and audit log in SQLite
- Offers a secure web API + WebSocket UI and a Discord bot adapter
- Supports secure multipart file upload references for prompts

## Manual setup (without installer)

1. Configure environment:

```bash
cp .env.example .env
```

2. Edit `.env`:
- Set `WEB_AUTH_TOKEN`
- Optional: set Discord and Anthropic keys

3. Edit `config.json` to map project aliases to real paths.

4. Install and run:

```bash
npm install
npm run build
npm start
```

5. Open web UI:
- `http://127.0.0.1:3456`
- Enter `WEB_AUTH_TOKEN`

## Commands

Discord slash commands:
- `/projects`
- `/bind <alias>`
- `/continue <message>`
- `/status`
- `/cancel`
- `/audit [project] [limit]`
- `/budget [project]`

Web API:
- `GET /health`
- `GET /api/projects`
- `GET /api/tasks?project=...` or `?threadId=...`
- `GET /api/audit?project=...&limit=...`
- `POST /api/tasks`
- `POST /api/approvals/:id`
- `POST /api/upload` (multipart: `project`, `file`)

## Test

```bash
npm test
```

## Security defaults

- Web server binds to `127.0.0.1` by default
- Bearer auth required for all web API routes except `/health`
- Uploads are content-validated and path-confined
- Secrets are redacted in audit and summaries
- Audit table is DB-enforced append-only
