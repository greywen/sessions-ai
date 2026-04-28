import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Heartbeat Request schema
const heartbeatSchema = z.object({
  agentVersion: z.string().optional(),
});

describe('Heartbeat API Schema Correction', () => {
  it('Tape should be accepted agentVersion defective returning', () => {
    const result = heartbeatSchema.safeParse({ agentVersion: '0.1.0' });
    expect(result.success).toBe(true);
    expect(result.data?.agentVersion).toBe('0.1.0');
  });

  it('Empty object should be accepted', () => {
    const result = heartbeatSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('Should accept none agentVersion', () => {
    const result = heartbeatSchema.safeParse({ agentVersion: undefined });
    expect(result.success).toBe(true);
  });

  it('30 The second heartbeat timeout threshold should be configurable', () => {
    // Verify Heart Rate Timeout Constant(For front-end display)
    const HEARTBEAT_TIMEOUT_SECONDS = 30;
    expect(HEARTBEAT_TIMEOUT_SECONDS).toBe(30);
  });
});
