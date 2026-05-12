'use client';

import React from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/i18n/provider';

interface CollapsibleThinkingProps {
  content: string;
}

// Collapsible thinking block.
export function CollapsibleThinking({ content }: CollapsibleThinkingProps) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);

  // Use the first 80 characters as preview text.
  const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border-l-2 border-amber-500 bg-muted/50 rounded-r-md">
        <CollapsibleTrigger asChild>
          <button className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors text-left">
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
            <span className="font-medium text-amber-600 dark:text-amber-400">{t('block.thinking')}</span>
            {!open && <span className="truncate text-xs">{preview}</span>}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pb-3 text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-muted-foreground">
            {content}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
