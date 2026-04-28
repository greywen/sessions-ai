import { gzipSync } from 'node:zlib';

import type { UnifiedMessage } from '../parser/types.ts';
import { logger, maskKey } from '../logger.ts';

export interface UploaderConfig {
  serverUrl: string;
  authKey: string;
  fingerprint: string;
  agentVersion: string;
  /** Maximum retry attempts. */
  maxRetries: number;
  /** Initial retry delay (ms). */
  initialRetryDelayMs: number;
  /** Maximum retry delay (ms). */
  maxRetryDelayMs: number;
}

export interface UploadResult {
  accepted: number;
  durationMs: number;
  compressionRatio: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BatchUploader {
  private authKey: string;

  constructor(private readonly cfg: UploaderConfig) {
    this.authKey = cfg.authKey;
  }

  updateAuthKey(nextKey: string): void {
    this.authKey = nextKey;
  }

  async uploadBatch(messages: UnifiedMessage[]): Promise<UploadResult> {
    const start = Date.now();
    const json = Buffer.from(JSON.stringify(messages), 'utf-8');
    const compressed = gzipSync(json);
    const ratio = json.length === 0 ? 1 : compressed.length / json.length;

    const url = `${this.cfg.serverUrl}/api/agent/ingest`;
    let delay = this.cfg.initialRetryDelayMs;

    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt += 1) {
      if (attempt > 0) {
        logger.warn({ attempt, delayMs: delay }, 'Upload failed, backing off before retry');
        await sleep(delay);
        delay = Math.min(delay * 2, this.cfg.maxRetryDelayMs);
      }

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.authKey}`,
            'x-machine-fingerprint': this.cfg.fingerprint,
            'content-type': 'application/json',
            'content-encoding': 'gzip',
          },
          // Bun & Node fetch both accept Uint8Array body
          body: compressed,
        });
      } catch (err) {
        logger.warn({ err: String(err), attempt }, 'Upload request failed');
        continue;
      }

      if (resp.status >= 200 && resp.status < 300) {
        const body = (await resp.json().catch(() => ({}))) as { accepted?: number };
        const durationMs = Date.now() - start;
        logger.info(
          {
            count: messages.length,
            accepted: body.accepted ?? 0,
            durationMs,
            compressionRatio: Number(ratio.toFixed(2)),
          },
          'Upload completed',
        );
        return {
          accepted: Number(body.accepted ?? 0),
          durationMs,
          compressionRatio: ratio,
        };
      }

      if (resp.status === 401 || resp.status === 403) {
        const body = await resp.text().catch(() => '');
        logger.error(
          { status: resp.status, key: maskKey(this.authKey), body },
          'Authorization failed, stopping upload retries',
        );
        throw new Error(`Authorization failed: ${resp.status} - ${body}`);
      }

      const body = await resp.text().catch(() => '');
      logger.warn({ status: resp.status, attempt, body }, 'Server returned non-success status');
    }

    throw new Error('Upload failed after retries');
  }

  async sendHeartbeat(localConfigs: Record<string, unknown> | null = null): Promise<void> {
    const url = `${this.cfg.serverUrl}/api/agent/heartbeat`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.authKey}`,
        'x-machine-fingerprint': this.cfg.fingerprint,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        agentVersion: this.cfg.agentVersion,
        localConfigs,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Heartbeat failed: ${resp.status} - ${body}`);
    }
    logger.debug('Heartbeat sent successfully');
  }
}
