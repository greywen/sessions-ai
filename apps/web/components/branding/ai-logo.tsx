'use client';

import React from 'react';
import {
  ClaudeCode,
  Codex,
  Cursor,
  GeminiCLI,
  GithubCopilot,
  ModelIcon,
  OpenCode,
  ProviderIcon,
  Qwen,
} from '@lobehub/icons';
import { cn } from '@/lib/utils';

const TOOL_ICON_MAP = {
  ClaudeCode,
  OpenCode,
  Cursor,
  GeminiCli: GeminiCLI,
  GitHubCopilot: GithubCopilot,
  Codex,
  QwenCode: Qwen,
  Qcoder: Qwen,
  // CodeBuddy uses provider fallback (no @lobehub/icons entry)
} as const;

const TOOL_PROVIDER_MAP: Record<string, string> = {
  ClaudeCode: 'anthropic',
  OpenCode: 'openai',
  Cursor: 'openai',
  GeminiCli: 'google',
  Aider: 'openai',
  GitHubCopilot: 'githubcopilot',
  Codex: 'openai',
  QwenCode: 'qwen',
  Qcoder: 'qwen',
  CodeBuddy: 'tencent',
};

const TOOL_LABELS: Record<string, string> = {
  ClaudeCode: 'Claude Code',
  OpenCode: 'OpenCode',
  Cursor: 'Cursor',
  GeminiCli: 'Gemini CLI',
  Aider: 'Aider',
  GitHubCopilot: 'GitHub Copilot',
  Codex: 'Codex',
  QwenCode: 'Qcoder',
  Qcoder: 'Qcoder',
  CodeBuddy: 'CodeBuddy',
};

export function getToolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

function toLower(input?: string | null): string {
  return String(input ?? '').trim().toLowerCase();
}

export function normalizeProvider(provider?: string | null): string | undefined {
  const value = toLower(provider);
  if (!value) return undefined;

  if (value.includes('anthropic') || value.includes('claude')) return 'anthropic';
  if (value.includes('openai') || value.includes('gpt') || value.includes('chatgpt') || value.includes('codex')) return 'openai';
  if (value.includes('google') || value.includes('gemini')) return 'google';
  if (value.includes('github') || value.includes('copilot')) return 'githubcopilot';
  if (value.includes('xai') || value.includes('grok')) return 'xai';
  if (value.includes('qwen') || value.includes('alibaba')) return 'qwen';
  if (value.includes('deepseek')) return 'deepseek';
  if (value.includes('mistral')) return 'mistral';

  return value;
}

export function inferProviderFromModel(model?: string | null): string | undefined {
  const value = toLower(model);
  if (!value) return undefined;

  if (value.includes('/')) {
    return normalizeProvider(value.split('/')[0]);
  }

  if (value.startsWith('claude')) return 'anthropic';
  if (value.startsWith('gpt') || value.startsWith('o1') || value.startsWith('o3') || value.includes('codex')) return 'openai';
  if (value.startsWith('gemini')) return 'google';
  if (value.startsWith('deepseek')) return 'deepseek';
  if (value.startsWith('qwen')) return 'qwen';
  if (value.startsWith('grok')) return 'xai';
  if (value.startsWith('mistral')) return 'mistral';

  return undefined;
}

function normalizeModel(model?: string | null): string | undefined {
  const value = String(model ?? '').trim();
  return value.length > 0 ? value : undefined;
}

function FallbackDot({ size, text }: { size: number; text: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-[rgba(28,28,28,0.04)] text-[10px] font-medium text-foreground"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {text.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ProviderLogo({
  provider,
  size = 16,
  className,
}: {
  provider?: string | null;
  size?: number;
  className?: string;
}) {
  const normalized = normalizeProvider(provider);
  if (!normalized) return <FallbackDot size={size} text="P" />;

  return (
    <ProviderIcon
      provider={normalized}
      size={size}
      type="color"
      className={cn('shrink-0', className)}
    />
  );
}

export function ModelLogo({
  model,
  provider,
  size = 16,
  className,
}: {
  model?: string | null;
  provider?: string | null;
  size?: number;
  className?: string;
}) {
  const normalizedModel = normalizeModel(model);
  if (normalizedModel) {
    return (
      <ModelIcon
        model={normalizedModel}
        size={size}
        type="color"
        className={cn('shrink-0', className)}
      />
    );
  }

  return <ProviderLogo provider={provider} size={size} className={className} />;
}

export function ToolLogo({
  tool,
  size = 16,
  className,
}: {
  tool?: string | null;
  size?: number;
  className?: string;
}) {
  const name = String(tool ?? '').trim();
  const Icon = TOOL_ICON_MAP[name as keyof typeof TOOL_ICON_MAP] as React.ComponentType<{ size?: number; className?: string }> | undefined;

  if (Icon) {
    return <Icon size={size} className={cn('shrink-0', className)} />;
  }

  const provider = normalizeProvider(TOOL_PROVIDER_MAP[name]);
  if (provider) {
    return <ProviderLogo provider={provider} size={size} className={className} />;
  }

  return <FallbackDot size={size} text={name || 'T'} />;
}
