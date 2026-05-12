import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';

import type {
  ContentBlock,
  ContentBlockType,
  MessageRole,
  ToolType,
  UnifiedMessage,
} from './types.ts';
import type { ParseResult, ToolParser } from './tool-parser.ts';
import {
  buildFileEditBlock,
  diffFromOldNew,
  type FileEditOperation,
  type FileEditStatus,
  type NormalizedFileEdit,
} from './edit-normalizer.ts';
import { logger } from '../logger.ts';
import { sourcePayload } from './source-payload.ts';

/**
 * CodeBuddy parser (Tencent Coding Copilot — `tencent-cloud.coding-copilot`).
 *
 * Local data inventory (Windows reference machine):
 *
 *  1. Session metadata DB (always populated):
 *       %APPDATA%/CodeBuddy/User/globalStorage/tencent-cloud.coding-copilot/codebuddy-sessions.vscdb
 *     ItemTable rows keyed `session:<id>` with JSON value:
 *       { conversationId, cwd, userId, title, status, createdAt, updatedAt, isPlayground }
 *
 *  2. Per-conversation history (often empty — chat content is server-side):
 *       %APPDATA%/CodeBuddy/User/globalStorage/tencent-cloud.coding-copilot/genie-history/
 *         <base64url(cwd)>/conversations/<conversationId>/
 *     When messages are persisted, files like `messages.jsonl` / `messages.json`
 *     appear here. Schema (best-effort, observed in builds that flush):
 *       {
 *         id, role: 'user'|'assistant'|'system'|'tool',
 *         content: string | Array<{ type, text?, toolCalls?[], ... }>,
 *         timestamp,
 *         toolCalls?[]   (tool_use)
 *         toolResult?    (tool_result, paired by id)
 *       }
 *
 * Because the chat body is normally only stored on the cloud, the SQLite
 * pass yields a "session stub" (a single User message containing the title
 * + metadata) so the dashboard at least shows when/where each conversation
 * happened. When local message files exist they are parsed in detail.
 */

const CODEBUDDY_NS = 'codebuddy-ns-v1';

function toUuidV5(name: string, namespace: string = CODEBUDDY_NS): string {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(name) && namespace === CODEBUDDY_NS) return name.toLowerCase();
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

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function preserveFullText(input: string): string {
  return input;
}

function parseTimestampMs(ts: unknown): number {
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  if (typeof ts === 'string') {
    const t = Date.parse(ts);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function toIsoTimestamp(ts: unknown): string {
  const ms = parseTimestampMs(ts);
  return ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
}

function classifyToolName(name: string): ContentBlockType {
  const n = name.toLowerCase();
  if (n.includes('apply_patch') || n.includes('edit') || n.includes('write')) return 'FileEdit';
  if (n.includes('read') || n.includes('view')) return 'FileRead';
  if (n.includes('shell') || n.includes('exec') || n.includes('bash')) return 'ShellCommand';
  if (n.includes('search') || n.includes('grep') || n.includes('find')) return 'SearchResult';
  if (n.includes('web')) return 'McpCall';
  return 'ToolCall';
}

const CODEBUDDY_EDIT_TOOLS = new Set([
  'edit',
  'edit_file',
  'editfile',
  'write',
  'write_file',
  'writefile',
  'create_file',
  'apply_patch',
  'multiedit',
  'multi_edit',
  'replace',
  'delete_file',
]);

function normaliseCodeBuddyEdit(
  toolName: string,
  input: Record<string, unknown> | null,
  status: FileEditStatus = 'proposed',
): NormalizedFileEdit | null {
  const lower = toolName.toLowerCase();
  if (!CODEBUDDY_EDIT_TOOLS.has(lower)) return null;

  const filePath =
    asStringOrNull(input?.file_path)
    ?? asStringOrNull(input?.filePath)
    ?? asStringOrNull(input?.path)
    ?? asStringOrNull(input?.target_file);
  if (!filePath) return null;

  let operation: FileEditOperation = 'update';
  if (lower === 'delete_file') operation = 'delete';
  else if (lower === 'create_file' || lower === 'write_file' || lower === 'writefile' || lower === 'write') {
    operation = 'create';
  }

  const oldString = asStringOrNull(input?.old_string);
  const newString =
    asStringOrNull(input?.new_string)
    ?? asStringOrNull(input?.content)
    ?? asStringOrNull(input?.code_edit);

  let diff: string | null = null;
  let summary: string;
  if (operation === 'delete') {
    summary = `Deleted ${filePath}`;
  } else if (operation === 'create') {
    diff = diffFromOldNew(filePath, '', newString ?? '');
    summary = `Created ${filePath}`;
  } else {
    if (oldString !== null || newString !== null) {
      diff = diffFromOldNew(filePath, oldString ?? '', newString ?? '');
    }
    summary = `Edited ${filePath}`;
  }

  return {
    filePath,
    diff,
    summary,
    oldString,
    newString,
    meta: { operation, status, oldPath: null },
  };
}

interface SessionMetaRow {
  conversationId?: string;
  cwd?: string;
  userId?: string;
  title?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  isPlayground?: boolean;
}

interface CodeBuddyMessageRow {
  id?: string;
  role?: string;
  content?: unknown;
  timestamp?: string | number;
  toolCalls?: Array<{
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
    input?: Record<string, unknown>;
    result?: unknown;
    status?: string;
  }>;
  toolResult?: { id?: string; output?: unknown; isError?: boolean };
}

function mapRole(raw: string | null | undefined): MessageRole {
  switch ((raw ?? '').toLowerCase()) {
    case 'user':
      return 'User';
    case 'assistant':
    case 'model':
      return 'Assistant';
    case 'system':
      return 'System';
    case 'tool':
    case 'tool_use':
      return 'ToolUse';
    case 'tool_result':
      return 'ToolResult';
    default:
      return 'Assistant';
  }
}

function convertMessageContent(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [emptyBlock('Text', content)] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const item of content) {
    const obj = asObject(item);
    if (!obj) continue;
    const type = asStringOrNull(obj.type);
    if (type === 'text') {
      const text = asStringOrNull(obj.text);
      if (text) blocks.push(emptyBlock('Text', text));
    } else if (type === 'thinking') {
      const text = asStringOrNull(obj.thinking) ?? asStringOrNull(obj.text);
      if (text) blocks.push(emptyBlock('Thinking', text));
    } else if (type === 'tool_use') {
      const name = asStringOrNull(obj.name) ?? 'unknown';
      const input = asObject(obj.input);
      const edit = normaliseCodeBuddyEdit(name, input, 'proposed');
      if (edit) blocks.push(buildFileEditBlock(edit, { toolName: name, toolInput: input }));
      else {
        blocks.push({
          ...emptyBlock(classifyToolName(name), `Tool: ${name}`),
          toolName: name,
          toolInput: input,
        });
      }
    } else if (type === 'tool_result') {
      const text = stringifyUnknown(obj.content);
      blocks.push(emptyBlock('ToolOutput', preserveFullText(text)));
    }
  }
  return blocks;
}

export class CodeBuddyParser implements ToolParser {
  /** Per-conversation last `updatedAt` already emitted (session-stub dedupe). */
  private readonly lastSessionUpdatedAt = new Map<string, number>();
  /** Per-message-file last byte offset (for messages.jsonl streaming). */
  // (Reserved for future use; current logic relies on the offset arg only.)

  constructor(private readonly machineId: string) {}

  toolType(): ToolType {
    return 'CodeBuddy';
  }

  fileExtensions(): string[] {
    return ['vscdb', 'jsonl', 'json'];
  }

  matches(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const name = basename(filePath);
    if (name === 'codebuddy-sessions.vscdb') return true;
    // Per-conversation message file under genie-history/<projectKey>/conversations/<convId>/...
    if (/\/genie-history\/[^/]+\/conversations\/[^/]+\//.test(normalized)) {
      return name === 'messages.jsonl' || name === 'messages.json';
    }
    // genie-history pointer file: genie-history/<projectKey>/current.json
    if (/\/genie-history\/[^/]+\/current\.json$/.test(normalized)) return true;
    // message-queue payloads: .../message-queue/<convId>.json
    if (/\/message-queue\/[^/]+\.json$/.test(normalized) && name.endsWith('.json')) return true;
    return false;
  }

  logPaths(): string[] {
    const home = homedir();
    const candidates: string[] = [];
    const seg = ['User', 'globalStorage', 'tencent-cloud.coding-copilot'];
    let cbRoot: string;
    if (process.platform === 'win32') {
      const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
      cbRoot = join(roaming, 'CodeBuddy');
    } else if (process.platform === 'darwin') {
      cbRoot = join(home, 'Library', 'Application Support', 'CodeBuddy');
    } else {
      const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
      cbRoot = join(xdgConfig, 'CodeBuddy');
    }
    // Top-level CodeBuddy root holds codebuddy-sessions.vscdb (real layout).
    candidates.push(cbRoot);
    // Extension globalStorage holds genie-history/, message-queue/, etc.
    candidates.push(join(cbRoot, ...seg));
    return candidates.filter((p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    });
  }

  async parseIncremental(filePath: string, offset: number): Promise<ParseResult> {
    if (!this.matches(filePath)) return { messages: [], newOffset: offset };
    const name = basename(filePath);
    if (name === 'codebuddy-sessions.vscdb') return this.parseSessionsDb(filePath, offset);
    if (name === 'messages.jsonl') return this.parseMessagesJsonl(filePath, offset);
    if (name === 'messages.json') return this.parseMessagesJson(filePath, offset);
    return { messages: [], newOffset: offset };
  }

  // ---------------------------------------------------------------------------
  // SQLite helpers (mirrors CursorParser's copy-to-temp pattern)
  // ---------------------------------------------------------------------------
  private copyToTemp(src: string): string {
    const tmpRoot = join(tmpdir(), 'sessions-ai-codebuddy');
    mkdirSync(tmpRoot, { recursive: true });
    const hash = createHash('sha1').update(src).digest('hex').slice(0, 12);
    const dst = join(tmpRoot, `copy_${hash}_${basename(src)}`);
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

  // ---------------------------------------------------------------------------
  // Sessions DB → session-stub messages
  // ---------------------------------------------------------------------------
  private parseSessionsDb(filePath: string, offset: number): ParseResult {
    let st;
    try {
      st = statSync(filePath);
    } catch {
      return { messages: [], newOffset: offset };
    }
    if (st.size === 0) return { messages: [], newOffset: 0 };
    // NOTE: Do not short-circuit on st.size === offset. SQLite WAL keeps the main
    // file size constant for long stretches while new sessions land in the -wal file.
    // The outer watcher dedupes calls via fileSignature (which folds in -wal/-shm),
    // and this.lastSessionUpdatedAt prevents emitting unchanged session stubs.
    void offset;

    const tempPath = this.copyToTemp(filePath);
    let db: Database | null = null;
    const out: UnifiedMessage[] = [];

    try {
      db = new Database(tempPath, { readonly: true });
      const tableExists = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'")
        .get() as { name?: string } | null;
      if (!tableExists) return { messages: [], newOffset: st.size };

      const rows = db
        .query("SELECT key, value FROM ItemTable WHERE key LIKE 'session:%'")
        .all() as Array<{ key: string; value: string | Buffer }>;

      for (const row of rows) {
        const valueText = typeof row.value === 'string' ? row.value : row.value.toString('utf-8');
        let meta: SessionMetaRow;
        try {
          meta = JSON.parse(valueText) as SessionMetaRow;
        } catch {
          continue;
        }
        const conversationId = asStringOrNull(meta.conversationId);
        if (!conversationId) continue;

        const updatedAt = typeof meta.updatedAt === 'number' ? meta.updatedAt : 0;
        const lastEmitted = this.lastSessionUpdatedAt.get(conversationId) ?? -1;
        if (updatedAt > 0 && updatedAt <= lastEmitted) continue;
        this.lastSessionUpdatedAt.set(conversationId, updatedAt);

        const title = asStringOrNull(meta.title) ?? '(untitled)';
        const cwd = asStringOrNull(meta.cwd) ?? null;
        const status = asStringOrNull(meta.status) ?? null;
        const createdAt = typeof meta.createdAt === 'number' ? meta.createdAt : 0;
        const ts = updatedAt || createdAt;

        const summary = `[CodeBuddy session] ${title}`
          + (cwd ? `\ncwd: ${cwd}` : '')
          + (status ? `\nstatus: ${status}` : '');

        out.push({
          id: toUuidV5(`codebuddy:session-stub:${conversationId}:${updatedAt}`),
          sessionId: toUuidV5(`session:codebuddy:${conversationId}`),
          parentId: null,
          machineId: this.machineId,
          sourceTool: 'CodeBuddy',
          role: 'System',
          contentBlocks: [emptyBlock('Status', summary)],
          usage: null,
          timestamp: toIsoTimestamp(ts),
          metadata: {
            conversationId,
            cwd,
            status,
            title,
            isPlayground: meta.isPlayground === true,
            userId: asStringOrNull(meta.userId),
            createdAt: createdAt || null,
            updatedAt: updatedAt || null,
            sourceFile: basename(filePath),
            stub: true,
          },
          sourcePayload: sourcePayload({
            format: 'codebuddy.sessions-db.row.v1',
            sourcePath: filePath,
            sourceFile: basename(filePath),
            sourceSessionId: conversationId,
            sourceMessageId: conversationId,
            records: [{
              key: row.key,
              row: meta,
              rawValue: valueText,
            }],
          }),
        });
      }
    } catch (err) {
      logger.warn({ path: filePath, err: String(err) }, 'CodeBuddy sessions DB read failed');
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
      this.cleanupTemp(tempPath);
    }

    return { messages: out, newOffset: st.size };
  }

  // ---------------------------------------------------------------------------
  // Per-conversation messages.jsonl (incremental, streaming)
  // ---------------------------------------------------------------------------
  private parseMessagesJsonl(filePath: string, offset: number): ParseResult {
    let st;
    try {
      st = statSync(filePath);
    } catch {
      return { messages: [], newOffset: offset };
    }
    let startOffset = offset;
    if (st.size < offset) startOffset = 0;
    if (st.size === startOffset) return { messages: [], newOffset: st.size };

    let raw: Buffer;
    try {
      raw = readFileSync(filePath);
    } catch (err) {
      logger.warn({ path: filePath, err: String(err) }, 'CodeBuddy messages.jsonl read failed');
      return { messages: [], newOffset: offset };
    }

    const conversationId = basename(dirname(filePath));
    const projectKey = basename(dirname(dirname(dirname(filePath)))); // genie-history/<projectKey>/conversations/<id>/messages.jsonl
    const messages: UnifiedMessage[] = [];

    let lineStart = 0;
    let lineNo = 0;

    for (let i = 0; i <= raw.length; i++) {
      const isLineEnd = i === raw.length || raw[i] === 10;
      if (!isLineEnd) continue;
      let lineEnd = i;
      if (lineEnd > lineStart && raw[lineEnd - 1] === 13) lineEnd -= 1;
      const consumedBytes = i === raw.length ? i : i + 1;
      lineNo += 1;
      const line = raw.subarray(lineStart, lineEnd).toString('utf-8').trim();
      lineStart = i + 1;
      if (line.length === 0) continue;
      if (consumedBytes <= startOffset) continue;

      let row: CodeBuddyMessageRow | null = null;
      try {
        row = JSON.parse(line) as CodeBuddyMessageRow;
      } catch {
        continue;
      }
      if (!row) continue;
      const built = this.buildMessageFromRow(row, conversationId, projectKey, lineNo, filePath);
      if (built) messages.push(built);
    }

    return { messages, newOffset: st.size };
  }

  // ---------------------------------------------------------------------------
  // Per-conversation messages.json (monolithic array)
  // ---------------------------------------------------------------------------
  private parseMessagesJson(filePath: string, offset: number): ParseResult {
    let st;
    try {
      st = statSync(filePath);
    } catch {
      return { messages: [], newOffset: offset };
    }
    if (st.size === 0) return { messages: [], newOffset: 0 };
    if (st.size === offset) return { messages: [], newOffset: st.size };

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      logger.warn({ path: filePath, err: String(err) }, 'CodeBuddy messages.json read failed');
      return { messages: [], newOffset: offset };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { messages: [], newOffset: st.size };
    }
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { messages?: unknown })?.messages)
        ? ((parsed as { messages: unknown[] }).messages)
        : [];

    const conversationId = basename(dirname(filePath));
    const projectKey = basename(dirname(dirname(dirname(filePath))));
    const out: UnifiedMessage[] = [];

    for (let i = 0; i < arr.length; i++) {
      const row = arr[i] as CodeBuddyMessageRow;
      const built = this.buildMessageFromRow(row, conversationId, projectKey, i, filePath);
      if (built) out.push(built);
    }
    return { messages: out, newOffset: st.size };
  }

  private buildMessageFromRow(
    row: CodeBuddyMessageRow,
    conversationId: string,
    projectKey: string,
    lineNo: number,
    filePath: string,
  ): UnifiedMessage | null {
    if (!row || typeof row !== 'object') return null;
    const role = mapRole(row.role);
    const blocks = convertMessageContent(row.content);

    // Top-level toolCalls / toolResult convenience fields.
    if (Array.isArray(row.toolCalls)) {
      for (const tc of row.toolCalls) {
        const name = asStringOrNull(tc?.name) ?? 'unknown';
        const input = asObject(tc?.args ?? tc?.input);
        const status: FileEditStatus = asStringOrNull(tc?.status) === 'error' ? 'failed' : 'applied';
        const edit = normaliseCodeBuddyEdit(name, input, status);
        if (edit) blocks.push(buildFileEditBlock(edit, { toolName: name, toolInput: input }));
        else {
          blocks.push({
            ...emptyBlock(classifyToolName(name), `Tool: ${name}`),
            toolName: name,
            toolInput: input,
          });
        }
        if (tc?.result !== undefined) {
          blocks.push(emptyBlock('ToolOutput', preserveFullText(stringifyUnknown(tc.result))));
        }
      }
    }
    if (row.toolResult) {
      blocks.push(emptyBlock('ToolOutput', preserveFullText(stringifyUnknown(row.toolResult.output ?? row.toolResult))));
    }

    if (blocks.length === 0) return null;

    const sourceMessageId = asStringOrNull(row.id) ?? `line:${lineNo}`;
    return {
      id: toUuidV5(`codebuddy:msg:${conversationId}:${sourceMessageId}`),
      sessionId: toUuidV5(`session:codebuddy:${conversationId}`),
      parentId: null,
      machineId: this.machineId,
      sourceTool: 'CodeBuddy',
      role,
      contentBlocks: blocks,
      usage: null,
      timestamp: toIsoTimestamp(row.timestamp),
      metadata: {
        conversationId,
        projectKey,
        sourceMessageId,
      },
      sourcePayload: sourcePayload({
        format: 'codebuddy.message-row.v1',
        sourcePath: filePath,
        sourceFile: basename(filePath),
        sourceSessionId: conversationId,
        sourceMessageId,
        records: [{ lineNo, row }],
        extra: { projectKey },
      }),
    };
  }
}
