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
}

export function defaultDataDir(): string {
  // Platform-specific default data directory:
  // - Windows: %LOCALAPPDATA%\llm-sessions
  // - macOS:   ~/Library/Application Support/llm-sessions
  // - Linux:   $XDG_DATA_HOME/llm-sessions or ~/.local/share/llm-sessions
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) return join(local, 'llm-sessions');
    return join(homedir(), 'AppData', 'Local', 'llm-sessions');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'llm-sessions');
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return join(xdg, 'llm-sessions');
  return join(homedir(), '.local', 'share', 'llm-sessions');
}

const AGENT_VERSION = '0.1.0';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const enabled = (env.COLLECT_TOOLS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    serverUrl: env.SERVER_URL ?? 'http://localhost:3000',
    logLevel: (env.LOG_LEVEL as AgentConfig['logLevel']) ?? 'info',
    heartbeatIntervalSecs: Number(env.HEARTBEAT_INTERVAL_SECS ?? 60),
    batchSize: Number(env.BATCH_SIZE ?? 50),
    batchTimeoutSecs: Number(env.BATCH_TIMEOUT_SECS ?? 5),
    dataDir: env.AGENT_DATA_DIR ?? defaultDataDir(),
    enabledTools: new Set(enabled),
    registerMaxPolls: Number(env.REGISTER_MAX_POLLS ?? 360),
    agentVersion: env.AGENT_VERSION ?? AGENT_VERSION,
    rescanIntervalSecs: Number(env.RESCAN_INTERVAL_SECS ?? 30),
  };
}
