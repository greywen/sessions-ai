import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// The configuration template schema(Map /api/configs)
const createConfigSchema = z.object({
  name: z.string().min(1, 'Configuration name cannot be empty'),
  configType: z.enum(['claude_code', 'opencode', 'openclaw', 'gemini_cli', 'custom']),
  configPayload: z.record(z.string(), z.unknown()),
});

const patchConfigSchema = z.object({
  name: z.string().min(1).optional(),
  configType: z.enum(['claude_code', 'opencode', 'openclaw', 'gemini_cli', 'custom']).optional(),
  configPayload: z.record(z.string(), z.unknown()).optional(),
});

// Device Configuration Push schema(Map /api/devices/[id]/configs)
const pushConfigSchema = z.object({
  configType: z.enum(['claude_code', 'opencode', 'openclaw', 'gemini_cli', 'custom']),
  configName: z.string().min(1).optional(),
  filePath: z.string().optional(),
  configPayload: z.record(z.string(), z.unknown()),
});

// Profile Read Request schema(Map /api/devices/[id]/config-read)
const configReadSchema = z.object({
  filePath: z.string().min(1, 'File path cannot be empty'),
});

// Agent Reading Result Returns schema(Map /api/agent/config/read-result)
const readResultSchema = z.object({
  requestId: z.string().uuid(),
  content: z.unknown().nullable(),
  error: z.string().nullable().optional(),
});

const ackSchema = z.union([
  z.object({
    pushLogId: z.string().min(1),
    status: z.enum(['acked', 'failed']),
    errorMessage: z.string().nullable().optional(),
  }),
  z.object({
    pushLogId: z.string().min(1),
    success: z.boolean(),
    errorMessage: z.string().nullable().optional(),
  }),
]);

describe('Configuration Management API Schema Correction', () => {
  describe('POST /api/configs Create Configuration Template', () => {
    it('Legal parameters should be accepted', () => {
      const result = createConfigSchema.safeParse({
        name: 'Default security profile',
        configType: 'claude_code',
        configPayload: { permissions: { deny: [] } },
      });
      expect(result.success).toBe(true);
      expect(result.data?.name).toBe('Default security profile');
    });

    it('Empty configuration name should be rejected', () => {
      const result = createConfigSchema.safeParse({
        name: '',
        configType: 'claude_code',
        configPayload: {},
      });
      expect(result.success).toBe(false);
    });

    it('Illegal configuration type should be rejected', () => {
      const result = createConfigSchema.safeParse({
        name: 'Test',
        configType: 'invalid_type',
        configPayload: {},
      });
      expect(result.success).toBe(false);
    });

    it('Custom configuration type should be accepted', () => {
      const result = createConfigSchema.safeParse({
        name: 'Customize Configuration',
        configType: 'custom',
        configPayload: { key: 'value' },
      });
      expect(result.success).toBe(true);
    });

    it('Acceptable gemini_cli Configuration type', () => {
      const result = createConfigSchema.safeParse({
        name: 'Gemini CLI Configure',
        configType: 'gemini_cli',
        configPayload: {},
      });
      expect(result.success).toBe(true);
    });
  });

  describe('PATCH /api/configs/[id] Update Configuration Template', () => {
    it('Some updates should be accepted', () => {
      const result = patchConfigSchema.safeParse({
        name: 'Updated name',
      });
      expect(result.success).toBe(true);
    });

    it('Empty object should be accepted', () => {
      const result = patchConfigSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('Acceptable gemini_cli Type update', () => {
      const result = patchConfigSchema.safeParse({
        configType: 'gemini_cli',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('POST /api/devices/[id]/configs Push configuration to device', () => {
    it('Full push parameters should be accepted', () => {
      const result = pushConfigSchema.safeParse({
        configType: 'claude_code',
        configName: 'Claude Configure Manufacturing',
        filePath: '~/.claude/settings.json',
        configPayload: { permissions: { deny: [] } },
      });
      expect(result.success).toBe(true);
    });

    it('configName And filePath Optional', () => {
      const result = pushConfigSchema.safeParse({
        configType: 'opencode',
        configPayload: { provider: { default: 'anthropic' } },
      });
      expect(result.success).toBe(true);
    });

    it('Acceptable gemini_cli Pushing', () => {
      const result = pushConfigSchema.safeParse({
        configType: 'gemini_cli',
        configPayload: {},
        filePath: '~/.gemini/settings.json',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('POST /api/devices/[id]/config-read Profile Read Request', () => {
    it('Legal file path should be accepted', () => {
      const result = configReadSchema.safeParse({
        filePath: '~/.claude/settings.json',
      });
      expect(result.success).toBe(true);
    });

    it('Empty file path should be rejected', () => {
      const result = configReadSchema.safeParse({
        filePath: '',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('POST /api/agent/config/read-result Agent Reading Result Returns', () => {
    it('Successful reads should be accepted', () => {
      const result = readResultSchema.safeParse({
        requestId: '550e8400-e29b-41d4-a716-446655440000',
        content: { key: 'value' },
        error: null,
      });
      expect(result.success).toBe(true);
    });

    it('Failed reads should be accepted', () => {
      const result = readResultSchema.safeParse({
        requestId: '550e8400-e29b-41d4-a716-446655440000',
        content: null,
        error: 'File don\'t exists',
      });
      expect(result.success).toBe(true);
    });

    it('Non- UUID right of privacy requestId', () => {
      const result = readResultSchema.safeParse({
        requestId: 'not-a-uuid',
        content: null,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('POST /api/agent/config/ack', () => {
    it('Acceptable acked Status', () => {
      const result = ackSchema.safeParse({
        pushLogId: 'log-1',
        status: 'acked',
      });
      expect(result.success).toBe(true);
    });

    it('Acceptable failed Status with error message', () => {
      const result = ackSchema.safeParse({
        pushLogId: 'log-1',
        status: 'failed',
        errorMessage: 'Insufficient Permissions',
      });
      expect(result.success).toBe(true);
    });

    it('Empty should be rejected pushLogId', () => {
      const result = ackSchema.safeParse({
        pushLogId: '',
        status: 'acked',
      });
      expect(result.success).toBe(false);
    });

    it('Illegal status should be rejected', () => {
      const result = ackSchema.safeParse({
        pushLogId: 'log-1',
        status: 'pending',
      });
      expect(result.success).toBe(false);
    });

    it('Should be compatible success Boolean field', () => {
      const result = ackSchema.safeParse({
        pushLogId: 'log-1',
        success: true,
      });
      expect(result.success).toBe(true);
    });

    it('Should be compatible errorMessage are null', () => {
      const result = ackSchema.safeParse({
        pushLogId: 'log-1',
        status: 'acked',
        errorMessage: null,
      });
      expect(result.success).toBe(true);
    });
  });
});
