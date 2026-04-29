/**
 * Build a publishable npm package at `apps/agent/publish-pkg/`.
 *
 * Strategy:
 *   - Bundle Agent + `@sessions-ai/shared` + service installer + supervisor
 *     into a single `dist/cli.js` with `bun build` (target=bun), so the
 *     published package does not depend on the workspace `shared` package
 *     and ships every CLI subcommand in one bundle.
 *   - Externalize heavy npm dependencies (chokidar, pino, pino-pretty,
 *     node-machine-id) — they remain regular `dependencies` in the
 *     published `package.json`.
 *   - Emit a tiny `bin/sessions-ai.js` shim with a `bun` shebang so
 *     `npm i -g sessions-ai` produces a working `sessions-ai` command.
 *
 * Usage:
 *   bun run scripts/build-publish.ts
 *   cd publish-pkg && npm publish --access public
 */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  rmSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(here, '..');
const monorepoRoot = resolve(agentDir, '..', '..');
const out = resolve(agentDir, 'publish-pkg');

rmSync(join(out, 'dist'), { recursive: true, force: true });
rmSync(join(out, 'bin'), { recursive: true, force: true });
rmSync(join(out, 'package.json'), { force: true });
rmSync(join(out, 'README.md'), { force: true });
mkdirSync(join(out, 'dist'), { recursive: true });
mkdirSync(join(out, 'bin'), { recursive: true });

const externals = ['chokidar', 'pino', 'pino-pretty', 'node-machine-id'];

console.log('📦 Bundling agent CLI (bun build) ...');
const buildArgs = [
  'build',
  join(agentDir, 'src/cli.ts'),
  '--target=bun',
  `--outfile=${join(out, 'dist/cli.js')}`,
  ...externals.flatMap((e) => ['--external', e]),
];
const buildResult = spawnSync('bun', buildArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
if (buildResult.status !== 0) {
  console.error('❌ bun build failed');
  process.exit(buildResult.status ?? 1);
}

console.log('✏️  Writing bin/sessions-ai.js ...');
const binPath = join(out, 'bin', 'sessions-ai.js');
writeFileSync(binPath, `#!/usr/bin/env bun\nimport '../dist/cli.js';\n`);
try {
  chmodSync(binPath, 0o755);
} catch {
  // chmod may fail on Windows; npm preserves +x via package.json `bin` anyway
}

console.log('✏️  Writing package.json ...');
const agentPkg = JSON.parse(readFileSync(join(agentDir, 'package.json'), 'utf8')) as {
  version: string;
  dependencies: Record<string, string>;
};
const publishPkg = {
  name: 'sessions-ai',
  version: agentPkg.version,
  description:
    'sessions-ai Agent — local LLM session collector for tools like GitHub Copilot Chat, OpenCode, Codex, Cursor and Qwen Code (Bun runtime).',
  type: 'module',
  bin: { 'sessions-ai': 'bin/sessions-ai.js' },
  files: ['dist', 'bin', 'README.md'],
  engines: { bun: '>=1.3.0' },
  dependencies: Object.fromEntries(
    externals.map((name) => [name, agentPkg.dependencies[name]]).filter(([, v]) => Boolean(v)),
  ),
  repository: { type: 'git', url: 'git+https://github.com/greywen/sessions-ai.git' },
  homepage: 'https://github.com/greywen/sessions-ai',
  bugs: { url: 'https://github.com/greywen/sessions-ai/issues' },
  keywords: ['llm', 'session', 'audit', 'copilot', 'opencode', 'codex', 'cursor', 'agent'],
  license: 'MIT',
};
writeFileSync(join(out, 'package.json'), JSON.stringify(publishPkg, null, 2) + '\n');

const dedicatedReadme = join(agentDir, 'NPM_README.md');
const fallbackReadme = join(monorepoRoot, 'README.md');
const targetReadme = join(out, 'README.md');
if (existsSync(dedicatedReadme)) {
  copyFileSync(dedicatedReadme, targetReadme);
} else if (existsSync(fallbackReadme)) {
  copyFileSync(fallbackReadme, targetReadme);
}

console.log('✅ publish-pkg ready at', out);
console.log('   Next steps:');
console.log('     cd', out);
console.log('     npm publish --access public');
