import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { logger, maskKey } from '../logger.ts';
import type { FingerprintResult, OsInfo } from './fingerprint.ts';

export interface AuthManagerOptions {
  serverUrl: string;
  /** Directory to persist auth key. */
  storeDir: string;
  agentVersion: string;
  /** Poll interval in milliseconds. */
  pollIntervalMs?: number;
}

interface RegisterResponse {
  machineId: string;
  status: 'pending' | 'active' | 'disabled';
  authKey?: string;
  message?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AuthManager {
  private readonly keyFile: string;
  private readonly pollIntervalMs: number;

  constructor(private readonly opts: AuthManagerOptions) {
    this.keyFile = join(opts.storeDir, 'auth_key');
    this.pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  }

  loadLocalKey(): string | null {
    if (!existsSync(this.keyFile)) return null;
    try {
      const text = readFileSync(this.keyFile, 'utf-8').trim();
      if (text.length === 0) return null;
      logger.debug({ key: maskKey(text) }, 'Loaded auth key from local storage');
      return text;
    } catch (err) {
      logger.warn({ err: String(err) }, 'Failed to read local auth key');
      return null;
    }
  }

  saveLocalKey(key: string): void {
    mkdirSync(dirname(this.keyFile), { recursive: true });
    writeFileSync(this.keyFile, key, 'utf-8');
    logger.debug({ key: maskKey(key) }, 'Saved auth key to local storage');
  }

  clearLocalKey(): void {
    if (!existsSync(this.keyFile)) return;
    try {
      rmSync(this.keyFile);
      logger.info('Cleared local auth key');
    } catch (err) {
      logger.warn({ err: String(err) }, 'Failed to clear local auth key');
    }
  }

  async register(fp: FingerprintResult): Promise<RegisterResponse> {
    const url = `${this.opts.serverUrl}/api/agent/register`;
    logger.info({ url, fingerprint: maskKey(fp.fingerprint) }, 'Requesting device registration');

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fingerprint: fp.fingerprint,
        osUsername: fp.osUsername,
        osInfo: fp.osInfo,
        agentVersion: this.opts.agentVersion,
      }),
    });

    const text = await resp.text();

    if (resp.status === 403) {
      logger.warn({ body: text }, 'Registration rejected: device is disabled');
      throw new Error('Device is disabled');
    }
    if (!resp.ok) {
      throw new Error(`Registration failed: HTTP ${resp.status} - ${text}`);
    }

    const data = JSON.parse(text) as RegisterResponse;
    if (data.status === 'active' && data.authKey) {
      this.saveLocalKey(data.authKey);
    }
    return data;
  }

  async pollStatus(fingerprint: string, osUsername: string): Promise<RegisterResponse> {
    const url = `${this.opts.serverUrl}/api/agent/register/status?fingerprint=${encodeURIComponent(fingerprint)}&osUsername=${encodeURIComponent(osUsername)}`;
    const resp = await fetch(url);
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Polling failed: HTTP ${resp.status} - ${text}`);
    const data = JSON.parse(text) as RegisterResponse;
    if (data.status === 'active' && data.authKey) {
      this.saveLocalKey(data.authKey);
    }
    return data;
  }

  /** Ensure authorization: local key -> register -> poll until active. */
  async ensureAuthorized(fp: FingerprintResult, maxPolls: number): Promise<string> {
    const local = this.loadLocalKey();
    if (local) return local;

    const reg = await this.register(fp);
    if (reg.status === 'active' && reg.authKey) return reg.authKey;
    if (reg.status === 'disabled') throw new Error('Device is disabled');

    for (let i = 0; i < maxPolls; i += 1) {
      await sleep(this.pollIntervalMs);
      logger.debug({ attempt: i + 1, max: maxPolls }, 'Polling approval status');
      try {
        const r = await this.pollStatus(fp.fingerprint, fp.osUsername);
        if (r.status === 'active' && r.authKey) return r.authKey;
        if (r.status === 'disabled') throw new Error('Device is disabled');
      } catch (err) {
        logger.warn({ err: String(err), attempt: i + 1 }, 'Polling failed, will retry');
      }
    }
    throw new Error('Authorization timed out');
  }
}
