#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

// Ensure 7-Zip uses the compatible BCJ filter to prevent silent extraction failures
// of ARM64 binaries in electron-builder's NSIS (nsis7z) runtime.
process.env.ELECTRON_BUILDER_7Z_FILTER = process.env.ELECTRON_BUILDER_7Z_FILTER || 'BCJ';

const args = ['electron-builder', '--win', ...process.argv.slice(2)];
const result = spawnSync('npx', args, {
  stdio: 'inherit',
  shell: true,
  env: process.env
});

process.exit(result.status ?? 0);
