import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { logger } from '../logger.ts';

/**
 * Default file paths per known config type. Mirrors UI defaults
 * (apps/web/app/(dashboard)/devices/[id]/page.tsx → DEFAULT_FILE_PATHS).
 */
export const DEFAULT_CONFIG_PATHS: Record<string, string> = {
  claude_code: '~/.claude/settings.json',
  opencode: '~/.config/opencode/config.json',
  openclaw: '~/.openclaw/config.json',
  gemini_cli: '~/.gemini/settings.json',
};

export interface LocalConfigReport {
  path: string;
  content: Record<string, unknown> | null;
  exists: boolean;
  readAt: string;
  error?: string;
}

export type LocalConfigs = Record<string, LocalConfigReport>;

interface ServerPushItem {
  pushLogId: string;
  configId: string;
  configName: string;
  configType: string;
  configPayload: Record<string, unknown>;
  version: number;
}

interface ServerReadRequest {
  requestId: string;
  filePath: string;
}

interface ServerConfigResponse {
  data: {
    configs: ServerPushItem[];
    readRequests: ServerReadRequest[];
  };
}

export interface ConfigSyncOptions {
  serverUrl: string;
  authKey: string;
  fingerprint: string;
  /** Poll interval seconds. */
  pollIntervalSecs: number;
  /** Custom file path overrides per push (configType+configName → filePath). Optional. */
  pathOverrides?: Record<string, string>;
}

/**
 * Expand "~" prefix to home directory. Leaves the rest of the path untouched.
 */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function readJsonFile(absPath: string): { content: Record<string, unknown> | null; error?: string } {
  try {
    const raw = readFileSync(absPath, 'utf-8');
    if (raw.trim().length === 0) return { content: null };
    return { content: JSON.parse(raw) as Record<string, unknown> };
  } catch (err) {
    return { content: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read all known local config files and return a structured report
 * suitable for the heartbeat endpoint's `localConfigs` field.
 */
export function readLocalConfigs(
  paths: Record<string, string> = DEFAULT_CONFIG_PATHS,
): LocalConfigs {
  const out: LocalConfigs = {};
  const readAt = new Date().toISOString();
  for (const [type, raw] of Object.entries(paths)) {
    const abs = expandHome(raw);
    const exists = existsSync(abs);
    if (!exists) {
      out[type] = { path: raw, content: null, exists: false, readAt };
      continue;
    }
    const { content, error } = readJsonFile(abs);
    out[type] = { path: raw, content, exists: true, readAt, ...(error ? { error } : {}) };
  }
  return out;
}

/**
 * Polls the server for pending config pushes & read requests, applies them,
 * and reports results. Designed to run on a timer.
 */
export class ConfigSync {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: ConfigSyncOptions) {}

  start(): void {
    if (this.timer) return;
    // Run once immediately, then on interval.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.pollIntervalSecs * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  updateAuthKey(key: string): void {
    this.opts.authKey = key;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.authKey}`,
      'x-machine-fingerprint': this.opts.fingerprint,
      'content-type': 'application/json',
    };
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const resp = await fetch(`${this.opts.serverUrl}/api/agent/config`, {
        headers: this.headers(),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        logger.warn({ status: resp.status, body }, 'ConfigSync: pull failed');
        return;
      }
      const json = (await resp.json()) as ServerConfigResponse;
      const { configs = [], readRequests = [] } = json.data ?? { configs: [], readRequests: [] };

      for (const item of configs) {
        await this.applyPush(item);
      }
      for (const req of readRequests) {
        await this.fulfillRead(req);
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'ConfigSync: tick failed');
    } finally {
      this.running = false;
    }
  }

  private resolveTargetPath(item: ServerPushItem): string | null {
    // Server side currently does not include filePath in the pull response,
    // so we fall back to defaults by configType. For 'custom' there is no
    // safe default — skip writing and just ack so the row clears.
    const override = this.opts.pathOverrides?.[item.configType];
    if (override) return expandHome(override);
    const def = DEFAULT_CONFIG_PATHS[item.configType];
    return def ? expandHome(def) : null;
  }

  private async applyPush(item: ServerPushItem): Promise<void> {
    const target = this.resolveTargetPath(item);
    if (!target) {
      logger.warn(
        { pushLogId: item.pushLogId, configType: item.configType },
        'ConfigSync: no target path resolvable; ack as failed',
      );
      await this.ackPush(item.pushLogId, false, 'no_target_path');
      return;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(item.configPayload, null, 2), 'utf-8');
      logger.info(
        { pushLogId: item.pushLogId, configType: item.configType, target },
        'ConfigSync: applied push',
      );
      await this.ackPush(item.pushLogId, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, target }, 'ConfigSync: apply push failed');
      await this.ackPush(item.pushLogId, false, msg);
    }
  }

  private async ackPush(pushLogId: string, success: boolean, errorMessage?: string): Promise<void> {
    try {
      const resp = await fetch(`${this.opts.serverUrl}/api/agent/config/ack`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          pushLogId,
          status: success ? 'acked' : 'failed',
          errorMessage: errorMessage ?? null,
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        logger.warn({ status: resp.status, body, pushLogId }, 'ConfigSync: ack failed');
      }
    } catch (err) {
      logger.warn({ err: String(err), pushLogId }, 'ConfigSync: ack request failed');
    }
  }

  private async fulfillRead(req: ServerReadRequest): Promise<void> {
    const abs = expandHome(req.filePath);
    let content: Record<string, unknown> | null = null;
    let error: string | null = null;
    if (!existsSync(abs)) {
      error = `file not found: ${req.filePath}`;
    } else {
      const r = readJsonFile(abs);
      content = r.content;
      if (r.error) error = r.error;
    }
    try {
      const resp = await fetch(`${this.opts.serverUrl}/api/agent/config/read-result`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          requestId: req.requestId,
          content,
          error,
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        logger.warn({ status: resp.status, body, requestId: req.requestId }, 'ConfigSync: read-result failed');
        return;
      }
      logger.info(
        { requestId: req.requestId, filePath: req.filePath, ok: !error },
        'ConfigSync: fulfilled read',
      );
    } catch (err) {
      logger.warn({ err: String(err), requestId: req.requestId }, 'ConfigSync: read-result request failed');
    }
  }
}
