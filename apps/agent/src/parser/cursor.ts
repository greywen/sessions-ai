import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';

import type {
  ContentBlock,
  ContentBlockType,
  MessageRole,
  ToolType,
  UnifiedMessage,
} from './types.ts';
import type { ParseResult, ToolParser } from './tool-parser.ts';
import { logger } from '../logger.ts';

const CURSOR_NS = 'cursor-ns-v1';

function toUuidV5(name: string, namespace: string = CURSOR_NS): string {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(name) && namespace === CURSOR_NS) return name.toLowerCase();
  const hash = createHash('sha1');
  hash.update(namespace);
  hash.update(name);
  const bytes = hash.digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function emptyBlock(type: ContentBlockType = 'Text', content = ''): ContentBlock {
  return {
    blockType: type,
    content,
    language: null,
    filePath: null,
    diff: null,
    toolName: null,
    toolInput: null,
    exitCode: null,
    isCollapsed: false,
  };
}

/** Extract plain text from a Lexical-style richText JSON tree. */
function flattenLexical(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const obj = node as { type?: string; text?: string; children?: unknown[] };
  if (obj.type === 'text' && typeof obj.text === 'string') return obj.text;
  if (Array.isArray(obj.children)) {
    return obj.children.map((c) => flattenLexical(c)).join('');
  }
  return '';
}

function extractRichText(richText: unknown): string {
  if (typeof richText !== 'string' || richText.length === 0) return '';
  try {
    const j = JSON.parse(richText) as { root?: unknown };
    return flattenLexical(j.root).trim();
  } catch {
    return '';
  }
}

interface ComposerData {
  composerId: string;
  name?: string;
  createdAt?: number; // ms epoch
  modelConfig?: { modelName?: string };
  unifiedMode?: string;
}

interface BubbleData {
  bubbleId: string;
  type?: number; // 1 = user, 2 = assistant
  text?: string;
  richText?: string;
  createdAt?: string | number;
  capabilityType?: number;
  toolFormerData?: {
    name?: string;
    params?: string;
    result?: string;
    status?: string;
  };
  modelInfo?: { modelName?: string };
  tokenCount?: { inputTokens?: number; outputTokens?: number };
  requestId?: string;
}

function bubbleTimestamp(b: BubbleData): number {
  if (typeof b.createdAt === 'number') return b.createdAt;
  if (typeof b.createdAt === 'string') {
    const t = Date.parse(b.createdAt);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

export class CursorParser implements ToolParser {
  constructor(private readonly machineId: string) {}

  toolType(): ToolType {
    return 'Cursor';
  }

  fileExtensions(): string[] {
    return ['vscdb'];
  }

  matches(filePath: string): boolean {
    return basename(filePath) === 'state.vscdb';
  }

  logPaths(): string[] {
    const home = homedir();
    const candidates: string[] = [];
    if (process.platform === 'win32') {
      const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
      candidates.push(join(roaming, 'Cursor', 'User', 'globalStorage'));
      candidates.push(join(roaming, 'Cursor', 'User', 'workspaceStorage'));
    } else if (process.platform === 'darwin') {
      candidates.push(join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage'));
      candidates.push(join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'));
    } else {
      candidates.push(join(home, '.config', 'Cursor', 'User', 'globalStorage'));
      candidates.push(join(home, '.config', 'Cursor', 'User', 'workspaceStorage'));
    }
    return candidates.filter((p) => existsSync(p));
  }

  /** Copy DB to temp to avoid lock conflicts (Cursor keeps an exclusive WAL handle). */
  private copyToTemp(src: string): string {
    const tmpRoot = join(tmpdir(), 'sessions-ai-cursor');
    mkdirSync(tmpRoot, { recursive: true });
    const hash = createHash('sha1').update(src).digest('hex').slice(0, 12);
    const dst = join(tmpRoot, `copy_${hash}_state.vscdb`);
    copyFileSync(src, dst);
    for (const ext of ['wal', 'shm']) {
      const sub = `${src}-${ext}`;
      if (existsSync(sub)) {
        try {
          copyFileSync(sub, `${dst}-${ext}`);
        } catch {
          // best effort
        }
      }
    }
    return dst;
  }

  private cleanupTemp(path: string): void {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        // best effort
      }
    }
  }

  private toUtf8(value: Buffer | string): string {
    return typeof value === 'string' ? value : value.toString('utf-8');
  }

  /**
   * Convert one bubble row into a UnifiedMessage. Returns null if the bubble
   * carries no presentable content.
   */
  private buildMessage(
    composerId: string,
    composerName: string | null,
    composerModel: string | null,
    bubble: BubbleData,
  ): UnifiedMessage | null {
    const text = bubble.text && bubble.text.length > 0
      ? bubble.text
      : extractRichText(bubble.richText);

    const blocks: ContentBlock[] = [];
    if (text) blocks.push(emptyBlock('Text', text));

    const tool = bubble.toolFormerData;
    if (tool && tool.name) {
      let parsedInput: Record<string, unknown> | null = null;
      if (typeof tool.params === 'string' && tool.params.length > 0) {
        try {
          parsedInput = JSON.parse(tool.params) as Record<string, unknown>;
        } catch {
          parsedInput = { raw: tool.params };
        }
      }
      const result = typeof tool.result === 'string' ? tool.result : '';
      const block: ContentBlock = {
        ...emptyBlock('ToolCall'),
        content: result.length > 4000 ? `${result.slice(0, 4000)}\n…[truncated]` : result || `Tool: ${tool.name}`,
        toolName: tool.name,
        toolInput: parsedInput,
      };
      blocks.push(block);
    }

    if (blocks.length === 0) return null;

    const role: MessageRole = bubble.type === 1 ? 'User' : 'Assistant';
    const ts = bubbleTimestamp(bubble);
    const model = bubble.modelInfo?.modelName ?? composerModel ?? 'unknown';

    const usage = bubble.tokenCount
      ? {
          inputTokens: Math.max(0, Number(bubble.tokenCount.inputTokens ?? 0)),
          outputTokens: Math.max(0, Number(bubble.tokenCount.outputTokens ?? 0)),
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
          model,
        }
      : null;

    const metadata: Record<string, unknown> = {
      sourceComposerId: composerId,
      sourceBubbleId: bubble.bubbleId,
      model,
    };
    if (composerName) metadata.sessionTitle = composerName;
    if (bubble.requestId) metadata.requestId = bubble.requestId;

    return {
      id: toUuidV5(`${composerId}:${bubble.bubbleId}`),
      sessionId: toUuidV5(`session:${composerId}`),
      parentId: null,
      machineId: this.machineId,
      sourceTool: 'Cursor',
      role,
      contentBlocks: blocks,
      usage,
      timestamp: ts > 0 ? new Date(ts).toISOString() : new Date().toISOString(),
      metadata,
    };
  }

  /**
   * Incremental parsing.
   *
   * - offset: max bubble createdAt (ms) observed in last scan.
   * - Each tick we copy the DB to temp, scan bubbles whose timestamp > offset
   *   and emit unified messages, attaching composer name/model when available.
   */
  async parseIncremental(filePath: string, offset: number): Promise<ParseResult> {
    if (!this.matches(filePath)) return { messages: [], newOffset: offset };

    const tempPath = this.copyToTemp(filePath);
    let db: Database | null = null;
    try {
      db = new Database(tempPath, { readonly: true });

      // The cursorDiskKV table only exists in Cursor-specific state DBs.
      const hasKv = !!(db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
        .get() as { name?: string } | null);
      if (!hasKv) return { messages: [], newOffset: offset };

      // Pull all composer metadata once.
      const composerRows = db
        .query<{ key: string; value: Buffer | string }, []>(
          "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
        )
        .all();

      const composers = new Map<string, { name: string | null; model: string | null }>();
      for (const row of composerRows) {
        try {
          const data = JSON.parse(this.toUtf8(row.value)) as ComposerData;
          composers.set(data.composerId, {
            name: data.name ?? null,
            model: data.modelConfig?.modelName ?? null,
          });
        } catch {
          // ignore corrupted composer
        }
      }

      // Pull all bubbles (they are small enough; the largest seen is < 100 KB).
      const bubbleRows = db
        .query<{ key: string; value: Buffer | string }, []>(
          "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'",
        )
        .all();

      const messages: UnifiedMessage[] = [];
      let newOffset = offset;
      for (const row of bubbleRows) {
        // key format: bubbleId:<composerId>:<bubbleId>
        const parts = row.key.split(':');
        if (parts.length < 3) continue;
        const composerId = parts[1];
        let data: BubbleData;
        try {
          data = JSON.parse(this.toUtf8(row.value)) as BubbleData;
        } catch {
          continue;
        }
        const ts = bubbleTimestamp(data);
        if (ts > newOffset) newOffset = ts;
        if (ts <= offset) continue;
        const meta = composers.get(composerId) ?? { name: null, model: null };
        const msg = this.buildMessage(composerId, meta.name, meta.model, data);
        if (msg) messages.push(msg);
      }

      messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      if (messages.length > 0) {
        logger.debug(
          { path: filePath, previousOffset: offset, newOffset, parsed: messages.length },
          'Cursor incremental parse completed',
        );
      }

      return { messages, newOffset };
    } catch (err) {
      logger.warn({ path: filePath, err: String(err) }, 'Cursor parse failed');
      return { messages: [], newOffset: offset };
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
