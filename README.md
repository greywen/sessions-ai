# sessions-ai

> A cross-tool platform for collecting, aggregating, and governing LLM coding-assistant sessions.

English | [中文](./README.zh-CN.md)

## Project structure

- `apps/web/` — Next.js admin web app + ingest API
- `apps/agent/` — Bun + TypeScript local collection agent (published as the `sessions-ai` npm package)
- `packages/shared/` — Shared types and constants across apps

## Supported tool sources

The agent ships with parsers for these LLM coding assistants. Each parser is incremental and resumes from its own watermark.

| Tool | Source | Watermark / cursor |
| --- | --- | --- |
| OpenCode | `opencode.db` (SQLite) | `MAX(message.time_updated)` |
| GitHub Copilot Chat | `chatSessions/*.jsonl` | `MAX(modelState.completedAt)` |
| Codex CLI | `~/.codex/sessions/.../rollout-*.jsonl` | byte offset |
| Cursor | `Cursor/User/.../state.vscdb` (`cursorDiskKV`) | `MAX(bubble.createdAt)` |
| Claude Code | `~/.claude/projects/...jsonl` | `MAX(message.timestamp)` |
| Qwen Code | `~/.qwen/tmp/<hash>/logs.json` | array length |

## Supported platforms

| Component | Windows 10/11 | macOS 12+ | Linux (systemd) |
| --- | :---: | :---: | :---: |
| **Agent** (`sessions-ai` CLI) | ✅ Task Scheduler (hidden, no console) | ✅ launchd LaunchAgent | ✅ `systemd --user` |
| **Web + Postgres** (Docker) | ✅ via Docker Desktop / WSL2 | ✅ via Docker Desktop | ✅ native |

> Database: PostgreSQL 17+ (the bundled docker image is the tested target).

## Quick deployment

Two paths, designed to coexist:

| Component | Path | Why |
| --- | --- | --- |
| **Agent** (per developer machine) | `npm i -g sessions-ai` + autostart | Single-machine background collector |
| **Web + DB** (shared service) | `docker compose up -d` | Multi-user, requires Postgres |

### One-click install (agent)

**Windows** (PowerShell, will self-elevate to Administrator):
```powershell
iwr -useb https://raw.githubusercontent.com/greywen/sessions-ai/main/scripts/install-agent.ps1 -OutFile $env:TEMP\sa.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\sa.ps1 -ServerUrl http://your-host:23712
```

**macOS / Linux**:
```bash
curl -fsSL https://raw.githubusercontent.com/greywen/sessions-ai/main/scripts/install-agent.sh \
  | bash -s -- --server-url http://your-host:23712
```

### One-click install (web + db, Docker Compose)

```bash
# Default — pulls greywen/sessions-ai-web:latest from Docker Hub
curl -fsSL https://raw.githubusercontent.com/greywen/sessions-ai/main/scripts/install-web.sh | bash

# China users — pulls from Aliyun ACR (no VPN needed)
curl -fsSL https://raw.githubusercontent.com/greywen/sessions-ai/main/scripts/install-web.sh \
  | bash -s -- --image-source aliyun
```

The script writes `~/sessions-ai-web/{docker-compose.yml,.env,drizzle/}` with random secrets, runs migrations, and starts the stack on `http://localhost:23712`.

For manual steps, registry choices, and image publishing, see [docs/deployment.md](./docs/deployment.md).

## CLI reference (excerpt)

```bash
sessions-ai run                       # Foreground, single run (debug)
sessions-ai start                     # Foreground supervisor
sessions-ai service install [opts]    # Autostart on Win / macOS / Linux
sessions-ai service uninstall
sessions-ai service print             # Dry-run, preview generated artifacts
sessions-ai config show
sessions-ai config set serverUrl http://your-host:23712
sessions-ai cache clear [--all]
```

Full CLI: [apps/agent/NPM_README.md](./apps/agent/NPM_README.md).

## Development

```bash
pnpm install

# Web
cp apps/web/.env.example apps/web/.env.local
pnpm db:migrate
pnpm dev:web

# Agent (requires Bun >= 1.3)
cp apps/agent/.env.example apps/agent/.env
pnpm dev:agent

# Tests
pnpm test:agent
```

Production / persistent (monorepo mode):

```bash
pnpm start:agent              # Foreground supervisor
pnpm service:print:agent      # Preview artifacts (dry run)
pnpm service:install:agent    # Install OS-level autostart
pnpm service:uninstall:agent
```

## Publishing

- **npm package** (`sessions-ai`):
  ```bash
  cd apps/agent && bun run scripts/build-publish.ts
  cd publish-pkg && npm publish --access public
  ```
- **Docker image** (multi-arch, pushes to Docker Hub + Aliyun ACR):
  ```bash
  DOCKERHUB_USER=<you> ACR_NAMESPACE=<you> ./scripts/release-docker.sh
  ```

See [docs/deployment.md](./docs/deployment.md) for the full deployment + release guide.
