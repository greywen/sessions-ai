# sessions-ai

> 跨工具 LLM 编程助手会话采集、聚合与治理平台。

<p align="center">
  <img src="./.github/assets/logo.png" alt="sessions-ai logo" width="180" />
</p>


[English](./README.md) | 中文

[![npm](https://img.shields.io/npm/v/sessions-ai.svg)](https://www.npmjs.com/package/sessions-ai)
[![Docker Hub](https://img.shields.io/docker/v/graywen/sessions-ai-web?label=docker&sort=semver)](https://hub.docker.com/r/graywen/sessions-ai-web)
[![Release](https://github.com/greywen/sessions-ai/actions/workflows/release.yml/badge.svg)](https://github.com/greywen/sessions-ai/actions/workflows/release.yml)

## 目录结构

- `apps/web/` — Next.js 管理后台 + 上报 API
- `apps/agent/` — Bun + TypeScript 本地采集 Agent（npm 包名 `sessions-ai`）
- `packages/shared/` — 跨端共享类型与常量

## 已支持的工具来源

Agent 内置以下解析器，全部支持增量采集，按各自的水位线断点续传。

| 工具 | 数据源 | 增量键 |
| --- | --- | --- |
| OpenCode | `opencode.db`（SQLite） | `MAX(message.time_updated)` |
| GitHub Copilot Chat | `chatSessions/*.jsonl` | `MAX(modelState.completedAt)` |
| Codex CLI | `~/.codex/sessions/.../rollout-*.jsonl` | byte offset |
| Cursor | `Cursor/User/.../state.vscdb` (`cursorDiskKV`) | `MAX(bubble.createdAt)` |
| Claude Code | `~/.claude/projects/...jsonl` | `MAX(message.timestamp)` |
| Qwen Code | `~/.qwen/tmp/<hash>/logs.json` | array length |

## 已支持的平台

| 组件 | Windows 10/11 | macOS 12+ | Linux (systemd) |
| --- | :---: | :---: | :---: |
| **Agent**（`sessions-ai` CLI） | ✅ Task Scheduler（隐藏窗口） | ✅ launchd LaunchAgent | ✅ `systemd --user` |
| **Web + Postgres**（Docker） | ✅ Docker Desktop / WSL2 | ✅ Docker Desktop | ✅ 原生 |

> 数据库：PostgreSQL 17+（以仓库内 docker 镜像为准）。

## 快速部署

两条独立通道，互不干扰：

| 组件 | 通道 | 理由 |
| --- | --- | --- |
| **Agent**（每台开发机） | `npm i -g sessions-ai` + 系统级 autostart | 单机后台进程 |
| **Web + DB**（共享服务） | `docker compose up -d` | 多用户共享，强依赖 Postgres |

### 一键安装（Agent）

**Windows**（PowerShell，自动提权到管理员）：
```powershell
iwr -useb https://raw.githubusercontent.com/greywen/sessions-ai/main/scripts/install-agent.ps1 -OutFile $env:TEMP\sa.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\sa.ps1 -ServerUrl http://localhost:23712
```

**macOS / Linux**：
```bash
curl -fsSL https://raw.githubusercontent.com/greywen/sessions-ai/main/scripts/install-agent.sh \
  | bash -s -- --server-url http://localhost:23712
```

### 一键部署（Web + DB，Docker Compose）

```bash
# 默认拉取 Docker Hub 镜像
curl -fsSL https://raw.githubusercontent.com/greywen/sessions-ai/main/scripts/install-web.sh | bash
```

脚本会在 `~/sessions-ai-web/` 下生成 `docker-compose.yml`、随机密钥的 `.env` 和 `drizzle/` 迁移脚本，启动后访问 `http://localhost:23712`。

完整部署指南与镜像发布流程详见 [docs/deployment.md](./docs/deployment.md)。

## 常用 CLI

```bash
sessions-ai run                       # 前台单次运行（调试）
sessions-ai start                     # 前台 supervisor
sessions-ai service install [opts]    # 安装当前平台 autostart
sessions-ai service uninstall
sessions-ai service status
sessions-ai service print             # dry-run，预览生成的产物
sessions-ai status                    # sessions-ai service status 的别名
sessions-ai config show
sessions-ai config set serverUrl http://localhost:23712
sessions-ai cache clear [--all]
```

完整 CLI 参考：[apps/agent/NPM_README.md](./apps/agent/NPM_README.md)。

## 本地开发

```bash
pnpm install

# Web
cp apps/web/.env.example apps/web/.env.local
pnpm db:migrate
pnpm dev:web

# Agent（需 Bun ≥ 1.3）
cp apps/agent/.env.example apps/agent/.env
pnpm dev:agent

# 测试
pnpm test:agent
```

monorepo 内的常驻运行：

```bash
pnpm start:agent
pnpm service:print:agent
pnpm service:install:agent
pnpm service:uninstall:agent
```

> Linux 如需用户注销后继续运行：`sudo loginctl enable-linger $USER`

## 发布

- **npm 包** (`sessions-ai`)：
  ```bash
  cd apps/agent && bun run scripts/build-publish.ts
  cd publish-pkg && npm publish --access public
  ```
- **Docker 镜像**（多架构，推送到 Docker Hub）：
  ```bash
  DOCKERHUB_USER=<你> pnpm release:docker
  pnpm release:docker -- v0.2.0
  ```

更多细节见 [docs/deployment.md](./docs/deployment.md)。
