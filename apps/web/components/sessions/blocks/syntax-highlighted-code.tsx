'use client';

import React from 'react';
import { Copy, Check } from 'lucide-react';
import { codeToHtml } from 'shiki';
import { useI18n } from '@/lib/i18n/provider';

interface SyntaxHighlightedCodeProps {
  code: string;
  language?: string;
}

// Generic code block with shiki syntax highlighting.
export function SyntaxHighlightedCode({ code, language }: SyntaxHighlightedCodeProps) {
  const { t } = useI18n();
  const [html, setHtml] = React.useState<string>('');
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const lang = language ?? 'text';

    codeToHtml(code, {
      lang,
      theme: 'github-light',
    })
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        // Fallback: if the language is unsupported, use plain text
        if (!cancelled) {
          codeToHtml(code, { lang: 'text', theme: 'github-light' })
            .then((result) => { if (!cancelled) setHtml(result); })
            .catch(() => { /* Final downgrade，Use Plain Text */ });
        }
      });

    return () => { cancelled = true; };
  }, [code, language]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group my-1 overflow-hidden rounded-md border border-border/70 bg-card">
      {/* Language Label + Copy Button */}
      <div className="flex items-center justify-between border-b border-border/70 bg-muted/35 px-3 py-1.5 text-xs text-muted-foreground">
        <span>{language ?? 'text'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 transition-colors hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>

      {/* Code Content */}
      {html ? (
        <div
          className="overflow-x-auto text-sm [&>pre]:m-0 [&>pre]:bg-transparent [&>pre]:p-4"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto bg-card p-4 text-sm text-foreground/90">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
