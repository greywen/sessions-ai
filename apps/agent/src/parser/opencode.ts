import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';

import type { ToolType, UnifiedMessage, ContentBlock, ContentBlockType, MessageRole } from './types.ts';
import type { ParseResult, ToolParser } from './tool-parser.ts';
import { logger } from '../logger.ts';

/**
 * UUID namespace. Version changes will alter all derived UUIDs (forced rebuild).
 *
 * v7: Completely skip sub-agent sub-session messages to avoid duplicate entries
 * in the parent session view.
 */
const OPENCODE_NS = 'opencode-ns-v7';

/** UUID v5: stable deterministic UUID based on SHA1. */
function toUuidV5(name: string, namespace: string = OPENCODE_NS): string {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(name)) return name.toLowerCase();

  const hash = createHash('sha1');
  hash.update(namespace);
  hash.update(name);
  const bytes = hash.digest();

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function classifyTool(toolName: string): ContentBlockType {
  const n = toolName.toLowerCase();
  if (['edit', 'write', 'file_edit', 'patch', 'file_patch'].includes(n)) return 'FileEdit';
  if (['read', 'file_read', 'view'].includes(n)) return 'FileRead';
  if (['bash', 'shell', 'exec', 'command'].includes(n)) return 'ShellCommand';
  if (['search', 'grep', 'find'].includes(n)) return 'SearchResult';
  if (n.startsWith('mcp_') || n.includes('mcp')) return 'McpCall';
  return 'ToolCall';
}

function millisToIso(ms: number): string {
  return new Date(ms).toISOString();
}

interface MsgRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface SessionRow {
  id: string;
  parent_id: string | null;
  title: string | null;
}

interface ParsedMsg {
  id: string;
  sessionId: string;
  role: string;
  timeCreated: number;
  timeUpdated: number;
  parentMsgId: string | null;
  modelId: string;
  tokens: { input: number; output: number; cacheRead: number | null; cacheWrite: number | null } | null;
  cost: number | null;
  parts: Record<string, unknown>[];
  sessionTitle: string | null;
}

export class OpenCodeParser implements ToolParser {
  constructor(private readonly machineId: string) {}

  toolType(): ToolType {
    return 'OpenCode';
  }

  fileExtensions(): string[] {
    return ['db'];
  }

  matches(filePath: string): boolean {
    return basename(filePath) === 'opencode.db';
  }

  logPaths(): string[] {
    const candidates: string[] = [];
    const home = homedir();
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
      const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
      candidates.push(join(local, 'opencode'), join(roaming, 'opencode'));
    } else if (process.platform === 'darwin') {
      candidates.push(join(home, 'Library', 'Application Support', 'opencode'));
    }
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg) candidates.push(join(xdg, 'opencode'));
    candidates.push(join(home, '.local', 'share', 'opencode'));

    const seen = new Set<string>();
    return candidates.filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return existsSync(join(p, 'opencode.db'));
    });
  }

  /** Copy the source DB to a temp directory to avoid SQLite lock conflicts. */
  private copyToTemp(src: string): string {
    const tmpRoot = join(tmpdir(), 'sessions-ai-opencode');
    mkdirSync(tmpRoot, { recursive: true });
    const hash = createHash('sha1').update(src).digest('hex').slice(0, 12);
    const dst = join(tmpRoot, `copy_${hash}_${basename(src)}`);
    copyFileSync(src, dst);
    for (const ext of ['wal', 'shm']) {
      const walSrc = `${src}-${ext}`;
      if (existsSync(walSrc)) {
        try {
          copyFileSync(walSrc, `${dst}-${ext}`);
        } catch {
          // best effort
        }
      }
    }
    return dst;
  }

  private cleanupTemp(path: string) {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        // best effort
      }
    }
  }

  /**
   * Load session metadata.
   *
   * Returns:
   * - titles: session_id -> title (used to attach a readable title to messages)
   * - subSessionIds: all sessions with non-empty parent_id (sub-agent sub-sessions)
   *
   * Sub-agent sub-session content is already represented in the parent session stream
   * as task tool calls. Syncing it again creates duplicate messages in the UI
   * (for example, "continue" appearing twice), so we skip all those sub-session
   * messages directly.
   */
  private loadSessionMeta(db: Database): {
    titles: Map<string, string>;
    subSessionIds: Set<string>;
  } {
    const hasSession = !!(db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='session'")
      .get() as { name?: string } | null);
    const titles = new Map<string, string>();
    const subSessionIds = new Set<string>();
    if (!hasSession) return { titles, subSessionIds };

    const rows = db.query<SessionRow, []>('SELECT id, parent_id, title FROM session').all();
    for (const r of rows) {
      if (r.title) titles.set(r.id, r.title);
      if (r.parent_id) subSessionIds.add(r.id);
    }
    return { titles, subSessionIds };
  }

  /** Detect whether message table has time_updated (for older OpenCode compatibility). */
  private detectTimeColumn(db: Database): 'time_updated' | 'time_created' {
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info('message')")
      .all();
    for (const c of cols) {
      if (c.name === 'time_updated') return 'time_updated';
    }
    return 'time_created';
  }

  private parseMsg(
    row: MsgRow,
    sessionTitles: Map<string, string>,
    parts: Record<string, unknown>[],
  ): ParsedMsg | null {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.data);
    } catch {
      return null;
    }
    const role = (data.role as string | undefined) ?? 'user';
    const parentMsgId = (data.parentID as string | undefined) ?? null;
    const modelId = (data.modelID as string | undefined) ?? 'unknown';

    const tokensRaw = data.tokens as
      | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
      | undefined;
    const tokens =
      tokensRaw && (Number(tokensRaw.input ?? 0) > 0 || Number(tokensRaw.output ?? 0) > 0)
        ? {
            input: Number(tokensRaw.input ?? 0),
            output: Number(tokensRaw.output ?? 0),
            cacheRead: tokensRaw.cacheRead ?? null,
            cacheWrite: tokensRaw.cacheWrite ?? null,
          }
        : null;
    const cost = (data.cost as number | undefined) ?? null;

    return {
      id: row.id,
      sessionId: row.session_id,
      role,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      parentMsgId,
      modelId,
      tokens,
      cost,
      parts,
      sessionTitle: sessionTitles.get(row.session_id) ?? null,
    };
  }

  private toUnifiedMessage(p: ParsedMsg): UnifiedMessage {
    const role: MessageRole = (() => {
      switch (p.role) {
        case 'user':
        case 'human':
          return 'User';
        case 'assistant':
          return 'Assistant';
        case 'system':
          return 'System';
        case 'tool':
        case 'tool_use':
          return 'ToolUse';
        case 'tool_result':
          return 'ToolResult';
        default:
          return 'User';
      }
    })();

    const blocks: ContentBlock[] = [];
    for (const part of p.parts) {
      const partType = (part.type as string | undefined) ?? '';
      if (partType === 'text') {
        const text = (part.text as string | undefined) ?? '';
        if (text.length > 0) {
          blocks.push({
            blockType: 'Text',
            content: text,
            language: null,
            filePath: null,
            diff: null,
            toolName: null,
            toolInput: null,
            exitCode: null,
            isCollapsed: false,
          });
        }
      } else if (partType === 'tool') {
        const toolName = ((part.tool as string | undefined) ?? 'unknown').toString();
        const state = part.state as Record<string, unknown> | undefined;
        const input = state?.input as Record<string, unknown> | undefined;
        const output = state?.output;
        const blockType = classifyTool(toolName);
        const filePath =
          (input?.filePath as string | undefined) ?? (input?.path as string | undefined) ?? null;
        const diff = (input?.diff as string | undefined) ?? (input?.content as string | undefined) ?? null;
        blocks.push({
          blockType,
          content:
            typeof output === 'string' && output.length > 0 ? output : `Tool: ${toolName}`,
          language: null,
          filePath,
          diff,
          toolName,
          toolInput: (input as Record<string, unknown>) ?? null,
          exitCode: null,
          isCollapsed: false,
        });
      }
      // step-start / step-finish are not rendered
    }

    if (blocks.length === 0) {
      blocks.push({
        blockType: 'Text',
        content: '',
        language: null,
        filePath: null,
        diff: null,
        toolName: null,
        toolInput: null,
        exitCode: null,
        isCollapsed: false,
      });
    }

    const usage = p.tokens
      ? {
          inputTokens: p.tokens.input,
          outputTokens: p.tokens.output,
          cacheCreationInputTokens: p.tokens.cacheWrite,
          cacheReadInputTokens: p.tokens.cacheRead,
          model: p.modelId,
        }
      : null;

    const metadata: Record<string, unknown> = { model: p.modelId };
    if (p.cost !== null) metadata.cost = p.cost;
    if (p.sessionTitle) metadata.sessionTitle = p.sessionTitle;

    return {
      id: toUuidV5(p.id),
      sessionId: toUuidV5(p.sessionId),
      parentId: p.parentMsgId ? toUuidV5(p.parentMsgId) : null,
      machineId: this.machineId,
      sourceTool: 'OpenCode',
      role,
      contentBlocks: blocks,
      usage,
      timestamp: millisToIso(p.timeCreated),
      metadata,
    };
  }

  /**
   * Incremental parsing.
   *
   * - offset: MAX(message.time_updated) observed in last scan (milliseconds; falls
   *   back to time_created for older schemas without that column).
   * - This scan reads all messages where time_updated > offset and pulls all related
   *   parts. Message updates (stream completion / appended parts) can therefore be
   *   emitted again, and the Web side remains idempotent via ON CONFLICT by id.
   * - Sub-agent sub-session messages are skipped entirely (already represented as
   *   task tool calls in the parent session, avoiding duplicates).
   */
  async parseIncremental(filePath: string, offset: number): Promise<ParseResult> {
    if (!this.matches(filePath)) {
      return { messages: [], newOffset: offset };
    }

    const tempPath = this.copyToTemp(filePath);
    let db: Database | null = null;
    try {
      db = new Database(tempPath, { readonly: true });

      const hasMessage = !!(db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='message'")
        .get() as { name?: string } | null);
      if (!hasMessage) {
        return { messages: [], newOffset: offset };
      }
      const hasPart = !!(db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='part'")
        .get() as { name?: string } | null);

      const { titles: sessionTitles, subSessionIds } = this.loadSessionMeta(db);
      const timeCol = this.detectTimeColumn(db);

      const msgRows = db
        .query<MsgRow, [number]>(
          `SELECT id, session_id, time_created, ${timeCol} AS time_updated, data FROM message ` +
            `WHERE ${timeCol} > ? ORDER BY ${timeCol} ASC`,
        )
        .all(offset);

      if (msgRows.length === 0) {
        return { messages: [], newOffset: offset };
      }

      // Filter sub-sessions first, then decide whether to load parts to save I/O.
      const visibleRows = msgRows.filter((r) => !subSessionIds.has(r.session_id));

      // Load all parts (including appended ones) for messages in this window.
      const partsByMsg = new Map<string, Record<string, unknown>[]>();
      if (hasPart && visibleRows.length > 0) {
        const ids = visibleRows.map((r) => r.id);
        const chunkSize = 200; // Avoid SQL variable-count limits.
        for (let i = 0; i < ids.length; i += chunkSize) {
          const chunk = ids.slice(i, i + chunkSize);
          const placeholders = chunk.map(() => '?').join(',');
          const partRows = db
            .query<{ message_id: string; data: string; time_created: number }, string[]>(
              `SELECT message_id, data, time_created FROM part
                 WHERE message_id IN (${placeholders})
                 ORDER BY message_id, time_created ASC`,
            )
            .all(...chunk);
          for (const r of partRows) {
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(r.data);
            } catch {
              continue;
            }
            const arr = partsByMsg.get(r.message_id) ?? [];
            arr.push(parsed);
            partsByMsg.set(r.message_id, arr);
          }
        }
      }

      const messages: UnifiedMessage[] = [];
      let newOffset = offset;
      // Important: offset advancement must use all msgRows, otherwise watermark
      // could be missed when sub-sessions are skipped.
      for (const r of msgRows) {
        if (r.time_updated > newOffset) newOffset = r.time_updated;
      }
      for (const r of visibleRows) {
        const parts = partsByMsg.get(r.id) ?? [];
        const parsed = this.parseMsg(r, sessionTitles, parts);
        if (!parsed) continue;
        messages.push(this.toUnifiedMessage(parsed));
      }

      logger.debug(
        {
          path: filePath,
          previousOffset: offset,
          newOffset,
          parsed: messages.length,
          skippedSubSession: msgRows.length - visibleRows.length,
        },
        'OpenCode incremental parse completed',
      );

      return { messages, newOffset };
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
      this.cleanupTemp(tempPath);
    }
  }
}
