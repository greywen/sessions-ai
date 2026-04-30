import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CopilotParser } from '../src/parser/copilot.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lsv-copilot-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const SESSION_ID = '068bb289-7263-48e1-a41d-c03e773bee19';

function writeJsonl(lines: unknown[]): string {
  const dir = join(tempDir, 'workspaceStorage', 'wsabc', 'chatSessions');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${SESSION_ID}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

/**
 * Build a minimal valid request object.
 */
function buildRequest(opts: {
  requestId: string;
  text: string;
  timestamp: number;
  modelId?: string;
  response?: unknown[];
  completedAt?: number;
}) {
  return {
    requestId: opts.requestId,
    timestamp: opts.timestamp,
    modelId: opts.modelId ?? 'claude-opus-4.6',
    agent: { id: 'github.copilot', extensionVersion: '0.40.1' },
    modelState: opts.completedAt ? { value: 1, completedAt: opts.completedAt } : undefined,
    message: {
      text: opts.text,
      parts: [{ kind: 'text', text: opts.text }],
    },
    response: opts.response ?? [],
  };
}

describe('CopilotParser - 基础识别', () => {
  test('toolType 与 fileExtensions', () => {
    const p = new CopilotParser('m1');
    expect(p.toolType()).toBe('GitHubCopilot');
    expect(p.fileExtensions()).toEqual(['jsonl']);
  });

  test('matches: chatSessions 目录下的 .jsonl 才算', () => {
    const p = new CopilotParser('m1');
    expect(p.matches('/x/y/chatSessions/abc.jsonl')).toBe(true);
    expect(p.matches('/x/y/other/abc.jsonl')).toBe(false);
    expect(p.matches('/x/y/chatSessions/abc.txt')).toBe(false);
  });
});

describe('CopilotParser - 单 request 解析', () => {
  test('已完成 request 输出 user + assistant 两条', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          version: 3,
          creationDate: 1000,
          sessionId: SESSION_ID,
          initialLocation: 'panel',
          hasPendingEdits: false,
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'hello',
              timestamp: 1000,
              completedAt: 2000,
              response: [{ value: 'hi there' }],
            }),
          ],
          pendingRequests: [],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages).toHaveLength(2);
    const [user, asst] = r.messages;
    expect(user.role).toBe('User');
    expect(user.contentBlocks[0].content).toBe('hello');
    expect(asst.role).toBe('Assistant');
    expect(asst.contentBlocks[0].blockType).toBe('Text');
    expect(asst.contentBlocks[0].content).toBe('hi there');
    expect(asst.parentId).toBe(user.id);
    expect(user.sessionId).toBe(asst.sessionId);
    expect(r.newOffset).toBe(2000);
  });

  test('未完成 request 不输出', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'pending',
              timestamp: 1000,
              response: [{ value: 'partial' }],
              // No completedAt
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages).toHaveLength(0);
    expect(r.newOffset).toBe(0);
  });
});

describe('CopilotParser - 内容块映射', () => {
  test('thinking / 文本 / toolInvocation / inlineReference 全部正确转换', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'q',
              timestamp: 1000,
              completedAt: 2000,
              response: [
                { kind: 'thinking', value: 'pondering...', id: 'th1' },
                { value: 'final answer text' },
                {
                  kind: 'inlineReference',
                  inlineReference: { path: '/x/y.py', name: 'y.py' },
                },
                {
                  kind: 'toolInvocationSerialized',
                  invocationMessage: { value: 'Reading foo.py' },
                  pastTenseMessage: { value: 'Read foo.py' },
                  toolCallId: 'tc1',
                  toolId: 'copilot_readFile',
                  isComplete: true,
                },
                {
                  kind: 'toolInvocationSerialized',
                  invocationMessage: 'Search regex foo',
                  pastTenseMessage: 'Searched',
                  toolCallId: 'tc2',
                  toolId: 'copilot_findTextInFiles',
                  isComplete: true,
                },
                { kind: 'mcpServersStarting', didStartServerIds: [] },
              ],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages).toHaveLength(2);
    const asst = r.messages[1];
    const types = asst.contentBlocks.map((b) => b.blockType);
    expect(types).toContain('Thinking');
    expect(types).toContain('Text');
    expect(types).toContain('FileRead');
    expect(types).toContain('SearchResult');
    expect(types).not.toContain('Unknown');
    // inlineReference should be appended to the end of the previous Text block
    const text = asst.contentBlocks.find((b) => b.blockType === 'Text')!;
    expect(text.content).toContain('final answer text');
    expect(text.content).toContain('[y.py](/x/y.py)');
    // Every ToolCall should carry toolName
    const fr = asst.contentBlocks.find((b) => b.blockType === 'FileRead')!;
    expect(fr.toolName).toBe('copilot_readFile');
  });

  test('内部信号类 part（undoStop / textEditGroup / workspaceEdit / codeblockUri / progressTask 等）静默丢弃', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'q',
              timestamp: 1000,
              completedAt: 2000,
              response: [
                { value: 'hello' },
                { kind: 'undoStop', id: 'u1' },
                { kind: 'textEditGroup', uri: { path: '/a' }, edits: [], done: true },
                { kind: 'codeblockUri', uri: { path: '/a' }, isEdit: true },
                { kind: 'workspaceEdit', edits: [] },
                { kind: 'confirmation', title: 't', message: 'm', data: {}, buttons: [] },
                { kind: 'elicitationSerialized', title: 't', message: 'm', state: 'pending' },
                { kind: 'progressTaskSerialized', content: { value: 'x' }, progress: [] },
                { kind: 'progressMessage', content: { value: 'x' }, shimmer: true },
                { kind: 'questionCarousel', questions: [], allowSkip: true },
                { kind: 'command', command: { id: 'c', title: 't' } },
                { value: 'world' },
              ],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    const asst = r.messages[1];
    const types = asst.contentBlocks.map((b) => b.blockType);
    expect(types).not.toContain('Unknown');
    // hello and world should merge into a single Text block
    expect(asst.contentBlocks).toHaveLength(1);
    expect(asst.contentBlocks[0].blockType).toBe('Text');
    expect(asst.contentBlocks[0].content).toBe('helloworld');
  });

  test('terminal 工具拆为 ShellCommand + ShellOutput，含 exitCode', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'q',
              timestamp: 1000,
              completedAt: 2000,
              response: [
                {
                  kind: 'toolInvocationSerialized',
                  toolId: 'run_in_terminal',
                  invocationMessage: { value: 'Running ` ls -la`' },
                  isComplete: true,
                  toolSpecificData: {
                    kind: 'terminal',
                    commandLine: { original: 'ls -la', toolEdited: ' ls -la', forDisplay: 'ls -la' },
                    cwd: { path: '/home/user' },
                    language: 'sh',
                    isBackground: false,
                    terminalCommandState: { exitCode: 0, timestamp: 1, duration: 100 },
                    terminalCommandOutput: { text: 'total 8\nfile.txt\n', lineCount: 2 },
                  },
                },
              ],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    const asst = r.messages[1];
    const cmd = asst.contentBlocks.find((b) => b.blockType === 'ShellCommand');
    const out = asst.contentBlocks.find((b) => b.blockType === 'ShellOutput');
    expect(cmd).toBeDefined();
    expect(cmd?.content).toBe('ls -la');
    expect(cmd?.exitCode).toBe(0);
    expect(cmd?.toolName).toBe('run_in_terminal');
    expect(out).toBeDefined();
    expect(out?.content).toBe('total 8\nfile.txt\n');
  });

  test('terminal 工具：失败退出码透传到 ShellCommand', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'q',
              timestamp: 1000,
              completedAt: 2000,
              response: [
                {
                  kind: 'toolInvocationSerialized',
                  toolId: 'run_in_terminal',
                  isComplete: true,
                  toolSpecificData: {
                    kind: 'terminal',
                    commandLine: { original: 'cargo build' },
                    terminalCommandState: { exitCode: 101 },
                    terminalCommandOutput: { text: 'error[E0432]: ...\n' },
                  },
                },
              ],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    const asst = r.messages[1];
    const cmd = asst.contentBlocks.find((b) => b.blockType === 'ShellCommand');
    expect(cmd?.exitCode).toBe(101);
  });

  test('invocationMessage 中 `[](file://...)` 空链接被替换为 [basename](path)', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'q',
              timestamp: 1000,
              completedAt: 2000,
              response: [
                {
                  kind: 'toolInvocationSerialized',
                  toolId: 'copilot_readFile',
                  isComplete: true,
                  pastTenseMessage: {
                    value: 'Read [](file:///a/b/c.ts), lines 10 to 20',
                    uris: { 'file:///a/b/c.ts': { path: '/a/b/c.ts' } },
                  },
                },
              ],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    const asst = r.messages[1];
    const fr = asst.contentBlocks.find((b) => b.blockType === 'FileRead')!;
    expect(fr.content).toBe('Read [c.ts](/a/b/c.ts), lines 10 to 20');
    expect(fr.filePath).toBe('/a/b/c.ts');
  });

  test('空 response 至少产生一个空 Text block', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'q',
              timestamp: 1000,
              completedAt: 2000,
              response: [],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    const asst = r.messages[1];
    expect(asst.contentBlocks).toHaveLength(1);
    expect(asst.contentBlocks[0].blockType).toBe('Text');
  });
});

describe('CopilotParser - JSON pointer 补丁回放', () => {
  test('kind:1 替换 — modelState 后置补全', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'q',
              timestamp: 1000,
              response: [{ value: 'partial' }],
            }),
          ],
          inputState: {},
        },
      },
      // A later patch marks completion
      { kind: 1, k: ['requests', 0, 'modelState'], v: { value: 1, completedAt: 5000 } },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages).toHaveLength(2);
    expect(r.newOffset).toBe(5000);
  });

  test('kind:2 无 i — 追加新 request', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: { requests: [], inputState: {} },
      },
      {
        kind: 2,
        k: ['requests'],
        v: [
          buildRequest({
            requestId: 'req-1',
            text: 'first',
            timestamp: 1000,
            completedAt: 2000,
            response: [{ value: 'a1' }],
          }),
        ],
      },
      {
        kind: 2,
        k: ['requests'],
        v: [
          buildRequest({
            requestId: 'req-2',
            text: 'second',
            timestamp: 3000,
            completedAt: 4000,
            response: [{ value: 'a2' }],
          }),
        ],
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages).toHaveLength(4);
    expect(r.messages[0].contentBlocks[0].content).toBe('first');
    expect(r.messages[2].contentBlocks[0].content).toBe('second');
  });

  test('kind:2 带 i — 在指定位置插入 response 元素', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'q',
              timestamp: 1000,
              completedAt: 2000,
              response: [{ value: 'A' }, { value: 'C' }],
            }),
          ],
          inputState: {},
        },
      },
      // Insert B at index 1
      { kind: 2, k: ['requests', 0, 'response'], v: [{ value: 'B' }], i: 1 },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    const asst = r.messages[1];
    // Consecutive Text parts should merge into one block in insertion order
    const texts = asst.contentBlocks.filter((b) => b.blockType === 'Text').map((b) => b.content);
    expect(texts).toEqual(['ABC']);
  });
});

describe('CopilotParser - 增量水位', () => {
  test('offset 之后只发出更新过的 request', async () => {
    const lines = [
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'q1',
              timestamp: 1000,
              completedAt: 2000,
              response: [{ value: 'a1' }],
            }),
            buildRequest({
              requestId: 'req-2',
              text: 'q2',
              timestamp: 3000,
              completedAt: 4000,
              response: [{ value: 'a2' }],
            }),
          ],
          inputState: {},
        },
      },
    ];
    const file = writeJsonl(lines);
    const p = new CopilotParser('m1');
    // Pretend the previous watermark stopped at 2500 (right after req-1)
    const r = await p.parseIncremental(file, 2500);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].contentBlocks[0].content).toBe('q2');
    expect(r.newOffset).toBe(4000);
  });

  test('无新增 → 空结果，offset 不变', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'q',
              timestamp: 1000,
              completedAt: 2000,
              response: [{ value: 'a' }],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 5000);
    expect(r.messages).toHaveLength(0);
    expect(r.newOffset).toBe(5000);
  });
});

describe('CopilotParser - 鲁棒性', () => {
  test('response 含 null/非对象元素被跳过，不抛异常', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'q',
              timestamp: 1000,
              completedAt: 2000,
              response: [null, 'string-part', { value: 'ok' }, undefined as unknown],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages).toHaveLength(2);
    const asst = r.messages[1];
    expect(asst.contentBlocks.some((b) => b.content === 'ok')).toBe(true);
  });

  test('损坏的行被跳过，不影响整体', async () => {
    const dir = join(tempDir, 'workspaceStorage', 'ws', 'chatSessions');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${SESSION_ID}.jsonl`);
    const good = JSON.stringify({
      kind: 0,
      v: {
        requests: [
          buildRequest({
            requestId: 'req-1',
            text: 'q',
            timestamp: 1000,
            completedAt: 2000,
            response: [{ value: 'a' }],
          }),
        ],
        inputState: {},
      },
    });
    writeFileSync(file, good + '\n{garbage not json}\n');
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages).toHaveLength(2);
  });

  test('UUID 派生稳定 — 同 requestId 多次解析 id 相同', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-stable',
              text: 'q',
              timestamp: 1000,
              completedAt: 2000,
              response: [{ value: 'a' }],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p1 = new CopilotParser('m1');
    const p2 = new CopilotParser('m1');
    const r1 = await p1.parseIncremental(file, 0);
    const r2 = await p2.parseIncremental(file, 0);
    expect(r1.messages[0].id).toBe(r2.messages[0].id);
    expect(r1.messages[1].id).toBe(r2.messages[1].id);
  });

  test('sessionId 取自文件名', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'q',
              timestamp: 1000,
              completedAt: 2000,
              response: [{ value: 'a' }],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    // sessionId should be uuidv5-derived from SESSION_ID (or keep original UUID)
    expect(r.messages[0].sessionId).toBe(r.messages[1].sessionId);
    // Both messages should share the same sessionId
  });

  test('sourceTool / machineId 正确', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'q',
              timestamp: 1000,
              completedAt: 2000,
              response: [{ value: 'a' }],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('mach-xyz');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages[0].sourceTool).toBe('GitHubCopilot');
    expect(r.messages[0].machineId).toBe('mach-xyz');
  });
});

describe('CopilotParser - 元数据/标题/Token 同步', () => {
  test('customTitle / responderUsername / initialLocation 注入到 metadata', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          version: 3,
          customTitle: '测试会话标题',
          responderUsername: 'GitHub Copilot',
          initialLocation: 'panel',
          sessionId: SESSION_ID,
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'q',
              timestamp: 1000,
              completedAt: 2000,
              response: [{ value: 'a' }],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages).toHaveLength(2);
    for (const m of r.messages) {
      expect(m.metadata.sessionTitle).toBe('测试会话标题');
      expect(m.metadata.initialLocation).toBe('panel');
      expect(m.metadata.responderUsername).toBe('GitHub Copilot');
      expect(m.metadata.sourceSessionId).toBe(SESSION_ID);
    }
  });

  test('agent.id / extensionVersion / responseId / modeInfo 同步到 metadata', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            {
              requestId: 'req-1',
              timestamp: 1000,
              modelId: 'gpt-5.3',
              responseId: 'resp_abc',
              agent: { id: 'github.copilot.editsAgent', extensionVersion: '0.40.1' },
              modeInfo: { kind: 'agent', modeId: 'agent', modeName: 'agent' },
              modelState: { value: 1, completedAt: 2000 },
              message: { text: 'hi', parts: [] },
              response: [{ value: 'ok' }],
            },
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    const asst = r.messages[1];
    expect(asst.metadata.responseId).toBe('resp_abc');
    expect(asst.metadata.mode).toBe('agent');
    expect(asst.metadata.agentId).toBe('github.copilot.editsAgent');
    expect(asst.metadata.extensionVersion).toBe('0.40.1');
    expect(asst.metadata.model).toBe('gpt-5.3');
  });

  test('VS Code 不持久化 prompt/completion tokens：usage 始终为 null（即便 metadata 出现这些字段）', async () => {
    // Even when (hypothetically) Copilot puts promptTokens/outputTokens in
    // metadata, we no longer trust them — historic versions never wrote them
    // and current versions still don't. Honest absence over fake numbers.
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            {
              requestId: 'req-1',
              timestamp: 1000,
              modelId: 'gpt-5.3',
              modelState: { value: 1, completedAt: 2000 },
              message: { text: 'q', parts: [] },
              response: [{ value: 'a' }],
              result: {
                metadata: {
                  resolvedModel: 'claude-opus-4-6',
                  promptTokens: 95551,
                  outputTokens: 1076,
                  toolCallRounds: [{ thinking: { tokens: 50 } }],
                },
              },
            },
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    const asst = r.messages[1];
    expect(asst.usage).toBeNull();
    expect(asst.metadata.model).toBe('claude-opus-4-6');
  });

  test('toolCallRounds[*].thinking.tokens 累加到 metadata.thinkingTokens（不再伪装成 outputTokens）', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            {
              requestId: 'req-1',
              timestamp: 1000,
              modelId: 'gpt-5.3',
              modelState: { value: 1, completedAt: 2000 },
              message: { text: 'q', parts: [] },
              response: [{ value: 'a' }],
              result: {
                timings: { totalElapsed: 12345 },
                metadata: {
                  resolvedModel: 'copilot/gpt-5.3-codex',
                  toolCallRounds: [
                    { thinking: { tokens: 90 } },
                    { thinking: { tokens: 10 } },
                    { thinking: {} }, // missing tokens
                    {}, // missing thinking
                  ],
                },
              },
            },
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    const asst = r.messages[1];
    expect(asst.usage).toBeNull();
    expect(asst.metadata.thinkingTokens).toBe(100);
    expect(asst.metadata.elapsedMs).toBe(12345);
    expect(asst.metadata.toolCallRoundCount).toBe(4);
    expect(asst.metadata.model).toBe('copilot/gpt-5.3-codex');
  });

  test('无 toolCallRounds 时 usage 为 null（不伪造 token）', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-1',
              text: 'q',
              timestamp: 1000,
              completedAt: 2000,
              response: [{ value: 'a' }],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages[1].usage).toBeNull();
  });

  test('容错：message 缺失、modelId 缺失、response 非数组都不应崩溃', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            {
              requestId: 'req-1',
              timestamp: 1000,
              modelState: { value: 1, completedAt: 2000 },
              // message is entirely missing
              // modelId is missing
              // response is not an array
              response: 'not-an-array' as unknown,
            },
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].contentBlocks[0].content).toBe('');
    expect(r.messages[1].metadata.model).toBe('unknown');
  });

  test('null/无效 timestamp 不输出消息', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            {
              requestId: 'req-1',
              timestamp: 'not-number' as unknown,
              modelState: { value: 1, completedAt: 2000 },
              message: { text: 'q' },
              response: [{ value: 'a' }],
            },
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages).toHaveLength(0);
  });
});

describe('CopilotParser - workspaceEdit / textEditGroup -> FileEdit', () => {
  test('textEditGroup with oldText produces FileEdit + diff', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-edit-1',
              text: 'do edit',
              timestamp: 1000,
              completedAt: 2000,
              response: [
                {
                  kind: 'textEditGroup',
                  uri: { path: '/repo/src/a.ts', scheme: 'file' },
                  edits: [
                    [
                      {
                        range: { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 4 },
                        newText: 'bar',
                        oldText: 'foo',
                      },
                    ],
                  ],
                },
              ],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    const asst = r.messages[1];
    const editBlock = asst.contentBlocks.find((b) => b.blockType === 'FileEdit');
    expect(editBlock).toBeDefined();
    expect(editBlock!.filePath).toBe('/repo/src/a.ts');
    expect(editBlock!.diff).toContain('-foo');
    expect(editBlock!.diff).toContain('+bar');
    const meta = (editBlock!.toolInput as Record<string, unknown>).editMeta as Record<string, unknown>;
    expect(meta.operation).toBe('update');
    expect(meta.status).toBe('applied');
  });

  test('textEditGroup without oldText still emits FileEdit but diff=null', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-edit-2',
              text: 'edit without old',
              timestamp: 1000,
              completedAt: 2000,
              response: [
                {
                  kind: 'textEditGroup',
                  uri: { path: '/repo/b.ts' },
                  edits: [
                    [
                      {
                        range: { startLineNumber: 5, endLineNumber: 5, startColumn: 1, endColumn: 1 },
                        newText: 'new content here',
                      },
                    ],
                  ],
                },
              ],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    const asst = r.messages[1];
    const editBlock = asst.contentBlocks.find((b) => b.blockType === 'FileEdit')!;
    expect(editBlock.filePath).toBe('/repo/b.ts');
    expect(editBlock.diff).toBeNull();
    expect(editBlock.content).toContain('L5-L5');
  });

  test('workspaceEdit produces one FileEdit per file', async () => {
    const file = writeJsonl([
      {
        kind: 0,
        v: {
          requests: [
            buildRequest({
              requestId: 'req-edit-3',
              text: 'multi file edit',
              timestamp: 1000,
              completedAt: 2000,
              response: [
                {
                  kind: 'workspaceEdit',
                  edits: [
                    {
                      resource: { path: '/repo/x.ts' },
                      textEdit: { range: {}, newText: 'X', oldText: 'x' },
                    },
                    {
                      resource: { path: '/repo/y.ts' },
                      textEdit: { range: {}, newText: 'Y', oldText: 'y' },
                    },
                    {
                      resource: { path: '/repo/x.ts' },
                      textEdit: { range: {}, newText: 'X2', oldText: 'x2' },
                    },
                  ],
                },
              ],
            }),
          ],
          inputState: {},
        },
      },
    ]);
    const p = new CopilotParser('m1');
    const r = await p.parseIncremental(file, 0);
    const asst = r.messages[1];
    const edits = asst.contentBlocks.filter((b) => b.blockType === 'FileEdit');
    expect(edits).toHaveLength(2);
    const paths = edits.map((b) => b.filePath).sort();
    expect(paths).toEqual(['/repo/x.ts', '/repo/y.ts']);
    const xBlock = edits.find((b) => b.filePath === '/repo/x.ts')!;
    expect(xBlock.diff).toContain('-x');
    expect(xBlock.diff).toContain('+X');
    expect(xBlock.diff).toContain('-x2');
    expect(xBlock.diff).toContain('+X2');
  });
});
