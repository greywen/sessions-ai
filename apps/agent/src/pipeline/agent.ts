import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { ToolParser } from '../parser/tool-parser.ts';
import { OpenCodeParser } from '../parser/opencode.ts';
import { CopilotParser } from '../parser/copilot.ts';
import { CodexParser } from '../parser/codex.ts';
import { CursorParser } from '../parser/cursor.ts';
import { QwenCodeParser } from '../parser/qwen.ts';
import { AuthManager } from '../identity/auth.ts';
import { generateFingerprint } from '../identity/fingerprint.ts';
import { FileWatcher, type WatchPath } from './watcher.ts';
import { MessageQueue } from './queue.ts';
import { BatchUploader } from './uploader.ts';
import { ConfigSync, readLocalConfigs } from './config-sync.ts';
import type { AgentConfig } from '../config.ts';
import { logger, maskKey } from '../logger.ts';

/**
 * Compute a cheap change-detection signature for a file.
 *
 * For SQLite databases the main `.db` mtime only changes at WAL checkpoint,
 * so we also fold in the sidecar `-wal` and `-shm` mtimes/sizes when present.
 * Returns null when the file does not exist (caller treats as "skip").
 */
function fileSignature(path: string): string | null {
  try {
    const st = statSync(path);
    let sig = `${st.size}:${st.mtimeMs}`;
    for (const ext of ['-wal', '-shm']) {
      try {
        const sub = statSync(path + ext);
        sig += `|${ext}:${sub.size}:${sub.mtimeMs}`;
      } catch {
        // sidecar absent
      }
    }
    return sig;
  } catch {
    return null;
  }
}

interface OffsetStore {
  get(path: string): number;
  set(path: string, offset: number): void;
  close(): void;
}

function openOffsetStore(file: string): OffsetStore {
  mkdirSync(join(file, '..'), { recursive: true });
  const db = new Database(file);
  db.exec('CREATE TABLE IF NOT EXISTS offsets (path TEXT PRIMARY KEY, offset INTEGER NOT NULL)');
  const getStmt = db.query<{ offset: number }, [string]>('SELECT offset FROM offsets WHERE path = ?');
  const setStmt = db.query(
    'INSERT INTO offsets (path, offset) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset',
  );
  return {
    get(p) {
      return getStmt.get(p)?.offset ?? 0;
    },
    set(p, o) {
      setStmt.run(p, o);
    },
    close() {
      db.close();
    },
  };
}

function listAllFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir) as unknown as string[];
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listAllFiles(full, exts));
    } else if (st.isFile()) {
      if (exts.length === 0) {
        out.push(full);
      } else {
        const ext = name.split('.').pop()?.toLowerCase() ?? '';
        if (exts.includes(ext)) out.push(full);
      }
    }
  }
  return out;
}

function normalizeToolToken(input: string): string {
  return input.trim().toLowerCase().replace(/[\s_-]/g, '');
}

function parserToolAliases(toolType: string): string[] {
  const normalized = normalizeToolToken(toolType);
  switch (normalized) {
    case 'githubcopilot':
      return ['githubcopilot', 'copilot', 'github'];
    case 'claudecode':
      return ['claudecode', 'claude'];
    case 'geminicli':
      return ['geminicli', 'gemini'];
    case 'qwencode':
      return ['qwencode', 'qwen', 'qcoder', 'qoder'];
    default:
      return [normalized];
  }
}

export class Agent {
  constructor(private readonly cfg: AgentConfig) {}

  private isAuthorizationError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return message.includes('Authorization failed: 401') || message.includes('Authorization failed: 403');
  }

  /** Start agent lifecycle and return stop handle. */
  async start(): Promise<{ stop: () => Promise<void> }> {
    logger.info(
      { version: this.cfg.agentVersion, server: this.cfg.serverUrl },
      'sessions-ai Agent starting',
    );

    mkdirSync(this.cfg.dataDir, { recursive: true });

    // 1) fingerprint and authorization
    const fp = await generateFingerprint();
    logger.info(
      { fingerprint: maskKey(fp.fingerprint), os: fp.osInfo.os, user: fp.osUsername },
      'Fingerprint generated',
    );

    const auth = new AuthManager({
      serverUrl: this.cfg.serverUrl,
      storeDir: this.cfg.dataDir,
      agentVersion: this.cfg.agentVersion,
    });
    const authKey = await auth.ensureAuthorized(fp, this.cfg.registerMaxPolls);
    logger.info({ key: maskKey(authKey) }, 'Authorization completed');

    // 2) initialize parsers
    const machineId = fp.fingerprint;
    const allParsers: ToolParser[] = [
      new OpenCodeParser(machineId),
      new CopilotParser(machineId),
      new CodexParser(machineId),
      new CursorParser(machineId),
      new QwenCodeParser(machineId),
    ];
    const enabled = this.cfg.enabledTools;
    const enabledNormalized = new Set([...enabled].map((item) => normalizeToolToken(item)));
    const parsers = allParsers.filter(
      (p) => enabledNormalized.size === 0
        || parserToolAliases(p.toolType()).some((alias) => enabledNormalized.has(alias)),
    );
    logger.info(
      { tools: parsers.map((p) => p.toolType()) },
      `Initialized ${parsers.length} parser(s)`,
    );

    // 3) queue, uploader, offset store
    const queue = new MessageQueue({
      batchSize: this.cfg.batchSize,
      batchTimeoutSecs: this.cfg.batchTimeoutSecs,
      channelCapacity: 1000,
      persistPath: join(this.cfg.dataDir, 'queue.db'),
    });
    await queue.recoverFromDisk();

    const uploader = new BatchUploader({
      serverUrl: this.cfg.serverUrl,
      authKey,
      fingerprint: fp.fingerprint,
      agentVersion: this.cfg.agentVersion,
      maxRetries: 10,
      initialRetryDelayMs: 1000,
      maxRetryDelayMs: 60_000,
    });

    const offsets = openOffsetStore(join(this.cfg.dataDir, 'offsets.db'));

    // mtime/size cache: skip parsing files whose disk signature has not changed
    // since last scan. This is crucial for OpenCode where each parse copies a
    // multi-hundred-MB SQLite file to temp.
    const signatureCache = new Map<string, string>();

    // Build watch paths per parser
    const watchPaths: WatchPath[] = [];
    const parserOf = new Map<string, ToolParser>(); // dir → parser
    for (const p of parsers) {
      for (const dir of p.logPaths()) {
        watchPaths.push({ path: dir, extensions: p.fileExtensions(), toolName: p.toolType() });
        parserOf.set(dir, p);
      }
    }

    const handleFile = async (filePath: string) => {
      // Select the owning parser for this path (longest-prefix style)
      let owner: ToolParser | undefined;
      for (const [dir, p] of parserOf) {
        if (filePath.startsWith(dir) && p.matches(filePath)) {
          owner = p;
          break;
        }
      }
      if (!owner) return;

      // Cheap mtime/size short-circuit: skip if nothing has changed.
      const sig = fileSignature(filePath);
      if (sig === null) return;
      const cachedSig = signatureCache.get(filePath);
      if (cachedSig === sig) return;

      const prev = offsets.get(filePath);
      try {
        const { messages, newOffset } = await owner.parseIncremental(filePath, prev);
        if (newOffset !== prev) offsets.set(filePath, newOffset);
        // Record the signature only after a successful parse so failures retry next time.
        signatureCache.set(filePath, sig);
        for (const m of messages) {
          // `push` applies backpressure when the in-memory buffer is full,
          // pacing the initial full scan to match upload throughput.
          await queue.push(m);
        }
        if (messages.length > 0) {
          // Yield to event loop for smoother throughput
          await new Promise<void>((r) => setImmediate(r));
          // Log only the file path + counts, never message bodies. During a
          // full backfill this can fire thousands of times, so keep it terse.
          logger.info(
            { path: filePath, parsed: messages.length },
            'Parsed incremental messages',
          );
        }
      } catch (err) {
        logger.error({ err: String(err), path: filePath }, 'Failed to parse file');
      }
    };

    // 4) consume and upload loop
    let configSync: ConfigSync | null = null;
    let consuming = true;
    const consumerPromise = (async () => {
      while (consuming) {
        const batch = await queue.consumeBatch();
        if (batch.length === 0) {
          if (!consuming) break;
          continue;
        }
        try {
          await uploader.uploadBatch(batch);
        } catch (err) {
          if (this.isAuthorizationError(err)) {
            logger.warn('Upload authorization failed, attempting re-authorization');
            try {
              auth.clearLocalKey();
              const refreshedAuthKey = await auth.ensureAuthorized(fp, this.cfg.registerMaxPolls);
              uploader.updateAuthKey(refreshedAuthKey);
              (configSync as ConfigSync | null)?.updateAuthKey(refreshedAuthKey);
              logger.info({ key: maskKey(refreshedAuthKey) }, 'Re-authorization completed, retrying batch once');
              await uploader.uploadBatch(batch);
              continue;
            } catch (reauthErr) {
              logger.error({ err: String(reauthErr) }, 'Re-authorization failed');
            }
          }
          logger.error({ err: String(err), size: batch.length }, 'Batch upload failed (messages may be dropped)');
        }
      }
    })();

    // 5) initial full scan
    const fullScan = async (label: 'initial' | 'periodic'): Promise<number> => {
      let total = 0;
      for (const wp of watchPaths) {
        if (!existsSync(wp.path)) {
          if (label === 'initial') {
            logger.warn({ path: wp.path, tool: wp.toolName }, 'Scan: path does not exist, skipping');
          }
          continue;
        }
        const files = listAllFiles(wp.path, wp.extensions);
        if (label === 'initial') {
          logger.info({ path: wp.path, tool: wp.toolName, count: files.length }, 'Initial scan: files discovered');
        }
        for (const f of files) {
          total += 1;
          await handleFile(f);
        }
      }
      return total;
    };

    // 5.0) Initial full scan from offset 0 — uploads ALL historical sessions.
    //   The MessageQueue applies backpressure via `channelCapacity`, and the
    //   uploader processes one batch at a time, so even very large backfills
    //   pace themselves naturally without freezing the host. Each parser is
    //   incremental (offset / time_updated based), so a single file is only
    //   parsed once even when the periodic rescan runs.
    logger.info('Starting initial full scan');
    const initialFiles = await fullScan('initial');
    logger.info({ initialFiles }, 'Initial scan completed');

    // 6) Start watcher (fast path)
    const watcher = new FileWatcher(watchPaths);
    watcher.start((ev) => handleFile(ev.path));

    // 6.1) Periodic full rescan (primary sync mechanism; covers missed watcher events)
    //   - SQLite WAL main-file mtime updates only at checkpoint, hard for chokidar to detect
    //   - Some editors (for example VS Code) write jsonl via atomic replace; inode changes can drop watches
    //   - Rescans are idempotent (offset/time_updated incremental read) and low cost
    let rescanning = false;
    const rescanTimer = setInterval(() => {
      if (rescanning) return;
      rescanning = true;
      void (async () => {
        try {
          const n = await fullScan('periodic');
          logger.debug({ files: n }, 'Periodic rescan completed');
        } catch (err) {
          logger.warn({ err: String(err) }, 'Periodic rescan failed');
        } finally {
          rescanning = false;
        }
      })();
    }, this.cfg.rescanIntervalSecs * 1000);

    // 7) heartbeat loop (also reports local config files for the dashboard)
    const sendHeartbeatOnce = () => {
      let local: Record<string, unknown> | null = null;
      try {
        local = readLocalConfigs() as unknown as Record<string, unknown>;
      } catch (err) {
        logger.warn({ err: String(err) }, 'Failed to read local configs for heartbeat');
      }
      uploader.sendHeartbeat(local).catch((err) => logger.warn({ err: String(err) }, 'Heartbeat failed'));
    };
    sendHeartbeatOnce();
    const heartbeatTimer = setInterval(sendHeartbeatOnce, this.cfg.heartbeatIntervalSecs * 1000);

    // 7.1) Config sync loop — pull pending pushes / read requests from the server,
    //      apply them locally and report back.
    configSync = new ConfigSync({
      serverUrl: this.cfg.serverUrl,
      authKey,
      fingerprint: fp.fingerprint,
      pollIntervalSecs: this.cfg.configPollIntervalSecs,
    });
    configSync.start();

    logger.info('Agent started and running');

    return {
      stop: async () => {
        logger.info('Agent received stop signal, shutting down gracefully');
        clearInterval(heartbeatTimer);
        clearInterval(rescanTimer);
        configSync?.stop();
        await watcher.stop();
        consuming = false;
        await queue.close();
        await consumerPromise;
        offsets.close();
        logger.info('Agent stopped');
      },
    };
  }
}
