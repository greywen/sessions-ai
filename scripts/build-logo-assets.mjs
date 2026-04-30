#!/usr/bin/env node

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const DEFAULT_SOURCE = path.join(repoRoot, 'logo', 'logo.png');
const DEFAULT_CROP_TOP = 192;
const DEFAULT_CROP_BOTTOM = 192;

const OUTPUTS = [
  { file: 'apps/web/public/brand/logo.png', size: 512, format: 'png' },
  { file: 'apps/web/public/icon.png', size: 512, format: 'png' },
  { file: 'apps/web/public/apple-touch-icon.png', size: 180, format: 'png' },
  { file: 'apps/web/public/favicon.ico', size: 256, format: 'ico' },
  { file: '.github/assets/logo.png', size: 512, format: 'png' },
];

function parseArgs(argv) {
  let source = DEFAULT_SOURCE;
  let cropTop = DEFAULT_CROP_TOP;
  let cropBottom = DEFAULT_CROP_BOTTOM;

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if ((current === '--source' || current === '-s') && argv[i + 1]) {
      source = path.resolve(repoRoot, argv[i + 1]);
      i += 1;
      continue;
    }

    if (current === '--crop-top' && argv[i + 1]) {
      cropTop = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }

    if (current === '--crop-bottom' && argv[i + 1]) {
      cropBottom = Number.parseInt(argv[i + 1], 10);
      i += 1;
    }
  }

  return { source, cropTop, cropBottom };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    const message = stderr || stdout || `Command failed: ${command} ${args.join(' ')}`;
    throw new Error(message);
  }
}

function ensureFfmpegAvailable() {
  try {
    run('ffmpeg', ['-version']);
  } catch {
    throw new Error('ffmpeg not found. Please install ffmpeg first, then run this script again.');
  }
}

function getSourceHeight(source) {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'default=nw=1:nk=1', source],
    {
      stdio: 'pipe',
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    const message = stderr || stdout || 'Failed to read source image metadata via ffprobe.';
    throw new Error(message);
  }

  const parsed = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Invalid source image height from ffprobe.');
  }

  return parsed;
}

function buildFilter(size, cropTop, cropBottom, sourceHeight) {
  const cropHeight = sourceHeight - cropTop - cropBottom;

  if (!Number.isInteger(cropTop) || !Number.isInteger(cropBottom) || cropTop < 0 || cropBottom < 0) {
    throw new Error('cropTop and cropBottom must be non-negative integers.');
  }

  if (cropHeight <= 0) {
    throw new Error(`Invalid crop values: cropTop(${cropTop}) + cropBottom(${cropBottom}) must be less than source height(${sourceHeight}).`);
  }

  return [
    `crop=iw:${cropHeight}:0:${cropTop}`,
    `scale=${size}:${size}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${size}:${size}`,
    'format=rgba',
  ].join(',');
}

function buildAsset(source, outputPath, size, format, cropTop, cropBottom, sourceHeight) {
  const outputDir = path.dirname(outputPath);
  mkdirSync(outputDir, { recursive: true });

  const args = [
    '-y',
    '-loglevel',
    'error',
    '-i',
    source,
    '-vf',
    buildFilter(size, cropTop, cropBottom, sourceHeight),
  ];

  if (format === 'ico') {
    args.push('-c:v', 'png', '-pix_fmt', 'rgba');
  }

  args.push(outputPath);
  run('ffmpeg', args);
}

function main() {
  const { source, cropTop, cropBottom } = parseArgs(process.argv.slice(2));

  if (!existsSync(source)) {
    throw new Error(`Source image not found: ${source}`);
  }

  ensureFfmpegAvailable();
  const sourceHeight = getSourceHeight(source);

  console.log('Building logo assets...');
  console.log(`Source: ${source}`);
  console.log(`Crop: top ${cropTop}px, bottom ${cropBottom}px`);
  console.log(
    'Note: This script crops, resizes, and exports the source image. Provide an authorized watermark-free source image if needed.',
  );

  for (const output of OUTPUTS) {
    const target = path.join(repoRoot, output.file);
    buildAsset(source, target, output.size, output.format, cropTop, cropBottom, sourceHeight);
    console.log(`  - generated ${output.file}`);
  }

  console.log('Logo assets updated successfully.');
}

try {
  main();
} catch (error) {
  console.error('[build-logo-assets] Failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
