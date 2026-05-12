'use client';

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/lib/i18n/provider';

interface MessageMetaBadgesProps {
  metadata: Record<string, unknown> | null | undefined;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function shortenPath(p: string, max = 32): string {
  if (p.length <= max) return p;
  // Keep tail (most informative for cwd-like values).
  return '…' + p.slice(p.length - max);
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m ${rest}s`;
}

// Renders the platform-specific metadata that all parsers stash in
// `metadata`. We deliberately do NOT render anything platform-coded:
// every field is read from a known-name key, missing keys simply mean
// the platform doesn't expose that signal. The display layer stays one
// component for all 6 platforms — the *information* is per-platform,
// not the rendering.
export function MessageMetaBadges({ metadata }: MessageMetaBadgesProps) {
  const { t } = useI18n();
  if (!metadata) return null;

  const cwd = isString(metadata.cwd) ? metadata.cwd : null;
  const gitBranch = isString(metadata.gitBranch) ? metadata.gitBranch : null;
  const elapsedMs = isFiniteNumber(metadata.elapsedMs) ? metadata.elapsedMs : null;
  const thinkingTokens = isFiniteNumber(metadata.thinkingTokens) ? metadata.thinkingTokens : null;
  const requestId = isString(metadata.requestId) ? metadata.requestId : null;

  if (!cwd && !gitBranch && elapsedMs == null && thinkingTokens == null && !requestId) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      {cwd && (
        <Badge variant="outline" className="px-1.5 py-0 text-[11px] font-mono" title={cwd}>
          {t('msg.meta.cwd')}: {shortenPath(cwd)}
        </Badge>
      )}
      {gitBranch && (
        <Badge variant="outline" className="px-1.5 py-0 text-[11px] font-mono" title={gitBranch}>
          {t('msg.meta.gitBranch')}: {gitBranch}
        </Badge>
      )}
      {elapsedMs != null && (
        <Badge variant="outline" className="px-1.5 py-0 text-[11px]" title={`${elapsedMs} ms`}>
          {t('msg.meta.elapsedMs')}: {formatElapsed(elapsedMs)}
        </Badge>
      )}
      {thinkingTokens != null && thinkingTokens > 0 && (
        <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
          {t('msg.meta.thinkingTokens')}: {thinkingTokens.toLocaleString()}
        </Badge>
      )}
      {requestId && (
        <Badge
          variant="outline"
          className="px-1.5 py-0 text-[11px] font-mono"
          title={requestId}
        >
          {t('msg.meta.requestId')}: {requestId.length > 10 ? requestId.slice(0, 10) + '…' : requestId}
        </Badge>
      )}
    </div>
  );
}
