# session-vault

> 跨工具 LLM 会话采集、聚合与治理平台。

[English](./README.md) | 中文

## 目录结构

- `apps/web/` — Next.js 管理后台
- `apps/agent/` — Bun + TypeScript 终端采集 Agent（重写，跨平台 Win/macOS/Linux）
- `packages/shared/` — 跨端共享类型与常量

## 当前阶段

阶段 1：仅完成 OpenCode 消息采集与上报。后续阶段会增加 GitHub Copilot / Codex / Claude Code 解析器。

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 启动 Web

```bash
cp apps/web/.env.example apps/web/.env.local   # 根据本地 PG 修改
pnpm db:migrate
pnpm dev:web
```

### 3. 启动 Agent（需要 Bun ≥ 1.3）

```bash
cp apps/agent/.env.example apps/agent/.env
pnpm dev:agent
```

生产/常驻运行：

```bash
# 前台常驻（由内置 supervisor 自动拉起崩溃后的 agent 子进程）
pnpm start:agent

# 预览当前系统会安装什么服务定义（不落地）
pnpm service:print:agent

# 安装当前平台的自启动 + 常驻守护
pnpm service:install:agent

# 卸载
pnpm service:uninstall:agent
```

实现方式：

- Windows：Task Scheduler + `run-supervisor.cmd`
- macOS：`launchd` LaunchAgent + `KeepAlive`
- Linux：`systemd --user` + `Restart=always`

其中三端都会先启动 `apps/agent/scripts/service/supervisor.ts`，由它负责在 agent 崩溃退出后自动退避重启。

> Linux 如果希望在用户退出登录后仍继续运行，还需要执行一次 `loginctl enable-linger <username>`。

### 4. 运行 Agent 测试

```bash
pnpm test:agent
```
