import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCodeParser } from '../src/parser/claude.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lsv-claude-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeClaudeProjectJsonl(entries: unknown[], sessionId = '11111111-2222-4333-8444-555555555555'): string {
  const dir = join(tempDir, '.claude', 'projects', 'c--Users-test');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

function appendClaudeProjectJsonl(filePath: string, entries: unknown[]): void {
  appendFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

describe('ClaudeCodeParser - basic identity', () => {
  test('toolType / fileExtensions', () => {
    const p = new ClaudeCodeParser('m1');
    expect(p.toolType()).toBe('ClaudeCode');
    expect(p.fileExtensions()).toEqual(['jsonl']);
  });

  test('matches: only .claude/projects/**/*.jsonl', () => {
    const p = new ClaudeCodeParser('m1');
    expect(p.matches('/home/u/.claude/projects/demo/abc.jsonl')).toBe(true);
    expect(p.matches('C:/Users/u/.claude/projects/demo/abc.jsonl')).toBe(true);
    expect(p.matches('/home/u/.claude/transcripts/ses_xxx.jsonl')).toBe(false);
    expect(p.matches('/home/u/.claude/projects/demo/abc.json')).toBe(false);
  });

  test('logPaths discovers ~/.claude/projects', () => {
    const spy = spyOn(nodeOs, 'homedir').mockReturnValue(tempDir);
    try {
      const p = new ClaudeCodeParser('m1');
      const projectsDir = join(tempDir, '.claude', 'projects');
      mkdirSync(projectsDir, { recursive: true });
      expect(p.logPaths()).toContain(projectsDir);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('ClaudeCodeParser - parsing messages and usage', () => {
  test('parses user + assistant text and maps token usage', async () => {
    const file = writeClaudeProjectJsonl([
      {
        type: 'user',
        uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        parentUuid: null,
        timestamp: '2026-04-28T08:00:00.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        cwd: '/work/demo',
        entrypoint: 'claude-vscode',
        version: '2.1.121',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello claude' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        parentUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        timestamp: '2026-04-28T08:00:01.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        cwd: '/work/demo',
        entrypoint: 'claude-vscode',
        version: '2.1.121',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'anthropic/claude-opus-4.6',
          content: [{ type: 'text', text: 'hi there' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 7,
          },
        },
      },
    ]);

    const p = new ClaudeCodeParser('m1');
    const r = await p.parseIncremental(file, 0);

    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].role).toBe('User');
    expect(r.messages[0].contentBlocks[0].content).toBe('hello claude');

    const asst = r.messages[1];
    expect(asst.role).toBe('Assistant');
    expect(asst.contentBlocks[0].content).toBe('hi there');
    expect(asst.usage).not.toBeNull();
    expect(asst.usage?.inputTokens).toBe(100);
    expect(asst.usage?.outputTokens).toBe(20);
    expect(asst.usage?.cacheCreationInputTokens).toBe(5);
    expect(asst.usage?.cacheReadInputTokens).toBe(7);
    expect(asst.usage?.model).toBe('anthropic/claude-opus-4.6');
    expect(asst.metadata.sourceSessionId).toBe('11111111-2222-4333-8444-555555555555');
  });

  test('parses tool_use + tool_result chain and links tool name', async () => {
    const file = writeClaudeProjectJsonl([
      {
        type: 'assistant',
        uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        parentUuid: null,
        timestamp: '2026-04-28T08:10:00.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: {
          id: 'msg_tool_call',
          type: 'message',
          role: 'assistant',
          model: 'anthropic/claude-opus-4.6',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Bash',
              input: { command: 'echo hi', description: 'print hi' },
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
      {
        type: 'user',
        uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        parentUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        timestamp: '2026-04-28T08:10:01.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        toolUseResult: {
          stdout: 'hi',
          stderr: '',
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'hi',
              is_error: false,
            },
          ],
        },
      },
    ]);

    const p = new ClaudeCodeParser('m1');
    const r = await p.parseIncremental(file, 0);

    expect(r.messages).toHaveLength(2);

    const toolUse = r.messages[0];
    expect(toolUse.role).toBe('Assistant');
    expect(toolUse.contentBlocks[0].blockType).toBe('ShellCommand');
    expect(toolUse.contentBlocks[0].toolName).toBe('Bash');
    expect(toolUse.contentBlocks[0].toolInput).toEqual({ command: 'echo hi', description: 'print hi' });

    const toolResult = r.messages[1];
    expect(toolResult.role).toBe('ToolResult');
    expect(toolResult.contentBlocks[0].toolName).toBe('Bash');
    expect(toolResult.contentBlocks[0].content).toContain('hi');
  });

  test('incremental parsing by byte offset', async () => {
    const file = writeClaudeProjectJsonl([
      {
        type: 'user',
        uuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        parentUuid: null,
        timestamp: '2026-04-28T08:20:00.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
      },
    ]);

    const p = new ClaudeCodeParser('m1');
    const r1 = await p.parseIncremental(file, 0);
    expect(r1.messages).toHaveLength(1);

    appendClaudeProjectJsonl(file, [
      {
        type: 'assistant',
        uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        parentUuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        timestamp: '2026-04-28T08:20:01.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          model: 'anthropic/claude-sonnet-4.5',
          content: [{ type: 'text', text: 'second' }],
          usage: {
            input_tokens: 12,
            output_tokens: 8,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
    ]);

    const r2 = await p.parseIncremental(file, r1.newOffset);
    expect(r2.messages).toHaveLength(1);
    expect(r2.messages[0].role).toBe('Assistant');
    expect(r2.messages[0].contentBlocks[0].content).toBe('second');
    expect(r2.newOffset).toBeGreaterThan(r1.newOffset);

    const r3 = await p.parseIncremental(file, r2.newOffset);
    expect(r3.messages).toHaveLength(0);
    expect(r3.newOffset).toBe(r2.newOffset);
  });
});

describe('ClaudeCodeParser - response-level merging', () => {
  test('consecutive assistant rows sharing message.id merge into one message with one usage', async () => {
    // Claude Code splits one API response across multiple jsonl rows
    // (thinking / tool_use / text). All rows carry the SAME cumulative usage.
    // The parser must collapse them into a single normalized message so the
    // displayed token counts and computed cost are not multiplied by the
    // number of split rows.
    const sharedUsage = {
      input_tokens: 13794,
      output_tokens: 474,
      cache_creation_input_tokens: 13788,
      cache_read_input_tokens: 26417,
    };
    const file = writeClaudeProjectJsonl([
      {
        type: 'assistant',
        uuid: 'a1111111-1111-4111-8111-111111111111',
        parentUuid: null,
        timestamp: '2026-04-28T08:00:00.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: {
          id: 'msg_shared',
          role: 'assistant',
          model: 'anthropic/claude-opus-4.6',
          content: [{ type: 'thinking', thinking: 'planning...' }],
          usage: sharedUsage,
        },
      },
      {
        type: 'assistant',
        uuid: 'a2222222-2222-4222-8222-222222222222',
        parentUuid: 'a1111111-1111-4111-8111-111111111111',
        timestamp: '2026-04-28T08:00:00.500Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: {
          id: 'msg_shared',
          role: 'assistant',
          model: 'anthropic/claude-opus-4.6',
          content: [
            { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: 'a.ts' } },
          ],
          usage: sharedUsage,
        },
      },
      {
        type: 'assistant',
        uuid: 'a3333333-3333-4333-8333-333333333333',
        parentUuid: 'a2222222-2222-4222-8222-222222222222',
        timestamp: '2026-04-28T08:00:01.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: {
          id: 'msg_shared',
          role: 'assistant',
          model: 'anthropic/claude-opus-4.6',
          content: [{ type: 'text', text: 'done' }],
          usage: sharedUsage,
        },
      },
    ]);

    const p = new ClaudeCodeParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages).toHaveLength(1);
    const m = r.messages[0];
    expect(m.metadata.sourceMessageId).toBe('msg_shared');
    const blockTypes = m.contentBlocks.map((b) => b.blockType);
    expect(blockTypes).toContain('Thinking');
    expect(blockTypes).toContain('FileRead');
    expect(blockTypes).toContain('Text');
    expect(m.usage?.inputTokens).toBe(13794);
    expect(m.usage?.outputTokens).toBe(474);
    expect(m.usage?.cacheCreationInputTokens).toBe(13788);
    expect(m.usage?.cacheReadInputTokens).toBe(26417);
  });

  test('separate message.ids stay separate', async () => {
    const file = writeClaudeProjectJsonl([
      {
        type: 'assistant',
        uuid: 'b1111111-1111-4111-8111-111111111111',
        parentUuid: null,
        timestamp: '2026-04-28T08:00:00.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: {
          id: 'msg_A',
          role: 'assistant',
          model: 'anthropic/claude-opus-4.6',
          content: [{ type: 'text', text: 'one' }],
          usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        uuid: 'b2222222-2222-4222-8222-222222222222',
        parentUuid: 'b1111111-1111-4111-8111-111111111111',
        timestamp: '2026-04-28T08:00:01.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      },
      {
        type: 'assistant',
        uuid: 'b3333333-3333-4333-8333-333333333333',
        parentUuid: 'b2222222-2222-4222-8222-222222222222',
        timestamp: '2026-04-28T08:00:02.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: {
          id: 'msg_B',
          role: 'assistant',
          model: 'anthropic/claude-opus-4.6',
          content: [{ type: 'text', text: 'two' }],
          usage: { input_tokens: 200, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
    ]);

    const p = new ClaudeCodeParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages).toHaveLength(3);
    expect(r.messages[0].usage?.outputTokens).toBe(10);
    expect(r.messages[2].usage?.outputTokens).toBe(20);
  });

  test('incremental tick re-emits merged group with stable id when new line joins', async () => {
    const sharedUsage = {
      input_tokens: 50,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const file = writeClaudeProjectJsonl([
      {
        type: 'assistant',
        uuid: 'c1111111-1111-4111-8111-111111111111',
        parentUuid: null,
        timestamp: '2026-04-28T08:00:00.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: {
          id: 'msg_split',
          role: 'assistant',
          model: 'anthropic/claude-opus-4.6',
          content: [{ type: 'thinking', thinking: 'plan' }],
          usage: sharedUsage,
        },
      },
    ]);

    const p = new ClaudeCodeParser('m1');
    const r1 = await p.parseIncremental(file, 0);
    expect(r1.messages).toHaveLength(1);
    const idAfterFirstTick = r1.messages[0].id;

    appendClaudeProjectJsonl(file, [
      {
        type: 'assistant',
        uuid: 'c2222222-2222-4222-8222-222222222222',
        parentUuid: 'c1111111-1111-4111-8111-111111111111',
        timestamp: '2026-04-28T08:00:00.500Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: {
          id: 'msg_split',
          role: 'assistant',
          model: 'anthropic/claude-opus-4.6',
          content: [{ type: 'text', text: 'reply' }],
          usage: sharedUsage,
        },
      },
    ]);

    const r2 = await p.parseIncremental(file, r1.newOffset);
    // Stable id => upsert overwrites the prior partial row with the merged form.
    expect(r2.messages).toHaveLength(1);
    expect(r2.messages[0].id).toBe(idAfterFirstTick);
    const blockTypes = r2.messages[0].contentBlocks.map((b) => b.blockType);
    expect(blockTypes).toContain('Thinking');
    expect(blockTypes).toContain('Text');
    expect(r2.messages[0].usage?.outputTokens).toBe(30);
  });
});

describe('ClaudeCodeParser - file edit tools', () => {
  test('Edit tool produces FileEdit block with diff and applied status', async () => {
    const file = writeClaudeProjectJsonl([
      {
        type: 'assistant',
        uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        parentUuid: null,
        timestamp: '2026-04-28T08:00:00.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        cwd: '/work/demo',
        gitBranch: 'main',
        message: {
          id: 'msg_edit',
          role: 'assistant',
          model: 'anthropic/claude-opus-4.6',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_edit_1',
              name: 'Edit',
              input: { file_path: 'src/x.ts', old_string: 'foo', new_string: 'bar' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        parentUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        timestamp: '2026-04-28T08:00:01.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_edit_1', content: 'ok' },
          ],
        },
      },
    ]);

    const p = new ClaudeCodeParser('m1');
    const r = await p.parseIncremental(file, 0);
    // The successful tool_result is folded into the FileEdit block's status,
    // so the trailing user message has no visible blocks and is skipped.
    expect(r.messages.length).toBe(1);
    const editBlock = r.messages[0].contentBlocks.find((b) => b.blockType === 'FileEdit');
    expect(editBlock).toBeDefined();
    expect(editBlock!.filePath).toBe('src/x.ts');
    expect(editBlock!.diff).toContain('-foo');
    expect(editBlock!.diff).toContain('+bar');
    expect(editBlock!.toolName).toBe('Edit');
    const meta = (editBlock!.toolInput as Record<string, unknown>).editMeta as Record<string, unknown>;
    expect(meta.operation).toBe('update');
    expect(meta.status).toBe('applied');
    expect(meta.cwd).toBe('/work/demo');
    expect(meta.gitBranch).toBe('main');
  });

  test('Failed Edit tool_result flips status to failed and emits Error block', async () => {
    const file = writeClaudeProjectJsonl([
      {
        type: 'assistant',
        uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        parentUuid: null,
        timestamp: '2026-04-28T08:00:00.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: {
          role: 'assistant',
          model: 'anthropic/claude-opus-4.6',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_edit_2',
              name: 'Edit',
              input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        parentUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        timestamp: '2026-04-28T08:00:01.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_edit_2', content: 'string not found', is_error: true },
          ],
        },
      },
    ]);
    const p = new ClaudeCodeParser('m1');
    const r = await p.parseIncremental(file, 0);
    const editBlock = r.messages[0].contentBlocks.find((b) => b.blockType === 'FileEdit')!;
    const meta = (editBlock.toolInput as Record<string, unknown>).editMeta as Record<string, unknown>;
    expect(meta.status).toBe('failed');
    const errorBlock = r.messages[1].contentBlocks.find((b) => b.blockType === 'Error');
    expect(errorBlock).toBeDefined();
    expect(errorBlock!.content).toContain('string not found');
  });

  test('MultiEdit produces a single FileEdit with combined hunks', async () => {
    const file = writeClaudeProjectJsonl([
      {
        type: 'assistant',
        uuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        parentUuid: null,
        timestamp: '2026-04-28T08:00:00.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: {
          role: 'assistant',
          model: 'anthropic/claude-opus-4.6',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_me_1',
              name: 'MultiEdit',
              input: {
                file_path: 'm.ts',
                edits: [
                  { old_string: 'a', new_string: 'A' },
                  { old_string: 'b', new_string: 'B' },
                ],
              },
            },
          ],
        },
      },
    ]);
    const p = new ClaudeCodeParser('m1');
    const r = await p.parseIncremental(file, 0);
    const editBlocks = r.messages[0].contentBlocks.filter((b) => b.blockType === 'FileEdit');
    expect(editBlocks).toHaveLength(1);
    expect(editBlocks[0].diff).toContain('-a');
    expect(editBlocks[0].diff).toContain('+A');
    expect(editBlocks[0].diff).toContain('-b');
    expect(editBlocks[0].diff).toContain('+B');
    expect(editBlocks[0].content).toContain('2 hunks');
  });

  test('Write produces FileEdit with operation=create', async () => {
    const file = writeClaudeProjectJsonl([
      {
        type: 'assistant',
        uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        parentUuid: null,
        timestamp: '2026-04-28T08:00:00.000Z',
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: {
          role: 'assistant',
          model: 'anthropic/claude-opus-4.6',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_w_1',
              name: 'Write',
              input: { file_path: 'new.txt', content: 'hello\nworld' },
            },
          ],
        },
      },
    ]);
    const p = new ClaudeCodeParser('m1');
    const r = await p.parseIncremental(file, 0);
    const editBlock = r.messages[0].contentBlocks.find((b) => b.blockType === 'FileEdit')!;
    expect(editBlock.filePath).toBe('new.txt');
    expect(editBlock.diff).toContain('+hello');
    expect(editBlock.diff).toContain('+world');
    const meta = (editBlock.toolInput as Record<string, unknown>).editMeta as Record<string, unknown>;
    expect(meta.operation).toBe('create');
  });
});
