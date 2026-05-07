import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GeminiCliParser } from '../src/parser/gemini.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lsv-gemini-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeJsonl(rows: unknown[], fileName = 'session-2026-04-30T07-26-d3f5fbce.jsonl'): string {
  const dir = join(tempDir, '.gemini', 'tmp', 'greyw', 'chats');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, fileName);
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

function writeSessionJson(record: unknown, fileName = 'session-d3f5fbce.json'): string {
  const dir = join(tempDir, '.gemini', 'tmp', 'greyw', 'chats');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, fileName);
  writeFileSync(file, JSON.stringify(record));
  return file;
}

function writeLegacyLogs(entries: unknown[]): string {
  const dir = join(tempDir, '.gemini', 'tmp', 'greyw');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'logs.json');
  writeFileSync(file, JSON.stringify(entries));
  return file;
}

describe('GeminiCliParser - identity & matching', () => {
  test('toolType / extensions', () => {
    const p = new GeminiCliParser('m1');
    expect(p.toolType()).toBe('GeminiCli');
    expect(p.fileExtensions()).toEqual(['jsonl', 'json']);
  });

  test('matches gemini session jsonl/json and legacy logs.json only inside ~/.gemini/tmp/', () => {
    const p = new GeminiCliParser('m1');
    expect(p.matches('/home/u/.gemini/tmp/u/chats/session-x.jsonl')).toBe(true);
    expect(p.matches('/home/u/.gemini/tmp/u/chats/session-x.json')).toBe(true);
    expect(p.matches('/home/u/.gemini/tmp/u/logs.json')).toBe(true);
    expect(p.matches('/home/u/.gemini/tmp/u/chats/other.jsonl')).toBe(false);
    expect(p.matches('/home/u/somewhere/session-x.jsonl')).toBe(false);
  });
});

describe('GeminiCliParser - JSONL session', () => {
  test('parses header + user + gemini (with thoughts, tokens, toolCalls) + $set mutator', async () => {
    const file = writeJsonl([
      {
        sessionId: 'd3f5fbce-6018-4189-83ff-5796c4fefbe0',
        projectHash: 'abc',
        startTime: '2026-04-30T07:26:04.036Z',
        lastUpdated: '2026-04-30T07:26:04.036Z',
        kind: 'main',
      },
      { id: 'u1', timestamp: '2026-04-30T07:26:50.984Z', type: 'user', content: [{ text: '查询天气' }] },
      { $set: { lastUpdated: '2026-04-30T07:26:50.985Z' } },
      {
        id: 'g1',
        timestamp: '2026-04-30T07:27:02.286Z',
        type: 'gemini',
        content: '已完成',
        thoughts: [{ subject: 'plan', description: 'do it' }],
        tokens: { input: 100, output: 20, cached: 30, total: 150 },
        model: 'gemini-3-flash-preview',
        toolCalls: [{
          id: 'tc1',
          name: 'google_web_search',
          args: { query: 'weather' },
          result: [{ functionResponse: { response: { output: 'sunny' } } }],
          status: 'success',
        }],
      },
    ]);
    const p = new GeminiCliParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages.length).toBe(2);

    const [user, gemini] = r.messages;
    expect(user.role).toBe('User');
    expect(user.contentBlocks[0].blockType).toBe('Text');
    expect(user.contentBlocks[0].content).toBe('查询天气');

    expect(gemini.role).toBe('Assistant');
    expect(gemini.usage?.inputTokens).toBe(70); // 100 - 30 cached
    expect(gemini.usage?.cacheReadInputTokens).toBe(30);
    expect(gemini.usage?.outputTokens).toBe(20);

    const types = gemini.contentBlocks.map((b) => b.blockType);
    expect(types).toContain('Thinking');
    expect(types).toContain('Text');
    // Tool call + tool result
    const toolBlocks = gemini.contentBlocks.filter((b) => b.toolName);
    expect(toolBlocks.length).toBeGreaterThanOrEqual(1);
    expect(toolBlocks[0].toolName).toBe('WebSearch'); // mapped from google_web_search
  });

  test('emits FileEdit block via shared normalizer for write_file functionCall', async () => {
    const file = writeJsonl([
      {
        sessionId: 'sess-xx', projectHash: 'h', startTime: '2026-04-30T00:00:00Z',
        lastUpdated: '2026-04-30T00:00:00Z', kind: 'main',
      },
      {
        id: 'g2', timestamp: '2026-04-30T00:00:01Z', type: 'gemini', content: '',
        toolCalls: [{
          id: 'tc-write', name: 'write_file',
          args: { file_path: '/tmp/a.txt', content: 'hello world' }, status: 'success',
        }],
      },
    ]);
    const p = new GeminiCliParser('m1');
    const r = await p.parseIncremental(file, 0);
    const [msg] = r.messages;
    const fileEdit = msg.contentBlocks.find((b) => b.blockType === 'FileEdit');
    expect(fileEdit).toBeDefined();
    expect(fileEdit?.filePath).toBe('/tmp/a.txt');
    expect(fileEdit?.diff).toContain('hello world');
    const meta = (fileEdit?.toolInput as { editMeta?: { operation: string; status: string } } | null)?.editMeta;
    expect(meta?.operation).toBe('create');
    expect(meta?.status).toBe('applied');
  });

  test('incremental parse: second call only emits new rows', async () => {
    const file = writeJsonl([
      {
        sessionId: 's1', projectHash: 'h', startTime: '2026-04-30T00:00:00Z',
        lastUpdated: '2026-04-30T00:00:00Z', kind: 'main',
      },
      { id: 'u1', timestamp: '2026-04-30T00:00:01Z', type: 'user', content: [{ text: 'hi' }] },
    ]);
    const p = new GeminiCliParser('m1');
    const r1 = await p.parseIncremental(file, 0);
    expect(r1.messages.length).toBe(1);

    // Append another row.
    const more = JSON.stringify({ id: 'g1', timestamp: '2026-04-30T00:00:02Z', type: 'gemini', content: 'ok' }) + '\n';
    const fs = await import('node:fs');
    fs.appendFileSync(file, more);
    const r2 = await p.parseIncremental(file, r1.newOffset);
    expect(r2.messages.length).toBe(1);
    expect(r2.messages[0].role).toBe('Assistant');
  });

  test('drops info/warning rows by default; preserves error rows as System/Error', async () => {
    const file = writeJsonl([
      {
        sessionId: 's1', projectHash: 'h', startTime: '2026-04-30T00:00:00Z',
        lastUpdated: '2026-04-30T00:00:00Z', kind: 'main',
      },
      { id: 'i1', timestamp: '2026-04-30T00:00:01Z', type: 'info', content: 'Conflicts detected' },
      { id: 'w1', timestamp: '2026-04-30T00:00:02Z', type: 'warning', content: 'deprecated flag' },
      { id: 'e1', timestamp: '2026-04-30T00:00:03Z', type: 'error', content: 'oops' },
    ]);
    const p = new GeminiCliParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages.length).toBe(1);
    expect(r.messages[0].role).toBe('System');
    expect(r.messages[0].contentBlocks[0].blockType).toBe('Error');
    expect(r.messages[0].contentBlocks[0].content).toBe('oops');
  });
});

describe('GeminiCliParser - monolithic JSON', () => {
  test('parses {sessionId, messages:[]} shape used by older builds', async () => {
    const file = writeSessionJson({
      sessionId: 'sess-mono',
      kind: 'main',
      messages: [
        { id: 'u1', timestamp: '2026-04-30T00:00:00Z', type: 'user', content: [{ text: 'hello' }] },
        { id: 'g1', timestamp: '2026-04-30T00:00:01Z', type: 'gemini', content: 'hi' },
      ],
    });
    const p = new GeminiCliParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages.length).toBe(2);
    expect(r.messages[0].role).toBe('User');
    expect(r.messages[1].role).toBe('Assistant');
  });
});

describe('GeminiCliParser - legacy logs.json', () => {
  test('parses Qwen-compatible array shape with tool_call → FileEdit', async () => {
    const file = writeLegacyLogs([
      { sessionId: 's1', messageId: 0, type: 'user', message: 'hi', timestamp: '2026-04-30T00:00:00Z' },
      { sessionId: 's1', messageId: 1, type: 'gemini', message: 'response', timestamp: '2026-04-30T00:00:01Z' },
      {
        sessionId: 's1', messageId: 2, type: 'tool_call', toolName: 'edit_file',
        toolArgs: { file_path: '/f.txt', old_string: 'a', new_string: 'b' },
        toolResult: 'ok', timestamp: '2026-04-30T00:00:02Z',
      },
    ]);
    const p = new GeminiCliParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages.length).toBe(3);
    expect(r.messages[0].role).toBe('User');
    expect(r.messages[2].role).toBe('ToolUse');
    const fe = r.messages[2].contentBlocks.find((b) => b.blockType === 'FileEdit');
    expect(fe?.filePath).toBe('/f.txt');
    expect(fe?.diff).toContain('-a');
    expect(fe?.diff).toContain('+b');

    // Incremental: second call returns nothing.
    const r2 = await p.parseIncremental(file, r.newOffset);
    expect(r2.messages.length).toBe(0);
  });
});
