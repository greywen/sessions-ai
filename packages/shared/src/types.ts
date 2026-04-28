// Tool Type Enumeration
export type ToolType = 'ClaudeCode' | 'OpenCode' | 'Cursor' | 'GeminiCli' | 'Aider' | 'GitHubCopilot' | 'Codex';

// Message Role Enumeration
export type MessageRole = 'User' | 'Assistant' | 'System' | 'ToolUse' | 'ToolResult';

// Content Block Type Enumeration
export type ContentBlockType =
  | 'Text'
  | 'Thinking'
  | 'Code'
  | 'ToolCall'
  | 'ToolOutput'
  | 'FileEdit'
  | 'FileRead'
  | 'ShellCommand'
  | 'ShellOutput'
  | 'McpCall'
  | 'McpResult'
  | 'SearchResult'
  | 'Image'
  | 'Error'
  | 'Status'
  | 'Unknown';

// Token Quantity
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  model: string;
}

// Block
export interface ContentBlock {
  blockType: ContentBlockType;
  content: string;
  language: string | null;
  filePath: string | null;
  diff: string | null;
  toolName: string | null;
  toolInput: Record<string, unknown> | null;
  exitCode: number | null;
  isCollapsed: boolean;
}

// Unified Messaging Structure
export interface UnifiedMessage {
  id: string;
  sessionId: string;
  parentId: string | null;
  machineId: string;
  sourceTool: ToolType;
  role: MessageRole;
  contentBlocks: ContentBlock[];
  usage: TokenUsage | null;
  timestamp: string; // UTC ISO 8601
  metadata: Record<string, unknown>;
}

// Device Status
export type MachineStatus = 'pending' | 'active' | 'disabled';

// Users Groups
export type UserRole = 'super_admin' | 'admin' | 'viewer';

// Configuration type
export type ConfigType = 'claude_managed' | 'mcp_servers' | 'model_policy' | 'custom';

// Configure Push Destination Type
export type TargetType = 'all' | 'group' | 'specific';

// Configure Push Status
export type ConfigPushStatus = 'pending' | 'pushed' | 'acked' | 'failed';

// Device Configuration Status
export type DeviceConfigStatus = 'draft' | 'pushing' | 'pushed' | 'rolled_back';
