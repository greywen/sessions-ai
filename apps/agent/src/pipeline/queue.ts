import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { UnifiedMessage } from '../parser/types.ts';
import { logger } from '../logger.ts';

export interface QueueConfig {
  batchSize: number;
  batchTimeoutSecs: number;
  channelCapacity: number;
  /** Persistent queue path (SQLite file). */
  persistPath: string;
}

export interface QueueStatus {
  diskPending: number;
  inMemory: number;
}

interface DiskRow {
  id: number;
  payload: string;
}

/**
 * In-memory queue with SQLite fallback persistence.
 * - Producers push messages into memory.
 * - Consumer batches by size and timeout.
 * - Remaining messages are flushed to disk on shutdown.
 */
export class MessageQueue {
  private readonly db: Database;
  private readonly buffer: UnifiedMessage[] = [];
  /** Pending consumer-side waiters (woken when a message arrives). */
  private readonly waiters: Array<() => void> = [];
  /** Pending producer-side waiters (woken when buffer drains below capacity). */
  private readonly drainWaiters: Array<() => void> = [];
  private closed = false;

  constructor(private readonly cfg: QueueConfig) {
    mkdirSync(dirname(cfg.persistPath), { recursive: true });
    this.db = new Database(cfg.persistPath);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)',
    );
  }

  /**
   * Push a message into the queue. Applies backpressure: if the in-memory
   * buffer reaches `channelCapacity`, the call awaits until the consumer
   * drains some space. This protects the server from initial-scan floods
   * (otherwise tens of thousands of messages would queue in memory and the
   * uploader/server/Web UI would all be saturated for minutes).
   */
  async push(msg: UnifiedMessage): Promise<void> {
    if (this.closed) throw new Error('Queue is closed');
    while (this.buffer.length >= this.cfg.channelCapacity && !this.closed) {
      logger.debug(
        { size: this.buffer.length, capacity: this.cfg.channelCapacity },
        'Queue full, applying backpressure to producer',
      );
      await this.waitForDrain();
    }
    if (this.closed) throw new Error('Queue is closed');
    this.buffer.push(msg);
    this.notify();
  }

  /** Recover persisted messages from disk into memory. */
  async recoverFromDisk(): Promise<number> {
    let recovered = 0;
    const stmt = this.db.query<DiskRow, []>(
      'SELECT id, payload FROM pending ORDER BY id ASC',
    );
    const removeStmt = this.db.query('DELETE FROM pending WHERE id = ?');
    for (const row of stmt.iterate()) {
      if (this.buffer.length >= this.cfg.channelCapacity) break;
      try {
        this.buffer.push(JSON.parse(row.payload) as UnifiedMessage);
        removeStmt.run(row.id);
        recovered += 1;
      } catch {
        // Drop malformed persisted row
        removeStmt.run(row.id);
      }
    }
    if (recovered > 0) {
      this.notify();
      logger.info({ recovered }, 'Recovered messages from disk');
    }
    return recovered;
  }

  status(): QueueStatus {
    const row = this.db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM pending').get();
    return { diskPending: row?.c ?? 0, inMemory: this.buffer.length };
  }

  /** Consume a batch up to batchSize, bounded by timeout. */
  async consumeBatch(): Promise<UnifiedMessage[]> {
    const batch: UnifiedMessage[] = [];

    // Wait for first message if needed
    if (this.buffer.length === 0 && !this.closed) {
      await this.waitForMessage();
    }

    const deadline = Date.now() + this.cfg.batchTimeoutSecs * 1000;
    while (batch.length < this.cfg.batchSize) {
      while (this.buffer.length > 0 && batch.length < this.cfg.batchSize) {
        batch.push(this.buffer.shift()!);
      }
      if (batch.length >= this.cfg.batchSize) break;
      if (this.closed) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const got = await this.waitForMessage(remaining);
      if (!got) break;
    }

    // Wake any producers waiting for capacity
    if (batch.length > 0) this.notifyDrain();

    return batch;
  }

  private waitForMessage(timeoutMs?: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const timer = timeoutMs
        ? setTimeout(() => {
            if (done) return;
            done = true;
            const idx = this.waiters.indexOf(handler);
            if (idx >= 0) this.waiters.splice(idx, 1);
            resolve(false);
          }, timeoutMs)
        : null;
      const handler = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(handler);
    });
  }

  private notify() {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.();
    }
  }

  private waitForDrain(): Promise<void> {
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  private notifyDrain() {
    while (this.drainWaiters.length > 0) {
      const w = this.drainWaiters.shift();
      w?.();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Persist remaining in-memory messages
    if (this.buffer.length > 0) {
      const insert = this.db.query('INSERT INTO pending (payload) VALUES (?)');
      for (const m of this.buffer) {
        insert.run(JSON.stringify(m));
      }
      this.buffer.length = 0;
    }
    this.notify();
    this.notifyDrain();
    this.db.close();
  }
}
