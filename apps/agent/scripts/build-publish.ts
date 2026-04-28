/**
 * Build a publishable npm package at `apps/agent/publish-pkg/`.
 *
 * Strategy:
 *   - Bundle Agent + `@sessions-ai/shared` into a single `dist/main.js`
 *     with `bun build` (target=bun), so the published package does not
 *     depend on the workspace `shared` package.
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

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'dist'), { recursive: true });
mkdirSync(join(out, 'bin'), { recursive: true });

const externals = ['chokidar', 'pino', 'pino-pretty', 'node-machine-id'];

console.log('📦 Bundling agent (bun build) ...');
const buildArgs = [
  'build',
  join(agentDir, 'src/main.ts'),
  '--target=bun',
  `--outfile=${join(out, 'dist/main.js')}`,
  ...externals.flatMap((e) => ['--external', e]),
];
const buildResult = spawnSync('bun', buildArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
if (buildResult.status !== 0) {
  console.error('❌ bun build failed');
  process.exit(buildResult.status ?? 1);
}

console.log('✏️  Writing bin/sessions-ai.js ...');
const binPath = join(out, 'bin', 'sessions-ai.js');
writeFileSync(binPath, `#!/usr/bin/env bun\nimport '../dist/main.js';\n`);
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
    'sessions-ai Agent — local LLM session collector for tools like GitHub Copilot Chat and OpenCode (Bun runtime).',
  type: 'module',
  bin: { 'sessions-ai': 'bin/sessions-ai.js' },
  files: ['dist', 'bin', 'README.md'],
  engines: { bun: '>=1.3.0' },
  dependencies: Object.fromEntries(
    externals.map((name) => [name, agentPkg.dependencies[name]]).filter(([, v]) => Boolean(v)),
  ),
  repository: { type: 'git', url: 'git+https://github.com/greywen/SessionVault.git' },
  homepage: 'https://github.com/greywen/SessionVault',
  bugs: { url: 'https://github.com/greywen/SessionVault/issues' },
  keywords: ['llm', 'session', 'audit', 'copilot', 'opencode', 'agent'],
  license: 'MIT',
};
writeFileSync(join(out, 'package.json'), JSON.stringify(publishPkg, null, 2) + '\n');

const readmeSrc = join(monorepoRoot, 'README.md');
if (existsSync(readmeSrc)) {
  copyFileSync(readmeSrc, join(out, 'README.md'));
}

console.log('✅ publish-pkg ready at', out);
console.log('   Next steps:');
console.log('     cd', out);
console.log('     npm publish --access public');
