'use client';

import React from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { FileEdit } from 'lucide-react';

interface DiffViewerProps {
  filePath?: string;
  diff: string;
}

// File edit diff viewer
export function DiffViewer({ filePath, diff }: DiffViewerProps) {
  // Try to parse unified diff are old/new Contents
  const { oldValue, newValue } = React.useMemo(() => {
    // Simple Insights unified diff
    const lines = diff.split('\n');
    const oldLines: string[] = [];
    const newLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) {
        continue;
      }
      if (line.startsWith('-')) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith('+')) {
        newLines.push(line.slice(1));
      } else if (line.startsWith(' ')) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      } else {
        // No Prefix Row,Treat as Context
        oldLines.push(line);
        newLines.push(line);
      }
    }

    // If the resolution is empty,Back to original display
    if (oldLines.length === 0 && newLines.length === 0) {
      return { oldValue: diff, newValue: diff };
    }

    return { oldValue: oldLines.join('\n'), newValue: newLines.join('\n') };
  }, [diff]);

  return (
    <div className="my-1 rounded-md overflow-hidden border border-border">
      {/* File name header */}
      {filePath && (
        <div className="flex items-center gap-2 bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          <FileEdit className="h-3 w-3" />
          <span className="font-mono">{filePath}</span>
        </div>
      )}
      <div className="text-xs overflow-x-auto">
        <ReactDiffViewer
          oldValue={oldValue}
          newValue={newValue}
          splitView={false}
          compareMethod={DiffMethod.WORDS}
          useDarkTheme={false}
          styles={{
            contentText: { fontSize: '12px', lineHeight: '1.5' },
            variables: {
              light: {
                diffViewerBackground: '#f7f4ed',
                addedBackground: 'rgba(47,125,97,0.12)',
                removedBackground: 'rgba(217,119,6,0.12)',
                codeFoldBackground: 'rgba(28,28,28,0.04)',
                gutterBackground: 'rgba(28,28,28,0.03)',
                gutterBackgroundDark: 'rgba(28,28,28,0.03)',
                highlightBackground: 'rgba(56,108,140,0.14)',
                highlightGutterBackground: 'rgba(56,108,140,0.14)',
              },
            },
          }}
        />
      </div>
    </div>
  );
}
