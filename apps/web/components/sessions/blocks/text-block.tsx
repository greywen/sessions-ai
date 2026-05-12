'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface TextBlockProps {
  content: string;
}

// Text blocks:markdown rendered
export function TextBlock({ content }: TextBlockProps) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none break-words [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_code]:break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
