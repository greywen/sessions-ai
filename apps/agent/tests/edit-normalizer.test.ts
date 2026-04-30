import { describe, expect, test } from 'bun:test';
import {
  diffFromOldNew,
  diffFromHunks,
  extractPathFromToolInput,
  parseApplyPatch,
  buildFileEditBlock,
} from '../src/parser/edit-normalizer.ts';

describe('edit-normalizer / diffFromOldNew', () => {
  test('returns null when both sides empty or identical', () => {
    expect(diffFromOldNew('a.ts', '', '')).toBeNull();
    expect(diffFromOldNew('a.ts', 'same', 'same')).toBeNull();
  });

  test('produces unified diff for replacement', () => {
    const d = diffFromOldNew('src/a.ts', 'foo', 'bar');
    expect(d).toContain('--- a/src/a.ts');
    expect(d).toContain('+++ b/src/a.ts');
    expect(d).toContain('-foo');
    expect(d).toContain('+bar');
  });

  test('handles multi-line old/new', () => {
    const d = diffFromOldNew('x.md', 'l1\nl2', 'r1\nr2\nr3');
    expect(d).toContain('-l1');
    expect(d).toContain('-l2');
    expect(d).toContain('+r1');
    expect(d).toContain('+r2');
    expect(d).toContain('+r3');
  });

  test('handles create (empty old)', () => {
    const d = diffFromOldNew('new.txt', '', 'hello');
    expect(d).toContain('--- a/new.txt');
    expect(d).toContain('+hello');
  });
});

describe('edit-normalizer / extractPathFromToolInput', () => {
  test('reads common keys', () => {
    expect(extractPathFromToolInput({ file_path: '/a/b' })).toBe('/a/b');
    expect(extractPathFromToolInput({ filePath: '/a/c' })).toBe('/a/c');
    expect(extractPathFromToolInput({ path: '/a/d' })).toBe('/a/d');
    expect(extractPathFromToolInput({ uri: 'file:///x' })).toBe('file:///x');
    expect(extractPathFromToolInput({ target_file: 'rel.ts' })).toBe('rel.ts');
  });

  test('returns null on missing / non-object', () => {
    expect(extractPathFromToolInput(null)).toBeNull();
    expect(extractPathFromToolInput('plain')).toBeNull();
    expect(extractPathFromToolInput({ other: 'x' })).toBeNull();
  });
});

describe('edit-normalizer / parseApplyPatch', () => {
  test('parses Add File section', () => {
    const text = [
      '*** Begin Patch',
      '*** Add File: pkg/a.ts',
      '+export const a = 1;',
      '+export const b = 2;',
      '*** End Patch',
    ].join('\n');
    const out = parseApplyPatch(text);
    expect(out).toHaveLength(1);
    expect(out[0].filePath).toBe('pkg/a.ts');
    expect(out[0].meta.operation).toBe('create');
    expect(out[0].newString).toBe('export const a = 1;\nexport const b = 2;');
    expect(out[0].diff).toContain('+export const a = 1;');
  });

  test('parses Update File with hunks', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: src/x.ts',
      '@@',
      '-old line',
      '+new line',
      '*** End Patch',
    ].join('\n');
    const out = parseApplyPatch(text);
    expect(out).toHaveLength(1);
    expect(out[0].meta.operation).toBe('update');
    expect(out[0].diff).toContain('-old line');
    expect(out[0].diff).toContain('+new line');
  });

  test('parses Delete File', () => {
    const out = parseApplyPatch('*** Begin Patch\n*** Delete File: rm.ts\n*** End Patch');
    expect(out).toHaveLength(1);
    expect(out[0].meta.operation).toBe('delete');
    expect(out[0].filePath).toBe('rm.ts');
    expect(out[0].diff).toBeNull();
  });

  test('parses Move to as rename', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: old/path.ts',
      '*** Move to: new/path.ts',
      '@@',
      '-x',
      '+y',
      '*** End Patch',
    ].join('\n');
    const out = parseApplyPatch(text);
    expect(out).toHaveLength(1);
    expect(out[0].meta.operation).toBe('rename');
    expect(out[0].meta.oldPath).toBe('old/path.ts');
    expect(out[0].filePath).toBe('new/path.ts');
  });

  test('parses multiple sections', () => {
    const text = [
      '*** Begin Patch',
      '*** Add File: a.ts',
      '+a',
      '*** Update File: b.ts',
      '@@',
      '-x',
      '+y',
      '*** Delete File: c.ts',
      '*** End Patch',
    ].join('\n');
    const out = parseApplyPatch(text);
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.meta.operation)).toEqual(['create', 'update', 'delete']);
  });

  test('returns [] on empty input', () => {
    expect(parseApplyPatch('')).toEqual([]);
  });
});

describe('edit-normalizer / diffFromHunks', () => {
  test('combines multiple hunks for same file', () => {
    const d = diffFromHunks('m.ts', [
      { oldString: 'a', newString: 'A' },
      { oldString: 'b', newString: 'B' },
    ]);
    expect(d).toContain('--- a/m.ts');
    expect(d).toContain('-a');
    expect(d).toContain('+A');
    expect(d).toContain('-b');
    expect(d).toContain('+B');
  });
});

describe('edit-normalizer / buildFileEditBlock', () => {
  test('produces a FileEdit block carrying meta', () => {
    const block = buildFileEditBlock(
      {
        filePath: 'x.ts',
        diff: '--- a/x.ts\n+++ b/x.ts\n-1\n+2',
        summary: 'Edited x.ts',
        oldString: '1',
        newString: '2',
        meta: { operation: 'update', status: 'applied', oldPath: null },
      },
      { toolName: 'Edit', toolInput: { file_path: 'x.ts' }, cwd: '/repo', gitBranch: 'main' },
    );
    expect(block.blockType).toBe('FileEdit');
    expect(block.filePath).toBe('x.ts');
    expect(block.diff).toContain('+2');
    expect(block.toolName).toBe('Edit');
    const meta = (block.toolInput as Record<string, unknown>).editMeta as Record<string, unknown>;
    expect(meta.operation).toBe('update');
    expect(meta.status).toBe('applied');
    expect(meta.cwd).toBe('/repo');
    expect(meta.gitBranch).toBe('main');
  });
});
