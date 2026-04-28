import type { UnifiedMessage, ToolType } from './types.ts';

/**
 * Incremental parse result
 *  - messages: parsed normalized messages
 *  - newOffset: latest consumed source offset
 */
export interface ParseResult {
  messages: UnifiedMessage[];
  newOffset: number;
}

/**
 * Parser interface for each source tool (OpenCode / Claude Code / Copilot).
 */
export interface ToolParser {
  toolType(): ToolType;

  /** Candidate log directories by OS/environment. */
  logPaths(): string[];

  /** Parse from offset and return parsed messages plus next offset. */
  parseIncremental(filePath: string, offset: number): Promise<ParseResult>;

  /** Watched file extensions (without dot). */
  fileExtensions(): string[];

  /** Whether parser is interested in this file path. */
  matches(filePath: string): boolean;
}
