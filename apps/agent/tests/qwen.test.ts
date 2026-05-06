import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QwenCodeParser } from '../src/parser/qwen.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lsv-qwen-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeQoderJsonl(entries: unknown[], fileName = 'task-abc.session.execution.jsonl'): string {
  const dir = join(tempDir, 'Qoder', 'SharedClientCache', 'cli', 'projects', 'demo-project');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, fileName);
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

function appendQoderJsonl(filePath: string, entries: unknown[]): void {
  appendFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function writeAcpLog(entries: unknown[]): string {
  const dir = join(tempDir, 'Qoder', 'SharedClientCache', 'cli', 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'acp.log');
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

function appendAcpLog(filePath: string, entries: unknown[]): void {
  appendFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function writeLegacyLogs(entries: unknown[]): string {
  const dir = join(tempDir, '.qwen', 'tmp', 'abc123def456');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'logs.json');
  writeFileSync(file, JSON.stringify(entries));
  return file;
}

describe('QwenCodeParser - identity and matching', () => {
  test('toolType / fileExtensions', () => {
    const p = new QwenCodeParser('m1');
    expect(p.toolType()).toBe('QwenCode');
    expect(p.fileExtensions()).toEqual(['jsonl', 'json', 'log']);
  });

  test('matches qoder jsonl, acp.log and legacy qwen logs.json', () => {
    const p = new QwenCodeParser('m1');
    expect(
      p.matches('C:/Users/u/AppData/Roaming/Qoder/SharedClientCache/cli/projects/demo/task-x.session.execution.jsonl'),
    ).toBe(true);
    expect(
      p.matches('C:/Users/u/AppData/Roaming/Qoder/SharedClientCache/cli/logs/acp.log'),
    ).toBe(true);
    expect(p.matches('/home/u/.qwen/tmp/abc/logs.json')).toBe(true);
    expect(p.matches('/home/u/.qwen/tmp/abc/other.json')).toBe(false);
    expect(
      p.matches('C:/Users/u/AppData/Roaming/Qoder/SharedClientCache/cli/projects/demo/anything.json'),
    ).toBe(false);
  });

  test('logPaths discovers Qoder projects + logs in platform-specific location', () => {
    const homeSpy = spyOn(nodeOs, 'homedir').mockReturnValue(tempDir);
    const oldAppData = process.env.APPDATA;
    const oldXdg = process.env.XDG_CONFIG_HOME;
    try {
      // Force POSIX branches to also resolve under tempDir
      process.env.APPDATA = tempDir;
      process.env.XDG_CONFIG_HOME = tempDir;

      let projectsBase: string;
      let logsBase: string;
      if (process.platform === 'win32') {
        projectsBase = join(tempDir, 'Qoder', 'SharedClientCache', 'cli', 'projects');
        logsBase = join(tempDir, 'Qoder', 'SharedClientCache', 'cli', 'logs');
      } else if (process.platform === 'darwin') {
        projectsBase = join(tempDir, 'Library', 'Application Support', 'Qoder', 'SharedClientCache', 'cli', 'projects');
        logsBase = join(tempDir, 'Library', 'Application Support', 'Qoder', 'SharedClientCache', 'cli', 'logs');
      } else {
        projectsBase = join(tempDir, 'Qoder', 'SharedClientCache', 'cli', 'projects');
        logsBase = join(tempDir, 'Qoder', 'SharedClientCache', 'cli', 'logs');
      }
      mkdirSync(projectsBase, { recursive: true });
      mkdirSync(logsBase, { recursive: true });
      const p = new QwenCodeParser('m1');
      expect(p.logPaths()).toContain(projectsBase);
      expect(p.logPaths()).toContain(logsBase);
    } finally {
      homeSpy.mockRestore();
      if (oldAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = oldAppData;
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
    }
  });
});

describe('QwenCodeParser - qoder jsonl parsing', () => {
  test('parses text/tool_use/tool_result/thinking in one stream', async () => {
    const file = writeQoderJsonl([
      {
        uuid: '11111111-1111-4111-8111-111111111111',
        sessionId: 'task-001.session.execution',
        type: 'user',
        timestamp: '2026-04-28T09:30:00.000Z',
        message: {
          id: 'm-1',
          role: 'user',
          content: [{ type: 'text', text: 'hello qoder' }],
        },
      },
      {
        uuid: '22222222-2222-4222-8222-222222222222',
        sessionId: 'task-001.session.execution',
        type: 'assistant',
        timestamp: '2026-04-28T09:30:01.000Z',
        message: {
          id: 'm-2',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              id: 'toolu_1',
              input: { command: 'git remote -v' },
            },
          ],
        },
      },
      {
        uuid: '33333333-3333-4333-8333-333333333333',
        sessionId: 'task-001.session.execution',
        type: 'user',
        timestamp: '2026-04-28T09:30:02.000Z',
        message: {
          id: 'm-3',
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'origin\thttps://github.com/example/repo.git',
            },
          ],
        },
      },
      {
        uuid: '44444444-4444-4444-8444-444444444444',
        sessionId: 'task-001.session.execution',
        type: 'assistant',
        timestamp: '2026-04-28T09:30:03.000Z',
        message: {
          id: 'm-4',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Need to summarize output.' },
            { type: 'text', text: 'Remote looks correct.' },
          ],
        },
      },
    ]);

    const p = new QwenCodeParser('m1');
    const r = await p.parseIncremental(file, 0);

    expect(r.messages.length).toBe(4);

    expect(r.messages[0].role).toBe('User');
    expect(r.messages[0].contentBlocks[0].content).toBe('hello qoder');

    expect(r.messages[1].role).toBe('ToolUse');
    expect(r.messages[1].contentBlocks[0].toolName).toBe('Bash');
    expect(r.messages[1].contentBlocks[0].toolInput).toEqual({ command: 'git remote -v' });

    expect(r.messages[2].role).toBe('ToolResult');
    expect(r.messages[2].contentBlocks[0].toolName).toBe('Bash');
    expect(r.messages[2].contentBlocks[0].content).toContain('origin');

    expect(r.messages[3].role).toBe('Assistant');
    expect(r.messages[3].contentBlocks[0].blockType).toBe('Thinking');
    expect(r.messages[3].contentBlocks[1].blockType).toBe('Text');
  });

  test('merges multiple rows with same message.id and keeps zero usage visible', async () => {
    const file = writeQoderJsonl([
      {
        uuid: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa',
        sessionId: 'task-merge.session.execution',
        type: 'assistant',
        timestamp: '2026-04-28T10:00:00.000Z',
        message: {
          id: 'msg-merge-1',
          role: 'assistant',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: 'thinking', thinking: 'I should inspect files first.' }],
        },
      },
      {
        uuid: 'bbbbbbbb-1111-4bbb-8bbb-bbbbbbbbbbbb',
        sessionId: 'task-merge.session.execution',
        type: 'assistant',
        timestamp: '2026-04-28T10:00:01.000Z',
        message: {
          id: 'msg-merge-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Done inspecting.' }],
        },
      },
    ]);

    const p = new QwenCodeParser('m1');
    const r = await p.parseIncremental(file, 0);

    expect(r.messages.length).toBe(1);
    expect(r.messages[0].contentBlocks.map((b) => b.blockType)).toEqual(['Thinking', 'Text']);
    expect(r.messages[0].usage).not.toBeNull();
    expect(r.messages[0].usage?.inputTokens).toBe(0);
    expect(r.messages[0].usage?.outputTokens).toBe(0);
  });

  test('incremental parsing by byte offset', async () => {
    const file = writeQoderJsonl([
      {
        uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sessionId: 'task-002.session.execution',
        type: 'user',
        timestamp: '2026-04-28T09:31:00.000Z',
        message: { id: 'm-1', role: 'user', content: [{ type: 'text', text: 'first' }] },
      },
    ]);

    const p = new QwenCodeParser('m1');
    const r1 = await p.parseIncremental(file, 0);
    expect(r1.messages.length).toBe(1);

    appendQoderJsonl(file, [
      {
        uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        sessionId: 'task-002.session.execution',
        type: 'assistant',
        timestamp: '2026-04-28T09:31:01.000Z',
        message: { id: 'm-2', role: 'assistant', content: [{ type: 'text', text: 'second' }] },
      },
    ]);

    const r2 = await p.parseIncremental(file, r1.newOffset);
    expect(r2.messages.length).toBe(1);
    expect(r2.messages[0].contentBlocks[0].content).toBe('second');
    expect(r2.newOffset).toBeGreaterThan(r1.newOffset);
  });
});

describe('QwenCodeParser - ACP token sync', () => {
  test('backfills non-zero usage from acp.log onto existing qoder messages', async () => {
    const qoderFile = writeQoderJsonl([
      {
        uuid: 'acp-11111111-1111-4111-8111-111111111111',
        sessionId: 'task-acp.session.execution',
        type: 'assistant',
        timestamp: '2026-04-28T11:00:00.000Z',
        message: {
          id: 'acp-msg-1',
          role: 'assistant',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: 'text', text: 'Initial answer' }],
        },
      },
    ], 'task-acp.session.execution.jsonl');

    const p = new QwenCodeParser('m1');
    const qoderResult = await p.parseIncremental(qoderFile, 0);
    expect(qoderResult.messages.length).toBe(1);
    expect(qoderResult.messages[0].usage?.inputTokens).toBe(0);

    const acpFile = writeAcpLog([
      {
        timestamp: '2026-04-28T11:00:01.000+08:00',
        method: 'session/update',
        request: {
          _meta: {
            'ai-coding/message-id': 'acp-msg-1',
            'ai-coding/message-end': false,
          },
          sessionId: 'task-acp.session.execution',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'chunk' },
          },
        },
        isNotify: true,
      },
      {
        timestamp: '2026-04-28T11:00:02.000+08:00',
        method: 'session/update',
        request: {
          sessionId: 'task-acp.session.execution',
          update: {
            sessionUpdate: 'notification',
            type: 'context_usage',
            data: {
              sessionId: 'task-acp.session.execution',
              promptTokens: 1234,
              completionTokens: 56,
              usedTokens: 1290,
              limitTokens: 200000,
            },
          },
        },
        isNotify: true,
      },
    ]);

    const acpResult = await p.parseIncremental(acpFile, 0);
    expect(acpResult.messages.length).toBe(1);
    expect(acpResult.messages[0].id).toBe(qoderResult.messages[0].id);
    expect(acpResult.messages[0].usage?.inputTokens).toBe(1234);
    expect(acpResult.messages[0].usage?.outputTokens).toBe(56);
    expect(acpResult.messages[0].metadata.usageSource).toBe('qoder_acp');

    const acpResult2 = await p.parseIncremental(acpFile, acpResult.newOffset);
    expect(acpResult2.messages.length).toBe(0);

    appendAcpLog(acpFile, [
      {
        timestamp: '2026-04-28T11:00:03.000+08:00',
        method: 'session/update',
        request: {
          sessionId: 'task-acp.session.execution',
          update: {
            sessionUpdate: 'notification',
            type: 'context_usage',
            data: {
              sessionId: 'task-acp.session.execution',
              promptTokens: 1300,
              completionTokens: 60,
              usedTokens: 1360,
              limitTokens: 200000,
            },
          },
        },
        isNotify: true,
      },
    ]);
    const acpResult3 = await p.parseIncremental(acpFile, acpResult.newOffset);
    expect(acpResult3.messages.length).toBe(1);
    expect(acpResult3.messages[0].usage?.inputTokens).toBe(1300);
    expect(acpResult3.messages[0].usage?.outputTokens).toBe(60);
  });
});

describe('QwenCodeParser - legacy qwen logs compatibility', () => {
  test('parses old logs.json array format', async () => {
    const file = writeLegacyLogs([
      {
        sessionId: 'legacy-s1',
        messageId: 0,
        type: 'user',
        message: 'hi from legacy',
        timestamp: '2025-11-20T10:00:00.000Z',
      },
      {
        sessionId: 'legacy-s1',
        messageId: 1,
        type: 'tool_call',
        toolName: 'read_file',
        toolArgs: { path: 'a.ts' },
        toolResult: 'file contents',
        timestamp: '2025-11-20T10:00:01.000Z',
      },
    ]);

    const p = new QwenCodeParser('m1');
    const r = await p.parseIncremental(file, 0);

    expect(r.messages.length).toBe(2);
    expect(r.messages[0].role).toBe('User');
    expect(r.messages[0].contentBlocks[0].content).toBe('hi from legacy');

    expect(r.messages[1].role).toBe('ToolUse');
    expect(r.messages[1].contentBlocks[0].toolName).toBe('read_file');
    expect(r.messages[1].contentBlocks[0].toolInput).toEqual({ path: 'a.ts' });
  });
});

describe('QwenCodeParser - FileEdit normalization', () => {
  test('replace tool emits FileEdit with diff', async () => {
    const file = writeQoderJsonl([
      {
        uuid: 'aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee',
        sessionId: 'task-edit.session.execution',
        type: 'assistant',
        timestamp: '2026-05-01T10:00:00.000Z',
        message: {
          id: 'm-edit-1',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'replace',
              id: 'toolu_e1',
              input: {
                file_path: 'src/foo.ts',
                old_string: 'a = 1',
                new_string: 'a = 2',
              },
            },
          ],
        },
      },
    ]);
    const p = new QwenCodeParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages.length).toBe(1);
    const block = r.messages[0].contentBlocks[0];
    expect(block.blockType).toBe('FileEdit');
    expect(block.filePath).toBe('src/foo.ts');
    expect(block.diff).toContain('-a = 1');
    expect(block.diff).toContain('+a = 2');
    expect((block.toolInput as Record<string, unknown>).editMeta).toMatchObject({
      operation: 'update',
      status: 'proposed',
    });
  });

  test('write_file tool emits FileEdit create', async () => {
    const file = writeQoderJsonl([
      {
        uuid: 'bbbbbbbb-eeee-4eee-8eee-eeeeeeeeeeee',
        sessionId: 'task-edit2.session.execution',
        type: 'assistant',
        timestamp: '2026-05-01T10:00:01.000Z',
        message: {
          id: 'm-edit-2',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'write_file',
              id: 'toolu_e2',
              input: { file_path: 'NEW.md', content: '# Hi\n' },
            },
          ],
        },
      },
    ]);
    const p = new QwenCodeParser('m1');
    const r = await p.parseIncremental(file, 0);
    const block = r.messages[0].contentBlocks[0];
    expect(block.blockType).toBe('FileEdit');
    expect(block.filePath).toBe('NEW.md');
    expect((block.toolInput as Record<string, unknown>).editMeta).toMatchObject({
      operation: 'create',
      status: 'proposed',
    });
    expect(block.diff).toContain('+# Hi');
  });

  test('legacy tool_call with edit_file maps to FileEdit applied/failed by result text', async () => {
    const file = writeLegacyLogs([
      {
        sessionId: 's-1',
        messageId: 1,
        type: 'tool_call',
        timestamp: '2026-05-02T10:00:00.000Z',
        toolName: 'edit',
        toolArgs: { file_path: 'x.ts', old_string: 'A', new_string: 'B' },
        toolResult: 'edit applied successfully',
      },
      {
        sessionId: 's-1',
        messageId: 2,
        type: 'tool_call',
        timestamp: '2026-05-02T10:00:01.000Z',
        toolName: 'edit',
        toolArgs: { file_path: 'y.ts', old_string: 'C', new_string: 'D' },
        toolResult: 'Error: file not found',
      },
    ]);
    const p = new QwenCodeParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages.length).toBe(2);
    const e1 = r.messages[0].contentBlocks[0];
    expect(e1.blockType).toBe('FileEdit');
    expect((e1.toolInput as Record<string, unknown>).editMeta).toMatchObject({
      operation: 'update',
      status: 'applied',
    });
    const e2 = r.messages[1].contentBlocks[0];
    expect((e2.toolInput as Record<string, unknown>).editMeta).toMatchObject({
      status: 'failed',
    });
  });

  test('non-edit tool_use stays as ToolCall', async () => {
    const file = writeQoderJsonl([
      {
        uuid: 'cccccccc-eeee-4eee-8eee-eeeeeeeeeeee',
        sessionId: 'task-grep.session.execution',
        type: 'assistant',
        timestamp: '2026-05-01T10:00:02.000Z',
        message: {
          id: 'm-grep',
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', id: 'toolu_g', input: { command: 'ls' } },
          ],
        },
      },
    ]);
    const p = new QwenCodeParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages[0].contentBlocks[0].blockType).toBe('ShellCommand');
  });
});
