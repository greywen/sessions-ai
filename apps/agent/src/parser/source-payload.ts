import type { SourcePayload } from '@sessions-ai/shared';

export interface SourcePayloadOptions {
  format: string;
  sourcePath?: string | null;
  sourceFile?: string | null;
  sourceSessionId?: string | null;
  sourceMessageId?: string | null;
  records?: unknown[];
  extra?: Record<string, unknown>;
}

export function sourcePayload(opts: SourcePayloadOptions): SourcePayload {
  return {
    formatVersion: 1,
    format: opts.format,
    ...(opts.sourcePath ? { sourcePath: opts.sourcePath } : {}),
    ...(opts.sourceFile ? { sourceFile: opts.sourceFile } : {}),
    ...(opts.sourceSessionId ? { sourceSessionId: opts.sourceSessionId } : {}),
    ...(opts.sourceMessageId ? { sourceMessageId: opts.sourceMessageId } : {}),
    records: opts.records ?? [],
    ...(opts.extra ?? {}),
  };
}
