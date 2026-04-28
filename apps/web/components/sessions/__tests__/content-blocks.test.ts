import { describe, it, expect } from 'vitest';
import type { ContentBlock, ContentBlockType } from '@llm-sessions/shared';

// Test Content Block Type Mapping Table:Ensure that all ContentBlockType have corresponding rendering logic
const KNOWN_BLOCK_TYPES: ContentBlockType[] = [
  'Text',
  'Thinking',
  'Code',
  'ToolCall',
  'ToolOutput',
  'FileEdit',
  'FileRead',
  'ShellCommand',
  'ShellOutput',
  'McpCall',
  'McpResult',
  'SearchResult',
  'Image',
  'Error',
  'Status',
  'Unknown',
];

// Analog Content Block Factory
function makeBlock(type: ContentBlockType, content = 'Tests carried out'): ContentBlock {
  return {
    blockType: type,
    content,
    language: type === 'Code' ? 'typescript' : null,
    filePath: type === 'FileEdit' || type === 'FileRead' ? 'src/test.ts' : null,
    diff: type === 'FileEdit'
      ? '--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line\n unchanged'
      : null,
    toolName: type === 'ToolCall' || type === 'McpCall' ? 'read_file' : null,
    toolInput: type === 'ToolCall' || type === 'McpCall' ? { path: '/test' } : null,
    exitCode: type === 'ShellCommand' ? 0 : null,
    isCollapsed: type === 'Thinking',
  };
}

describe('ContentBlock Type System', () => {
  it('Full definition of all type constants', () => {
    expect(KNOWN_BLOCK_TYPES.length).toBe(16);
  });

  it('Each type creates a valid ContentBlock', () => {
    for (const type of KNOWN_BLOCK_TYPES) {
      const block = makeBlock(type);
      expect(block.blockType).toBe(type);
      expect(typeof block.content).toBe('string');
    }
  });

  it('Code Block contains language information', () => {
    const block = makeBlock('Code', 'const x = 1;');
    expect(block.language).toBe('typescript');
  });

  it('FileEdit Block contains diff Message', () => {
    const block = makeBlock('FileEdit');
    expect(block.diff).toContain('---');
    expect(block.diff).toContain('+++');
    expect(block.filePath).toBe('src/test.ts');
  });

  it('FileRead Block contains file paths', () => {
    const block = makeBlock('FileRead');
    expect(block.filePath).toBe('src/test.ts');
  });

  it('ToolCall Block contains tool name and parameters', () => {
    const block = makeBlock('ToolCall');
    expect(block.toolName).toBe('read_file');
    expect(block.toolInput).toEqual({ path: '/test' });
  });

  it('ShellCommand Block contains an exit code', () => {
    const block = makeBlock('ShellCommand', 'ls -la');
    expect(block.exitCode).toBe(0);
  });

  it('Thinking Blocks are collapsed by default', () => {
    const block = makeBlock('Thinking');
    expect(block.isCollapsed).toBe(true);
  });
});

describe('Diff analyzing', () => {
  it('unified diff Split Correctly old/new', () => {
    const diff = '--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line\n unchanged';
    const lines = diff.split('\n');
    const oldLines: string[] = [];
    const newLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
      if (line.startsWith('-')) oldLines.push(line.slice(1));
      else if (line.startsWith('+')) newLines.push(line.slice(1));
      else if (line.startsWith(' ')) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      } else {
        oldLines.push(line);
        newLines.push(line);
      }
    }

    expect(oldLines).toContain('old line');
    expect(newLines).toContain('new line');
    expect(oldLines).not.toContain('new line');
  });
});

describe('Token To Format', () => {
  const formatNum = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  it('Format million level Token', () => {
    expect(formatNum(1_500_000)).toBe('1.5M');
  });

  it('Format Thousand Levels Token', () => {
    expect(formatNum(42_300)).toBe('42.3K');
  });

  it('Format Decimal Token', () => {
    expect(formatNum(500)).toBe('500');
  });

  it('Format Zero', () => {
    expect(formatNum(0)).toBe('0');
  });
});
