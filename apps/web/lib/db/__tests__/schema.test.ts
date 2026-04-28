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
    expect(schema.pricingTable).toBeDefined();
    expect(schema.dailyStats).toBeDefined();
    expect(schema.auditLogs).toBeDefined();
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

  it('pricingTable Table should have price related fields', () => {
    const columns = Object.keys(schema.pricingTable);
    expect(columns).toContain('model');
    expect(columns).toContain('provider');
    expect(columns).toContain('inputPricePerMtok');
    expect(columns).toContain('outputPricePerMtok');
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
