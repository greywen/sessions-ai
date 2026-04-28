// Agent API Path constants
export const AGENT_API = {
  REGISTER: '/api/agent/register',
  REGISTER_STATUS: '/api/agent/register/status',
  INGEST: '/api/agent/ingest',
  HEARTBEAT: '/api/agent/heartbeat',
  CONFIG: '/api/agent/config',
  CONFIG_ACK: '/api/agent/config/ack',
} as const;

// Agent API Current limiting
export const RATE_LIMITS = {
  AGENT_PER_MINUTE: 100,
  ADMIN_PER_MINUTE: 60,
} as const;

// Escalate Batch Parameters
export const BATCH = {
  MAX_SIZE: 50,
  TIMEOUT_SECONDS: 5,
  MAX_PAYLOAD_MESSAGES: 200,
} as const;

// Tool Identification Color(TailwindCSS class Mapping)
export const TOOL_COLORS: Record<string, { text: string; bg: string }> = {
  ClaudeCode: { text: 'text-amber-600', bg: 'bg-amber-100' },
  OpenCode: { text: 'text-blue-600', bg: 'bg-blue-100' },
  Cursor: { text: 'text-violet-600', bg: 'bg-violet-100' },
  GeminiCli: { text: 'text-emerald-600', bg: 'bg-emerald-100' },
  Aider: { text: 'text-red-600', bg: 'bg-red-100' },
  GitHubCopilot: { text: 'text-sky-600', bg: 'bg-sky-100' },
  Codex: { text: 'text-teal-600', bg: 'bg-teal-100' },
  QwenCode: { text: 'text-orange-600', bg: 'bg-orange-100' },
} as const;
