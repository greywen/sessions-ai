'use client';

import React from 'react';
import type { ContentBlock } from '@sessions-ai/shared';
import { TextBlock } from './blocks/text-block';
import { CollapsibleThinking } from './blocks/collapsible-thinking';
import { SyntaxHighlightedCode } from './blocks/syntax-highlighted-code';
import { DiffViewer } from './blocks/diff-viewer';
import { FileReadSummary } from './blocks/file-read-summary';
import { TerminalBlock } from './blocks/terminal-block';
import { McpCallBlock } from './blocks/mcp-call-block';
import { ErrorAlert } from './blocks/error-alert';
import { useI18n } from '@/lib/i18n/provider';

interface ContentBlockRendererProps {
  block: ContentBlock;
}

// Content block rendering router.
export function ContentBlockRenderer({ block }: ContentBlockRendererProps) {
  const { t } = useI18n();
  switch (block.blockType) {
    case 'Text':
      return <TextBlock content={block.content} />;

    case 'Thinking':
      return <CollapsibleThinking content={block.content} />;

    case 'Code':
      return (
        <SyntaxHighlightedCode
          code={block.content}
          language={block.language ?? undefined}
        />
      );

    case 'FileEdit':
      return (
        <DiffViewer
          filePath={block.filePath ?? undefined}
          diff={block.diff ?? block.content}
        />
      );

    case 'FileRead':
      return <FileReadSummary filePath={block.filePath ?? block.content} />;

    case 'ShellCommand':
      return (
        <TerminalBlock
          command={block.content}
          output={null}
          exitCode={block.exitCode}
        />
      );

    case 'ShellOutput':
      return (
        <TerminalBlock
          command={null}
          output={block.content}
          exitCode={block.exitCode}
        />
      );

    case 'ToolCall':
    case 'McpCall':
      return (
        <McpCallBlock
          toolName={block.toolName ?? t('block.unknownTool')}
          toolInput={block.toolInput}
          content={block.content}
        />
      );

    case 'ToolOutput':
    case 'McpResult':
      return (
        <McpCallBlock
          toolName={block.toolName ?? t('block.toolResult')}
          toolInput={null}
          content={block.content}
          isResult
        />
      );

    case 'Error':
      return <ErrorAlert message={block.content} />;

    case 'SearchResult':
      return (
        <div className="text-sm bg-muted/50 rounded-md p-3">
          <span className="text-muted-foreground font-medium">🔍 {t('block.searchResults')}</span>
          <p className="mt-1 whitespace-pre-wrap">{block.content}</p>
        </div>
      );

    case 'Image':
      return (
        <div className="my-2">
          <img
            src={block.content}
            alt={t('block.imageAlt')}
            className="max-w-full max-h-[400px] rounded-md object-contain"
          />
        </div>
      );

    case 'Status':
      return (
        <div className="text-xs text-muted-foreground italic">
          {block.content}
        </div>
      );

    case 'Unknown':
    default:
      console.warn(`[ContentBlock] Unknown block_type: ${block.blockType}`);
      return (
        <div className="text-sm bg-muted/30 rounded p-2 text-muted-foreground">
          <span className="font-mono text-xs">[{block.blockType}]</span> {block.content}
        </div>
      );
  }
}
