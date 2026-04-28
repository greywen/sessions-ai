import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CursorParser } from '../src/parser/cursor.ts';

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lsv-cursor-'));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const COMPOSER_ID = 'cccccccc-1111-2222-3333-444444444444';
const BUBBLE_USER = 'b1111111-aaaa-bbbb-cccc-000000000001';
const BUBBLE_ASSI = 'b2222222-aaaa-bbbb-cccc-000000000002';
const TS_USER = Date.parse('2025-11-20T09:00:00.000Z');
const TS_ASSI = Date.parse('2025-11-20T09:00:05.000Z');

function buildDb(rows: { key: string; value: unknown }[]): string {
  const file = join(tempDir, 'state.vscdb');
  const db = new Database(file);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  const stmt = db.query<unknown, [string, string]>(
    'INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)',
  );
  for (const r of rows) {
    stmt.run(r.key, JSON.stringify(r.value));
  }
  db.close();
  return file;
}

describe('CursorParser - 基础识别', () => {
  test('toolType / fileExtensions', () => {
    const p = new CursorParser('m1');
    expect(p.toolType()).toBe('Cursor');
    expect(p.fileExtensions()).toEqual(['vscdb']);
  });

  test('matches: state.vscdb', () => {
    const p = new CursorParser('m1');
    expect(p.matches('/x/y/state.vscdb')).toBe(true);
    expect(p.matches('/x/y/other.vscdb')).toBe(false);
  });
});

describe('CursorParser - 解析 composer + bubbles', () => {
  test('User + Assistant + ToolCall', async () => {
    const file = buildDb([
      {
        key: `composerData:${COMPOSER_ID}`,
        value: {
          composerId: COMPOSER_ID,
          name: 'My Conversation',
          createdAt: TS_USER,
          modelConfig: { modelName: 'claude-sonnet-4' },
        },
      },
      {
        key: `bubbleId:${COMPOSER_ID}:${BUBBLE_USER}`,
        value: {
          bubbleId: BUBBLE_USER,
          type: 1,
          text: 'help me refactor',
          createdAt: TS_USER,
        },
      },
      {
        key: `bubbleId:${COMPOSER_ID}:${BUBBLE_ASSI}`,
        value: {
          bubbleId: BUBBLE_ASSI,
          type: 2,
          text: 'sure, here we go',
          createdAt: TS_ASSI,
          modelInfo: { modelName: 'claude-sonnet-4' },
          tokenCount: { inputTokens: 50, outputTokens: 30 },
          toolFormerData: {
            name: 'edit_file',
            params: '{"path":"a.ts"}',
            result: 'edited',
            status: 'completed',
          },
        },
      },
    ]);

    const p = new CursorParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages.length).toBe(2);
    expect(r.messages[0].role).toBe('User');
    expect(r.messages[0].contentBlocks[0].content).toBe('help me refactor');
    expect(r.messages[0].metadata.sessionTitle).toBe('My Conversation');

    const a = r.messages[1];
    expect(a.role).toBe('Assistant');
    expect(a.usage?.inputTokens).toBe(50);
    expect(a.contentBlocks.length).toBe(2);
    expect(a.contentBlocks[1].toolName).toBe('edit_file');
    expect(a.contentBlocks[1].toolInput).toEqual({ path: 'a.ts' });

    expect(r.newOffset).toBe(TS_ASSI);
  });

  test('增量: 基于 createdAt 跳过已处理 bubble', async () => {
    const file = buildDb([
      {
        key: `composerData:${COMPOSER_ID}`,
        value: { composerId: COMPOSER_ID, createdAt: TS_USER },
      },
      {
        key: `bubbleId:${COMPOSER_ID}:${BUBBLE_USER}`,
        value: { bubbleId: BUBBLE_USER, type: 1, text: 'first', createdAt: TS_USER },
      },
    ]);
    const p = new CursorParser('m1');
    const r1 = await p.parseIncremental(file, 0);
    expect(r1.messages.length).toBe(1);
    const r2 = await p.parseIncremental(file, r1.newOffset);
    expect(r2.messages.length).toBe(0);
  });

  test('解析 richText (Lexical JSON)', async () => {
    const richText = JSON.stringify({
      root: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'text', text: 'rich ' },
              { type: 'text', text: 'content' },
            ],
          },
        ],
      },
    });
    const file = buildDb([
      {
        key: `composerData:${COMPOSER_ID}`,
        value: { composerId: COMPOSER_ID },
      },
      {
        key: `bubbleId:${COMPOSER_ID}:${BUBBLE_USER}`,
        value: { bubbleId: BUBBLE_USER, type: 1, richText, createdAt: TS_USER },
      },
    ]);
    const p = new CursorParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages.length).toBe(1);
    expect(r.messages[0].contentBlocks[0].content).toBe('rich content');
  });

  test('tokenCount present with zeros should still emit zero usage', async () => {
    const file = buildDb([
      {
        key: `composerData:${COMPOSER_ID}`,
        value: { composerId: COMPOSER_ID, modelConfig: { modelName: 'gpt-4.1' } },
      },
      {
        key: `bubbleId:${COMPOSER_ID}:${BUBBLE_ASSI}`,
        value: {
          bubbleId: BUBBLE_ASSI,
          type: 2,
          text: 'answer',
          createdAt: TS_ASSI,
          tokenCount: { inputTokens: 0, outputTokens: 0 },
        },
      },
    ]);

    const p = new CursorParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages.length).toBe(1);
    expect(r.messages[0].usage).not.toBeNull();
    expect(r.messages[0].usage?.inputTokens).toBe(0);
    expect(r.messages[0].usage?.outputTokens).toBe(0);
  });
});
