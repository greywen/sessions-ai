import { describe, it, expect } from 'vitest';

// DAG Reconstruction Algorithm(AND: page.tsx Sync in)
interface MessageItem {
  id: string;
  parentId: string | null;
  rawTimestamp: string;
  role: string;
}

function reconstructConversation(messages: MessageItem[]): MessageItem[] {
  if (messages.length === 0) return [];

  const messageMap = new Map<string, MessageItem>();
  for (const msg of messages) {
    messageMap.set(msg.id, msg);
  }

  const lastMessage = messages.reduce((a, b) =>
    new Date(a.rawTimestamp) > new Date(b.rawTimestamp) ? a : b,
  );

  const mainChain: MessageItem[] = [];
  const visited = new Set<string>();
  let current: MessageItem | undefined = lastMessage;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    mainChain.unshift(current);
    current = current.parentId ? messageMap.get(current.parentId) : undefined;
  }

  if (mainChain.length <= messages.length * 0.5) {
    return [...messages].sort(
      (a, b) => new Date(a.rawTimestamp).getTime() - new Date(b.rawTimestamp).getTime(),
    );
  }

  return mainChain;
}

describe('DAG Session Reconstruction Algorithm', () => {
  it('Empty message list returns empty array', () => {
    expect(reconstructConversation([])).toEqual([]);
  });

  it('Single message straight back', () => {
    const msgs: MessageItem[] = [
      { id: 'a', parentId: null, rawTimestamp: '2026-04-03T10:00:00Z', role: 'User' },
    ];
    const result = reconstructConversation(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('a');
  });

  it('Correct Reconstruction of Linear Links', () => {
    const msgs: MessageItem[] = [
      { id: 'a', parentId: null, rawTimestamp: '2026-04-03T10:00:00Z', role: 'User' },
      { id: 'b', parentId: 'a', rawTimestamp: '2026-04-03T10:00:01Z', role: 'Assistant' },
      { id: 'c', parentId: 'b', rawTimestamp: '2026-04-03T10:00:02Z', role: 'User' },
      { id: 'd', parentId: 'c', rawTimestamp: '2026-04-03T10:00:03Z', role: 'Assistant' },
    ];
    const result = reconstructConversation(msgs);
    expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('Branch DAG Select Primary Link(Latest news retroactively)', () => {
    // a → b → c (main link)
    // a → d → e (Branch)
    const msgs: MessageItem[] = [
      { id: 'a', parentId: null, rawTimestamp: '2026-04-03T10:00:00Z', role: 'User' },
      { id: 'b', parentId: 'a', rawTimestamp: '2026-04-03T10:00:01Z', role: 'Assistant' },
      { id: 'c', parentId: 'b', rawTimestamp: '2026-04-03T10:00:05Z', role: 'User' },
      { id: 'd', parentId: 'a', rawTimestamp: '2026-04-03T10:00:02Z', role: 'Assistant' },
      { id: 'e', parentId: 'd', rawTimestamp: '2026-04-03T10:00:03Z', role: 'User' },
    ];
    const result = reconstructConversation(msgs);
    // c is the latest news,Primary link is a → b → c
    expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('Fallback to time sort when no parent-child relationship', () => {
    const msgs: MessageItem[] = [
      { id: 'c', parentId: null, rawTimestamp: '2026-04-03T10:00:02Z', role: 'User' },
      { id: 'a', parentId: null, rawTimestamp: '2026-04-03T10:00:00Z', role: 'User' },
      { id: 'b', parentId: null, rawTimestamp: '2026-04-03T10:00:01Z', role: 'Assistant' },
    ];
    const result = reconstructConversation(msgs);
    // Primary link only 1 Pcs(Newest c),Reach < 50%,Fallback Time Sort
    expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('fallback should trigger at exactly 50% chain coverage', () => {
    const msgs: MessageItem[] = [
      { id: 'a', parentId: null, rawTimestamp: '2026-04-03T10:00:00Z', role: 'User' },
      { id: 'b', parentId: null, rawTimestamp: '2026-04-03T10:00:01Z', role: 'Assistant' },
    ];
    const result = reconstructConversation(msgs);
    expect(result.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('Anti-cyclic references', () => {
    const msgs: MessageItem[] = [
      { id: 'a', parentId: 'b', rawTimestamp: '2026-04-03T10:00:00Z', role: 'User' },
      { id: 'b', parentId: 'a', rawTimestamp: '2026-04-03T10:00:01Z', role: 'Assistant' },
    ];
    // Should not loop indefinitely
    const result = reconstructConversation(msgs);
    expect(result.length).toBeLessThanOrEqual(2);
  });
});
