'use client';

import React from 'react';
import type { TokenUsage } from '@llm-sessions/shared';
import { useI18n } from '@/lib/i18n/provider';

interface TokenUsageBarProps {
  usage: TokenUsage;
}

// Token usage row shown at the bottom of each message.
export function TokenUsageBar({ usage }: TokenUsageBarProps) {
  const { t } = useI18n();
  const formatNum = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  return (
    <div className="flex items-center gap-3 mt-2 pt-2 border-t border-border/50 text-xs font-mono text-muted-foreground">
      <span>📊</span>
      <span>{t('block.usage.input')}: {formatNum(usage.inputTokens)}</span>
      <span>{t('block.usage.output')}: {formatNum(usage.outputTokens)}</span>
      {usage.cacheReadInputTokens != null && usage.cacheReadInputTokens > 0 && (
        <span>{t('block.usage.cacheRead')}: {formatNum(usage.cacheReadInputTokens)}</span>
      )}
      {usage.cacheCreationInputTokens != null && usage.cacheCreationInputTokens > 0 && (
        <span>{t('block.usage.cacheWrite')}: {formatNum(usage.cacheCreationInputTokens)}</span>
      )}
    </div>
  );
}
