import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import type {
  ToolType,
  UnifiedMessage,
  ContentBlock,
  ContentBlockType,
  MessageRole,
} from './types.ts';
import type { ParseResult, ToolParser } from './tool-parser.ts';
import { logger } from '../logger.ts';

const COPILOT_NS = 'copilot-ns-v1';

/** UUIDv5 (same implementation as OpenCode). */
function toUuidV5(name: string, namespace: string = COPILOT_NS): string {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(name) && namespace === COPILOT_NS) {
    // Only return directly when not explicitly deriving (we always derive here,
    // so this branch is intentionally unused).
  }
  const hash = createHash('sha1');
  hash.update(namespace);
  hash.update(name);
  const bytes = hash.digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Tool id -> ContentBlockType mapping */
function classifyToolId(toolId: string): ContentBlockType {
  const n = toolId.toLowerCase();
  if (n.includes('readfile') || n.includes('readproject')) return 'FileRead';
  if (n.includes('edit') || n.includes('insertedit') || n.includes('applypatch')) return 'FileEdit';
  if (n.includes('runinterminal') || n.includes('terminal') || n.includes('shell')) return 'ShellCommand';
  if (n.includes('findtext') || n.includes('search') || n.includes('filesearch') || n.includes('grep'))
    return 'SearchResult';
  if (n.startsWith('mcp_') || n.includes('mcp')) return 'McpCall';
  return 'ToolCall';
}

interface CopilotRequest {
  requestId?: string;
  timestamp?: number;
  modelId?: string;
  responseId?: string;
  modelState?: { value?: number; completedAt?: number };
  modeInfo?: { kind?: string; modeId?: string; modeName?: string };
  agent?: { id?: string; fullName?: string; extensionVersion?: string };
  message?: { text?: string; parts?: unknown[] };
  response?: Record<string, unknown>[];
  result?: {
    timings?: { firstProgress?: number; totalElapsed?: number };
    metadata?: {
      toolCallRounds?: Array<{ thinking?: { tokens?: number } }>;
      resolvedModel?: string;
    };
  };
}

interface ChatModel {
  requests?: CopilotRequest[];
  customTitle?: string;
  responderUsername?: string;
  initialLocation?: string;
  creationDate?: number;
  sessionId?: string;
  [k: string]: unknown;
}

interface SessionContext {
  uuid: string;
  rawId: string;
  customTitle: string | null;
  initialLocation: string | null;
  responderUsername: string | null;
}

/** Apply a patch to state; patch.k is the path array. */
function applyPatch(state: any, patch: { kind: number; k: unknown[]; v: unknown; i?: number }): void {
  const path = patch.k;
  if (!Array.isArray(path) || path.length === 0) return;
  // Traverse to the second-last level.
  let cur: any = state;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as string | number;
    if (cur == null) return;
    cur = cur[key as keyof typeof cur];
  }
  if (cur == null) return;
  const last = path[path.length - 1] as string | number;

  if (patch.kind === 1) {
    // Replace.
    cur[last] = patch.v;
  } else if (patch.kind === 2) {
    // Append/insert into array.
    const arr = cur[last];
    if (!Array.isArray(arr)) return;
    const items = Array.isArray(patch.v) ? patch.v : [patch.v];
    if (typeof patch.i === 'number') {
      arr.splice(patch.i, 0, ...items);
    } else {
      arr.push(...items);
    }
  }
}

function emptyTextBlock(): ContentBlock {
  return {
    blockType: 'Text',
    content: '',
    language: null,
    filePath: null,
    diff: null,
    toolName: null,
    toolInput: null,
    exitCode: null,
    isCollapsed: false,
  };
}

function flattenMessageOrString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const val = (v as { value: unknown }).value;
    return typeof val === 'string' ? val : '';
  }
  return '';
}

/**
 * VS Code embeds empty-text links in invocationMessage as `[](file://...)`,
 * which renders as blank links. Use the message `uris` dictionary to rewrite
 * them into readable `[basename](path)` links.
 */
function renderMessageWithUris(msg: unknown): string {
  if (typeof msg === 'string') return msg;
  if (!msg || typeof msg !== 'object') return '';
  const obj = msg as { value?: unknown; uris?: Record<string, { path?: string }> };
  let text = typeof obj.value === 'string' ? obj.value : '';
  if (!text) return '';
  const uris = obj.uris;
  if (uris && typeof uris === 'object') {
    text = text.replace(/\[\]\(([^)]+)\)/g, (_match, uri: string) => {
      const entry = uris[uri];
      const path = entry?.path ?? uri;
      const name = path.split('/').filter(Boolean).pop() ?? path;
      return `[${name}](${path})`;
    });
  }
  return text;
}

/** Extract a file path from toolSpecificData / inlineReference / other fields for FileRead/FileEdit blocks. */
function firstUriPath(part: Record<string, unknown>): string | null {
  const sources: unknown[] = [part.pastTenseMessage, part.invocationMessage];
  for (const src of sources) {
    if (src && typeof src === 'object') {
      const uris = (src as { uris?: Record<string, { path?: string }> }).uris;
      if (uris && typeof uris === 'object') {
        const first = Object.values(uris)[0];
        if (first?.path) return first.path;
      }
    }
  }
  return null;
}

function thinkingValueToString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => thinkingValueToString(x)).join('');
  return '';
}

export class CopilotParser implements ToolParser {
  constructor(private readonly machineId: string) {}

  toolType(): ToolType {
    return 'GitHubCopilot';
  }

  fileExtensions(): string[] {
    return ['jsonl'];
  }

  matches(filePath: string): boolean {
    if (!filePath.endsWith('.jsonl')) return false;
    const parent = basename(dirname(filePath));
    return parent === 'chatSessions';
  }

  logPaths(): string[] {
    const candidates: string[] = [];
    const home = homedir();
    if (process.platform === 'win32') {
      const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
      candidates.push(join(roaming, 'Code', 'User', 'workspaceStorage'));
      candidates.push(join(roaming, 'Code - Insiders', 'User', 'workspaceStorage'));
    } else if (process.platform === 'darwin') {
      candidates.push(join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'));
    } else {
      candidates.push(join(home, '.config', 'Code', 'User', 'workspaceStorage'));
    }
    return candidates.filter((p) => existsSync(p));
  }

  /**
   * Convert the response array into ContentBlocks.
   *
   * Design notes:
   * - Merge consecutive plain-text parts into one Text block (Copilot often splits paragraphs)
   * - Inline inlineReference into the tail of the previous Text block (keeps reading flow)
   * - Classify tool calls by toolId and keep full toolSpecificData for frontend display
   * - Handle terminal tools separately: split into ShellCommand + ShellOutput blocks
   * - Silently skip internal signal parts to avoid Unknown noise
   */
  private responseToBlocks(response: Record<string, unknown>[]): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    /** Get/create the trailing Text block for appending content. */
    const appendText = (text: string) => {
      if (!text) return;
      const last = blocks[blocks.length - 1];
      if (last && last.blockType === 'Text') {
        last.content = last.content ? `${last.content}${text}` : text;
      } else {
        blocks.push({ ...emptyTextBlock(), content: text });
      }
    };

    for (const part of response) {
      if (part == null || typeof part !== 'object') continue;
      const kind = (part.kind as string | undefined) ?? '';

      // ====== Text (no kind / string value) ======
      if (kind === '' && typeof (part as { value?: unknown }).value === 'string') {
        appendText(part.value as string);
        continue;
      }

      // ====== Thinking ======
      if (kind === 'thinking') {
        const text = thinkingValueToString(part.value);
        if (text.length === 0) continue;
        blocks.push({ ...emptyTextBlock(), blockType: 'Thinking', content: text });
        continue;
      }

      // ====== Inline file reference -> append to previous text block ======
      if (kind === 'inlineReference') {
        const ref = part.inlineReference as { path?: string; name?: string } | undefined;
        const filePath = ref?.path ?? null;
        if (filePath) {
          const name = ref?.name ?? filePath.split('/').filter(Boolean).pop() ?? filePath;
          appendText(` [${name}](${filePath})`);
        }
        continue;
      }

      // ====== Tool invocation ======
      if (kind === 'toolInvocationSerialized') {
        this.appendToolBlocks(blocks, part);
        continue;
      }

      // ====== Explicit codeblock part (rare but handled) ======
      if (kind === 'codeblock' && typeof (part as { code?: unknown }).code === 'string') {
        blocks.push({
          ...emptyTextBlock(),
          blockType: 'Code',
          content: (part as { code: string }).code,
          language: (part as { languageId?: string }).languageId ?? null,
        });
        continue;
      }

      // ====== Internal signal parts skipped silently ======
      // These kinds are internal status/control elements from VS Code Chat UI and
      // carry no semantic content. Syncing them to web UI only adds noise.
      if (
        kind === 'undoStop' ||
        kind === 'textEditGroup' ||
        kind === 'workspaceEdit' ||
        kind === 'codeblockUri' ||
        kind === 'mcpServersStarting' ||
        kind === 'progressMessage' ||
        kind === 'progressTask' ||
        kind === 'progressTaskSerialized' ||
        kind === 'confirmation' ||
        kind === 'elicitationSerialized' ||
        kind === 'questionCarousel' ||
        kind === 'command'
      ) {
        continue;
      }

      // ====== Warning ======
      if (kind === 'warning') {
        const text = flattenMessageOrString((part as { content?: unknown }).content);
        if (text) blocks.push({ ...emptyTextBlock(), blockType: 'Error', content: text });
        continue;
      }

      // All other truly unknown types: keep record without breaking parsing
      // (include kind name for troubleshooting).
      blocks.push({
        ...emptyTextBlock(),
        blockType: 'Unknown',
        content: `kind=${kind || '<text>'}`,
      });
    }

    if (blocks.length === 0) blocks.push(emptyTextBlock());
    return blocks;
  }

  /** Convert one toolInvocationSerialized into 1-2 ContentBlocks and append. */
  private appendToolBlocks(blocks: ContentBlock[], part: Record<string, unknown>): void {
    const toolId = (part.toolId as string | undefined) ?? 'unknown';
    const tsd = (part.toolSpecificData as Record<string, unknown> | undefined) ?? null;
    const tsdKind = (tsd?.kind as string | undefined) ?? '';

    // ===== Terminal command: split into ShellCommand + ShellOutput =====
    if (tsdKind === 'terminal') {
      const cmd = tsd?.commandLine as { original?: string; toolEdited?: string; forDisplay?: string } | undefined;
      const command = cmd?.original ?? cmd?.toolEdited ?? cmd?.forDisplay ?? '';
      const exitCode = (tsd?.terminalCommandState as { exitCode?: number } | undefined)?.exitCode ?? null;
      const output = (tsd?.terminalCommandOutput as { text?: string } | undefined)?.text ?? '';

      if (command) {
        blocks.push({
          ...emptyTextBlock(),
          blockType: 'ShellCommand',
          content: command,
          toolName: toolId,
          toolInput: tsd,
          exitCode,
        });
      }
      if (output) {
        blocks.push({
          ...emptyTextBlock(),
          blockType: 'ShellOutput',
          content: output,
          toolName: toolId,
          exitCode,
        });
      }
      // If both command and output are empty, keep at least a fallback ShellCommand label.
      if (!command && !output) {
        const fallback = renderMessageWithUris(part.invocationMessage) || `Tool: ${toolId}`;
        blocks.push({
          ...emptyTextBlock(),
          blockType: 'ShellCommand',
          content: fallback,
          toolName: toolId,
          toolInput: tsd,
        });
      }
      return;
    }

    // ===== Generic tool: use pastTenseMessage or invocationMessage for display text =====
    const messageText =
      renderMessageWithUris(part.pastTenseMessage) ||
      renderMessageWithUris(part.invocationMessage) ||
      (typeof part.generatedTitle === 'string' ? (part.generatedTitle as string) : '') ||
      `Tool: ${toolId}`;

    const blockType = classifyToolId(toolId);
    const filePath = firstUriPath(part);

    blocks.push({
      ...emptyTextBlock(),
      blockType,
      content: messageText,
      toolName: toolId,
      toolInput: tsd,
      filePath,
    });
  }

  /**
   * Token usage for VS Code Copilot Chat sessions.
   *
   * Truth (verified against vscode source `chatModel.ts` + real session files):
   * - VS Code's persisted chat session JSONL does **NOT** carry the real
   *   prompt/completion token counts. `ChatResponseModel.toJSON()` does include
   *   a `completionTokens` field, but the GitHub Copilot extension never calls
   *   `setUsage()` for chat requests, so it is always absent from the persisted
   *   request object (`request.completionTokens === undefined`).
   * - The only token-shaped data in `result.metadata` is
   *   `toolCallRounds[i].thinking.tokens`, which counts **only the model's
   *   internal reasoning tokens for that round** (typically 20-500). Treating
   *   it as the assistant's `outputTokens` underreports real cost by 1-2
   *   orders of magnitude and was the root cause of the wrong token display.
   *
   * Therefore this method always returns `null` for `usage`. Honest absence is
   * better than a fabricated number. The thinking-token aggregate and elapsed
   * time are still surfaced through `metadata.thinkingTokens` and
   * `metadata.elapsedMs` (see `buildMessages`) so the UI can show them
   * separately if desired.
   */
  private extractUsage(): null {
    return null;
  }

  /** Sum `toolCallRounds[*].thinking.tokens` for the request, or null if none. */
  private aggregateThinkingTokens(req: CopilotRequest): number | null {
    const rounds = req.result?.metadata?.toolCallRounds;
    if (!Array.isArray(rounds) || rounds.length === 0) return null;
    let total = 0;
    let hasAny = false;
    for (const r of rounds) {
      const t = r?.thinking?.tokens;
      if (typeof t === 'number' && Number.isFinite(t) && t >= 0) {
        total += t;
        hasAny = true;
      }
    }
    return hasAny ? total : null;
  }

  private buildMessages(req: CopilotRequest, ctx: SessionContext): UnifiedMessage[] | null {
    const reqId = req.requestId;
    const ts = req.timestamp;
    const completedAt = req.modelState?.completedAt;
    if (!reqId || typeof reqId !== 'string') return null;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
    if (!completedAt && !req.result) return null; // Not completed yet.

    const userId = toUuidV5(`${reqId}:user`);
    const asstId = toUuidV5(`${reqId}:assistant`);
    const userText = typeof req.message?.text === 'string' ? req.message.text : '';
    const model =
      req.result?.metadata?.resolvedModel ??
      (typeof req.modelId === 'string' && req.modelId.length > 0 ? req.modelId : 'unknown');

    const sharedMeta: Record<string, unknown> = {
      requestId: reqId,
      model,
      sourceSessionId: ctx.rawId,
    };
    if (ctx.customTitle) sharedMeta.sessionTitle = ctx.customTitle;
    if (ctx.initialLocation) sharedMeta.initialLocation = ctx.initialLocation;
    if (ctx.responderUsername) sharedMeta.responderUsername = ctx.responderUsername;
    if (req.responseId) sharedMeta.responseId = req.responseId;
    if (req.modeInfo?.modeId) sharedMeta.mode = req.modeInfo.modeId;
    if (req.agent?.id) sharedMeta.agentId = req.agent.id;
    if (req.agent?.extensionVersion) sharedMeta.extensionVersion = req.agent.extensionVersion;

    // Surface what IS available even though prompt/completion tokens are not:
    //   - thinkingTokens: sum of internal-reasoning tokens across all tool rounds
    //   - elapsedMs: total wall-clock time the assistant spent on the request
    //   - toolCallRoundCount: how many tool-call rounds the assistant made
    const thinkingTokens = this.aggregateThinkingTokens(req);
    if (thinkingTokens != null) sharedMeta.thinkingTokens = thinkingTokens;
    const elapsed = req.result?.timings?.totalElapsed;
    if (typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0) {
      sharedMeta.elapsedMs = elapsed;
    }
    const rounds = req.result?.metadata?.toolCallRounds;
    if (Array.isArray(rounds)) sharedMeta.toolCallRoundCount = rounds.length;

    const userMsg: UnifiedMessage = {
      id: userId,
      sessionId: ctx.uuid,
      parentId: null,
      machineId: this.machineId,
      sourceTool: 'GitHubCopilot',
      role: 'User' as MessageRole,
      contentBlocks: [{ ...emptyTextBlock(), content: userText }],
      usage: null,
      timestamp: new Date(ts).toISOString(),
      metadata: { ...sharedMeta },
    };

    const blocks = this.responseToBlocks(Array.isArray(req.response) ? req.response : []);
    const asstTs = completedAt ?? ts;
    const asstMsg: UnifiedMessage = {
      id: asstId,
      sessionId: ctx.uuid,
      parentId: userId,
      machineId: this.machineId,
      sourceTool: 'GitHubCopilot',
      role: 'Assistant' as MessageRole,
      contentBlocks: blocks,
      usage: this.extractUsage(),
      timestamp: new Date(asstTs).toISOString(),
      metadata: { ...sharedMeta },
    };

    return [userMsg, asstMsg];
  }

  /**
   * Incremental parsing. offset = max(modelState.completedAt) observed in last scan.
   *
   * Since patches are replayed as stateful events, each run reads the whole file
   * from the beginning and emits only requests with completedAt > offset.
   */
  async parseIncremental(filePath: string, offset: number): Promise<ParseResult> {
    if (!this.matches(filePath)) return { messages: [], newOffset: offset };
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      logger.warn({ path: filePath, err: String(err) }, 'Copilot read failed');
      return { messages: [], newOffset: offset };
    }
    const lines = raw.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return { messages: [], newOffset: offset };

    let state: ChatModel | null = null;
    for (let i = 0; i < lines.length; i++) {
      let obj: { kind: number; v?: unknown; k?: unknown[]; i?: number };
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (obj.kind === 0) {
        state = (obj.v as ChatModel) ?? null;
      } else if (state && (obj.kind === 1 || obj.kind === 2)) {
        try {
          applyPatch(state, obj as { kind: number; k: unknown[]; v: unknown; i?: number });
        } catch {
          // A corrupted single patch should not affect the whole stream.
        }
      }
    }
    if (!state || !Array.isArray(state.requests)) {
      return { messages: [], newOffset: offset };
    }

    // sessionId comes from the filename (without .jsonl).
    const fname = basename(filePath, '.jsonl');
    const ctx: SessionContext = {
      uuid: toUuidV5(`session:${fname}`),
      rawId: fname,
      customTitle:
        typeof state.customTitle === 'string' && state.customTitle.length > 0
          ? state.customTitle
          : null,
      initialLocation:
        typeof state.initialLocation === 'string' && state.initialLocation.length > 0
          ? state.initialLocation
          : null,
      responderUsername:
        typeof state.responderUsername === 'string' && state.responderUsername.length > 0
          ? state.responderUsername
          : null,
    };

    let newOffset = offset;
    const messages: UnifiedMessage[] = [];
    for (const req of state.requests) {
      const completedAt = req.modelState?.completedAt;
      if (typeof completedAt === 'number' && completedAt > newOffset) {
        newOffset = completedAt;
      }
      if (typeof completedAt === 'number' && completedAt > offset) {
        const built = this.buildMessages(req, ctx);
        if (built) messages.push(...built);
      }
    }

    if (messages.length > 0) {
      logger.debug(
        { path: filePath, previousOffset: offset, newOffset, parsed: messages.length },
        'Copilot incremental parse completed',
      );
    }

    return { messages, newOffset };
  }
}
