import chokidar, { type FSWatcher } from 'chokidar';
import { existsSync } from 'node:fs';

import { logger } from '../logger.ts';

export type FileChangeKind = 'created' | 'modified' | 'removed';

export interface FileChangeEvent {
  path: string;
  kind: FileChangeKind;
}

export interface WatchPath {
  path: string;
  /** File extensions to watch (without dot). Empty means all files. */
  extensions: string[];
  toolName: string;
}

export type EventHandler = (ev: FileChangeEvent) => void | Promise<void>;

/**
 * File watcher wrapper based on chokidar.
 * - Missing directories are logged as warnings.
 * - Watcher fires on raw fs events; partial-write tolerance lives in the
 *   per-parser incremental readers, not in chokidar's awaitWriteFinish.
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;

  constructor(private readonly paths: WatchPath[]) {}

  start(handler: EventHandler): void {
    const validPaths = this.paths.filter((p) => {
      if (existsSync(p.path)) return true;
      logger.warn({ path: p.path, tool: p.toolName }, 'Watch path does not exist (will be picked up after agent restart)');
      return false;
    });

    if (validPaths.length === 0) {
      logger.warn('No valid watch paths found');
      return;
    }

    const targets = validPaths.map((p) => p.path);

    const matchExt = (filePath: string): boolean => {
      const wp = validPaths.find((p) => filePath.startsWith(p.path));
      if (!wp) return false;
      if (wp.extensions.length === 0) return true;
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      return wp.extensions.includes(ext);
    };

    /**
     * Ignore irrelevant files directly at the chokidar layer (critical guardrail).
     *
     * Background: VS Code workspaceStorage contains many temporary SQLite files
     * (`state.vscdb-journal`, `-wal`, `-shm`, etc.). These files are often held
     * with active write handles by VS Code, and direct fs.watch calls in Node/Bun
     * can throw EPERM. Under Bun, internal chokidar errors may even trigger a
     * segfault and terminate the process.
     * Therefore these files must be filtered out before chokidar starts watching.
     *
     * Note: the ignore function must return false for **directories** (do not
     * ignore), otherwise recursion gets pruned and target files may never be found.
     */
    const ignoreFn = (testPath: string, stats?: { isDirectory(): boolean; isFile(): boolean }): boolean => {
      // Directory: ignore only when no watch path is under it or is its ancestor.
      if (stats?.isDirectory()) {
        const isCandidate = validPaths.some(
          (p) => p.path === testPath || testPath.startsWith(p.path + '\\') ||
                 testPath.startsWith(p.path + '/') || p.path.startsWith(testPath + '\\') ||
                 p.path.startsWith(testPath + '/'),
        );
        return !isCandidate;
      }
      // File: ignore immediately when extension does not match.
      if (stats?.isFile()) return !matchExt(testPath);
      // No stats (initial matching phase): use extension as a fast-path check.
      const base = testPath.split(/[\\/]/).pop() ?? '';
      const dotIdx = base.lastIndexOf('.');
      if (dotIdx <= 0) return false; // Treat as dir/no-extension and defer to chokidar.
      return !matchExt(testPath);
    };

    // awaitWriteFinish is intentionally OFF.
    // Why: Claude Code's VS Code extension streams assistant output token-by-token
    // into the same .jsonl, so the file is never "stable" mid-response and a
    // stability-window debounce delays sync until the turn ends. Parsers here
    // are byte-offset incremental and tolerate partial trailing lines, so
    // raw change events are safe and far more timely.
    this.watcher = chokidar.watch(targets, {
      ignoreInitial: true,
      persistent: true,
      ignored: ignoreFn,
      ignorePermissionErrors: true,
    });

    this.watcher.on('error', (err) => {
      // Single-file watch failures should not crash the process.
      logger.warn({ err: String(err) }, 'Watcher error (suppressed)');
    });

    const dispatch = (kind: FileChangeKind) => async (filePath: string) => {
      if (!matchExt(filePath)) return;
      logger.debug({ path: filePath, kind }, 'File change event');
      try {
        await handler({ path: filePath, kind });
      } catch (err) {
        logger.error({ err: String(err), path: filePath }, 'File event handler failed');
      }
    };

    this.watcher.on('add', dispatch('created'));
    this.watcher.on('change', dispatch('modified'));
    this.watcher.on('unlink', dispatch('removed'));

    for (const wp of validPaths) {
      logger.info({ path: wp.path, tool: wp.toolName }, 'Watching path');
    }
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }
}
