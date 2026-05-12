import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- chainable-builder mocks ----------
// drizzle calls look like: db.select({...}).from(t).where(...).limit(1)
// or                       db.insert(t).values({...}).onConflictDoUpdate({...})
// We capture each terminal call so we can assert on it.

const mockSelectColumns = vi.fn();
const mockSelectFrom = vi.fn();
const mockSelectWhere = vi.fn();
const mockSelectLimit = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoUpdate = vi.fn();
const mockDelete = vi.fn();
const mockDeleteWhere = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => {
      mockSelectColumns(...args);
      return {
        from: (...fromArgs: unknown[]) => {
          mockSelectFrom(...fromArgs);
          return {
            where: (...whereArgs: unknown[]) => {
              mockSelectWhere(...whereArgs);
              return {
                limit: (n: number) => mockSelectLimit(n),
              };
            },
          };
        },
      };
    },
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return {
        values: (val: unknown) => {
          mockValues(val);
          return {
            onConflictDoUpdate: (conflict: unknown) => {
              mockOnConflictDoUpdate(conflict);
              return Promise.resolve();
            },
          };
        },
      };
    },
    delete: (...args: unknown[]) => {
      mockDelete(...args);
      return {
        where: (...whereArgs: unknown[]) => {
          mockDeleteWhere(...whereArgs);
          return Promise.resolve();
        },
      };
    },
  },
}));

vi.mock('@/lib/db/schema', () => ({
  normalizedMessages: {
    id: 'nm.id',
    sessionId: 'nm.session_id',
    sourceTool: 'nm.source_tool',
    machineId: 'nm.machine_id',
    role: 'nm.role',
    contentBlocks: 'nm.content_blocks',
    usage: 'nm.usage',
    metadata: 'nm.metadata',
    sourcePayload: 'nm.source_payload',
    rawTimestamp: 'nm.raw_timestamp',
  },
  favoriteSnapshots: {
    id: 'fs.id',
    userId: 'fs.user_id',
    sourceMessageId: 'fs.source_message_id',
  },
}));

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ kind: 'and', args }),
  eq: (col: unknown, val: unknown) => ({ kind: 'eq', col, val }),
}));

import { getSession } from '@/lib/auth/session';

const mockGetSession = vi.mocked(getSession);

const SESSION_ID = 'sess-1';
const MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = 'user-uuid-1';

const FROZEN_MESSAGE = {
  id: MESSAGE_ID,
  sessionId: SESSION_ID,
  sourceTool: 'Cursor',
  machineId: 'machine-uuid-1',
  role: 'Assistant',
  contentBlocks: [
    { blockType: 'Text', content: 'frozen text payload' },
    { blockType: 'ToolCall', toolName: 'read_file', content: 'huge tool result' },
  ],
  usage: { inputTokens: 10, outputTokens: 20, model: 'claude-sonnet-4' },
  metadata: { sourceComposerId: 'cmp-1', model: 'claude-sonnet-4' },
  sourcePayload: {
    formatVersion: 1,
    records: [{ bubbleId: 'bubble-1', text: 'frozen text payload' }],
  },
  rawTimestamp: new Date('2026-04-01T12:00:00Z'),
};

async function callRoute(body: unknown) {
  const { PATCH } = await import('@/app/api/sessions/[id]/messages/[messageId]/favorite/route');
  const req = new Request('http://localhost/x', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await PATCH(req, {
    params: Promise.resolve({ id: SESSION_ID, messageId: MESSAGE_ID }),
  });
  return { status: res.status, json: await res.json() };
}

describe('PATCH /api/sessions/[id]/messages/[messageId]/favorite — snapshot semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetSession.mockResolvedValue({ userId: USER_ID, email: 'u@x', role: 'viewer' });
  });

  it('returns 401 when not logged in', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { status } = await callRoute({ favorite: true });
    expect(status).toBe(401);
  });

  it('rejects invalid body', async () => {
    const { status } = await callRoute({ favorite: 'yes' });
    expect(status).toBe(400);
  });

  it('on favorite=true freezes the FULL UnifiedMessage payload (no truncation)', async () => {
    mockSelectLimit.mockResolvedValueOnce([FROZEN_MESSAGE]);

    const { status, json } = await callRoute({ favorite: true, note: 'remember this' });

    expect(status).toBe(200);
    expect(json.data).toEqual({ messageId: MESSAGE_ID, isFavorite: true });

    // The values written to favorite_snapshots must contain the COMPLETE
    // contentBlocks array — that's the whole point of the snapshot table.
    expect(mockValues).toHaveBeenCalledTimes(1);
    const written = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(written.userId).toBe(USER_ID);
    expect(written.sourceMessageId).toBe(MESSAGE_ID);
    expect(written.sourceSessionId).toBe(SESSION_ID);
    expect(written.sourceTool).toBe('Cursor');
    expect(written.machineId).toBe('machine-uuid-1');
    expect(written.role).toBe('Assistant');
    expect(written.contentBlocks).toEqual(FROZEN_MESSAGE.contentBlocks);
    expect(written.usage).toEqual(FROZEN_MESSAGE.usage);
    expect(written.metadata).toEqual(FROZEN_MESSAGE.metadata);
    expect(written.sourcePayload).toEqual(FROZEN_MESSAGE.sourcePayload);
    expect(written.rawTimestamp).toBe(FROZEN_MESSAGE.rawTimestamp);
    expect(written.userNote).toBe('remember this');

    // Re-favoriting must refresh the snapshot, not crash on conflict.
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    const conflict = mockOnConflictDoUpdate.mock.calls[0][0] as { set: Record<string, unknown> };
    expect(conflict.set.contentBlocks).toEqual(FROZEN_MESSAGE.contentBlocks);
    expect(conflict.set.sourcePayload).toEqual(FROZEN_MESSAGE.sourcePayload);
    expect(conflict.set.userNote).toBe('remember this');
  });

  it('returns 404 when source message does not exist', async () => {
    mockSelectLimit.mockResolvedValueOnce([]);
    const { status } = await callRoute({ favorite: true });
    expect(status).toBe(404);
    expect(mockValues).not.toHaveBeenCalled();
  });

  it('on favorite=false deletes the snapshot without touching normalized_messages', async () => {
    const { status, json } = await callRoute({ favorite: false });
    expect(status).toBe(200);
    expect(json.data).toEqual({ messageId: MESSAGE_ID, isFavorite: false });
    // No source-message read on unfavorite — just delete.
    expect(mockSelectLimit).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
  });
});
