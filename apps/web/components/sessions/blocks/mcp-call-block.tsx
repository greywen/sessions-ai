'use client';

import React from 'react';
import { ChevronRight, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/i18n/provider';

interface McpCallBlockProps {
  toolName: string;
  toolInput: Record<string, unknown> | null;
  content: string;
  isResult?: boolean;
}

// Threshold above which the result body collapses by default. Larger
// payloads still render IN FULL when expanded — we never throw away data
// at the renderer layer; this is an archive product.
const RESULT_COLLAPSE_THRESHOLD = 1200;

// MCP / tool call block. Header always shows tool name + a short param
// summary; the body holds the full input JSON and the full result text.
// Long results auto-collapse to keep scroll length sane but stay 100%
// recoverable via "show all".
export function McpCallBlock({ toolName, toolInput, content, isResult }: McpCallBlockProps) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);

  // Header summary — for collapsed-row hint only. Truncating the visual
  // hint is fine; the underlying data lives in `toolInput` and is shown
  // in full when the block is expanded.
  const paramSummary = React.useMemo(() => {
    if (!toolInput) return '';
    const keys = Object.keys(toolInput).slice(0, 3);
    return keys.map((k) => {
      const v = toolInput[k];
      const str = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}: ${str && str.length > 30 ? str.slice(0, 30) + '...' : str}`;
    }).join(', ');
  }, [toolInput]);

  const isLong = content.length > RESULT_COLLAPSE_THRESHOLD;
  const visibleContent = isLong && !showAll
    ? content.slice(0, RESULT_COLLAPSE_THRESHOLD)
    : content;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="my-1 rounded-md border border-border bg-muted/30">
        <CollapsibleTrigger asChild>
          <button className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left">
            <ChevronRight className={`h-3.5 w-3.5 transition-transform flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
            <Wrench className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            <Badge variant="outline" className="text-xs px-1.5 py-0 font-mono">
              {isResult ? '← ' : ''}{toolName}
            </Badge>
            {!open && paramSummary && (
              <span className="text-xs text-muted-foreground truncate">{paramSummary}</span>
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pb-3 space-y-2">
            {toolInput && (
              <pre className="text-xs font-mono bg-zinc-950 text-zinc-300 rounded p-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {JSON.stringify(toolInput, null, 2)}
              </pre>
            )}
            {content && (
              <>
                <pre className="text-xs font-mono whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground/85">
                  {visibleContent}
                  {isLong && !showAll ? '\n…' : ''}
                </pre>
                {isLong && (
                  <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="text-xs text-primary hover:underline"
                  >
                    {showAll
                      ? t('block.collapseOutput')
                      : t('block.showFullOutput', { bytes: content.length.toLocaleString() })}
                  </button>
                )}
              </>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
