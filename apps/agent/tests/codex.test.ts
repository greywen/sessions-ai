import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexParser } from '../src/parser/codex.ts';

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lsv-codex-'));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const SESSION_ID = '6f0e1234-aaaa-bbbb-cccc-deadbeef0001';

function writeRollout(lines: unknown[]): string {
  const dir = join(tempDir, '.codex', 'sessions', '2025', '11', '20');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2025-11-20T08-00-00-${SESSION_ID}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

describe('CodexParser - 基础识别', () => {
  test('toolType / fileExtensions', () => {
    const p = new CodexParser('m1');
    expect(p.toolType()).toBe('Codex');
    expect(p.fileExtensions()).toEqual(['jsonl']);
  });

  test('matches: sessions 目录 + rollout-*.jsonl', () => {
    const p = new CodexParser('m1');
    expect(p.matches('/home/u/.codex/sessions/2025/11/rollout-x.jsonl')).toBe(true);
    expect(p.matches('/home/u/.codex/other/rollout-x.jsonl')).toBe(false);
    expect(p.matches('/home/u/.codex/sessions/2025/11/foo.jsonl')).toBe(false);
  });
});

describe('CodexParser - 解析 user/assistant + token usage', () => {
  test('解析 session_meta + turn_context + 两条消息 + token_count', async () => {
    const file = writeRollout([
      {
        timestamp: '2025-11-20T08:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: SESSION_ID,
          cwd: '/work/x',
          cli_version: '0.5.0',
          originator: 'codex_cli',
          source: 'cli',
          model_provider: 'openai',
        },
      },
      {
        timestamp: '2025-11-20T08:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5-codex' },
      },
      {
        timestamp: '2025-11-20T08:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello codex' }],
        },
      },
      {
        timestamp: '2025-11-20T08:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello back' }],
        },
      },
      {
        timestamp: '2025-11-20T08:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 50,
              reasoning_output_tokens: 10,
            },
          },
        },
      },
    ]);

    const p = new CodexParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages.length).toBe(2);
    expect(r.messages[0].role).toBe('User');
    expect(r.messages[0].contentBlocks[0].content).toBe('hello codex');
    expect(r.messages[1].role).toBe('Assistant');
    expect(r.messages[1].usage).toMatchObject({
      inputTokens: 80,
      outputTokens: 60,
      cacheReadInputTokens: 20,
      model: 'gpt-5-codex',
    });
    expect(r.newOffset).toBeGreaterThan(0);
  });

  test('忽略 environment_context 用户提示', async () => {
    const file = writeRollout([
      {
        timestamp: '2025-11-20T08:00:00.000Z',
        type: 'session_meta',
        payload: { id: SESSION_ID },
      },
      {
        timestamp: '2025-11-20T08:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>cwd=/x</environment_context>' }],
        },
      },
    ]);
    const p = new CodexParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages.length).toBe(0);
  });

  test('增量: 第二次只读取新内容(基于 byte offset)', async () => {
    const file = writeRollout([
      { timestamp: '2025-11-20T08:00:00.000Z', type: 'session_meta', payload: { id: SESSION_ID } },
      {
        timestamp: '2025-11-20T08:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] },
      },
    ]);
    const p = new CodexParser('m1');
    const r1 = await p.parseIncremental(file, 0);
    expect(r1.messages.length).toBe(1);
    const r2 = await p.parseIncremental(file, r1.newOffset);
    expect(r2.messages.length).toBe(0);
    expect(r2.newOffset).toBe(r1.newOffset);
  });
});

describe('CodexParser - apply_patch 解析为 FileEdit', () => {
  const ASSISTANT_LINES = [
    {
      timestamp: '2025-11-20T08:00:00.000Z',
      type: 'session_meta',
      payload: { id: SESSION_ID, cwd: '/work/x' },
    },
    {
      timestamp: '2025-11-20T08:00:01.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5-codex' },
    },
    {
      timestamp: '2025-11-20T08:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'patching' }],
      },
    },
  ];

  test('Add + Update + Delete 各产生一个 FileEdit', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: a.ts',
      '+const a = 1;',
      '*** Update File: b.ts',
      '@@',
      '-old',
      '+new',
      '*** Delete File: c.ts',
      '*** End Patch',
    ].join('\n');
    const file = writeRollout([
      ...ASSISTANT_LINES,
      {
        timestamp: '2025-11-20T08:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'apply_patch',
          arguments: JSON.stringify({ input: patch }),
        },
      },
      {
        timestamp: '2025-11-20T08:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'Success. Updated 3 files.',
        },
      },
      {
        timestamp: '2025-11-20T08:00:05.000Z',
        type: 'event_msg',
        payload: { type: 'patch_apply_end', call_id: 'call_1', success: true, stdout: 'ok' },
      },
    ]);
    const p = new CodexParser('m1');
    const r = await p.parseIncremental(file, 0);
    const asst = r.messages.find((m) => m.role === 'Assistant')!;
    const edits = asst.contentBlocks.filter((b) => b.blockType === 'FileEdit');
    expect(edits).toHaveLength(3);
    expect(edits.map((e) => e.filePath)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    const opsAndStatus = edits.map((e) => {
      const m = (e.toolInput as Record<string, unknown>).editMeta as Record<string, unknown>;
      return [m.operation, m.status, m.cwd];
    });
    expect(opsAndStatus).toEqual([
      ['create', 'applied', '/work/x'],
      ['update', 'applied', '/work/x'],
      ['delete', 'applied', '/work/x'],
    ]);
    expect(edits[0].diff).toContain('+const a = 1;');
    expect(edits[1].diff).toContain('-old');
    expect(edits[1].diff).toContain('+new');
  });

  test('patch_apply_end success=false 翻转状态为 failed', async () => {
    const patch = '*** Begin Patch\n*** Update File: x.ts\n@@\n-a\n+b\n*** End Patch';
    const file = writeRollout([
      ...ASSISTANT_LINES,
      {
        timestamp: '2025-11-20T08:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call_2',
          name: 'apply_patch',
          arguments: JSON.stringify({ input: patch }),
        },
      },
      {
        timestamp: '2025-11-20T08:00:05.000Z',
        type: 'event_msg',
        payload: { type: 'patch_apply_end', call_id: 'call_2', success: false, stdout: 'patch failed' },
      },
    ]);
    const p = new CodexParser('m1');
    const r = await p.parseIncremental(file, 0);
    const asst = r.messages.find((m) => m.role === 'Assistant')!;
    const edit = asst.contentBlocks.find((b) => b.blockType === 'FileEdit')!;
    const meta = (edit.toolInput as Record<string, unknown>).editMeta as Record<string, unknown>;
    expect(meta.status).toBe('failed');
    const err = asst.contentBlocks.find((b) => b.blockType === 'Error');
    expect(err).toBeDefined();
    expect(err!.content).toContain('patch failed');
  });
});
