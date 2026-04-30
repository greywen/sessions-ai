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
    expect(asst.usage?.inputTokens).toBe(93);
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
    expect(toolUse.role).toBe('ToolUse');
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
