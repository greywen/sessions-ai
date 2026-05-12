import { describe, it, expect } from 'vitest';
import * as schema from '../schema';

describe('Database Schema Definition', () => {
  it('All core tables should be exported', () => {
    expect(schema.users).toBeDefined();
    expect(schema.machines).toBeDefined();
    expect(schema.normalizedMessages).toBeDefined();
    expect(schema.rawEvents).toBeDefined();
    expect(schema.deviceConfigs).toBeDefined();
    expect(schema.configPushLogs).toBeDefined();
    expect(schema.dailyStats).toBeDefined();
    expect(schema.auditLogs).toBeDefined();
    expect(schema.sessionFavorites).toBeDefined();
    expect(schema.favoriteSnapshots).toBeDefined();
  });

  it('users The table should have the correct required fields', () => {
    const columns = Object.keys(schema.users);
    expect(columns).toContain('id');
    expect(columns).toContain('email');
    expect(columns).toContain('passwordHash');
    expect(columns).toContain('role');
  });

  it('machines The table should have the correct required fields', () => {
    const columns = Object.keys(schema.machines);
    expect(columns).toContain('id');
    expect(columns).toContain('fingerprint');
    expect(columns).toContain('authKey');
    expect(columns).toContain('status');
  });

  it('normalizedMessages The table should have the correct required fields', () => {
    const columns = Object.keys(schema.normalizedMessages);
    expect(columns).toContain('id');
    expect(columns).toContain('sessionId');
    expect(columns).toContain('machineId');
    expect(columns).toContain('sourceTool');
    expect(columns).toContain('role');
    expect(columns).toContain('contentBlocks');
  });

  it('sessionFavorites The table should have favorite related fields', () => {
    const columns = Object.keys(schema.sessionFavorites);
    expect(columns).toContain('id');
    expect(columns).toContain('userId');
    expect(columns).toContain('sessionId');
  });

  it('favoriteSnapshots table should freeze a full UnifiedMessage payload', () => {
    const columns = Object.keys(schema.favoriteSnapshots);
    // Identity
    expect(columns).toContain('id');
    expect(columns).toContain('userId');
    // Soft references — kept after source row is gone (no FK by design)
    expect(columns).toContain('sourceMessageId');
    expect(columns).toContain('sourceSessionId');
    // Frozen UnifiedMessage payload — must outlive parser rewrites
    expect(columns).toContain('sourceTool');
    expect(columns).toContain('machineId');
    expect(columns).toContain('role');
    expect(columns).toContain('contentBlocks');
    expect(columns).toContain('usage');
    expect(columns).toContain('metadata');
    expect(columns).toContain('rawTimestamp');
    // User affordances
    expect(columns).toContain('userNote');
    expect(columns).toContain('snapshottedAt');
  });

  it('dailyStats Table should have aggregate fields', () => {
    const columns = Object.keys(schema.dailyStats);
    expect(columns).toContain('day');
    expect(columns).toContain('machineId');
    expect(columns).toContain('messageCount');
    expect(columns).toContain('totalInputTokens');
    expect(columns).toContain('estimatedCostUsd');
  });
});
