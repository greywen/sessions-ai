import path from 'node:path';
import type { NextConfig } from 'next';

// Monorepo root (two levels above apps/web). next.config is always loaded
// from the project directory (apps/web), so cwd is a stable anchor.
const monorepoRoot = path.resolve(process.cwd(), '..', '..');

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (`apps/web/Dockerfile`).
  // Generates `.next/standalone/` with only the deps actually used at runtime.
  output: 'standalone',
  // The standalone output traces files starting at the next.config.ts directory
  // by default. In a pnpm workspace the source files (e.g. @sessions-ai/shared)
  // live above that, so point tracing at the monorepo root.
  outputFileTracingRoot: monorepoRoot,
  // Next.js 16 / Turbopack: explicitly anchor the project root so module
  // resolution does not climb out of `apps/web` looking for `next/package.json`.
  turbopack: {
    root: monorepoRoot,
  },
  transpilePackages: ['@sessions-ai/shared'],
};

export default nextConfig;
