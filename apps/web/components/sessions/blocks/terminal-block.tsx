'use client';

import React from 'react';
import { Terminal, ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/i18n/provider';

interface TerminalBlockProps {
  command: string | null;
  output: string | null;
  exitCode: number | null;
}

// Terminal block: dark background + green text (command + output).
export function TerminalBlock({ command, output, exitCode }: TerminalBlockProps) {
  const { t } = useI18n();
  const outputLines = output?.split('\n') ?? [];
  const shouldCollapse = outputLines.length > 10;
  const [open, setOpen] = React.useState(!shouldCollapse);

  return (
    <div className="my-1 overflow-hidden rounded-md border border-border/70 bg-card">
      {/* CLI */}
      {command && (
        <div className="flex items-start gap-2 px-3 py-2 font-mono text-sm">
          <Terminal className="h-3.5 w-3.5 shrink-0 text-emerald-600 mt-0.5" />
          <span className="text-emerald-700 mt-0.5">$</span>
          <span className="text-foreground break-all">{command}</span>
          {exitCode != null && exitCode !== 0 && (
            <span className="ml-auto shrink-0 text-xs text-red-600 mt-0.5">[exit {exitCode}]</span>
          )}
        </div>
      )}

      {/* Output */}
      {output && (
        <>
          {shouldCollapse ? (
            <Collapsible open={open} onOpenChange={setOpen}>
              <CollapsibleTrigger asChild>
                <button className="flex w-full items-center gap-1.5 border-t border-border/70 px-3 py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
                  <ChevronRight className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />
                  <span>{t('block.terminalOutput', { count: outputLines.length })}</span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] px-3 pb-2 font-mono text-xs text-foreground/80">
                  {output}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] border-t border-border/70 px-3 pb-2 pt-2 font-mono text-xs text-foreground/80">
              {output}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
