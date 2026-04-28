'use client';

import React from 'react';
import { File } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface FileReadSummaryProps {
  filePath: string;
}

// File Read Summary:Show only the filename Badge
export function FileReadSummary({ filePath }: FileReadSummaryProps) {
  // Extract File Names
  const fileName = filePath.split('/').pop() ?? filePath;

  return (
    <div className="inline-flex items-center gap-1.5 my-0.5">
      <Badge variant="outline" className="bg-muted text-xs font-mono gap-1 px-2 py-0.5">
        <File className="h-3 w-3" />
        {fileName}
      </Badge>
    </div>
  );
}
