#!/usr/bin/env bun
/**
 * sessions-ai unified CLI entrypoint.
 *
 * Usage:
 *   sessions-ai run                          # Run agent once in foreground (no auto-restart)
 *   sessions-ai start                        # Run agent under built-in supervisor (foreground)
 *   sessions-ai service install [--print] [--no-start]
 *   sessions-ai service uninstall
 *   sessions-ai service status
 *   sessions-ai service print                # Alias for `service install --print`
 *   sessions-ai status                       # Alias for: service status
 *   sessions-ai config show
 *   sessions-ai config path
 *   sessions-ai config set <key> <value>
 *   sessions-ai cache clear [--all]
 *   sessions-ai --version | -v
 *   sessions-ai --help    | -h
 *
 * Supported config keys (file: <dataDir>/config.json):
 *   serverUrl, logLevel, heartbeatIntervalSecs, batchSize, batchTimeoutSecs,
 *   collectTools (comma-separated), registerMaxPolls, rescanIntervalSecs,
 *   configPollIntervalSecs
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  defaultDataDir,
  fileConfigPath,
  isFileConfigKey,
  loadConfig,
  readFileConfig,
  writeFileConfig,
  type FileConfig,
} from './config.ts';

const VERSION = '0.1.0';

function printHelp(): void {
  console.log(`sessions-ai v${VERSION}

Usage:
  sessions-ai run                       Run agent once in foreground
  sessions-ai start                     Run agent under built-in supervisor
  sessions-ai service install [opts]    Install OS-level autostart service
                                          --print     Preview only, do not install
                                          --no-start  Install but do not start now
  sessions-ai service uninstall         Remove autostart service
  sessions-ai service status            Show service runtime status
  sessions-ai service print             Alias for: service install --print
  sessions-ai status                    Alias for: service status
  sessions-ai config show               Print effective configuration
  sessions-ai config path               Print config file path
  sessions-ai config set <key> <value>  Persist a setting to config.json
  sessions-ai cache clear [--all]       Clear queue/offsets caches (--all also drops auth_key)
  sessions-ai --version, -v
  sessions-ai --help, -h

Config file: ${fileConfigPath()}
Data dir:    ${defaultDataDir()}
`);
}

async function cmdRun(): Promise<void> {
  const { Agent } = await import('./pipeline/agent.ts');
  const { logger } = await import('./logger.ts');

  const cfg = loadConfig();
  const agent = new Agent(cfg);
  const handle = await agent.start();

  const shutdown = async (sig: string) => {
    logger.info({ signal: sig }, 'Received shutdown signal');
    try {
      await handle.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
  }
}

async function cmdStart(): Promise<void> {
  const { runSupervisor } = await import('./service/supervisor.ts');
  await runSupervisor();
}

async function cmdServiceInstall(rest: string[]): Promise<void> {
  const { installService } = await import('./service/install.ts');
  await installService({
    printOnly: rest.includes('--print'),
    noStart: rest.includes('--no-start'),
  });
}

async function cmdServiceUninstall(): Promise<void> {
  const { uninstallService } = await import('./service/uninstall.ts');
  await uninstallService();
}

async function cmdServiceStatus(): Promise<void> {
  const { printServiceStatus } = await import('./service/status.ts');
  await printServiceStatus();
}

function cmdConfigShow(): void {
  const cfg = loadConfig();
  const file = readFileConfig();
  console.log('# Effective configuration');
  console.log(JSON.stringify({ ...cfg, enabledTools: [...cfg.enabledTools] }, null, 2));
  console.log('');
  console.log(`# File overrides at ${fileConfigPath()}`);
  console.log(JSON.stringify(file, null, 2));
}

function parseConfigValue(key: string, raw: string): unknown {
  if (key === 'collectTools') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (
    key === 'heartbeatIntervalSecs' ||
    key === 'batchSize' ||
    key === 'batchTimeoutSecs' ||
    key === 'registerMaxPolls' ||
    key === 'rescanIntervalSecs' ||
    key === 'configPollIntervalSecs'
  ) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid number for ${key}: ${raw}`);
    return n;
  }
  if (key === 'logLevel') {
    if (!['trace', 'debug', 'info', 'warn', 'error'].includes(raw)) {
      throw new Error(`Invalid logLevel: ${raw} (use trace|debug|info|warn|error)`);
    }
    return raw;
  }
  return raw;
}

function cmdConfigSet(key: string | undefined, value: string | undefined): void {
  if (!key || value === undefined) {
    console.error('Usage: sessions-ai config set <key> <value>');
    process.exit(2);
  }
  if (!isFileConfigKey(key)) {
    console.error(`Unknown config key: ${key}`);
    console.error(
      'Allowed keys: serverUrl, logLevel, heartbeatIntervalSecs, batchSize, batchTimeoutSecs, collectTools, registerMaxPolls, rescanIntervalSecs, configPollIntervalSecs',
    );
    process.exit(2);
  }
  const parsed = parseConfigValue(key, value);
  const next = writeFileConfig({ [key]: parsed } as FileConfig);
  console.log(`✅ Updated ${key} → ${JSON.stringify(parsed)}`);
  console.log(`File: ${fileConfigPath()}`);
  console.log(JSON.stringify(next, null, 2));
}

function cmdCacheClear(rest: string[]): void {
  const dataDir = process.env.AGENT_DATA_DIR ?? defaultDataDir();
  const clearAll = rest.includes('--all');
  console.log(`📂 agent dataDir: ${dataDir}`);
  if (!existsSync(dataDir)) {
    console.log('   (directory does not exist — nothing to do)');
    return;
  }
  const targets = clearAll
    ? readdirSync(dataDir).map((name) => join(dataDir, name))
    : ['queue.db', 'queue.db-wal', 'queue.db-shm', 'offsets.db', 'offsets.db-wal', 'offsets.db-shm'].map((name) =>
        join(dataDir, name),
      );

  let removed = 0;
  let busy = 0;
  for (const p of targets) {
    if (!existsSync(p)) continue;
    const st = statSync(p);
    try {
      rmSync(p, { recursive: true, force: true });
      console.log(`   ✅ removed ${p}${st.isDirectory() ? ' (dir)' : ''}`);
      removed += 1;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EBUSY' || code === 'EPERM') {
        console.warn(`   ⚠️  busy/locked, skipped: ${p}`);
        busy += 1;
      } else {
        throw err;
      }
    }
  }

  if (removed === 0 && busy === 0) {
    console.log('   nothing to remove.');
  } else {
    console.log(`✅ Done. cleared ${removed} item(s)${busy ? `, ${busy} busy/skipped` : ''}.`);
    if (busy > 0) {
      console.log('ℹ️  Some files are locked by a running agent. Stop it first, then re-run.');
    }
    if (!clearAll) {
      console.log('ℹ️  auth_key preserved. Use --all to also drop it (forces re-registration).');
    }
  }
}

async function dispatch(argv: string[]): Promise<void> {
  const [cmd, sub, ...rest] = argv;

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printHelp();
    return;
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(VERSION);
    return;
  }

  switch (cmd) {
    case 'run':
      await cmdRun();
      return;
    case 'start':
      await cmdStart();
      return;
    case 'service': {
      switch (sub) {
        case 'install':
          await cmdServiceInstall(rest);
          return;
        case 'uninstall':
          await cmdServiceUninstall();
          return;
        case 'status':
          await cmdServiceStatus();
          return;
        case 'print':
          await cmdServiceInstall(['--print', ...rest]);
          return;
        default:
          console.error('Usage: sessions-ai service <install|uninstall|status|print> [options]');
          process.exit(2);
      }
      return;
    }
    case 'status':
      await cmdServiceStatus();
      return;
    case 'config': {
      switch (sub) {
        case 'show':
          cmdConfigShow();
          return;
        case 'path':
          console.log(fileConfigPath());
          return;
        case 'set':
          cmdConfigSet(rest[0], rest[1]);
          return;
        default:
          console.error('Usage: sessions-ai config <show|path|set>');
          process.exit(2);
      }
      return;
    }
    case 'cache': {
      switch (sub) {
        case 'clear':
          cmdCacheClear(rest);
          return;
        default:
          console.error('Usage: sessions-ai cache clear [--all]');
          process.exit(2);
      }
      return;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(2);
  }
}

// Bun.argv: [bun, script, ...userArgs]
const userArgs = (typeof Bun !== 'undefined' ? Bun.argv : process.argv).slice(2);

dispatch(userArgs).catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

// Silence unused import lint when JSON parsed via existsSync only.
void readFileSync;
