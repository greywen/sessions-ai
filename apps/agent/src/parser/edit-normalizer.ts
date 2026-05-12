/**
 * edit-normalizer.ts
 *
 * Shared helpers for converting tool inputs from Claude Code, Codex, and
 * GitHub Copilot into a unified `FileEdit` ContentBlock.
 *
 * Three platforms expose file edits in different shapes:
 *
 * - Claude Code:   `Edit` / `MultiEdit` / `Write` tool_use entries with
 *                  `file_path`, `old_string`, `new_string`, `content`,
 *                  `edits[]`.
 * - Codex CLI:     `apply_patch` function_call whose `arguments.input` is
 *                  an envelope containing `*** Add File`, `*** Update File`,
 *                  `*** Delete File`, `*** Move to`, with `@@` hunks.
 * - GitHub Copilot:`textEditGroup` / `workspaceEdit` response parts holding
 *                  TextEdit ranges (often with no `oldText`).
 *
 * The normalizer intentionally stays dependency-free and only emits
 * structures defined in `./types.ts`. When old text is missing we still
 * emit a FileEdit, but `diff` is set to `null` (UI falls back to showing
 * the new content / message).
 */

import type { ContentBlock } from './types.ts';

export type FileEditOperation = 'create' | 'update' | 'delete' | 'rename' | 'unknown';
export type FileEditStatus = 'proposed' | 'applied' | 'failed' | 'unknown';

export interface FileEditMeta {
  operation: FileEditOperation;
  status: FileEditStatus;
  oldPath: string | null;
  cwd?: string | null;
  gitBranch?: string | null;
}

export interface NormalizedFileEdit {
  filePath: string;
  diff: string | null;
  /** Human-readable summary for the block content. */
  summary: string;
  /** Original old text snippet, when available. */
  oldString: string | null;
  /** Original new text snippet, when available. */
  newString: string | null;
  meta: FileEditMeta;
  /** Raw tool input fragment for traceability. */
  raw?: unknown;
}

export interface BuildBlockOptions {
  toolName: string;
  /** Optional original tool input to keep alongside in `toolInput`. */
  toolInput?: Record<string, unknown> | null;
  /** Optional shared cwd / git branch to record on every produced block. */
  cwd?: string | null;
  gitBranch?: string | null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function ensureTrailingNewline(s: string): string {
  return s.length === 0 || s.endsWith('\n') ? s : `${s}\n`;
}

/**
 * Build a minimal unified-diff string. We do not run an LCS — for the
 * `oldString -> newString` snippet pattern that Claude/Codex use, dumping
 * the whole `-old / +new` pair is both lossless and what the existing
 * `<DiffViewer>` component already renders correctly (it strips `---`/`+++`
 * and `@@` headers and reconstructs old/new sides from `-` / `+` prefixes).
 */
export function diffFromOldNew(
  filePath: string,
  oldString: string | null | undefined,
  newString: string | null | undefined,
): string | null {
  const oldText = isString(oldString) ? oldString : '';
  const newText = isString(newString) ? newString : '';
  if (!oldText && !newText) return null;
  if (oldText === newText) return null;

  const oldLines = oldText.length > 0 ? ensureTrailingNewline(oldText).split('\n') : [];
  const newLines = newText.length > 0 ? ensureTrailingNewline(newText).split('\n') : [];
  // Drop trailing empty caused by ensureTrailingNewline split.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();

  const header = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];
  const body: string[] = [];
  for (const l of oldLines) body.push(`-${l}`);
  for (const l of newLines) body.push(`+${l}`);
  return [...header, ...body].join('\n');
}

/**
 * Concatenate multiple `oldString -> newString` edits for a single file
 * into one diff body. Used by Claude `MultiEdit` and Codex multi-hunk
 * `Update File` patches.
 */
export function diffFromHunks(
  filePath: string,
  hunks: Array<{ oldString: string; newString: string }>,
): string | null {
  if (hunks.length === 0) return null;
  if (hunks.length === 1) {
    return diffFromOldNew(filePath, hunks[0].oldString, hunks[0].newString);
  }
  const sections: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const h of hunks) {
    const oldLines = h.oldString.length > 0 ? h.oldString.split('\n') : [];
    const newLines = h.newString.length > 0 ? h.newString.split('\n') : [];
    sections.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);
    for (const l of oldLines) sections.push(`-${l}`);
    for (const l of newLines) sections.push(`+${l}`);
  }
  return sections.join('\n');
}

/**
 * Attempt to extract a single file path from common tool-input shapes.
 * Recognised keys: `file_path`, `filePath`, `path`, `uri`, `target_file`.
 */
export function extractPathFromToolInput(input: unknown): string | null {
  const obj = asObject(input);
  if (!obj) return null;
  const candidates = ['file_path', 'filePath', 'path', 'uri', 'target_file'];
  for (const key of candidates) {
    const v = obj[key];
    if (isString(v) && v.length > 0) return v;
  }
  return null;
}

interface ParsedPatchSection {
  operation: FileEditOperation;
  filePath: string;
  oldPath: string | null;
  hunks: Array<{ oldString: string; newString: string }>;
  /** Whole file body for `Add File` (collected as `+` lines). */
  addedBody: string | null;
}

/**
 * Parse Codex's `apply_patch` envelope. The wire format is:
 *
 *   *** Begin Patch
 *   *** Add File: path/to/new
 *   +contents...
 *   *** Update File: path/to/existing
 *   *** Move to: new/path
 *   @@ optional context
 *   -old line
 *   +new line
 *   *** Delete File: path/to/remove
 *   *** End Patch
 *
 * Returns one `NormalizedFileEdit` per file section. Status defaults to
 * `proposed`; callers should override with `applied`/`failed` once the
 * matching `patch_apply_end` event is observed.
 */
export function parseApplyPatch(patchText: string): NormalizedFileEdit[] {
  if (!isString(patchText) || patchText.length === 0) return [];
  const lines = patchText.replace(/\r\n/g, '\n').split('\n');
  const sections: ParsedPatchSection[] = [];
  let current: ParsedPatchSection | null = null;
  let pendingOld: string[] = [];
  let pendingNew: string[] = [];

  const flushHunk = () => {
    if (!current) return;
    if (pendingOld.length === 0 && pendingNew.length === 0) return;
    current.hunks.push({
      oldString: pendingOld.join('\n'),
      newString: pendingNew.join('\n'),
    });
    pendingOld = [];
    pendingNew = [];
  };

  const flushSection = () => {
    flushHunk();
    if (current) sections.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine;
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) {
      flushSection();
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      flushSection();
      current = {
        operation: 'create',
        filePath: line.slice('*** Add File: '.length).trim(),
        oldPath: null,
        hunks: [],
        addedBody: '',
      };
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      flushSection();
      current = {
        operation: 'update',
        filePath: line.slice('*** Update File: '.length).trim(),
        oldPath: null,
        hunks: [],
        addedBody: null,
      };
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      flushSection();
      current = {
        operation: 'delete',
        filePath: line.slice('*** Delete File: '.length).trim(),
        oldPath: null,
        hunks: [],
        addedBody: null,
      };
      continue;
    }
    if (line.startsWith('*** Move to: ')) {
      if (current) {
        current.oldPath = current.filePath;
        current.filePath = line.slice('*** Move to: '.length).trim();
        current.operation = current.operation === 'update' ? 'rename' : current.operation;
      }
      continue;
    }
    if (line.startsWith('@@')) {
      flushHunk();
      continue;
    }

    if (!current) continue;

    if (current.operation === 'create') {
      // Collect everything as the new file body, accept '+' prefix or raw.
      const text = line.startsWith('+') ? line.slice(1) : line;
      current.addedBody = (current.addedBody ?? '') + (current.addedBody ? '\n' : '') + text;
      continue;
    }

    if (line.startsWith('+')) {
      pendingNew.push(line.slice(1));
    } else if (line.startsWith('-')) {
      pendingOld.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      // Context line: emit the preceding hunk so context separates them.
      if (pendingOld.length > 0 || pendingNew.length > 0) flushHunk();
      // We don't keep context lines — diff renderer doesn't need them
      // because we synthesize fake hunk headers anyway.
    }
  }
  flushSection();

  return sections.map((s) => normaliseSection(s));
}

function normaliseSection(s: ParsedPatchSection): NormalizedFileEdit {
  if (s.operation === 'create') {
    const body = s.addedBody ?? '';
    return {
      filePath: s.filePath,
      diff: diffFromOldNew(s.filePath, '', body),
      summary: `Created ${s.filePath}`,
      oldString: '',
      newString: body,
      meta: {
        operation: 'create',
        status: 'proposed',
        oldPath: null,
      },
    };
  }
  if (s.operation === 'delete') {
    return {
      filePath: s.filePath,
      diff: null,
      summary: `Deleted ${s.filePath}`,
      oldString: null,
      newString: null,
      meta: {
        operation: 'delete',
        status: 'proposed',
        oldPath: null,
      },
    };
  }
  if (s.operation === 'rename') {
    return {
      filePath: s.filePath,
      diff: s.hunks.length > 0 ? diffFromHunks(s.filePath, s.hunks) : null,
      summary: s.oldPath ? `Renamed ${s.oldPath} → ${s.filePath}` : `Renamed to ${s.filePath}`,
      oldString: null,
      newString: null,
      meta: {
        operation: 'rename',
        status: 'proposed',
        oldPath: s.oldPath,
      },
    };
  }
  // update
  const diff = diffFromHunks(s.filePath, s.hunks);
  return {
    filePath: s.filePath,
    diff,
    summary: `Edited ${s.filePath}`,
    oldString: s.hunks.map((h) => h.oldString).join('\n') || null,
    newString: s.hunks.map((h) => h.newString).join('\n') || null,
    meta: {
      operation: 'update',
      status: 'proposed',
      oldPath: null,
    },
  };
}

/**
 * Produce a `FileEdit` ContentBlock from a normalized edit.
 *
 * The block carries:
 *   - `filePath` / `diff` for the existing DiffViewer.
 *   - `toolInput` keeps the raw tool input plus an `editMeta` dictionary
 *     so downstream consumers (and future migrations) can recover the
 *     operation/status/oldPath without reparsing.
 */
export function buildFileEditBlock(
  edit: NormalizedFileEdit,
  opts: BuildBlockOptions,
): ContentBlock {
  const editMeta: FileEditMeta = {
    ...edit.meta,
    cwd: opts.cwd ?? edit.meta.cwd ?? null,
    gitBranch: opts.gitBranch ?? edit.meta.gitBranch ?? null,
  };
  const toolInput: Record<string, unknown> = {
    ...(opts.toolInput ?? {}),
    editMeta,
  };
  if (edit.raw !== undefined) toolInput.editRaw = edit.raw;
  return {
    blockType: 'FileEdit',
    content: edit.summary,
    language: null,
    filePath: edit.filePath,
    diff: edit.diff,
    toolName: opts.toolName,
    toolInput,
    exitCode: null,
    isCollapsed: false,
  };
}
