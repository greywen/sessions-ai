import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpenCodeParser } from '../src/parser/opencode.ts';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lsv-opencode-'));
  dbPath = join(tempDir, 'opencode.db');
  const db = new Database(dbPath);
  // Replicate key columns from the real OpenCode schema
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      title TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  db.close();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

interface SessionInsert {
  id: string;
  parentId?: string | null;
  title?: string;
  time?: number;
}

function insertSession(s: SessionInsert) {
  const db = new Database(dbPath);
  const t = s.time ?? 1;
  db.run(
    'INSERT INTO session (id, parent_id, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)',
    [s.id, s.parentId ?? null, s.title ?? null, t, t],
  );
  db.close();
}

interface MsgInsert {
  id: string;
  sessionId: string;
  role: string;
  timeCreated: number;
  timeUpdated?: number;
  parentId?: string;
  modelId?: string;
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  cost?: number;
}

function insertMessage(m: MsgInsert) {
  const db = new Database(dbPath);
  const data: Record<string, unknown> = { role: m.role };
  if (m.parentId) data.parentID = m.parentId;
  if (m.modelId) data.modelID = m.modelId;
  if (m.tokens) data.tokens = m.tokens;
  if (m.cost !== undefined) data.cost = m.cost;
  db.run(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
    [m.id, m.sessionId, m.timeCreated, m.timeUpdated ?? m.timeCreated, JSON.stringify(data)],
  );
  db.close();
}

function updateMessage(id: string, timeUpdated: number, dataPatch?: Record<string, unknown>) {
  const db = new Database(dbPath);
  if (dataPatch) {
    const row = db.query<{ data: string }, [string]>('SELECT data FROM message WHERE id=?').get(id);
    const merged = { ...JSON.parse(row?.data ?? '{}'), ...dataPatch };
    db.run('UPDATE message SET time_updated=?, data=? WHERE id=?', [
      timeUpdated,
      JSON.stringify(merged),
      id,
    ]);
  } else {
    db.run('UPDATE message SET time_updated=? WHERE id=?', [timeUpdated, id]);
  }
  db.close();
}

function insertPart(opts: {
  id: string;
  messageId: string;
  sessionId: string;
  timeCreated: number;
  data: Record<string, unknown>;
}) {
  const db = new Database(dbPath);
  db.run(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
    [
      opts.id,
      opts.messageId,
      opts.sessionId,
      opts.timeCreated,
      opts.timeCreated,
      JSON.stringify(opts.data),
    ],
  );
  db.close();
}

describe('OpenCodeParser - 基础解析', () => {
  test('解析 user + assistant 消息及 token 用量', async () => {
    insertSession({ id: 'sess-1', title: '测试会话' });
    insertMessage({ id: 'msg-1', sessionId: 'sess-1', role: 'user', timeCreated: 1000 });
    insertPart({
      id: 'prt-1',
      messageId: 'msg-1',
      sessionId: 'sess-1',
      timeCreated: 1000,
      data: { type: 'text', text: 'hello' },
    });
    insertMessage({
      id: 'msg-2',
      sessionId: 'sess-1',
      role: 'assistant',
      timeCreated: 2000,
      parentId: 'msg-1',
      modelId: 'gpt-4',
      tokens: { input: 100, output: 50 },
    });
    insertPart({
      id: 'prt-2',
      messageId: 'msg-2',
      sessionId: 'sess-1',
      timeCreated: 2000,
      data: { type: 'text', text: 'hello there!' },
    });

    const parser = new OpenCodeParser('test-machine');
    const { messages, newOffset } = await parser.parseIncremental(dbPath, 0);

    expect(messages).toHaveLength(2);
    expect(newOffset).toBe(2000);
    expect(messages[0].machineId).toBe('test-machine');
    expect(messages[0].sourceTool).toBe('OpenCode');
    expect(messages[0].role).toBe('User');
    expect(messages[0].contentBlocks[0].content).toContain('hello');
    expect(messages[0].sessionId).toBe(messages[1].sessionId);
    expect(messages[0].metadata.sessionTitle).toBe('测试会话');
    expect(messages[1].role).toBe('Assistant');
    expect(messages[1].usage?.inputTokens).toBe(100);
    expect(messages[1].usage?.model).toBe('gpt-4');
    expect(messages[1].parentId).toBe(messages[0].id);
  });

  test('多轮 user 消息聚合在同一个会话', async () => {
    insertSession({ id: 'sess-multi', title: '多轮' });
    let t = 1000;
    for (let i = 1; i <= 5; i++) {
      insertMessage({ id: `u${i}`, sessionId: 'sess-multi', role: 'user', timeCreated: t });
      insertPart({
        id: `up${i}`,
        messageId: `u${i}`,
        sessionId: 'sess-multi',
        timeCreated: t,
        data: { type: 'text', text: `q${i}` },
      });
      t += 100;
      insertMessage({
        id: `a${i}`,
        sessionId: 'sess-multi',
        role: 'assistant',
        timeCreated: t,
        parentId: `u${i}`,
      });
      insertPart({
        id: `ap${i}`,
        messageId: `a${i}`,
        sessionId: 'sess-multi',
        timeCreated: t,
        data: { type: 'text', text: `a${i}` },
      });
      t += 100;
    }

    const parser = new OpenCodeParser('m');
    const { messages } = await parser.parseIncremental(dbPath, 0);
    expect(messages).toHaveLength(10);
    const sids = new Set(messages.map((m) => m.sessionId));
    expect(sids.size).toBe(1);
    const userMsgs = messages.filter((m) => m.role === 'User');
    expect(userMsgs).toHaveLength(5);
  });

  test('工具 part 映射: bash / edit / read', async () => {
    insertSession({ id: 's2' });
    insertMessage({ id: 'tm', sessionId: 's2', role: 'assistant', timeCreated: 1 });
    insertPart({
      id: 'tp1',
      messageId: 'tm',
      sessionId: 's2',
      timeCreated: 1,
      data: { type: 'text', text: 'tool output follows' },
    });
    insertPart({
      id: 'tp2',
      messageId: 'tm',
      sessionId: 's2',
      timeCreated: 2,
      data: { type: 'tool', tool: 'bash', state: { input: { command: 'ls' }, output: 'a\nb' } },
    });
    insertPart({
      id: 'tp3',
      messageId: 'tm',
      sessionId: 's2',
      timeCreated: 3,
      data: { type: 'tool', tool: 'edit', state: { input: { filePath: '/tmp/x.rs', diff: '+1' } } },
    });
    insertPart({
      id: 'tp4',
      messageId: 'tm',
      sessionId: 's2',
      timeCreated: 4,
      data: { type: 'tool', tool: 'read', state: { input: { filePath: '/tmp/y.rs' }, output: 'content' } },
    });

    const parser = new OpenCodeParser('m');
    const { messages } = await parser.parseIncremental(dbPath, 0);
    const blocks = messages[0].contentBlocks;
    expect(blocks).toHaveLength(4);
    expect(blocks[0].blockType).toBe('Text');
    expect(blocks[1].blockType).toBe('ShellCommand');
    expect(blocks[2].blockType).toBe('FileEdit');
    expect(blocks[2].filePath).toBe('/tmp/x.rs');
    expect(blocks[3].blockType).toBe('FileRead');
  });
});

describe('OpenCodeParser - 子会话过滤（避免重复）', () => {
  test('subagent 子会话的所有消息被整体跳过', async () => {
    // Root session P, with sub-sessions C1 (direct child) and C2 (nested grandchild)
    insertSession({ id: 'P', title: '主会话' });
    insertSession({ id: 'C1', parentId: 'P', title: 'subagent A' });
    insertSession({ id: 'C2', parentId: 'C1', title: 'subagent B' });

    insertMessage({ id: 'pm', sessionId: 'P', role: 'user', timeCreated: 1 });
    insertPart({ id: 'pp', messageId: 'pm', sessionId: 'P', timeCreated: 1, data: { type: 'text', text: '父任务' } });

    insertMessage({ id: 'c1m', sessionId: 'C1', role: 'user', timeCreated: 2 });
    insertPart({ id: 'c1p', messageId: 'c1m', sessionId: 'C1', timeCreated: 2, data: { type: 'text', text: '子任务1' } });

    insertMessage({ id: 'c2m', sessionId: 'C2', role: 'user', timeCreated: 3 });
    insertPart({ id: 'c2p', messageId: 'c2m', sessionId: 'C2', timeCreated: 3, data: { type: 'text', text: '子任务2' } });

    const parser = new OpenCodeParser('m');
    const { messages, newOffset } = await parser.parseIncremental(dbPath, 0);
    // Sub-session messages are already represented in parent session task tool calls,
    // so keep only root-session messages to avoid duplicates
    expect(messages).toHaveLength(1);
    expect(messages[0].contentBlocks[0].content).toBe('父任务');
    expect(messages[0].metadata.sessionTitle).toBe('主会话');
    // offset must advance based on all 3 messages to avoid reprocessing sub-sessions
    expect(newOffset).toBe(3);
  });

  test('session 表缺失时回退到原始 session_id（无子会话过滤）', async () => {
    // Drop session table to simulate an older version
    const db = new Database(dbPath);
    db.exec('DROP TABLE session');
    db.close();

    insertMessage({ id: 'm', sessionId: 'raw', role: 'user', timeCreated: 1 });
    insertPart({ id: 'p', messageId: 'm', sessionId: 'raw', timeCreated: 1, data: { type: 'text', text: 'x' } });

    const parser = new OpenCodeParser('m');
    const { messages } = await parser.parseIncremental(dbPath, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0].sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('orphan parent_id 仍视为子会话被跳过', async () => {
    insertSession({ id: 'orphan', parentId: 'missing', title: '孤立子会话' });
    insertMessage({ id: 'm1', sessionId: 'orphan', role: 'user', timeCreated: 1 });
    insertPart({ id: 'p1', messageId: 'm1', sessionId: 'orphan', timeCreated: 1, data: { type: 'text', text: 'x' } });

    const parser = new OpenCodeParser('m');
    const { messages, newOffset } = await parser.parseIncremental(dbPath, 0);
    expect(messages).toHaveLength(0);
    expect(newOffset).toBe(1);
  });
});

describe('OpenCodeParser - 老库兼容', () => {
  test('message 表无 time_updated 字段时回退到 time_created', async () => {
    // Recreate tables to simulate an early OpenCode schema
    const db = new Database(dbPath);
    db.exec('DROP TABLE message; DROP TABLE part;');
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    db.run("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)", [
      'om',
      'os',
      1234,
      JSON.stringify({ role: 'user' }),
    ]);
    db.run("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)", [
      'op',
      'om',
      'os',
      1234,
      JSON.stringify({ type: 'text', text: 'old schema' }),
    ]);
    db.close();

    const parser = new OpenCodeParser('m');
    const { messages, newOffset } = await parser.parseIncremental(dbPath, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0].contentBlocks[0].content).toBe('old schema');
    expect(newOffset).toBe(1234);
  });
});

describe('OpenCodeParser - 增量同步', () => {
  test('time_updated 偏移：第二次扫描只返回新增/更新的消息', async () => {
    insertSession({ id: 's1' });
    insertMessage({ id: 'm1', sessionId: 's1', role: 'user', timeCreated: 1000 });
    insertPart({ id: 'p1', messageId: 'm1', sessionId: 's1', timeCreated: 1000, data: { type: 'text', text: 'a' } });
    insertMessage({ id: 'm2', sessionId: 's1', role: 'assistant', timeCreated: 2000, parentId: 'm1' });
    insertPart({ id: 'p2', messageId: 'm2', sessionId: 's1', timeCreated: 2000, data: { type: 'text', text: 'b' } });

    const parser = new OpenCodeParser('m');
    const r1 = await parser.parseIncremental(dbPath, 0);
    expect(r1.messages).toHaveLength(2);
    expect(r1.newOffset).toBe(2000);

    // Add one new message
    insertMessage({ id: 'm3', sessionId: 's1', role: 'user', timeCreated: 3000, parentId: 'm2' });
    insertPart({ id: 'p3', messageId: 'm3', sessionId: 's1', timeCreated: 3000, data: { type: 'text', text: 'c' } });

    const r2 = await parser.parseIncremental(dbPath, r1.newOffset);
    expect(r2.messages).toHaveLength(1);
    expect(r2.newOffset).toBe(3000);
    expect(r2.messages[0].contentBlocks[0].content).toBe('c');

    // Third scan has no new data
    const r3 = await parser.parseIncremental(dbPath, r2.newOffset);
    expect(r3.messages).toHaveLength(0);
    expect(r3.newOffset).toBe(r2.newOffset);
  });

  test('已有消息更新 time_updated 后会被重新发出', async () => {
    insertSession({ id: 's1' });
    insertMessage({ id: 'm1', sessionId: 's1', role: 'assistant', timeCreated: 1000 });
    insertPart({ id: 'p1', messageId: 'm1', sessionId: 's1', timeCreated: 1000, data: { type: 'text', text: '初始' } });

    const parser = new OpenCodeParser('m');
    const r1 = await parser.parseIncremental(dbPath, 0);
    expect(r1.messages).toHaveLength(1);
    expect(r1.newOffset).toBe(1000);

    // Simulate streaming completion: update time_updated and append token usage
    updateMessage('m1', 1500, { tokens: { input: 10, output: 20 }, modelID: 'gpt-4' });

    const r2 = await parser.parseIncremental(dbPath, r1.newOffset);
    expect(r2.messages).toHaveLength(1);
    expect(r2.newOffset).toBe(1500);
    expect(r2.messages[0].usage?.inputTokens).toBe(10);
  });

  test('已有消息追加 part 后会带全部 parts 重新发出', async () => {
    insertSession({ id: 's1' });
    insertMessage({ id: 'm1', sessionId: 's1', role: 'assistant', timeCreated: 1000 });
    insertPart({ id: 'p1', messageId: 'm1', sessionId: 's1', timeCreated: 1000, data: { type: 'text', text: 'first' } });

    const parser = new OpenCodeParser('m');
    const r1 = await parser.parseIncremental(dbPath, 0);
    expect(r1.messages[0].contentBlocks).toHaveLength(1);

    // Append a new part and bump time_updated
    insertPart({ id: 'p2', messageId: 'm1', sessionId: 's1', timeCreated: 1500, data: { type: 'text', text: 'second' } });
    updateMessage('m1', 1500);

    const r2 = await parser.parseIncremental(dbPath, r1.newOffset);
    expect(r2.messages).toHaveLength(1);
    expect(r2.messages[0].contentBlocks).toHaveLength(2);
    expect(r2.messages[0].contentBlocks[1].content).toBe('second');
  });

  test('多次用户聊天的增量同步整体一致性', async () => {
    insertSession({ id: 'big' });
    const parser = new OpenCodeParser('m');
    let offset = 0;

    // Round 1
    insertMessage({ id: 'u1', sessionId: 'big', role: 'user', timeCreated: 1000 });
    insertPart({ id: 'up1', messageId: 'u1', sessionId: 'big', timeCreated: 1000, data: { type: 'text', text: 'q1' } });
    insertMessage({ id: 'a1', sessionId: 'big', role: 'assistant', timeCreated: 1100, parentId: 'u1' });
    insertPart({ id: 'ap1', messageId: 'a1', sessionId: 'big', timeCreated: 1100, data: { type: 'text', text: 'a1' } });
    let r = await parser.parseIncremental(dbPath, offset);
    expect(r.messages).toHaveLength(2);
    offset = r.newOffset;

    // Round 2
    insertMessage({ id: 'u2', sessionId: 'big', role: 'user', timeCreated: 2000 });
    insertPart({ id: 'up2', messageId: 'u2', sessionId: 'big', timeCreated: 2000, data: { type: 'text', text: 'q2' } });
    insertMessage({ id: 'a2', sessionId: 'big', role: 'assistant', timeCreated: 2100, parentId: 'u2' });
    insertPart({ id: 'ap2', messageId: 'a2', sessionId: 'big', timeCreated: 2100, data: { type: 'text', text: 'a2' } });
    r = await parser.parseIncremental(dbPath, offset);
    expect(r.messages).toHaveLength(2);
    offset = r.newOffset;

    // Round 3 + previous a2 streaming token completion
    updateMessage('a2', 3000, { tokens: { input: 50, output: 100 }, modelID: 'gpt-4' });
    insertMessage({ id: 'u3', sessionId: 'big', role: 'user', timeCreated: 3500 });
    insertPart({ id: 'up3', messageId: 'u3', sessionId: 'big', timeCreated: 3500, data: { type: 'text', text: 'q3' } });
    r = await parser.parseIncremental(dbPath, offset);
    expect(r.messages).toHaveLength(2);
    const ids = r.messages.map((m) => m.contentBlocks[0].content);
    expect(ids).toContain('q3');
    expect(r.messages.find((m) => m.usage?.inputTokens === 50)).toBeDefined();
  });
});

describe('OpenCodeParser - 杂项', () => {
  test('返回空结果当无新数据', async () => {
    const parser = new OpenCodeParser('m');
    const r = await parser.parseIncremental(dbPath, 0);
    expect(r.messages).toHaveLength(0);
    expect(r.newOffset).toBe(0);
  });

  test('ID 归一化：非 UUID 字符串确定性映射', async () => {
    insertSession({ id: 'sess_x' });
    insertMessage({ id: 'msg_abc', sessionId: 'sess_x', role: 'user', timeCreated: 1 });
    insertPart({ id: 'p', messageId: 'msg_abc', sessionId: 'sess_x', timeCreated: 1, data: { type: 'text', text: '1' } });
    const parser = new OpenCodeParser('m');
    const r1 = await parser.parseIncremental(dbPath, 0);
    const r2 = await parser.parseIncremental(dbPath, 0);
    expect(r1.messages[0].id).toBe(r2.messages[0].id);
    expect(r1.messages[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('matches() 仅接受 opencode.db', () => {
    const parser = new OpenCodeParser('m');
    expect(parser.matches('/x/opencode/opencode.db')).toBe(true);
    expect(parser.matches('/x/opencode/storage/state.json')).toBe(false);
  });

  test('源 DB 被锁时也能解析（拷贝法）', async () => {
    insertSession({ id: 's' });
    insertMessage({ id: 'm1', sessionId: 's', role: 'user', timeCreated: 1 });
    insertPart({ id: 'p1', messageId: 'm1', sessionId: 's', timeCreated: 1, data: { type: 'text', text: 'hi' } });

    const lockingDb = new Database(dbPath);
    lockingDb.exec('BEGIN IMMEDIATE');
    try {
      const parser = new OpenCodeParser('m');
      const r = await parser.parseIncremental(dbPath, 0);
      expect(r.messages).toHaveLength(1);
    } finally {
      lockingDb.exec('ROLLBACK');
      lockingDb.close();
    }
  });
});
