import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  bigint,
  numeric,
  date,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// ==================== users ====================
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').unique().notNull(),
  name: text('name'),
  role: text('role', { enum: ['super_admin', 'admin', 'viewer'] }).default('viewer').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ==================== machines ====================
export const machines = pgTable('machines', {
  id: uuid('id').defaultRandom().primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  osUsername: text('os_username'),
  displayName: text('display_name'),
  osInfo: jsonb('os_info'),
  authKey: uuid('auth_key').defaultRandom().unique().notNull(),
  status: text('status', { enum: ['pending', 'active', 'disabled'] }).default('pending').notNull(),
  agentVersion: text('agent_version'),
  localConfigs: jsonb('local_configs'), // Agent Escalated local profile content
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('idx_machines_fingerprint_user').on(table.fingerprint, table.osUsername),
  index('idx_machines_auth_key').on(table.authKey),
  index('idx_machines_status').on(table.status),
]);

// ==================== normalized_messages ====================
export const normalizedMessages = pgTable('normalized_messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: text('session_id').notNull(),
  parentId: text('parent_id'),
  machineId: uuid('machine_id').notNull(),
  sourceTool: text('source_tool').notNull(),
  role: text('role').notNull(),
  contentBlocks: jsonb('content_blocks'),
  usage: jsonb('usage'),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).default('0').notNull(),
  rawTimestamp: timestamp('raw_timestamp', { withTimezone: true }).notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_nm_machine_time').on(table.machineId, table.createdAt),
  index('idx_nm_session').on(table.sessionId),
  index('idx_nm_source_tool').on(table.sourceTool, table.createdAt),
]);

// ==================== session_favorites ====================
export const sessionFavorites = pgTable('session_favorites', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  sessionId: text('session_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('idx_session_favorites_unique').on(table.userId, table.sessionId),
  index('idx_session_favorites_user').on(table.userId),
  index('idx_session_favorites_session').on(table.sessionId),
]);

// ==================== favorite_snapshots ====================
// Replaces the old `message_favorites` table.
//
// Why a snapshot table?
// The product promise is "save messages users may want later". A plain
// (user_id, message_id) reference fails that promise the moment the source
// `normalized_messages` row is rebuilt, re-parsed, or pruned. So when a user
// stars a message, we deep-copy the full `UnifiedMessage` payload here.
// The snapshot is the source of truth for the favorites view; it survives
// schema changes, parser rewrites, and source-data deletion.
//
// `source_message_id` / `source_session_id` are kept as soft references only
// (no FK, no cascade) so historical favorites stay even after a re-ingest.
export const favoriteSnapshots = pgTable('favorite_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  // Soft references — no FK, intentional. Keep the snapshot even if the
  // source row is gone.
  sourceMessageId: uuid('source_message_id').notNull(),
  sourceSessionId: text('source_session_id').notNull(),
  // Frozen copy of UnifiedMessage at favorite-time. All platform-specific
  // metadata stays inside `metadata`.
  sourceTool: text('source_tool').notNull(),
  machineId: uuid('machine_id').notNull(),
  role: text('role').notNull(),
  contentBlocks: jsonb('content_blocks').notNull(),
  usage: jsonb('usage'),
  metadata: jsonb('metadata'),
  rawTimestamp: timestamp('raw_timestamp', { withTimezone: true }).notNull(),
  // User's free-form note attached to the favorite.
  userNote: text('user_note'),
  snapshottedAt: timestamp('snapshotted_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('idx_favorite_snapshots_unique').on(table.userId, table.sourceMessageId),
  index('idx_favorite_snapshots_user').on(table.userId, table.snapshottedAt),
  index('idx_favorite_snapshots_session').on(table.sourceSessionId),
]);

// ==================== raw_events ====================
export const rawEvents = pgTable('raw_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  machineId: uuid('machine_id').notNull(),
  sourceTool: text('source_tool').notNull(),
  sourceFilePath: text('source_file_path').notNull(),
  rawContent: text('raw_content').notNull(), // base64 Coded gzip Contents
  contentHash: text('content_hash').notNull(),
  byteOffsetStart: bigint('byte_offset_start', { mode: 'number' }),
  byteOffsetEnd: bigint('byte_offset_end', { mode: 'number' }),
  parsedAt: timestamp('parsed_at', { withTimezone: true }),
  parseVersion: text('parse_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('idx_raw_events_unique').on(table.machineId, table.sourceFilePath, table.contentHash),
]);

// ==================== device_configs ====================
export const deviceConfigs = pgTable('device_configs', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  configType: text('config_type', {
    enum: ['claude_code', 'opencode', 'openclaw', 'gemini_cli', 'custom'],
  }).notNull(),
  configPayload: jsonb('config_payload').notNull(),
  filePath: text('file_path'),
  targetType: text('target_type', { enum: ['all', 'group', 'specific'] }).notNull(),
  targetIds: uuid('target_ids').array(),
  targetGroup: text('target_group'),
  version: integer('version').default(1).notNull(),
  status: text('status', {
    enum: ['draft', 'pushing', 'pushed', 'rolled_back'],
  }).default('draft').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ==================== config_push_logs ====================
export const configPushLogs = pgTable('config_push_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  configId: uuid('config_id').notNull().references(() => deviceConfigs.id),
  machineId: uuid('machine_id').notNull().references(() => machines.id),
  pushedBy: uuid('pushed_by').references(() => users.id),
  status: text('status', {
    enum: ['pending', 'pushed', 'acked', 'failed'],
  }).default('pending').notNull(),
  pushedAt: timestamp('pushed_at', { withTimezone: true }),
  ackedAt: timestamp('acked_at', { withTimezone: true }),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_push_logs_config').on(table.configId),
  index('idx_push_logs_machine').on(table.machineId),
]);

// ==================== daily_stats ====================
export const dailyStats = pgTable('daily_stats', {
  day: date('day').notNull(),
  machineId: uuid('machine_id').notNull(),
  sourceTool: text('source_tool').notNull(),
  model: text('model'),
  messageCount: integer('message_count').default(0).notNull(),
  sessionCount: integer('session_count').default(0).notNull(),
  totalInputTokens: bigint('total_input_tokens', { mode: 'number' }).default(0).notNull(),
  totalOutputTokens: bigint('total_output_tokens', { mode: 'number' }).default(0).notNull(),
  totalCacheTokens: bigint('total_cache_tokens', { mode: 'number' }).default(0).notNull(),
  estimatedCostUsd: numeric('estimated_cost_usd', { precision: 12, scale: 4 }).default('0').notNull(),
}, (table) => [
  uniqueIndex('idx_daily_stats_unique').on(table.day, table.machineId, table.sourceTool, table.model),
  index('idx_daily_stats_day').on(table.day),
]);

// ==================== config_read_requests ====================
// On-demand profile read requests(Used to read files from devices when creating custom configurations)
export const configReadRequests = pgTable('config_read_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  machineId: uuid('machine_id').notNull().references(() => machines.id),
  filePath: text('file_path').notNull(),
  status: text('status', {
    enum: ['pending', 'completed', 'failed'],
  }).default('pending').notNull(),
  content: jsonb('content'),
  error: text('error'),
  requestedBy: uuid('requested_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
  index('idx_config_read_machine').on(table.machineId, table.status),
]);

// ==================== audit_logs ====================
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: uuid('target_id'),
  details: jsonb('details'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
