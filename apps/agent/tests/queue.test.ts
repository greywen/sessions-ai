import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MessageQueue } from '../src/pipeline/queue.ts';
import type { UnifiedMessage } from '../src/parser/types.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lsv-queue-'));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // On Windows, SQLite file handles may still be settling down
  }
});

function makeMsg(id: string): UnifiedMessage {
  return {
    id,
    sessionId: 's1',
    parentId: null,
    machineId: 'mach-1',
    sourceTool: 'OpenCode',
    role: 'User',
    contentBlocks: [
      {
        blockType: 'Text',
        content: id,
        language: null,
        filePath: null,
        diff: null,
        toolName: null,
        toolInput: null,
        exitCode: null,
        isCollapsed: false,
      },
    ],
    usage: null,
    timestamp: '2026-04-22T00:00:00Z',
    metadata: {},
  };
}

describe('MessageQueue', () => {
  test('push then consumeBatch returns up to batchSize', async () => {
    const q = new MessageQueue({
      batchSize: 3,
      batchTimeoutSecs: 5,
      channelCapacity: 100,
      persistPath: join(dir, 'q'),
    });
    await q.push(makeMsg('a'));
    await q.push(makeMsg('b'));
    await q.push(makeMsg('c'));
    const batch = await q.consumeBatch();
    expect(batch.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    await q.close();
  });

  test('consumeBatch returns after timeout', async () => {
    const q = new MessageQueue({
      batchSize: 5,
      batchTimeoutSecs: 1,
      channelCapacity: 10,
      persistPath: join(dir, 'q'),
    });
    await q.push(makeMsg('only'));
    const start = Date.now();
    const batch = await q.consumeBatch();
    const elapsed = Date.now() - start;
    expect(batch).toHaveLength(1);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    await q.close();
  });

  test('close persists in-memory messages and recover restores them', async () => {
    const q = new MessageQueue({
      batchSize: 10,
      batchTimeoutSecs: 5,
      channelCapacity: 2,
      persistPath: join(dir, 'q'),
    });
    await q.push(makeMsg('m1'));
    await q.push(makeMsg('m2'));
    await q.push(makeMsg('m3'));
    await q.push(makeMsg('m4'));

    // Not persisted yet (still in memory), persistence happens during close()
    expect(q.status().diskPending).toBe(0);
    await q.close();

    const q2 = new MessageQueue({
      batchSize: 10,
      batchTimeoutSecs: 1,
      channelCapacity: 100,
      persistPath: join(dir, 'q'),
    });
    const recovered = await q2.recoverFromDisk();
    expect(recovered).toBe(4);
    const batch = await q2.consumeBatch();
    expect(batch.map((m) => m.id).sort()).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(q2.status().diskPending).toBe(0);
    await q2.close();
  });

  test('push after close throws', async () => {
    const q = new MessageQueue({
      batchSize: 3,
      batchTimeoutSecs: 1,
      channelCapacity: 5,
      persistPath: join(dir, 'q'),
    });
    await q.close();
    expect(() => q.push(makeMsg('x'))).toThrow();
  });
});
