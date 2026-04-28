import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
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

const CODEX_NS = 'codex-ns-v1';

function toUuidV5(name: string, namespace: string = CODEX_NS): string {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(name) && namespace === CODEX_NS) return name.toLowerCase();
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

function classifyToolName(name: string): ContentBlockType {
  const n = name.toLowerCase();
  if (n.includes('apply_patch') || n.includes('edit') || n.includes('write')) return 'FileEdit';
  if (n.includes('read') || n.includes('view')) return 'FileRead';
  if (n.includes('exec') || n.includes('shell') || n.includes('bash')) return 'ShellCommand';
  if (n.includes('search') || n.includes('grep') || n.includes('find')) return 'SearchResult';
  if (n.includes('web_search') || n.includes('browser')) return 'McpCall';
  if (n.startsWith('mcp_')) return 'McpCall';
  return 'ToolCall';
}

/**
 * Extract plain text from a Codex message content array. Codex uses entries
 * such as {type:'input_text',text:'...'} and {type:'output_text',text:'...'}.
 */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const t = (c as { text?: unknown }).text;
    if (typeof t === 'string') parts.push(t);
  }
  return parts.join('');
}

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface SessionMeta {
  id: string;
  cwd: string | null;
  cliVersion: string | null;
  originator: string | null;
  source: string | null;
  modelProvider: string | null;
}

interface PendingFunctionCall {
  callId: string;
  name: string;
  args: string;
  ts: string;
}

export class CodexParser implements ToolParser {
  constructor(private readonly machineId: string) {}

  toolType(): ToolType {
    return 'Codex';
  }

  fileExtensions(): string[] {
    return ['jsonl'];
  }

  matches(filePath: string): boolean {
    if (!filePath.endsWith('.jsonl')) return false;
    return /[\\/]sessions[\\/]/.test(filePath) && basename(filePath).startsWith('rollout-');
  }

  logPaths(): string[] {
    const home = homedir();
    return [join(home, '.codex', 'sessions')].filter((p) => existsSync(p));
  }

  /**
   * Incremental parsing by byte offset. Codex rollouts are append-only JSONL,
   * so we track a byte offset per file and parse only the new tail. A complete
   * rebuild of message context for the full file is performed on each call so
   * tool-call/output pairing across the offset boundary is preserved.
   */
  async parseIncremental(filePath: string, offset: number): Promise<ParseResult> {
    if (!this.matches(filePath)) return { messages: [], newOffset: offset };
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      return { messages: [], newOffset: offset };
    }
    // File rotated/truncated: restart from 0.
    let startOffset = offset;
    if (stat.size < offset) startOffset = 0;
    if (stat.size === startOffset) return { messages: [], newOffset: stat.size };

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      logger.warn({ path: filePath, err: String(err) }, 'Codex read failed');
      return { messages: [], newOffset: offset };
    }

    const lines = raw.split('\n').filter((l) => l.length > 0);
    const parsed: RolloutLine[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as RolloutLine);
      } catch {
        // ignore corrupted line
      }
    }
    if (parsed.length === 0) return { messages: [], newOffset: stat.size };

    const sessionMeta = this.extractSessionMeta(parsed, filePath);
    const sessionUuid = toUuidV5(`session:${sessionMeta.id}`);
    const messages = this.buildMessages(parsed, sessionMeta, sessionUuid);

    return { messages, newOffset: stat.size };
  }

  private extractSessionMeta(lines: RolloutLine[], filePath: string): SessionMeta {
    for (const ln of lines) {
      if (ln.type === 'session_meta' && ln.payload && typeof ln.payload === 'object') {
        const p = ln.payload as Record<string, unknown>;
        return {
          id: typeof p.id === 'string' ? p.id : basename(filePath, '.jsonl'),
          cwd: typeof p.cwd === 'string' ? p.cwd : null,
          cliVersion: typeof p.cli_version === 'string' ? p.cli_version : null,
          originator: typeof p.originator === 'string' ? p.originator : null,
          source: typeof p.source === 'string' ? p.source : null,
          modelProvider: typeof p.model_provider === 'string' ? p.model_provider : null,
        };
      }
    }
    return {
      id: basename(filePath, '.jsonl'),
      cwd: null,
      cliVersion: null,
      originator: null,
      source: null,
      modelProvider: null,
    };
  }

  private buildMessages(
    lines: RolloutLine[],
    meta: SessionMeta,
    sessionUuid: string,
  ): UnifiedMessage[] {
    const sharedMeta: Record<string, unknown> = {
      sourceSessionId: meta.id,
    };
    if (meta.cwd) sharedMeta.cwd = meta.cwd;
    if (meta.cliVersion) sharedMeta.cliVersion = meta.cliVersion;
    if (meta.originator) sharedMeta.originator = meta.originator;
    if (meta.source) sharedMeta.source = meta.source;
    if (meta.modelProvider) sharedMeta.modelProvider = meta.modelProvider;

    const messages: UnifiedMessage[] = [];
    let lastTurnContextModel: string | null = null;
    let lastAssistantId: string | null = null;
    let lastAssistantIndex: number = -1;
    let messageIndex = 0;
    const pendingFunctionCalls = new Map<string, PendingFunctionCall>();

    const baseUsage = (model: string, totals: {
      input?: number;
      cached?: number;
      output?: number;
      reasoning?: number;
    }): TokenUsage => ({
      inputTokens: Math.max(0, (totals.input ?? 0) - (totals.cached ?? 0)),
      outputTokens: (totals.output ?? 0) + (totals.reasoning ?? 0),
      cacheCreationInputTokens: null,
      cacheReadInputTokens: totals.cached ?? null,
      model,
    });

    for (const ln of lines) {
      const ts = ln.timestamp ?? new Date().toISOString();
      const payload = ln.payload as Record<string, unknown> | undefined;
      if (!payload) continue;

      // turn_context: capture the model used for the upcoming turn.
      if (ln.type === 'turn_context') {
        const model = typeof payload.model === 'string' ? payload.model : null;
        if (model) lastTurnContextModel = model;
        continue;
      }

      // event_msg / token_count: attach usage to last assistant message.
      if (ln.type === 'event_msg' && payload.type === 'token_count') {
        const info = payload.info as
          | {
              total_token_usage?: {
                input_tokens?: number;
                cached_input_tokens?: number;
                output_tokens?: number;
                reasoning_output_tokens?: number;
              };
              last_token_usage?: {
                input_tokens?: number;
                cached_input_tokens?: number;
                output_tokens?: number;
                reasoning_output_tokens?: number;
              };
            }
          | null
          | undefined;
        const last = info?.last_token_usage;
        if (last && lastAssistantIndex >= 0 && lastTurnContextModel) {
          messages[lastAssistantIndex].usage = baseUsage(lastTurnContextModel, {
            input: last.input_tokens,
            cached: last.cached_input_tokens,
            output: last.output_tokens,
            reasoning: last.reasoning_output_tokens,
          });
        }
        continue;
      }

      // response_item.message: user / assistant / developer
      if (ln.type === 'response_item' && payload.type === 'message') {
        const role = payload.role as string | undefined;
        if (role !== 'user' && role !== 'assistant') continue; // skip developer/system noise
        const text = flattenContent(payload.content);
        if (!text) continue;
        // Skip the synthetic `<environment_context>` user message.
        if (role === 'user' && text.startsWith('<environment_context>')) continue;
        // Skip the giant projectless-chat developer prompt that comes through
        // as a user message (it begins with `<app-context>` etc.).
        if (
          role === 'user' &&
          (text.startsWith('<app-context>') || text.startsWith('<permissions instructions>'))
        ) {
          continue;
        }

        const idSeed = `${meta.id}:${messageIndex++}:${role}`;
        const id = toUuidV5(idSeed);
        const parentId = role === 'user' ? null : lastAssistantId;
        const msg: UnifiedMessage = {
          id,
          sessionId: sessionUuid,
          parentId: role === 'assistant' && messages.length > 0 ? messages[messages.length - 1].id : null,
          machineId: this.machineId,
          sourceTool: 'Codex',
          role: (role === 'user' ? 'User' : 'Assistant') as MessageRole,
          contentBlocks: [emptyBlock('Text', text)],
          usage: null,
          timestamp: ts,
          metadata: { ...sharedMeta, model: lastTurnContextModel ?? 'unknown' },
        };
        messages.push(msg);
        if (role === 'assistant') {
          lastAssistantId = id;
          lastAssistantIndex = messages.length - 1;
        }
        // Suppress unused warning
        void parentId;
        continue;
      }

      // response_item.reasoning (encrypted). Surface as a Thinking placeholder.
      if (ln.type === 'response_item' && payload.type === 'reasoning') {
        const summary = payload.summary;
        const summaryText = Array.isArray(summary)
          ? summary
              .map((s) => (s && typeof s === 'object' ? flattenContent((s as { text?: unknown }).text) : ''))
              .filter(Boolean)
              .join('\n')
          : '';
        if (summaryText && lastAssistantIndex >= 0) {
          messages[lastAssistantIndex].contentBlocks.unshift(emptyBlock('Thinking', summaryText));
        }
        continue;
      }

      // response_item.function_call / custom_tool_call: capture pending tool call.
      if (
        ln.type === 'response_item' &&
        (payload.type === 'function_call' || payload.type === 'custom_tool_call')
      ) {
        const callId =
          (payload.call_id as string | undefined) ?? (payload.id as string | undefined) ?? '';
        const name = (payload.name as string | undefined) ?? 'unknown';
        const args =
          (payload.arguments as string | undefined) ??
          (payload.input as string | undefined) ??
          '';
        if (callId) pendingFunctionCalls.set(callId, { callId, name, args, ts });
        continue;
      }

      // response_item.function_call_output / custom_tool_call_output: pair output.
      if (
        ln.type === 'response_item' &&
        (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')
      ) {
        const callId = (payload.call_id as string | undefined) ?? '';
        const output =
          typeof payload.output === 'string'
            ? payload.output
            : flattenContent(payload.output) || JSON.stringify(payload.output ?? '');
        const pending = pendingFunctionCalls.get(callId);
        const name = pending?.name ?? 'unknown';
        let parsedInput: Record<string, unknown> | null = null;
        if (pending?.args) {
          try {
            parsedInput = JSON.parse(pending.args) as Record<string, unknown>;
          } catch {
            parsedInput = { raw: pending.args };
          }
        }
        const block: ContentBlock = {
          ...emptyBlock(classifyToolName(name)),
          content: output.length > 4000 ? `${output.slice(0, 4000)}\n…[truncated]` : output,
          toolName: name,
          toolInput: parsedInput,
        };
        if (lastAssistantIndex >= 0) {
          messages[lastAssistantIndex].contentBlocks.push(block);
        }
        if (callId) pendingFunctionCalls.delete(callId);
        continue;
      }

      // event_msg.exec_command_end: command + stdout/stderr + exit code.
      if (ln.type === 'event_msg' && payload.type === 'exec_command_end') {
        const cmd = Array.isArray(payload.command) ? (payload.command as unknown[]).join(' ') : '';
        const stdout = typeof payload.stdout === 'string' ? payload.stdout : '';
        const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : null;
        if (lastAssistantIndex >= 0) {
          if (cmd) {
            messages[lastAssistantIndex].contentBlocks.push({
              ...emptyBlock('ShellCommand', cmd),
              toolName: 'exec',
              exitCode,
            });
          }
          if (stdout) {
            const trimmed = stdout.length > 4000 ? `${stdout.slice(0, 4000)}\n…[truncated]` : stdout;
            messages[lastAssistantIndex].contentBlocks.push({
              ...emptyBlock('ShellOutput', trimmed),
              toolName: 'exec',
              exitCode,
            });
          }
        }
        continue;
      }

      // event_msg.patch_apply_end: edits applied.
      if (ln.type === 'event_msg' && payload.type === 'patch_apply_end') {
        const stdout = typeof payload.stdout === 'string' ? payload.stdout : '';
        if (stdout && lastAssistantIndex >= 0) {
          messages[lastAssistantIndex].contentBlocks.push({
            ...emptyBlock('FileEdit', stdout),
            toolName: 'apply_patch',
          });
        }
        continue;
      }

      // event_msg.error: surface as Error block on last assistant message.
      if (ln.type === 'event_msg' && payload.type === 'error') {
        const text = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload);
        if (lastAssistantIndex >= 0) {
          messages[lastAssistantIndex].contentBlocks.push(emptyBlock('Error', text));
        }
        continue;
      }
    }

    return messages;
  }
}
