import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type {
  ContentBlock,
  ContentBlockType,
  MessageRole,
  ToolType,
  TokenUsage,
  UnifiedMessage,
} from './types.ts';
import type { ParseResult, ToolParser } from './tool-parser.ts';
import { logger } from '../logger.ts';
import {
  buildFileEditBlock,
  diffFromHunks,
  diffFromOldNew,
  type FileEditMeta,
  type NormalizedFileEdit,
} from './edit-normalizer.ts';
import { sourcePayload } from './source-payload.ts';

const CLAUDE_NS = 'claude-code-ns-v1';

function toUuidV5(name: string, namespace: string = CLAUDE_NS): string {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(name) && namespace === CLAUDE_NS) return name.toLowerCase();
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

function preserveFullText(input: string): string {
  return input;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
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

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function classifyToolName(name: string): ContentBlockType {
  const n = name.toLowerCase();
  if (n.includes('bash') || n.includes('shell') || n.includes('exec')) return 'ShellCommand';
  if (n.includes('apply_patch') || n.includes('edit') || n.includes('write')) return 'FileEdit';
  if (n.includes('read') || n.includes('view')) return 'FileRead';
  if (n.includes('search') || n.includes('grep') || n.includes('find')) return 'SearchResult';
  if (n.includes('web') || n.startsWith('mcp_')) return 'McpCall';
  return 'ToolCall';
}

function resultBlockTypeForToolName(name: string): ContentBlockType {
  const callType = classifyToolName(name);
  switch (callType) {
    case 'ShellCommand':
      return 'ShellOutput';
    case 'McpCall':
      return 'McpResult';
    case 'ToolCall':
      return 'ToolOutput';
    default:
      return callType;
  }
}

function parseUsage(
  usageRaw: Record<string, unknown> | null,
  model: string,
  preserveZero = true,
): TokenUsage | null {
  if (!usageRaw) return null;
  const input = Math.max(0, toSafeNumber(usageRaw.input_tokens));
  const output = Math.max(0, toSafeNumber(usageRaw.output_tokens));
  const cacheRead = Math.max(0, toSafeNumber(usageRaw.cache_read_input_tokens));
  const cacheWrite = Math.max(0, toSafeNumber(usageRaw.cache_creation_input_tokens));
  const hasAny = input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0;
  if (!hasAny && !preserveZero) return null;
  return {
    // Anthropic's input_tokens already excludes cache_read_input_tokens and
    // cache_creation_input_tokens — the three counters are disjoint. Do not
    // subtract; subtracting clamps almost every row to 0 and starves the
    // displayed Input total.
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: cacheWrite > 0 || preserveZero ? cacheWrite : null,
    cacheReadInputTokens: cacheRead > 0 || preserveZero ? cacheRead : null,
    model,
  };
}

function parseToolInput(input: unknown): Record<string, unknown> | null {
  const obj = asObject(input);
  if (obj) return obj;
  if (typeof input === 'string' && input.length > 0) {
    try {
      const parsed = JSON.parse(input) as unknown;
      const parsedObj = asObject(parsed);
      if (parsedObj) return parsedObj;
      return { raw: input };
    } catch {
      return { raw: input };
    }
  }
  return null;
}

function stringifyToolUseResult(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map((v) => stringifyToolUseResult(v)).filter(Boolean).join('\n');
  }
  const obj = asObject(raw);
  if (obj) {
    const stdout = asString(obj.stdout) ?? '';
    const stderr = asString(obj.stderr) ?? '';
    const content = asString(obj.content) ?? '';
    if (stdout || stderr) return [stdout, stderr].filter(Boolean).join('\n');
    if (content) return content;
  }
  return stringifyUnknown(raw);
}

interface ToolUseIndexEntry {
  name: string;
  input: Record<string, unknown> | null;
  /**
   * If the tool_use produced FileEdit blocks (Edit / MultiEdit / Write), we
   * keep references here so the matching tool_result can flip their status
   * from `proposed` to `applied` / `failed` instead of emitting a duplicate.
   */
  fileEditBlocks?: ContentBlock[];
}

/**
 * Normalised file edit entry derived from a Claude `Edit` / `MultiEdit` /
 * `Write` tool_use. Returns `null` when the tool is not an edit tool or the
 * input is missing required keys.
 */
function normaliseClaudeEdit(
  toolName: string,
  input: Record<string, unknown> | null,
): NormalizedFileEdit[] | null {
  if (!input) return null;
  const filePath = asString(input.file_path) ?? asString(input.filePath);
  if (!filePath) return null;

  if (toolName === 'Edit') {
    const oldString = asString(input.old_string) ?? '';
    const newString = asString(input.new_string) ?? '';
    const diff = diffFromOldNew(filePath, oldString, newString);
    return [
      {
        filePath,
        diff,
        summary: `Edited ${filePath}`,
        oldString,
        newString,
        meta: { operation: 'update', status: 'proposed', oldPath: null },
      },
    ];
  }

  if (toolName === 'MultiEdit') {
    const editsRaw = Array.isArray(input.edits) ? input.edits : [];
    const hunks: Array<{ oldString: string; newString: string }> = [];
    for (const e of editsRaw) {
      const obj = asObject(e);
      if (!obj) continue;
      const oldString = asString(obj.old_string) ?? '';
      const newString = asString(obj.new_string) ?? '';
      hunks.push({ oldString, newString });
    }
    if (hunks.length === 0) return null;
    const diff = diffFromHunks(filePath, hunks);
    return [
      {
        filePath,
        diff,
        summary: `Edited ${filePath} (${hunks.length} hunks)`,
        oldString: hunks.map((h) => h.oldString).join('\n') || null,
        newString: hunks.map((h) => h.newString).join('\n') || null,
        meta: { operation: 'update', status: 'proposed', oldPath: null },
      },
    ];
  }

  if (toolName === 'Write') {
    const content = asString(input.content) ?? '';
    const diff = diffFromOldNew(filePath, '', content);
    return [
      {
        filePath,
        diff,
        summary: `Wrote ${filePath}`,
        oldString: '',
        newString: content,
        meta: { operation: 'create', status: 'proposed', oldPath: null },
      },
    ];
  }

  return null;
}

function setEditStatus(blocks: ContentBlock[] | undefined, status: FileEditMeta['status']): void {
  if (!blocks) return;
  for (const b of blocks) {
    const ti = b.toolInput as Record<string, unknown> | null;
    if (!ti) continue;
    const meta = ti.editMeta as FileEditMeta | undefined;
    if (meta) meta.status = status;
  }
}

interface ParsedBlocks {
  blocks: ContentBlock[];
  hasText: boolean;
  hasToolUse: boolean;
  hasToolResult: boolean;
}

interface ClaudeBlocksContext {
  cwd: string | null;
  gitBranch: string | null;
}

function parseClaudeBlocks(
  content: unknown,
  toolUseResultRaw: unknown,
  sourceSessionId: string,
  toolUseIndex: Map<string, ToolUseIndexEntry>,
  ctx: ClaudeBlocksContext = { cwd: null, gitBranch: null },
): ParsedBlocks {
  const result: ParsedBlocks = {
    blocks: [],
    hasText: false,
    hasToolUse: false,
    hasToolResult: false,
  };

  const items = Array.isArray(content) ? content : [];
  for (const itemRaw of items) {
    const item = asObject(itemRaw);
    if (!item) continue;
    const type = asString(item.type) ?? '';

    if (type === 'text') {
      const text = asString(item.text) ?? stringifyUnknown(item.text);
      if (text.length > 0) {
        result.blocks.push(emptyBlock('Text', text));
        result.hasText = true;
      }
      continue;
    }

    if (type === 'thinking') {
      const thinking = asString(item.thinking) ?? asString(item.text) ?? stringifyUnknown(item.thinking);
      if (thinking.length > 0) {
        result.blocks.push(emptyBlock('Thinking', thinking));
      }
      continue;
    }

    if (type === 'tool_use') {
      const name = asString(item.name) ?? 'unknown';
      const input = parseToolInput(item.input);
      const toolUseId = asString(item.id);

      // Edit / MultiEdit / Write -> emit structured FileEdit blocks so the
      // viewer can render a diff, and keep references for status flipping.
      const edits = normaliseClaudeEdit(name, input);
      if (edits && edits.length > 0) {
        const editBlocks = edits.map((e) =>
          buildFileEditBlock(e, {
            toolName: name,
            toolInput: input,
            cwd: ctx.cwd,
            gitBranch: ctx.gitBranch,
          }),
        );
        for (const b of editBlocks) result.blocks.push(b);
        if (toolUseId) {
          toolUseIndex.set(`${sourceSessionId}::${toolUseId}`, {
            name,
            input,
            fileEditBlocks: editBlocks,
          });
        }
        result.hasToolUse = true;
        continue;
      }

      if (toolUseId) toolUseIndex.set(`${sourceSessionId}::${toolUseId}`, { name, input });
      const command = input && typeof input.command === 'string' ? input.command : null;
      result.blocks.push({
        ...emptyBlock(classifyToolName(name), command ?? `Tool: ${name}`),
        toolName: name,
        toolInput: input,
      });
      result.hasToolUse = true;
      continue;
    }

    if (type === 'tool_result') {
      const toolUseId = asString(item.tool_use_id);
      const linked = toolUseId ? toolUseIndex.get(`${sourceSessionId}::${toolUseId}`) : undefined;
      const name = linked?.name ?? 'unknown';
      const fromContent = asString(item.content) ?? stringifyUnknown(item.content);
      const fallback = stringifyToolUseResult(toolUseResultRaw);
      const contentText = fromContent.length > 0 ? fromContent : fallback;
      const isError = item.is_error === true;

      // If the tool_use already produced FileEdit blocks, just flip their
      // status — don't emit a duplicate FileEdit block. We still surface
      // an Error block when the apply failed.
      if (linked?.fileEditBlocks && linked.fileEditBlocks.length > 0) {
        setEditStatus(linked.fileEditBlocks, isError ? 'failed' : 'applied');
        if (isError) {
          result.blocks.push({
            ...emptyBlock('Error', preserveFullText(contentText)),
            toolName: name,
            toolInput: linked.input,
          });
        }
        result.hasToolResult = true;
        continue;
      }

      result.blocks.push({
        ...emptyBlock(isError ? 'Error' : resultBlockTypeForToolName(name), preserveFullText(contentText)),
        toolName: name,
        toolInput: linked?.input ?? null,
      });
      result.hasToolResult = true;
      continue;
    }
  }

  return result;
}

function inferRole(baseType: string, messageRole: string | null, signals: ParsedBlocks): MessageRole {
  const roleRaw = (messageRole ?? baseType).toLowerCase();

  // Assistant rows ALWAYS map to 'Assistant'. One API response (one
  // message.id) is one UnifiedMessage, regardless of whether it contains
  // text, thinking, tool_use, or any combination. The block list inside
  // tells the renderer how to draw each piece; the message role tells it
  // who spoke. The previous per-row 'ToolUse' downgrade dropped the
  // TokenUsageBar in the viewer because the assistant card branch only
  // matches role === 'Assistant'.
  if (roleRaw === 'assistant') return 'Assistant';

  // For user rows, tool_result-only payloads are surfaced as 'ToolResult'
  // so the viewer renders them as compact tool output rather than a chat
  // bubble. A real user prompt has text and stays 'User'.
  if (roleRaw === 'user') {
    if (signals.hasToolResult && !signals.hasText && !signals.hasToolUse) return 'ToolResult';
    return 'User';
  }

  switch (roleRaw) {
    case 'system':
      return 'System';
    case 'tool_use':
      return 'ToolUse';
    case 'tool_result':
      return 'ToolResult';
    default:
      return 'Assistant';
  }
}

function resolveSessionId(line: Record<string, unknown>, filePath: string): string {
  const fromLine = asString(line.sessionId);
  if (fromLine) return fromLine;
  return basename(filePath, '.jsonl');
}

/**
 * Claude Code parser.
 *
 * Primary source:
 * - ~/.claude/projects/<project>/<sessionId>.jsonl
 *
 * Format highlights:
 * - `type: user|assistant` lines carry `message.content[]`.
 * - Assistant lines include `message.usage` with token counts.
 * - Tool calls appear as `message.content[].type === "tool_use"`.
 * - Tool outputs appear as `message.content[].type === "tool_result"` on user lines.
 */
export class ClaudeCodeParser implements ToolParser {
  constructor(private readonly machineId: string) {}

  toolType(): ToolType {
    return 'ClaudeCode';
  }

  fileExtensions(): string[] {
    return ['jsonl'];
  }

  matches(filePath: string): boolean {
    if (!filePath.toLowerCase().endsWith('.jsonl')) return false;
    const normalized = filePath.replace(/\\/g, '/');
    return /\/\.claude\/projects\//i.test(normalized);
  }

  logPaths(): string[] {
    const home = homedir();
    const candidates = [join(home, '.claude', 'projects')];
    return candidates.filter((p) => existsSync(p));
  }

  async parseIncremental(filePath: string, offset: number): Promise<ParseResult> {
    if (!this.matches(filePath)) return { messages: [], newOffset: offset };

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
      logger.warn({ path: filePath, err: String(err) }, 'Claude Code read failed');
      return { messages: [], newOffset: offset };
    }
    if (raw.length === 0) return { messages: [], newOffset: 0 };

    // Last byte of the last complete (newline-terminated) line. The streaming
    // VS Code writer can leave a partial trailing line; advancing past it
    // would permanently skip that record once the rest is flushed.
    let lastCompleteEnd = -1;

    interface LineRecord {
      type: 'user' | 'assistant';
      parsedLine: Record<string, unknown>;
      messageObj: Record<string, unknown>;
      sourceSessionId: string;
      msgId: string | null;
      rawUuid: string;
      parentRawUuid: string | null;
      lineEndByte: number;
    }

    const records: LineRecord[] = [];
    let lineStart = 0;
    let lineNo = 0;

    for (let i = 0; i <= raw.length; i++) {
      const isLineEnd = i === raw.length || raw[i] === 10; // '\n'
      if (!isLineEnd) continue;
      if (i < raw.length) lastCompleteEnd = i;

      let lineEnd = i;
      if (lineEnd > lineStart && raw[lineEnd - 1] === 13) lineEnd -= 1; // trim '\r'
      const lineEndByte = i === raw.length ? i : i + 1;
      lineNo += 1;

      const lineText = raw.subarray(lineStart, lineEnd).toString('utf-8').trim();
      lineStart = i + 1;
      if (lineText.length === 0) continue;

      let parsedLine: Record<string, unknown> | null = null;
      try {
        parsedLine = JSON.parse(lineText) as Record<string, unknown>;
      } catch {
        parsedLine = null;
      }
      if (!parsedLine) continue;

      const type = asString(parsedLine.type) ?? '';
      if (type !== 'user' && type !== 'assistant') continue;

      const messageObj = asObject(parsedLine.message);
      if (!messageObj) continue;

      records.push({
        type: type as 'user' | 'assistant',
        parsedLine,
        messageObj,
        sourceSessionId: resolveSessionId(parsedLine, filePath),
        msgId: asString(messageObj.id),
        rawUuid: asString(parsedLine.uuid) ?? `line:${lineNo}`,
        parentRawUuid: asString(parsedLine.parentUuid),
        lineEndByte,
      });
    }

    // Group consecutive assistant rows that share the same message.id. The
    // Claude Code jsonl writer splits one API response across multiple lines
    // (e.g. `thinking`, `tool_use`, `text`) — each line carries the SAME
    // cumulative `message.usage`. Treating each line as its own message both
    // duplicates the displayed token counts and multiplies cost. The unit of
    // a "message" is one API response, keyed by `message.id`.
    interface Group {
      records: LineRecord[];
      msgId: string | null;
    }
    const groups: Group[] = [];
    for (let i = 0; i < records.length; ) {
      const r = records[i];
      if (r.type !== 'assistant' || !r.msgId) {
        groups.push({ records: [r], msgId: r.msgId });
        i++;
        continue;
      }
      let j = i + 1;
      while (
        j < records.length &&
        records[j].type === 'assistant' &&
        records[j].msgId === r.msgId
      ) {
        j++;
      }
      groups.push({ records: records.slice(i, j), msgId: r.msgId });
      i = j;
    }

    // Stable id per group: msgId-based when available so subsequent ticks
    // (which re-read the whole file) re-emit the same UnifiedMessage id and
    // upsert overwrites the previous content_blocks/usage with the merged
    // form — no information is lost across incremental boundaries.
    const groupIdFor = (g: Group): string => {
      const sid = g.records[0].sourceSessionId;
      return g.msgId
        ? toUuidV5(`claude:${sid}:msg:${g.msgId}`)
        : toUuidV5(`claude:${sid}:${g.records[0].rawUuid}`);
    };

    // Map every consumed rawUuid (across all groups in this file) to its
    // merged group id so cross-row parent pointers resolve correctly.
    const uuidToMergedId = new Map<string, string>();
    for (const g of groups) {
      const gid = groupIdFor(g);
      for (const r of g.records) uuidToMergedId.set(r.rawUuid, gid);
    }

    const toolUseIndex = new Map<string, ToolUseIndexEntry>();
    const messages: UnifiedMessage[] = [];

    for (const g of groups) {
      const head = g.records[0];
      const tail = g.records[g.records.length - 1];
      const sourceSessionId = head.sourceSessionId;

      const allBlocks: ContentBlock[] = [];
      const signals = { hasText: false, hasToolUse: false, hasToolResult: false };
      for (const r of g.records) {
        const parsed = parseClaudeBlocks(
          r.messageObj.content,
          r.parsedLine.toolUseResult,
          sourceSessionId,
          toolUseIndex,
          {
            cwd: asString(r.parsedLine.cwd),
            gitBranch: asString(r.parsedLine.gitBranch),
          },
        );
        if (parsed.blocks.length === 0) {
          const fallback = stringifyToolUseResult(r.parsedLine.toolUseResult);
          if (fallback.length > 0) {
            parsed.blocks.push(emptyBlock('ToolOutput', preserveFullText(fallback)));
            parsed.hasToolResult = true;
          }
        }
        for (const b of parsed.blocks) allBlocks.push(b);
        signals.hasText ||= parsed.hasText;
        signals.hasToolUse ||= parsed.hasToolUse;
        signals.hasToolResult ||= parsed.hasToolResult;
      }

      // Skip empty groups (e.g. a tool_result whose FileEdit status was
      // already absorbed into a prior tool_use group).
      if (allBlocks.length === 0) continue;

      // Skip groups already emitted in a prior tick. A group is "new" if its
      // tail line extends past the previously-consumed offset; this also
      // re-emits a group when a new line joined its tail (stable id + upsert
      // means the merged form replaces the partial one).
      if (tail.lineEndByte <= startOffset) continue;

      const messageRole = asString(head.messageObj.role);
      const role = inferRole(head.type, messageRole, signals as ParsedBlocks);
      const model = asString(head.messageObj.model) ?? 'unknown';
      // Usage is identical across rows in the group (same API response).
      const usage = parseUsage(asObject(head.messageObj.usage), model, true);

      const metadata: Record<string, unknown> = { sourceSessionId };
      if (asString(head.parsedLine.cwd)) metadata.cwd = asString(head.parsedLine.cwd);
      if (asString(head.parsedLine.entrypoint)) metadata.entrypoint = asString(head.parsedLine.entrypoint);
      if (asString(head.parsedLine.version)) metadata.clientVersion = asString(head.parsedLine.version);
      if (asString(head.parsedLine.gitBranch)) metadata.gitBranch = asString(head.parsedLine.gitBranch);
      if (asString(head.parsedLine.promptId)) metadata.promptId = asString(head.parsedLine.promptId);
      if (asString(head.parsedLine.permissionMode)) metadata.permissionMode = asString(head.parsedLine.permissionMode);
      if (asString(head.parsedLine.sourceToolAssistantUUID)) {
        metadata.sourceToolAssistantUUID = asString(head.parsedLine.sourceToolAssistantUUID);
      }
      if (asString(head.parsedLine.error)) metadata.error = asString(head.parsedLine.error);
      if (head.parsedLine.isApiErrorMessage !== undefined) metadata.isApiErrorMessage = head.parsedLine.isApiErrorMessage;
      if (g.msgId) metadata.sourceMessageId = g.msgId;
      metadata.model = model;

      const parentId = head.parentRawUuid
        ? uuidToMergedId.get(head.parentRawUuid) ??
          toUuidV5(`claude:${sourceSessionId}:${head.parentRawUuid}`)
        : null;

      messages.push({
        id: groupIdFor(g),
        sessionId: toUuidV5(`session:${sourceSessionId}`),
        parentId,
        machineId: this.machineId,
        sourceTool: 'ClaudeCode',
        role,
        contentBlocks: allBlocks,
        usage,
        timestamp: (() => {
          const tsMs = parseTimestampMs(head.parsedLine.timestamp);
          return tsMs > 0 ? new Date(tsMs).toISOString() : new Date().toISOString();
        })(),
        metadata,
        sourcePayload: sourcePayload({
          format: 'claude-code.jsonl.message.v1',
          sourcePath: filePath,
          sourceFile: basename(filePath),
          sourceSessionId,
          sourceMessageId: g.msgId ?? head.rawUuid,
          records: g.records.map((r) => ({
            rawUuid: r.rawUuid,
            parentRawUuid: r.parentRawUuid,
            lineEndByte: r.lineEndByte,
            line: r.parsedLine,
          })),
        }),
      });
    }

    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    // Advance only past the last complete line. Partial trailing bytes (mid-stream
    // writes from claude-vscode) stay un-consumed and will be re-read next tick.
    const newOffset = lastCompleteEnd >= 0 ? lastCompleteEnd + 1 : startOffset;
    return { messages, newOffset };
  }
}
