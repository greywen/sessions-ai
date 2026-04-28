'use client';

import React from 'react';
import { ChevronRight, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface McpCallBlockProps {
  toolName: string;
  toolInput: Record<string, unknown> | null;
  content: string;
  isResult?: boolean;
}

// MCP/Tool Call Block:Tool name + Parameter Summary,Expandable
export function McpCallBlock({ toolName, toolInput, content, isResult }: McpCallBlockProps) {
  const [open, setOpen] = React.useState(false);

  // Parameter Summary:Withdrawal 3 Pcs key
  const paramSummary = React.useMemo(() => {
    if (!toolInput) return '';
    const keys = Object.keys(toolInput).slice(0, 3);
    return keys.map((k) => {
      const v = toolInput[k];
      const str = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}: ${str && str.length > 30 ? str.slice(0, 30) + '...' : str}`;
    }).join(', ');
  }, [toolInput]);

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
              <pre className="text-xs font-mono bg-zinc-950 text-zinc-300 rounded p-2 overflow-x-auto">
                {JSON.stringify(toolInput, null, 2)}
              </pre>
            )}
            {content && (
              <div className="text-sm text-muted-foreground whitespace-pre-wrap">
                {content.length > 500 ? content.slice(0, 500) + '...' : content}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
