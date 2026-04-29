import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentConfig {
  serverUrl: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  heartbeatIntervalSecs: number;
  batchSize: number;
  batchTimeoutSecs: number;
  /** Agent data directory (auth_key, queue, offsets). */
  dataDir: string;
  /** Enabled tools list (comma-separated). Empty means all tools. */
  enabledTools: Set<string>;
  /** Maximum registration polling attempts. */
  registerMaxPolls: number;
  /** Agent version string. */
  agentVersion: string;
  /**
   * Interval for periodic full rescans (seconds). Watcher events are not fully reliable
   * (for example, SQLite WAL main file mtime updates only at checkpoint), so periodic
   * rescans serve as the primary synchronization mechanism.
   * Parsers read incrementally via offset/time_updated, so rescans are idempotent.
   */
  rescanIntervalSecs: number;
  /** Interval for polling pending config pushes / read requests (seconds). */
  configPollIntervalSecs: number;
}

export function defaultDataDir(): string {
  // Platform-specific default data directory:
  // - Windows: %LOCALAPPDATA%\sessions-ai
  // - macOS:   ~/Library/Application Support/sessions-ai
  // - Linux:   $XDG_DATA_HOME/sessions-ai or ~/.local/share/sessions-ai
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) return join(local, 'sessions-ai');
    return join(homedir(), 'AppData', 'Local', 'sessions-ai');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'sessions-ai');
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return join(xdg, 'sessions-ai');
  return join(homedir(), '.local', 'share', 'sessions-ai');
}

const AGENT_VERSION = '0.1.0';

function normalizeToolToken(input: string): string {
  return input.trim().toLowerCase().replace(/[\s_-]/g, '');
}

function canonicalToolToken(input: string): string {
  const normalized = normalizeToolToken(input);
  if (normalized === 'qcoder' || normalized === 'qoder') return 'qwencode';
  return normalized;
}

/**
 * Persistent on-disk config (lives at `${dataDir}/config.json`).
 *
 * Used by the npm-published CLI so users can configure the agent without
 * dropping a `.env` file next to the binary. Environment variables still
 * win over file values, which preserves the dev workflow that uses
 * `apps/agent/.env`.
 */
export interface FileConfig {
  serverUrl?: string;
  logLevel?: AgentConfig['logLevel'];
  heartbeatIntervalSecs?: number;
  batchSize?: number;
  batchTimeoutSecs?: number;
  collectTools?: string[];
  registerMaxPolls?: number;
  rescanIntervalSecs?: number;
  configPollIntervalSecs?: number;
}

const FILE_CONFIG_KEYS = [
  'serverUrl',
  'logLevel',
  'heartbeatIntervalSecs',
  'batchSize',
  'batchTimeoutSecs',
  'collectTools',
  'registerMaxPolls',
  'rescanIntervalSecs',
  'configPollIntervalSecs',
] as const satisfies ReadonlyArray<keyof FileConfig>;

export type FileConfigKey = (typeof FILE_CONFIG_KEYS)[number];

export function isFileConfigKey(key: string): key is FileConfigKey {
  return (FILE_CONFIG_KEYS as readonly string[]).includes(key);
}

export function fileConfigPath(dataDir: string = process.env.AGENT_DATA_DIR ?? defaultDataDir()): string {
  return join(dataDir, 'config.json');
}

export function readFileConfig(dataDir: string = process.env.AGENT_DATA_DIR ?? defaultDataDir()): FileConfig {
  const path = fileConfigPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return {};
    return raw as FileConfig;
  } catch {
    return {};
  }
}

export function writeFileConfig(
  patch: FileConfig,
  dataDir: string = process.env.AGENT_DATA_DIR ?? defaultDataDir(),
): FileConfig {
  mkdirSync(dataDir, { recursive: true });
  const current = readFileConfig(dataDir);
  const next: FileConfig = { ...current, ...patch };
  writeFileSync(fileConfigPath(dataDir), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const dataDir = env.AGENT_DATA_DIR ?? defaultDataDir();
  const file = readFileConfig(dataDir);

  const enabledRaw =
    env.COLLECT_TOOLS !== undefined
      ? env.COLLECT_TOOLS.split(',')
      : (file.collectTools ?? []);
  const enabled = enabledRaw.map((s) => canonicalToolToken(s)).filter(Boolean);

  return {
    serverUrl: env.SERVER_URL ?? file.serverUrl ?? 'http://localhost:23712',
    logLevel:
      (env.LOG_LEVEL as AgentConfig['logLevel']) ?? file.logLevel ?? 'info',
    heartbeatIntervalSecs: Number(env.HEARTBEAT_INTERVAL_SECS ?? file.heartbeatIntervalSecs ?? 60),
    batchSize: Number(env.BATCH_SIZE ?? file.batchSize ?? 50),
    batchTimeoutSecs: Number(env.BATCH_TIMEOUT_SECS ?? file.batchTimeoutSecs ?? 5),
    dataDir,
    enabledTools: new Set(enabled),
    registerMaxPolls: Number(env.REGISTER_MAX_POLLS ?? file.registerMaxPolls ?? 360),
    agentVersion: env.AGENT_VERSION ?? AGENT_VERSION,
    rescanIntervalSecs: Number(env.RESCAN_INTERVAL_SECS ?? file.rescanIntervalSecs ?? 30),
    configPollIntervalSecs: Number(env.CONFIG_POLL_INTERVAL_SECS ?? file.configPollIntervalSecs ?? 15),
  };
}
