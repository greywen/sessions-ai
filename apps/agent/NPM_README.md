# sessions-ai

> Local LLM session collector. Watches your machine for chat history from
> **GitHub Copilot Chat**, **OpenCode**, **Codex CLI**, **Cursor** and
> **QCoder**, then ships normalized messages to a self-hosted
> [sessions-ai web](https://github.com/greywen/sessions-ai) backend for
> aggregation, audit and cost analytics.

## Requirements

- [Bun](https://bun.sh) **1.3+** (the agent uses `bun:sqlite` and `Bun.spawn`)
- A reachable sessions-ai web server (see "Web backend" below)

## Install

```bash
npm i -g sessions-ai
# or:  bun add -g sessions-ai
# or:  pnpm add -g sessions-ai
```

## Quick start

```bash
# 1. Tell the agent where your web backend lives
sessions-ai config set serverUrl https://sessions.example.com

# 2. (Optional) restrict which tools to collect from
sessions-ai config set collectTools copilot,opencode,cursor

# 3. Verify
sessions-ai config show

# 4. Install the autostart service for the current user
sessions-ai service install
```

`service install` does the right thing per platform:

| OS      | Mechanism                                  |
|---------|--------------------------------------------|
| Windows | Task Scheduler (`/SC ONLOGON`, hidden task) |
| macOS   | `launchd` LaunchAgent (`KeepAlive=true`)   |
| Linux   | `systemd --user` (`Restart=always`)        |

> On Linux, to keep the agent running after logout: `loginctl enable-linger $USER`

Use `sessions-ai service print` to **dry-run** and inspect the generated service artifacts before installing.

## Common commands

```bash
sessions-ai run                   # one-shot foreground (no auto-restart, good for debugging)
sessions-ai start                 # foreground supervisor with crash-restart
sessions-ai service install       # install + start
sessions-ai service install --no-start
sessions-ai service uninstall     # stop + remove
sessions-ai cache clear           # drop incremental offsets, re-scan everything
sessions-ai cache clear --all     # also drop auth_key (forces re-registration)
sessions-ai config show
sessions-ai config path
sessions-ai config set <key> <value>
sessions-ai --version
```

## Configuration keys

Stored in `<dataDir>/config.json`. Run `sessions-ai config path` to find it.

| Key                        | Type             | Default                     |
|----------------------------|------------------|-----------------------------|
| `serverUrl`                | string           | `http://localhost:23712`    |
| `logLevel`                 | string           | `info`                      |
| `collectTools`             | string[]         | all tools                   |
| `heartbeatIntervalSecs`    | number           | `60`                        |
| `rescanIntervalSecs`       | number           | `30`                        |
| `batchSize`                | number           | `50`                        |
| `batchTimeoutSecs`         | number           | `5`                         |
| `registerMaxPolls`         | number           | `360`                       |
| `configPollIntervalSecs`   | number           | `15`                        |

Equivalent environment variables are still honored (and override the file):
`SERVER_URL`, `LOG_LEVEL`, `COLLECT_TOOLS`, `HEARTBEAT_INTERVAL_SECS`,
`RESCAN_INTERVAL_SECS`, `BATCH_SIZE`, `BATCH_TIMEOUT_SECS`,
`REGISTER_MAX_POLLS`, `CONFIG_POLL_INTERVAL_SECS`, `AGENT_DATA_DIR`.

## Data directory

| OS      | Default `dataDir`                                     |
|---------|-------------------------------------------------------|
| Windows | `%LOCALAPPDATA%\sessions-ai`                          |
| macOS   | `~/Library/Application Support/sessions-ai`           |
| Linux   | `$XDG_DATA_HOME/sessions-ai` or `~/.local/share/sessions-ai` |

Contains: `auth_key`, `queue.db`, `offsets.db`, `config.json`, and `service/` (logs).

## Web backend

This npm package only ships the **agent**. The web UI + API server is
deployed separately via Docker Compose:

```bash
git clone https://github.com/greywen/sessions-ai.git
cd sessions-ai/apps/web
docker compose up -d
# Open http://localhost:23712
```

## License

MIT
