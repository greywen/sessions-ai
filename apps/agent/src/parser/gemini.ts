import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import type {
  ContentBlock,
  ContentBlockType,
  MessageRole,
  TokenUsage,
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
 * Gemini CLI parser.
 *
 * Supports three on-disk shapes observed in `~/.gemini/tmp/<user>/`:
 *
 *  1. Streaming JSONL session: `chats/session-*.jsonl`
 *     - First line: header `{ sessionId, projectHash, startTime, lastUpdated, kind }`
 *     - Body lines: events `{ id, timestamp, type: 'user'|'gemini'|'info'|'warning'|'error', content, ... }`
 *     - Mutator lines: `{ "$set": { lastUpdated: ... } }` (ignored for messages)
 *
 *  2. Monolithic JSON session: `chats/session-*.json`
 *     - Single object: `{ sessionId, kind, messages: [...] }` (older / reference-project shape)
 *
 *  3. Legacy Qwen-compatible array: `logs.json`
 *     - Array of `{ sessionId, messageId, type, message, timestamp, ... }`
 *
 * Cross-checked against `jhlee0409/claude-code-history-viewer` Gemini provider
 * for tool-name mapping, message conversion and content-block layout.
 */
const GEMINI_NS = 'gemini-cli-ns-v1';

function toUuidV5(name: string, namespace: string = GEMINI_NS): string {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(name) && namespace === GEMINI_NS) return name.toLowerCase();
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

function toSafeNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
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
  if (n.includes('shell') || n.includes('exec') || n.includes('bash') || n.includes('run_command')) return 'ShellCommand';
  if (n.includes('search') || n.includes('grep') || n.includes('find') || n.includes('list_dir')) return 'SearchResult';
  if (n.includes('web')) return 'McpCall';
  return 'ToolCall';
}

/**
 * Map raw Gemini tool names to a Claude-style canonical name.
 * Mirrors `map_gemini_tool_name` in the reference project.
 */
function mapGeminiToolName(name: string): string {
  switch (name) {
    case 'read_file':
    case 'ReadFile':
      return 'Read';
    case 'write_file':
    case 'WriteFile':
    case 'create_file':
      return 'Write';
    case 'edit_file':
    case 'EditFile':
    case 'replace':
      return 'Edit';
    case 'shell':
    case 'run_command':
    case 'execute_command':
      return 'Bash';
    case 'list_directory':
    case 'list_dir':
      return 'Glob';
    case 'search_files':
    case 'grep':
      return 'Grep';
    case 'web_search':
    case 'google_web_search':
      return 'WebSearch';
    case 'web_fetch':
      return 'WebFetch';
    default:
      return name;
  }
}

const GEMINI_EDIT_TOOLS = new Set([
  'edit',
  'edit_file',
  'editfile',
  'replace',
  'write_file',
  'writefile',
  'create_file',
  'apply_patch',
  'multiedit',
  'multi_edit',
]);

/** Build a NormalizedFileEdit from a Gemini tool call's input. */
function normaliseGeminiEdit(
  toolName: string,
  input: Record<string, unknown> | null,
  status: FileEditStatus = 'proposed',
): NormalizedFileEdit | null {
  const lower = toolName.toLowerCase();
  if (!GEMINI_EDIT_TOOLS.has(lower)) return null;

  const filePath =
    asStringOrNull(input?.file_path)
    ?? asStringOrNull(input?.filePath)
    ?? asStringOrNull(input?.path)
    ?? asStringOrNull(input?.absolute_path);
  if (!filePath) return null;

  let operation: FileEditOperation = 'update';
  if (lower === 'create_file' || lower === 'write_file' || lower === 'writefile') {
    operation = 'create';
  }

  const oldString = asStringOrNull(input?.old_string);
  const newString =
    asStringOrNull(input?.new_string)
    ?? asStringOrNull(input?.content);

  let diff: string | null = null;
  let summary: string;
  if (operation === 'create') {
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

function parseTokens(tokens: unknown, model: string): TokenUsage | null {
  const t = asObject(tokens);
  if (!t) return null;
  const input = Math.max(0, toSafeNumber(t.input));
  const output = Math.max(0, toSafeNumber(t.output));
  const cached = Math.max(0, toSafeNumber(t.cached));
  if (input === 0 && output === 0 && cached === 0) return null;
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: output,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: cached > 0 ? cached : null,
    model,
  };
}

interface GeminiContentPart {
  text?: unknown;
  thought?: unknown;
  inlineData?: { mimeType?: unknown; data?: unknown };
  fileData?: { fileUri?: unknown; mimeType?: unknown };
  functionCall?: { id?: unknown; name?: unknown; args?: unknown };
  functionResponse?: { id?: unknown; name?: unknown; response?: { output?: unknown } };
  executableCode?: { code?: unknown; language?: unknown };
  codeExecutionResult?: { outcome?: unknown; output?: unknown };
}

/** Convert a single Gemini content part to a ContentBlock (or null to skip). */
function convertPart(part: unknown): ContentBlock | null {
  if (typeof part === 'string') {
    return part.length > 0 ? emptyBlock('Text', part) : null;
  }
  const p = asObject(part) as GeminiContentPart | null;
  if (!p) return null;

  if (typeof p.text === 'string') {
    if (p.text.length === 0) return null;
    if (p.thought === true) return emptyBlock('Thinking', p.text);
    return emptyBlock('Text', p.text);
  }

  if (p.inlineData) {
    const mime = asStringOrNull(p.inlineData.mimeType) ?? 'application/octet-stream';
    if (mime.startsWith('image/')) {
      const block = emptyBlock('Image', `[Image ${mime}]`);
      return block;
    }
    return emptyBlock('Text', `[Inline ${mime}]`);
  }

  if (p.fileData) {
    const uri = asStringOrNull(p.fileData.fileUri) ?? '';
    return emptyBlock('Text', `[File] ${uri}`);
  }

  if (p.functionCall) {
    const name = asStringOrNull(p.functionCall.name) ?? 'unknown';
    const args = asObject(p.functionCall.args);
    const edit = normaliseGeminiEdit(name, args, 'proposed');
    if (edit) return buildFileEditBlock(edit, { toolName: name, toolInput: args });
    return {
      ...emptyBlock(classifyToolName(name), `Tool: ${mapGeminiToolName(name)}`),
      toolName: mapGeminiToolName(name),
      toolInput: args,
    };
  }

  if (p.functionResponse) {
    const name = asStringOrNull(p.functionResponse.name) ?? 'unknown';
    const output = asStringOrNull(p.functionResponse.response?.output) ?? stringifyUnknown(p.functionResponse.response);
    return {
      ...emptyBlock(classifyToolName(name), preserveFullText(output)),
      toolName: mapGeminiToolName(name),
    };
  }

  if (p.executableCode) {
    const code = asStringOrNull(p.executableCode.code) ?? '';
    const language = asStringOrNull(p.executableCode.language) ?? 'python';
    const block = emptyBlock('Code', code);
    block.language = language.toLowerCase();
    return block;
  }

  if (p.codeExecutionResult) {
    const outcome = asStringOrNull(p.codeExecutionResult.outcome) ?? 'UNKNOWN';
    const output = asStringOrNull(p.codeExecutionResult.output) ?? '';
    return emptyBlock('ShellOutput', `[${outcome}]\n${output}`);
  }

  return null;
}

function convertContent(content: unknown): ContentBlock[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') {
    return content.length > 0 ? [emptyBlock('Text', content)] : [];
  }
  if (Array.isArray(content)) {
    const out: ContentBlock[] = [];
    for (const part of content) {
      const b = convertPart(part);
      if (b) out.push(b);
    }
    return out;
  }
  return [];
}

interface ToolCallEntry {
  id?: unknown;
  name?: unknown;
  args?: unknown;
  result?: unknown;
  status?: unknown;
  resultDisplay?: unknown;
}

/** Convert top-level toolCalls[] from a `gemini` event row. */
function convertToolCalls(toolCalls: unknown): ContentBlock[] {
  if (!Array.isArray(toolCalls)) return [];
  const out: ContentBlock[] = [];
  for (const raw of toolCalls) {
    const tc = raw as ToolCallEntry;
    if (!tc || typeof tc !== 'object') continue;
    const name = asStringOrNull(tc.name) ?? 'unknown';
    const args = asObject(tc.args);
    const status: FileEditStatus = asStringOrNull(tc.status) === 'error' ? 'failed' : 'applied';
    const edit = normaliseGeminiEdit(name, args, status);
    if (edit) {
      out.push(buildFileEditBlock(edit, { toolName: name, toolInput: args }));
    } else {
      out.push({
        ...emptyBlock(classifyToolName(name), `Tool: ${mapGeminiToolName(name)}`),
        toolName: mapGeminiToolName(name),
        toolInput: args,
      });
    }
    // Append tool result (if present) as a follow-up block.
    if (tc.result !== undefined) {
      const text = extractToolResultText(tc.result);
      if (text.length > 0) {
        out.push({
          ...emptyBlock(classifyToolName(name), preserveFullText(text)),
          toolName: mapGeminiToolName(name),
        });
      }
    }
  }
  return out;
}

function extractToolResultText(result: unknown): string {
  if (Array.isArray(result)) {
    const parts: string[] = [];
    for (const item of result) {
      const obj = asObject(item);
      const fr = asObject(obj?.functionResponse);
      const resp = asObject(fr?.response);
      const out = asStringOrNull(resp?.output);
      if (out) parts.push(out);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  if (typeof result === 'string') return result;
  return stringifyUnknown(result);
}

function convertGeminiResponseRow(row: Record<string, unknown>): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  // 1. Top-level thoughts[]
  const thoughts = row.thoughts;
  if (Array.isArray(thoughts)) {
    for (const t of thoughts) {
      const obj = asObject(t);
      if (!obj) continue;
      const subject = asStringOrNull(obj.subject) ?? '';
      const description = asStringOrNull(obj.description) ?? '';
      const text = subject ? `**${subject}**\n${description}` : description;
      if (text.length > 0) blocks.push(emptyBlock('Thinking', text));
    }
  }

  // 2. content (string OR Part[])
  const contentBlocks = convertContent(row.content);
  blocks.push(...contentBlocks);

  // 3. Top-level toolCalls[]
  blocks.push(...convertToolCalls(row.toolCalls));

  return blocks;
}

interface ConvertedRow {
  role: MessageRole;
  blocks: ContentBlock[];
  usage: TokenUsage | null;
  model: string | null;
}

/** Convert a single event row (any type) to a UnifiedMessage shape. */
function convertEventRow(row: Record<string, unknown>): ConvertedRow | null {
  const type = asStringOrNull(row.type);
  if (!type) return null;

  switch (type) {
    case 'user': {
      const blocks = convertContent(row.content);
      if (blocks.length === 0) return null;
      return { role: 'User', blocks, usage: null, model: null };
    }
    case 'gemini':
    case 'assistant':
    case 'model': {
      const model = asStringOrNull(row.model) ?? 'gemini';
      const blocks = convertGeminiResponseRow(row);
      if (blocks.length === 0) return null;
      const usage = parseTokens(row.tokens, model);
      return { role: 'Assistant', blocks, usage, model };
    }
    case 'info':
    case 'warning':
      // Drop CLI noise (e.g. "Conflicts detected for command...") to keep the session clean.
      return null;
    case 'error': {
      const text = typeof row.content === 'string'
        ? row.content
        : stringifyUnknown(row.content);
      if (!text) return null;
      return { role: 'System', blocks: [emptyBlock('Error', text)], usage: null, model: null };
    }
    default:
      return null;
  }
}

/** Header row detection — first JSONL line containing sessionId+startTime+kind. */
function isHeaderRow(row: Record<string, unknown>): boolean {
  return typeof row.sessionId === 'string'
    && typeof row.startTime === 'string'
    && typeof row.kind === 'string'
    && row.type === undefined;
}

/** Mutator row detection — `{ "$set": ... }` lines. */
function isMutatorRow(row: Record<string, unknown>): boolean {
  return Object.keys(row).every((k) => k.startsWith('$'));
}

interface LegacyLogEntry {
  sessionId?: string;
  messageId?: number | string;
  type?: string;
  message?: unknown;
  timestamp?: string | number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
}

export class GeminiCliParser implements ToolParser {
  // Per-session header-derived sessionId from JSONL header line, keyed by file path.
  private readonly headerSessionByFile = new Map<string, string>();

  constructor(private readonly machineId: string) {}

  toolType(): ToolType {
    return 'GeminiCli';
  }

  fileExtensions(): string[] {
    return ['jsonl', 'json'];
  }

  matches(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    // Accept default `~/.gemini/tmp/` layout (anywhere in path, for tests/sandboxes)
    // OR a custom location rooted at $GEMINI_HOME/tmp/.
    let underGeminiRoot = /\/\.gemini\/tmp\//.test(normalized);
    if (!underGeminiRoot && process.env.GEMINI_HOME) {
      const customRoot = `${process.env.GEMINI_HOME.replace(/\\/g, '/').replace(/\/$/, '')}/tmp/`;
      underGeminiRoot = normalized.startsWith(customRoot);
    }
    if (!underGeminiRoot) return false;
    const name = basename(filePath);
    if (name === 'logs.json') return true;
    if (/^session-.*\.(jsonl|json)$/i.test(name)) return true;
    return false;
  }

  logPaths(): string[] {
    const home = homedir();
    const candidates: string[] = [join(home, '.gemini', 'tmp')];
    if (process.env.GEMINI_HOME) {
      candidates.unshift(join(process.env.GEMINI_HOME, 'tmp'));
    }
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
    if (name === 'logs.json') return this.parseLegacyLogs(filePath, offset);
    if (name.toLowerCase().endsWith('.jsonl')) return this.parseSessionJsonl(filePath, offset);
    return this.parseSessionJson(filePath, offset);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Project name = directory under ~/.gemini/tmp/<projectName>/chats/... */
  private projectNameFor(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const m = /\/\.gemini\/tmp\/([^/]+)\//.exec(normalized);
    return m?.[1] ?? 'unknown';
  }

  private resolveSessionId(filePath: string, fallback: string | null): string {
    const fromHeader = this.headerSessionByFile.get(filePath);
    if (fromHeader) return fromHeader;
    if (fallback) return fallback;
    // Derive from filename: session-<ts>-<short>.jsonl
    const name = basename(filePath, '.jsonl').replace(/^session-/, '');
    return name || filePath;
  }

  private buildMessage(
    sourceSessionId: string,
    sourceMessageId: string,
    converted: ConvertedRow,
    timestamp: string,
    extraMetadata: Record<string, unknown> = {},
    sourcePayloadValue: Record<string, unknown> | null = null,
  ): UnifiedMessage {
    return {
      id: toUuidV5(`gemini:${sourceSessionId}:${sourceMessageId}`),
      sessionId: toUuidV5(`session:${sourceSessionId}`),
      parentId: null,
      machineId: this.machineId,
      sourceTool: 'GeminiCli',
      role: converted.role,
      contentBlocks: converted.blocks,
      usage: converted.usage,
      timestamp,
      metadata: {
        sourceSessionId,
        ...extraMetadata,
      },
      sourcePayload: sourcePayloadValue,
    };
  }

  // ---------------------------------------------------------------------------
  // Streaming JSONL session parser (primary)
  // ---------------------------------------------------------------------------
  private parseSessionJsonl(filePath: string, offset: number): ParseResult {
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
      logger.warn({ path: filePath, err: String(err) }, 'Gemini JSONL read failed');
      return { messages: [], newOffset: offset };
    }

    const projectName = this.projectNameFor(filePath);
    const sourceFile = basename(filePath);
    const messages: UnifiedMessage[] = [];

    let lineStart = 0;
    let lineNo = 0;
    let firstLine = true;

    for (let i = 0; i <= raw.length; i++) {
      const isLineEnd = i === raw.length || raw[i] === 10;
      if (!isLineEnd) continue;

      let lineEnd = i;
      if (lineEnd > lineStart && raw[lineEnd - 1] === 13) lineEnd -= 1;
      const consumedBytes = i === raw.length ? i : i + 1;
      lineNo += 1;

      const line = raw.subarray(lineStart, lineEnd).toString('utf-8').trim();
      lineStart = i + 1;

      if (line.length === 0) {
        firstLine = false;
        continue;
      }

      let row: Record<string, unknown> | null = null;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        row = null;
      }
      if (!row) {
        firstLine = false;
        continue;
      }

      // Header (always on first non-empty line of the file).
      if (firstLine && isHeaderRow(row)) {
        const sid = asStringOrNull(row.sessionId);
        if (sid) this.headerSessionByFile.set(filePath, sid);
        firstLine = false;
        continue;
      }
      firstLine = false;

      // Mutator rows (`$set`, etc.) — ignore for messages.
      if (isMutatorRow(row)) continue;

      // Skip rows already consumed in a previous incremental call.
      if (consumedBytes <= startOffset) continue;

      const converted = convertEventRow(row);
      if (!converted) continue;

      const sourceSessionId = this.resolveSessionId(filePath, asStringOrNull(row.sessionId));
      const sourceMessageId = asStringOrNull(row.id) ?? `line:${lineNo}`;
      const timestamp = toIsoTimestamp(row.timestamp);

      messages.push(this.buildMessage(sourceSessionId, sourceMessageId, converted, timestamp, {
        projectName,
        sourceFile,
      }, sourcePayload({
        format: 'gemini-cli.session-jsonl.row.v1',
        sourcePath: filePath,
        sourceFile,
        sourceSessionId,
        sourceMessageId,
        records: [{ line: row }],
        extra: { projectName },
      })));
    }

    return { messages, newOffset: st.size };
  }

  // ---------------------------------------------------------------------------
  // Monolithic JSON session parser (reference-project shape)
  // ---------------------------------------------------------------------------
  private parseSessionJson(filePath: string, offset: number): ParseResult {
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
      logger.warn({ path: filePath, err: String(err) }, 'Gemini JSON read failed');
      return { messages: [], newOffset: offset };
    }

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { messages: [], newOffset: st.size };
    }

    const sourceSessionId = asStringOrNull(record.sessionId) ?? basename(filePath, '.json');
    const messagesRaw = Array.isArray(record.messages) ? record.messages : [];
    const projectName = this.projectNameFor(filePath);
    const sourceFile = basename(filePath);

    const out: UnifiedMessage[] = [];
    for (let i = 0; i < messagesRaw.length; i++) {
      const row = asObject(messagesRaw[i]);
      if (!row) continue;
      const converted = convertEventRow(row);
      if (!converted) continue;
      const sourceMessageId = asStringOrNull(row.id) ?? `idx:${i}`;
      const timestamp = toIsoTimestamp(row.timestamp);
      out.push(
        this.buildMessage(sourceSessionId, sourceMessageId, converted, timestamp, {
          projectName,
          sourceFile,
        }, sourcePayload({
          format: 'gemini-cli.session-json.message.v1',
          sourcePath: filePath,
          sourceFile,
          sourceSessionId,
          sourceMessageId,
          records: [{ message: row }],
          extra: { projectName },
        })),
      );
    }

    return { messages: out, newOffset: st.size };
  }

  // ---------------------------------------------------------------------------
  // Legacy logs.json parser (Qwen-compatible array)
  // ---------------------------------------------------------------------------
  private parseLegacyLogs(filePath: string, offset: number): ParseResult {
    let st;
    try {
      st = statSync(filePath);
    } catch {
      return { messages: [], newOffset: offset };
    }
    if (st.size === 0) return { messages: [], newOffset: 0 };

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      logger.warn({ path: filePath, err: String(err) }, 'Gemini legacy logs read failed');
      return { messages: [], newOffset: offset };
    }

    let entries: LegacyLogEntry[];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return { messages: [], newOffset: offset };
      entries = parsed as LegacyLogEntry[];
    } catch {
      return { messages: [], newOffset: offset };
    }

    let startIdx = offset;
    if (entries.length < offset) startIdx = 0;
    if (entries.length === startIdx) return { messages: [], newOffset: entries.length };

    const projectName = this.projectNameFor(filePath);
    // Sessions already covered by JSONL headers must not be duplicated through legacy logs.
    const jsonlSessionIds = new Set<string>(this.headerSessionByFile.values());
    const out: UnifiedMessage[] = [];

    for (let i = startIdx; i < entries.length; i++) {
      const e = entries[i];
      const sourceSessionId = asStringOrNull(e.sessionId) ?? projectName;
      if (jsonlSessionIds.has(sourceSessionId)) continue;
      const sourceMessageId = `${e.messageId ?? i}:${e.type ?? 'unknown'}`;
      const timestamp = toIsoTimestamp(e.timestamp);

      let role: MessageRole = 'Assistant';
      const blocks: ContentBlock[] = [];

      switch (e.type) {
        case 'user':
          role = 'User';
          blocks.push(emptyBlock('Text', stringifyUnknown(e.message)));
          break;
        case 'assistant':
        case 'gemini':
        case 'model':
          role = 'Assistant';
          blocks.push(emptyBlock('Text', stringifyUnknown(e.message)));
          break;
        case 'tool_call': {
          role = 'ToolUse';
          const toolName = e.toolName ?? 'unknown';
          const args = e.toolArgs ?? null;
          const result = stringifyUnknown(e.toolResult);
          const status: FileEditStatus = result.toLowerCase().includes('error')
            ? 'failed'
            : 'applied';
          const edit = normaliseGeminiEdit(toolName, args, status);
          if (edit) {
            blocks.push(buildFileEditBlock(edit, { toolName, toolInput: args }));
          } else {
            blocks.push({
              ...emptyBlock(classifyToolName(toolName), preserveFullText(result || `Tool: ${toolName}`)),
              toolName: mapGeminiToolName(toolName),
              toolInput: args,
            });
          }
          break;
        }
        case 'system':
          role = 'System';
          blocks.push(emptyBlock('Status', stringifyUnknown(e.message)));
          break;
        case 'error':
          role = 'System';
          blocks.push(emptyBlock('Error', stringifyUnknown(e.message)));
          break;
        default:
          blocks.push(emptyBlock('Text', stringifyUnknown(e.message)));
      }

      if (blocks.length === 0) continue;

      out.push({
        id: toUuidV5(`gemini:legacy:${projectName}:${sourceSessionId}:${sourceMessageId}`),
        sessionId: toUuidV5(`session:${sourceSessionId}`),
        parentId: null,
        machineId: this.machineId,
        sourceTool: 'GeminiCli',
        role,
        contentBlocks: blocks,
        usage: null,
        timestamp,
        metadata: { projectName, sourceFile: basename(filePath), sourceSessionId, legacy: true },
        sourcePayload: sourcePayload({
          format: 'gemini-cli.legacy-logs.entry.v1',
          sourcePath: filePath,
          sourceFile: basename(filePath),
          sourceSessionId,
          sourceMessageId,
          records: [{ index: i, entry: e }],
          extra: { projectName, legacy: true },
        }),
      });
    }

    return { messages: out, newOffset: entries.length };
  }
}

// Suppress unused-import warning for readdir/dirname (kept for future use).
void readdirSync;
void dirname;
