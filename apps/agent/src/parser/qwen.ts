import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

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

const QWEN_NS = 'qwen-ns-v1';

function toUuidV5(name: string, namespace: string = QWEN_NS): string {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(name) && namespace === QWEN_NS) return name.toLowerCase();
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

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
  if (typeof ts === 'number') {
    return ts < 1e12 ? ts * 1000 : ts;
  }
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
  if (n.includes('exec') || n.includes('shell') || n.includes('bash')) return 'ShellCommand';
  if (n.includes('search') || n.includes('grep') || n.includes('find')) return 'SearchResult';
  if (n.includes('web') || n.startsWith('mcp_')) return 'McpCall';
  return 'ToolCall';
}

interface QoderUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface QoderContentItem {
  type?: string;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  id?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
}

interface QoderMessage {
  id?: string;
  role?: string;
  content?: unknown;
  usage?: QoderUsage;
}

interface QoderEntry {
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  type?: string;
  timestamp?: string | number;
  requestSetId?: string;
  cwd?: string;
  version?: string;
  agentId?: string;
  isMeta?: boolean;
  message?: QoderMessage;
}

interface LegacyLogEntry {
  sessionId?: string;
  messageId?: number | string;
  type?: 'user' | 'assistant' | 'gemini' | 'tool_call' | 'system' | 'error' | string;
  message?: unknown;
  timestamp?: string | number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
}

interface ToolUseIndexEntry {
  name: string;
  input: Record<string, unknown> | null;
}

interface QoderBlockParseResult {
  blocks: ContentBlock[];
  hasText: boolean;
  hasThinking: boolean;
  hasToolUse: boolean;
  hasToolResult: boolean;
}

interface QoderAggregate {
  key: string;
  unifiedId: string;
  sourceSessionId: string;
  parentRaw: string | null;
  role: MessageRole;
  timestampMs: number;
  timestampIso: string;
  contentBlocks: ContentBlock[];
  blockFingerprints: Set<string>;
  usage: TokenUsage | null;
  metadata: Record<string, unknown>;
  touchedAfterOffset: boolean;
}

interface PendingUsageEntry {
  usage: TokenUsage;
  tsMs: number;
}

function usageMagnitude(usage: TokenUsage | null): number {
  if (!usage) return -1;
  const input = toSafeNumber(usage.inputTokens);
  const output = toSafeNumber(usage.outputTokens);
  const cacheWrite = toSafeNumber(usage.cacheCreationInputTokens ?? 0);
  const cacheRead = toSafeNumber(usage.cacheReadInputTokens ?? 0);
  return input + output + cacheWrite + cacheRead;
}

function parseUsage(usage: QoderUsage | undefined, model: string, preserveZero = false): TokenUsage | null {
  if (!usage) return null;
  const input = Math.max(0, toSafeNumber(usage.input_tokens));
  const output = Math.max(0, toSafeNumber(usage.output_tokens));
  const cacheRead = Math.max(0, toSafeNumber(usage.cache_read_input_tokens));
  const cacheWrite = Math.max(0, toSafeNumber(usage.cache_creation_input_tokens));
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

function parseAcpUsage(data: Record<string, unknown>, model: string): TokenUsage | null {
  const prompt = Math.max(0, toSafeNumber(data.promptTokens));
  const completion = Math.max(0, toSafeNumber(data.completionTokens));
  const hasAny =
    prompt > 0
    || completion > 0
    || toSafeNumber(data.usedTokens) > 0
    || toSafeNumber(data.limitTokens) > 0;
  if (!hasAny) return null;
  return {
    inputTokens: prompt,
    outputTokens: completion,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    model,
  };
}

function blockFingerprint(block: ContentBlock): string {
  let toolInput = '';
  if (block.toolInput) {
    try {
      toolInput = JSON.stringify(block.toolInput);
    } catch {
      toolInput = '[unserializable]';
    }
  }
  return `${block.blockType}|${block.toolName ?? ''}|${toolInput}|${block.content}`;
}

function mapBaseRole(roleRaw: string | null | undefined): MessageRole {
  switch ((roleRaw ?? '').toLowerCase()) {
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
}

function inferRole(roleRaw: string | null | undefined, signals: QoderBlockParseResult): MessageRole {
  if (!signals.hasText && !signals.hasThinking) {
    if (signals.hasToolUse && !signals.hasToolResult) return 'ToolUse';
    if (signals.hasToolResult && !signals.hasToolUse) return 'ToolResult';
  }
  return mapBaseRole(roleRaw);
}

function mergeRole(current: MessageRole, next: MessageRole): MessageRole {
  if (next === 'User' || next === 'System') return next;
  if (current === 'User' || current === 'System') return current;
  if (next === 'Assistant') return 'Assistant';
  if (current === 'Assistant') return 'Assistant';
  if (current === 'ToolUse' && next === 'ToolResult') return 'ToolUse';
  if (current === 'ToolResult' && next === 'ToolUse') return 'ToolUse';
  return next;
}

function parseQoderBlocks(
  content: unknown,
  toolUseIndex: Map<string, ToolUseIndexEntry>,
): QoderBlockParseResult {
  const result: QoderBlockParseResult = {
    blocks: [],
    hasText: false,
    hasThinking: false,
    hasToolUse: false,
    hasToolResult: false,
  };

  const items = Array.isArray(content) ? (content as QoderContentItem[]) : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const type = typeof item.type === 'string' ? item.type : '';

    if (type === 'text') {
      const text = typeof item.text === 'string' ? item.text : stringifyUnknown(item.text);
      if (text.length > 0) {
        result.blocks.push(emptyBlock('Text', text));
        result.hasText = true;
      }
      continue;
    }

    if (type === 'thinking') {
      const thinking = typeof item.thinking === 'string' ? item.thinking : stringifyUnknown(item.thinking);
      if (thinking.length > 0) {
        result.blocks.push(emptyBlock('Thinking', thinking));
        result.hasThinking = true;
      }
      continue;
    }

    if (type === 'tool_use') {
      const toolName = typeof item.name === 'string' ? item.name : 'unknown';
      const toolInput = asObject(item.input);
      const toolUseId = typeof item.id === 'string' ? item.id : null;
      if (toolUseId) toolUseIndex.set(toolUseId, { name: toolName, input: toolInput });
      result.blocks.push({
        ...emptyBlock(classifyToolName(toolName), `Tool: ${toolName}`),
        toolName,
        toolInput,
      });
      result.hasToolUse = true;
      continue;
    }

    if (type === 'tool_result') {
      const toolUseId = typeof item.tool_use_id === 'string' ? item.tool_use_id : null;
      const linked = toolUseId ? toolUseIndex.get(toolUseId) : undefined;
      const toolName = linked?.name ?? 'unknown';
      result.blocks.push({
        ...emptyBlock(classifyToolName(toolName), truncate(stringifyUnknown(item.content))),
        toolName,
        toolInput: linked?.input ?? null,
      });
      result.hasToolResult = true;
      continue;
    }
  }

  return result;
}

/**
 * Qwen Code / Qoder parser.
 *
 * Supported sources:
 * 1) Qoder CLI session stream (primary)
 *    - .../Qoder/SharedClientCache/cli/projects/<project>/<session>.session.execution.jsonl
 * 2) Qoder ACP stream (token usage bridge)
 *    - .../Qoder/SharedClientCache/cli/logs/acp.log
 * 3) Legacy Qwen array logs
 *    - ~/.qwen/tmp/<hash>/logs.json
 */
export class QwenCodeParser implements ToolParser {
  private readonly qoderMessageCache = new Map<string, UnifiedMessage>();
  private readonly pendingUsageByMessage = new Map<string, PendingUsageEntry>();
  private readonly lastMessageBySession = new Map<string, string>();

  constructor(private readonly machineId: string) {}

  toolType(): ToolType {
    return 'QwenCode';
  }

  fileExtensions(): string[] {
    return ['jsonl', 'json', 'log'];
  }

  matches(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');

    if (basename(filePath) === 'logs.json') {
      return /\/\.qwen\/tmp\//.test(normalized);
    }

    if (basename(filePath).toLowerCase() === 'acp.log') {
      return /\/SharedClientCache\/cli\/logs\//i.test(normalized);
    }

    if (!normalized.endsWith('.jsonl')) return false;
    if (!/\/SharedClientCache\/cli\/projects\//i.test(normalized)) return false;
    return /\.session\.execution\.jsonl$/i.test(normalized);
  }

  logPaths(): string[] {
    const home = homedir();
    const candidates: string[] = [];

    if (process.platform === 'win32') {
      const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
      candidates.push(join(roaming, 'Qoder', 'SharedClientCache', 'cli', 'projects'));
      candidates.push(join(roaming, 'Qoder', 'SharedClientCache', 'cli', 'logs'));
    } else if (process.platform === 'darwin') {
      candidates.push(join(home, 'Library', 'Application Support', 'Qoder', 'SharedClientCache', 'cli', 'projects'));
      candidates.push(join(home, 'Library', 'Application Support', 'Qoder', 'SharedClientCache', 'cli', 'logs'));
    } else {
      const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
      candidates.push(join(xdgConfig, 'Qoder', 'SharedClientCache', 'cli', 'projects'));
      candidates.push(join(xdgConfig, 'Qoder', 'SharedClientCache', 'cli', 'logs'));
      candidates.push(join(home, '.qoder', 'SharedClientCache', 'cli', 'projects'));
      candidates.push(join(home, '.qoder', 'SharedClientCache', 'cli', 'logs'));
    }

    // Legacy Qwen path compatibility.
    candidates.push(join(home, '.qwen', 'tmp'));

    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of candidates) {
      if (seen.has(p)) continue;
      seen.add(p);
      if (existsSync(p)) out.push(p);
    }
    return out;
  }

  async parseIncremental(filePath: string, offset: number): Promise<ParseResult> {
    if (!this.matches(filePath)) return { messages: [], newOffset: offset };
    if (basename(filePath) === 'logs.json') return this.parseLegacyQwenLogs(filePath, offset);
    if (basename(filePath).toLowerCase() === 'acp.log') return this.parseQoderAcpLog(filePath, offset);
    return this.parseQoderJsonl(filePath, offset);
  }

  private qoderMessageKey(sourceSessionId: string, sourceMessageId: string): string {
    return `${sourceSessionId}::${sourceMessageId}`;
  }

  private qoderUnifiedMessageId(sourceSessionId: string, sourceMessageId: string): string {
    return toUuidV5(`qoder:${sourceSessionId}:${sourceMessageId}`);
  }

  private qoderUnifiedParentId(sourceSessionId: string, sourceParentId: string): string {
    return toUuidV5(`qoder:${sourceSessionId}:${sourceParentId}`);
  }

  private mergeUsage(current: TokenUsage | null, next: TokenUsage | null): TokenUsage | null {
    if (!next) return current;
    if (!current) return next;
    return usageMagnitude(next) >= usageMagnitude(current) ? next : current;
  }

  private rememberPendingUsage(key: string, usage: TokenUsage, tsMs: number): void {
    const existing = this.pendingUsageByMessage.get(key);
    if (!existing) {
      this.pendingUsageByMessage.set(key, { usage, tsMs });
      return;
    }
    if (tsMs > existing.tsMs) {
      this.pendingUsageByMessage.set(key, { usage, tsMs });
      return;
    }
    if (tsMs === existing.tsMs && usageMagnitude(usage) > usageMagnitude(existing.usage)) {
      this.pendingUsageByMessage.set(key, { usage, tsMs });
    }
  }

  private patchMessageUsage(base: UnifiedMessage, usage: TokenUsage, tsMs: number): UnifiedMessage {
    const metadata: Record<string, unknown> = {
      ...base.metadata,
      usageSource: 'qoder_acp',
    };
    if (tsMs > 0) metadata.usageTimestamp = new Date(tsMs).toISOString();
    return {
      ...base,
      usage,
      contentBlocks: base.contentBlocks.map((b) => ({ ...b })),
      metadata,
    };
  }

  private resolveQoderSessionId(
    entry: QoderEntry,
    projectKey: string,
    sourceFile: string,
  ): string {
    const fromEntry = asString(entry.sessionId);
    if (fromEntry) return fromEntry;
    if (/\.session\.execution\.jsonl$/i.test(sourceFile)) {
      return sourceFile.replace(/\.jsonl$/i, '');
    }
    return `${projectKey}:${sourceFile}`;
  }

  private resolveQoderMessageId(
    entry: QoderEntry,
    lineNo: number,
    filePath: string,
  ): string {
    const explicit = asString(entry.message?.id);
    if (explicit) return explicit;
    const uuid = asString(entry.uuid);
    if (uuid) return `uuid:${uuid}`;
    return `line:${filePath}:${lineNo}`;
  }

  private buildQoderMetadata(
    entry: QoderEntry,
    projectKey: string,
    sourceFile: string,
    sourceSessionId: string,
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      projectKey,
      sourceFile,
      sourceSessionId,
    };
    if (entry.requestSetId) metadata.requestSetId = entry.requestSetId;
    if (entry.cwd) metadata.cwd = entry.cwd;
    if (entry.version) metadata.clientVersion = entry.version;
    if (entry.agentId) metadata.agentId = entry.agentId;
    return metadata;
  }

  private async parseQoderJsonl(filePath: string, offset: number): Promise<ParseResult> {
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
      logger.warn({ path: filePath, err: String(err) }, 'Qoder JSONL read failed');
      return { messages: [], newOffset: offset };
    }

    if (raw.length === 0) return { messages: [], newOffset: 0 };

    const toolUseIndex = new Map<string, ToolUseIndexEntry>();
    const aggregates = new Map<string, QoderAggregate>();

    const projectKey = basename(dirname(filePath));
    const sourceFile = basename(filePath);

    let lineStart = 0;
    let lineNo = 0;

    for (let i = 0; i <= raw.length; i++) {
      const isLineEnd = i === raw.length || raw[i] === 10; // '\n'
      if (!isLineEnd) continue;

      let lineEnd = i;
      if (lineEnd > lineStart && raw[lineEnd - 1] === 13) lineEnd -= 1; // trim '\r'
      const consumedBytes = i === raw.length ? i : i + 1;
      lineNo += 1;

      const line = raw.subarray(lineStart, lineEnd).toString('utf-8').trim();
      lineStart = i + 1;
      if (line.length === 0) continue;

      let entry: QoderEntry | null = null;
      try {
        entry = JSON.parse(line) as QoderEntry;
      } catch {
        entry = null;
      }
      if (!entry || entry.isMeta) continue;

      const sourceSessionId = this.resolveQoderSessionId(entry, projectKey, sourceFile);
      const sourceMessageId = this.resolveQoderMessageId(entry, lineNo, filePath);
      const key = this.qoderMessageKey(sourceSessionId, sourceMessageId);

      const parsedBlocks = parseQoderBlocks(entry.message?.content, toolUseIndex);
      const roleRaw = entry.message?.role ?? entry.type ?? null;
      const role = inferRole(roleRaw, parsedBlocks);
      const model = 'unknown';
      const usage = parseUsage(entry.message?.usage, model, true);

      const explicitMsgId = asString(entry.message?.id);
      if (explicitMsgId && role !== 'User' && role !== 'System') {
        this.lastMessageBySession.set(sourceSessionId, explicitMsgId);
      }

      if (parsedBlocks.blocks.length === 0) {
        // No presentable blocks in this row. Keep session/message tracking for
        // ACP mapping, but skip message emission.
        continue;
      }

      const tsMs = parseTimestampMs(entry.timestamp);
      const tsIso = tsMs > 0 ? new Date(tsMs).toISOString() : new Date().toISOString();
      const touched = consumedBytes > startOffset;

      let agg = aggregates.get(key);
      if (!agg) {
        agg = {
          key,
          unifiedId: this.qoderUnifiedMessageId(sourceSessionId, sourceMessageId),
          sourceSessionId,
          parentRaw: asString(entry.parentUuid),
          role,
          timestampMs: tsMs,
          timestampIso: tsIso,
          contentBlocks: [],
          blockFingerprints: new Set<string>(),
          usage,
          metadata: this.buildQoderMetadata(entry, projectKey, sourceFile, sourceSessionId),
          touchedAfterOffset: touched,
        };
        aggregates.set(key, agg);
      } else {
        agg.role = mergeRole(agg.role, role);
        agg.touchedAfterOffset = agg.touchedAfterOffset || touched;
        const parentRaw = asString(entry.parentUuid);
        if (parentRaw) agg.parentRaw = parentRaw;
        agg.usage = this.mergeUsage(agg.usage, usage);
        if (tsMs >= agg.timestampMs) {
          agg.timestampMs = tsMs;
          agg.timestampIso = tsIso;
          agg.metadata = {
            ...agg.metadata,
            ...this.buildQoderMetadata(entry, projectKey, sourceFile, sourceSessionId),
          };
        } else {
          agg.metadata = {
            ...agg.metadata,
            ...this.buildQoderMetadata(entry, projectKey, sourceFile, sourceSessionId),
          };
        }
      }

      for (const block of parsedBlocks.blocks) {
        const fp = blockFingerprint(block);
        if (agg.blockFingerprints.has(fp)) continue;
        agg.blockFingerprints.add(fp);
        agg.contentBlocks.push(block);
      }
    }

    const messages: UnifiedMessage[] = [];
    for (const agg of aggregates.values()) {
      if (agg.contentBlocks.length === 0) continue;

      const pending = this.pendingUsageByMessage.get(agg.key);
      const mergedUsage = pending
        ? this.mergeUsage(agg.usage, pending.usage)
        : agg.usage;

      const message: UnifiedMessage = {
        id: agg.unifiedId,
        sessionId: toUuidV5(`session:${agg.sourceSessionId}`),
        parentId: agg.parentRaw ? this.qoderUnifiedParentId(agg.sourceSessionId, agg.parentRaw) : null,
        machineId: this.machineId,
        sourceTool: 'QwenCode',
        role: agg.role,
        contentBlocks: agg.contentBlocks,
        usage: mergedUsage,
        timestamp: agg.timestampIso,
        metadata: agg.metadata,
      };

      this.qoderMessageCache.set(agg.key, message);
      if (agg.touchedAfterOffset) messages.push(message);
    }

    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return { messages, newOffset: st.size };
  }

  private async parseQoderAcpLog(filePath: string, offset: number): Promise<ParseResult> {
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
      logger.warn({ path: filePath, err: String(err) }, 'Qoder ACP log read failed');
      return { messages: [], newOffset: offset };
    }
    if (raw.length === 0) return { messages: [], newOffset: 0 };

    // Keep a small lookback window so `context_usage` lines without
    // `ai-coding/message-id` can still resolve to the latest message id.
    const contextStart = startOffset > 128 * 1024 ? startOffset - 128 * 1024 : 0;
    const touchedKeys = new Set<string>();

    let lineStart = 0;
    for (let i = 0; i <= raw.length; i++) {
      const isLineEnd = i === raw.length || raw[i] === 10; // '\n'
      if (!isLineEnd) continue;

      let lineEnd = i;
      if (lineEnd > lineStart && raw[lineEnd - 1] === 13) lineEnd -= 1; // trim '\r'
      const consumedBytes = i === raw.length ? i : i + 1;

      const line = raw.subarray(lineStart, lineEnd).toString('utf-8').trim();
      lineStart = i + 1;
      if (line.length === 0) continue;
      if (consumedBytes <= contextStart) continue;

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      if (!parsed) continue;
      if (asString(parsed.method) !== 'session/update') continue;

      const request = asObject(parsed.request);
      if (!request) continue;
      const update = asObject(request.update);
      if (!update) continue;
      const data = asObject(update.data);

      const sessionId = asString(request.sessionId) ?? asString(data?.sessionId);
      if (!sessionId) continue;

      const meta = asObject(request._meta);
      const metaMessageId = asString(meta?.['ai-coding/message-id']);
      if (metaMessageId) {
        this.lastMessageBySession.set(sessionId, metaMessageId);
      }

      if (consumedBytes <= startOffset) continue;

      const updateType = asString(update.type);
      const sessionUpdate = asString(update.sessionUpdate);
      const hasTokenData =
        data !== null
        && (
          data.promptTokens !== undefined
          || data.completionTokens !== undefined
          || data.usedTokens !== undefined
          || data.limitTokens !== undefined
        );
      const isContextUsage = updateType === 'context_usage' || (sessionUpdate === 'notification' && hasTokenData);
      if (!isContextUsage || !data) continue;

      const usage = parseAcpUsage(data, 'unknown');
      if (!usage) continue;

      const sourceMessageId = metaMessageId ?? this.lastMessageBySession.get(sessionId) ?? null;
      if (!sourceMessageId) continue;

      const key = this.qoderMessageKey(sessionId, sourceMessageId);
      const tsMs = parseTimestampMs(parsed.timestamp);
      this.rememberPendingUsage(key, usage, tsMs);
      touchedKeys.add(key);
    }

    const messages: UnifiedMessage[] = [];
    for (const key of touchedKeys) {
      const cached = this.qoderMessageCache.get(key);
      const pending = this.pendingUsageByMessage.get(key);
      if (!cached || !pending) continue;
      const patched = this.patchMessageUsage(cached, pending.usage, pending.tsMs);
      this.qoderMessageCache.set(key, patched);
      messages.push(patched);
    }

    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return { messages, newOffset: st.size };
  }

  private async parseLegacyQwenLogs(filePath: string, offset: number): Promise<ParseResult> {
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
      logger.warn({ path: filePath, err: String(err) }, 'Qwen legacy read failed');
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

    const projectHash = basename(dirname(filePath));
    const messages: UnifiedMessage[] = [];

    for (let i = startIdx; i < entries.length; i++) {
      const entry = entries[i];
      const sessionRaw = entry.sessionId ?? projectHash;
      const sessionUuid = toUuidV5(`session:${projectHash}:${sessionRaw}`);
      const idSeed = `${projectHash}:${sessionRaw}:${entry.messageId ?? i}:${entry.type ?? 'unknown'}`;

      const role: MessageRole = (() => {
        switch (entry.type) {
          case 'user':
            return 'User';
          case 'assistant':
          case 'gemini':
            return 'Assistant';
          case 'tool_call':
            return 'ToolUse';
          case 'system':
            return 'System';
          case 'error':
            return 'Assistant';
          default:
            return 'Assistant';
        }
      })();

      const blocks: ContentBlock[] = [];
      if (entry.type === 'tool_call') {
        const toolName = entry.toolName ?? 'unknown';
        const result = stringifyUnknown(entry.toolResult);
        blocks.push({
          ...emptyBlock(classifyToolName(toolName), truncate(result || `Tool: ${toolName}`)),
          toolName,
          toolInput: entry.toolArgs ?? null,
        });
      } else {
        blocks.push(
          emptyBlock(entry.type === 'error' ? 'Error' : 'Text', stringifyUnknown(entry.message)),
        );
      }

      messages.push({
        id: toUuidV5(idSeed),
        sessionId: sessionUuid,
        parentId: null,
        machineId: this.machineId,
        sourceTool: 'QwenCode',
        role,
        contentBlocks: blocks,
        usage: null,
        timestamp: toIsoTimestamp(entry.timestamp),
        metadata: { projectHash, sourceSessionId: sessionRaw },
      });
    }

    return { messages, newOffset: entries.length };
  }
}
