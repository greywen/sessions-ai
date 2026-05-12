'use client';

import React from 'react';
import { ChevronRight, File } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface FileReadSummaryProps {
  filePath: string;
  // Optional file body. Some parsers (Claude Code, OpenCode) include the
  // full content of the read; we MUST surface it so the archive isn't
  // silently lossy.
  content?: string | null;
}

// File-read block. Always shows the file path; if the parser captured
// the file body, it is collapsible and rendered IN FULL on expand.
export function FileReadSummary({ filePath, content }: FileReadSummaryProps) {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  const hasContent = typeof content === 'string' && content.length > 0 && content !== filePath;
  const [open, setOpen] = React.useState(false);

  if (!hasContent) {
    return (
      <div className="inline-flex items-center gap-1.5 my-0.5">
        <Badge variant="outline" className="bg-muted text-xs font-mono gap-1 px-2 py-0.5">
          <File className="h-3 w-3" />
          {fileName}
        </Badge>
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="my-1 rounded-md border border-border bg-muted/30">
        <CollapsibleTrigger asChild>
          <button className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-muted/50 text-left">
            <ChevronRight className={`h-3.5 w-3.5 transition-transform flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
            <File className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            <span className="font-mono text-xs truncate" title={filePath}>{filePath}</span>
            <span className="ml-auto text-xs text-muted-foreground flex-shrink-0">
              {content.length.toLocaleString()} B
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="px-3 pb-3 text-xs font-mono whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground/85">
            {content}
          </pre>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
