import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// Verify Ingest payload schema
const contentBlockSchema = z.object({
  blockType: z.string(),
  content: z.string(),
  language: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
  diff: z.string().nullable().optional(),
  toolName: z.string().nullable().optional(),
  toolInput: z.record(z.string(), z.unknown()).nullable().optional(),
  exitCode: z.number().nullable().optional(),
  isCollapsed: z.boolean().optional(),
});

const tokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number().nullable().optional(),
  cacheReadInputTokens: z.number().nullable().optional(),
  model: z.string(),
});

const messageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  parentId: z.string().nullable().optional(),
  machineId: z.string(),
  sourceTool: z.string(),
  role: z.string(),
  contentBlocks: z.array(contentBlockSchema),
  usage: tokenUsageSchema.nullable().optional(),
  timestamp: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const ingestPayloadSchema = z.array(messageSchema).min(1).max(200);

describe('Ingest API Schema Correction', () => {
  it('A valid message array should be accepted', () => {
    const validPayload = [
      {
        id: 'msg-001',
        sessionId: 'sess-001',
        parentId: null,
        machineId: 'machine-001',
        sourceTool: 'ClaudeCode',
        role: 'User',
        contentBlocks: [
          {
            blockType: 'Text',
            content: 'Hello.',
            language: null,
            filePath: null,
            diff: null,
            toolName: null,
            toolInput: null,
            exitCode: null,
            isCollapsed: false,
          },
        ],
        usage: null,
        timestamp: '2026-04-03T10:00:00Z',
        metadata: {},
      },
    ];

    const result = ingestPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('Tape should be accepted token usage Message', () => {
    const payload = [
      {
        id: 'msg-002',
        sessionId: 'sess-001',
        machineId: 'machine-001',
        sourceTool: 'OpenCode',
        role: 'Assistant',
        contentBlocks: [{ blockType: 'Text', content: 'Reply' }],
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: 200,
          model: 'claude-3-5-sonnet',
        },
        timestamp: '2026-04-03T10:00:05Z',
      },
    ];

    const result = ingestPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('Empty array should be rejected', () => {
    const result = ingestPayloadSchema.safeParse([]);
    expect(result.success).toBe(false);
  });

  it('Should refuse to exceed 200 Array of bars', () => {
    const largePayload = Array.from({ length: 201 }, (_, i) => ({
      id: `msg-${i}`,
      sessionId: 'sess-001',
      machineId: 'machine-001',
      sourceTool: 'ClaudeCode',
      role: 'User',
      contentBlocks: [{ blockType: 'Text', content: 'test' }],
      timestamp: '2026-04-03T10:00:00Z',
    }));

    const result = ingestPayloadSchema.safeParse(largePayload);
    expect(result.success).toBe(false);
  });

  it('Missing should be rejected id Message', () => {
    const payload = [
      {
        sessionId: 'sess-001',
        machineId: 'machine-001',
        sourceTool: 'ClaudeCode',
        role: 'User',
        contentBlocks: [{ blockType: 'Text', content: 'test' }],
        timestamp: '2026-04-03T10:00:00Z',
      },
    ];

    const result = ingestPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('Missing should be rejected timestamp Message', () => {
    const payload = [
      {
        id: 'msg-001',
        sessionId: 'sess-001',
        machineId: 'machine-001',
        sourceTool: 'ClaudeCode',
        role: 'User',
        contentBlocks: [{ blockType: 'Text', content: 'test' }],
      },
    ];

    const result = ingestPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('Acceptable Containing tool_calls Message for content block', () => {
    const payload = [
      {
        id: 'msg-003',
        sessionId: 'sess-001',
        machineId: 'machine-001',
        sourceTool: 'ClaudeCode',
        role: 'Assistant',
        contentBlocks: [
          {
            blockType: 'ToolCall',
            content: 'Tool: Edit',
            toolName: 'Edit',
            toolInput: { file_path: '/tmp/test.ts', diff: '+new line' },
            filePath: '/tmp/test.ts',
            diff: '+new line',
          },
        ],
        timestamp: '2026-04-03T10:00:10Z',
      },
    ];

    const result = ingestPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
