# sessions-ai

> A cross-tool platform for collecting, aggregating, and governing LLM sessions.

English | [中文](./README.zh-CN.md)

## Project Structure

- `apps/web/` — Next.js admin web app
- `apps/agent/` — Bun + TypeScript terminal collection agent (rewritten, cross-platform: Win/macOS/Linux)
- `packages/shared/` — Shared types and constants across apps

## Current Phase

Phase 1 focuses on OpenCode message collection and upload only. Future phases will add parsers for GitHub Copilot / Codex / Claude Code.

## Quick Start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start the Web app

```bash
cp apps/web/.env.example apps/web/.env.local   # adjust PostgreSQL settings for local environment
pnpm db:migrate
pnpm dev:web
```

### 3. Start the Agent (Bun >= 1.3 required)

```bash
cp apps/agent/.env.example apps/agent/.env
pnpm dev:agent
```

Production/persistent running:

```bash
# Foreground persistent mode (built-in supervisor auto-restarts crashed agent child process)
pnpm start:agent

# Preview what service definition will be installed on current system (dry run)
pnpm service:print:agent

# Install auto-start + persistent service for current platform
pnpm service:install:agent

# Uninstall service
pnpm service:uninstall:agent
```

Implementation by platform:

- Windows: Task Scheduler + `run-supervisor.cmd`
- macOS: `launchd` LaunchAgent + `KeepAlive`
- Linux: `systemd --user` + `Restart=always`

All three platforms start `apps/agent/scripts/service/supervisor.ts` first, and the supervisor is responsible for exponential-backoff restart when the agent crashes.

> On Linux, if you want it to continue running after logout, also run: `loginctl enable-linger <username>`.

### 4. Run Agent tests

```bash
pnpm test:agent
```
