import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

import { CodeBuddyParser } from '../src/parser/codebuddy.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lsv-codebuddy-'));
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Windows can briefly hold sqlite file handles after Database.close();
    // the tmpdir is auto-cleaned by the OS, so we tolerate the EBUSY here.
  }
});

function ext(): string {
  return join(tempDir, 'CodeBuddy', 'User', 'globalStorage', 'tencent-cloud.coding-copilot');
}

function writeSessionsDb(rows: Array<Record<string, unknown>>): string {
  const dir = ext();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'codebuddy-sessions.vscdb');
  const db = new Database(file);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  const stmt = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  for (const row of rows) {
    const conv = String(row.conversationId ?? 'x');
    stmt.run(`session:${conv}`, JSON.stringify(row));
  }
  db.close();
  return file;
}

function writeMessagesJsonl(conversationId: string, rows: unknown[]): string {
  // .../genie-history/<projectKey>/conversations/<convId>/messages.jsonl
  const dir = join(ext(), 'genie-history', 'cHJvag==', 'conversations', conversationId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'messages.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

describe('CodeBuddyParser - identity & matching', () => {
  test('toolType / extensions', () => {
    const p = new CodeBuddyParser('m1');
    expect(p.toolType()).toBe('CodeBuddy');
    expect(p.fileExtensions()).toEqual(['vscdb', 'jsonl', 'json']);
  });

  test('matches sessions vscdb and per-conversation messages files', () => {
    const p = new CodeBuddyParser('m1');
    expect(p.matches('/x/CodeBuddy/.../codebuddy-sessions.vscdb')).toBe(true);
    expect(
      p.matches('/x/tencent-cloud.coding-copilot/genie-history/abc/conversations/xyz/messages.jsonl'),
    ).toBe(true);
    expect(
      p.matches('/x/tencent-cloud.coding-copilot/genie-history/abc/conversations/xyz/messages.json'),
    ).toBe(true);
    expect(p.matches('/x/CodeBuddy/.../other.vscdb')).toBe(false);
  });
});

describe('CodeBuddyParser - sessions DB stubs', () => {
  test('emits one System Status stub per conversation row', async () => {
    const file = writeSessionsDb([
      {
        conversationId: 'conv-1', cwd: 'c:/proj', userId: 'u', title: 'Hello',
        status: 'Completed', createdAt: 1777518855824, updatedAt: 1777518936117, isPlayground: false,
      },
      {
        conversationId: 'conv-2', cwd: 'c:/other', userId: 'u', title: 'Other',
        status: 'Active', createdAt: 1777518900000, updatedAt: 1777519000000, isPlayground: true,
      },
    ]);
    const p = new CodeBuddyParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages.length).toBe(2);
    for (const m of r.messages) {
      expect(m.role).toBe('System');
      expect(m.contentBlocks[0].blockType).toBe('Status');
      expect(m.sourceTool).toBe('CodeBuddy');
      expect((m.metadata as { stub?: boolean }).stub).toBe(true);
    }
  });

  test('dedupes unchanged rows on subsequent calls', async () => {
    const file = writeSessionsDb([
      {
        conversationId: 'conv-1', cwd: 'c:/p', userId: 'u', title: 'T',
        status: 'Completed', createdAt: 1, updatedAt: 100, isPlayground: false,
      },
    ]);
    const p = new CodeBuddyParser('m1');
    const r1 = await p.parseIncremental(file, 0);
    expect(r1.messages.length).toBe(1);

    // Re-trigger by changing file size (touch). Append a comment tail to bump size.
    // We simply call again with offset 0 but the same DB content; in-memory dedupe applies.
    const r2 = await p.parseIncremental(file, 0);
    expect(r2.messages.length).toBe(0);
  });
});

describe('CodeBuddyParser - messages.jsonl', () => {
  test('parses user/assistant + tool_use FileEdit incrementally', async () => {
    const file = writeMessagesJsonl('conv-9', [
      { id: 'm1', role: 'user', content: 'hi', timestamp: '2026-04-30T00:00:00Z' },
      {
        id: 'm2', role: 'assistant', timestamp: '2026-04-30T00:00:01Z',
        content: [
          { type: 'text', text: 'editing' },
          {
            type: 'tool_use', name: 'edit_file',
            input: { file_path: '/p/a.ts', old_string: 'foo', new_string: 'bar' },
          },
        ],
      },
    ]);

    const p = new CodeBuddyParser('m1');
    const r = await p.parseIncremental(file, 0);
    expect(r.messages.length).toBe(2);

    const [user, asst] = r.messages;
    expect(user.role).toBe('User');
    expect(user.contentBlocks[0].content).toBe('hi');

    expect(asst.role).toBe('Assistant');
    const fe = asst.contentBlocks.find((b) => b.blockType === 'FileEdit');
    expect(fe?.filePath).toBe('/p/a.ts');
    expect(fe?.diff).toContain('-foo');
    expect(fe?.diff).toContain('+bar');

    // Incremental no-op
    const r2 = await p.parseIncremental(file, r.newOffset);
    expect(r2.messages.length).toBe(0);
  });
});
