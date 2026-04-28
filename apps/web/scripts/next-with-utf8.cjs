#!/usr/bin/env node

const { spawn } = require('node:child_process');

const mode = process.argv[2];
const extraArgs = process.argv.slice(3);

const modeArgsMap = {
  dev: ['dev', '--turbopack'],
  start: ['start'],
};

// On Windows, Turbopack may garble CJK logs; use webpack in dev mode.
const modeArgs =
  process.platform === 'win32' && mode === 'dev'
    ? ['dev', '--webpack']
    : modeArgsMap[mode];

if (!modeArgs) {
  console.error(`Unsupported mode: ${mode ?? '<empty>'}. Expected one of: ${Object.keys(modeArgsMap).join(', ')}`);
  process.exit(1);
}

const args = [...modeArgs, ...extraArgs];
const nextBin = require.resolve('next/dist/bin/next');

function runOnPosix() {
  const child = spawn(process.execPath, [nextBin, ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

function runOnWindows() {
  const setCodePage = spawn('cmd.exe', ['/d', '/c', 'chcp 65001>nul'], {
    stdio: 'ignore',
    env: process.env,
    windowsHide: true,
  });

  setCodePage.on('exit', (code) => {
    if ((code ?? 0) !== 0) {
      console.error('Failed to switch console code page to UTF-8.');
      process.exit(code ?? 1);
      return;
    }

    const child = spawn(process.execPath, [nextBin, ...args], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: false,
    });

    child.on('exit', (exitCode, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(exitCode ?? 0);
    });
  });
}

if (process.platform === 'win32') {
  runOnWindows();
} else {
  runOnPosix();
}
