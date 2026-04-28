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

function truncate(input: string, limit = 4000): string {
  return input.length > limit ? `${input.slice(0, limit)}\n...[truncated]` : input;
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
    inputTokens: Math.max(0, input - cacheRead),
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
}

interface ParsedBlocks {
  blocks: ContentBlock[];
  hasText: boolean;
  hasToolUse: boolean;
  hasToolResult: boolean;
}

function parseClaudeBlocks(
  content: unknown,
  toolUseResultRaw: unknown,
  sourceSessionId: string,
  toolUseIndex: Map<string, ToolUseIndexEntry>,
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
      result.blocks.push({
        ...emptyBlock(isError ? 'Error' : resultBlockTypeForToolName(name), truncate(contentText)),
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
  const base: MessageRole = (() => {
    switch (roleRaw) {
      case 'user':
        return 'User';
      case 'assistant':
        return 'Assistant';
      case 'system':
        return 'System';
      case 'tool_use':
        return 'ToolUse';
      case 'tool_result':
        return 'ToolResult';
      default:
        return 'Assistant';
    }
  })();

  if (!signals.hasText) {
    if (signals.hasToolUse && !signals.hasToolResult) return 'ToolUse';
    if (signals.hasToolResult && !signals.hasToolUse) return 'ToolResult';
  }
  return base;
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

    const toolUseIndex = new Map<string, ToolUseIndexEntry>();
    const messages: UnifiedMessage[] = [];

    let lineStart = 0;
    let lineNo = 0;

    for (let i = 0; i <= raw.length; i++) {
      const isLineEnd = i === raw.length || raw[i] === 10; // '\n'
      if (!isLineEnd) continue;

      let lineEnd = i;
      if (lineEnd > lineStart && raw[lineEnd - 1] === 13) lineEnd -= 1; // trim '\r'
      const consumedBytes = i === raw.length ? i : i + 1;
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

      const sourceSessionId = resolveSessionId(parsedLine, filePath);
      const messageObj = asObject(parsedLine.message);
      if (!messageObj) continue;

      const blocksParsed = parseClaudeBlocks(
        messageObj.content,
        parsedLine.toolUseResult,
        sourceSessionId,
        toolUseIndex,
      );

      if (blocksParsed.blocks.length === 0) {
        const fallbackResult = stringifyToolUseResult(parsedLine.toolUseResult);
        if (fallbackResult.length > 0) {
          blocksParsed.blocks.push(emptyBlock('ToolOutput', truncate(fallbackResult)));
          blocksParsed.hasToolResult = true;
        } else {
          continue;
        }
      }

      const messageRole = asString(messageObj.role);
      const role = inferRole(type, messageRole, blocksParsed);
      const model = asString(messageObj.model) ?? 'unknown';
      const usage = parseUsage(asObject(messageObj.usage), model, true);

      const rawUuid = asString(parsedLine.uuid) ?? `line:${lineNo}`;
      const parentRaw = asString(parsedLine.parentUuid);

      const metadata: Record<string, unknown> = {
        sourceSessionId,
      };
      if (asString(parsedLine.cwd)) metadata.cwd = asString(parsedLine.cwd);
      if (asString(parsedLine.entrypoint)) metadata.entrypoint = asString(parsedLine.entrypoint);
      if (asString(parsedLine.version)) metadata.clientVersion = asString(parsedLine.version);
      if (asString(parsedLine.gitBranch)) metadata.gitBranch = asString(parsedLine.gitBranch);
      if (asString(parsedLine.promptId)) metadata.promptId = asString(parsedLine.promptId);
      if (asString(parsedLine.permissionMode)) metadata.permissionMode = asString(parsedLine.permissionMode);
      if (asString(parsedLine.sourceToolAssistantUUID)) {
        metadata.sourceToolAssistantUUID = asString(parsedLine.sourceToolAssistantUUID);
      }
      if (asString(parsedLine.error)) metadata.error = asString(parsedLine.error);
      if (parsedLine.isApiErrorMessage !== undefined) metadata.isApiErrorMessage = parsedLine.isApiErrorMessage;
      if (asString(messageObj.id)) metadata.sourceMessageId = asString(messageObj.id);
      metadata.model = model;

      if (consumedBytes <= startOffset) continue;

      messages.push({
        id: toUuidV5(`claude:${sourceSessionId}:${rawUuid}`),
        sessionId: toUuidV5(`session:${sourceSessionId}`),
        parentId: parentRaw ? toUuidV5(`claude:${sourceSessionId}:${parentRaw}`) : null,
        machineId: this.machineId,
        sourceTool: 'ClaudeCode',
        role,
        contentBlocks: blocksParsed.blocks,
        usage,
        timestamp: (() => {
          const tsMs = parseTimestampMs(parsedLine.timestamp);
          return tsMs > 0 ? new Date(tsMs).toISOString() : new Date().toISOString();
        })(),
        metadata,
      });
    }

    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return { messages, newOffset: st.size };
  }
}
