import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const arch = process.argv[2] || process.arch;
if (process.arch !== arch) throw new Error(`Native ${arch} runner required; current architecture is ${process.arch}`);
const executable = process.platform === 'darwin' ? join('dist', arch === 'arm64' ? 'mac-arm64' : 'mac', 'SitremPrinter.app', 'Contents', 'MacOS', 'SitremPrinter')
  : join('dist', arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked', 'SitremPrinter.exe');
const temporary = mkdtempSync(join(tmpdir(), 'sitrem-smoke-'));
const child = spawn(executable, ['--sitrem-smoke'], { env: { ...process.env, SITREM_SMOKE_DATA: temporary }, stdio: 'inherit' });
const timer = setTimeout(() => { child.kill(); }, 30_000);
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('close', (code) => { clearTimeout(timer); rmSync(temporary, { recursive: true, force: true }); process.exitCode = code === 0 ? 0 : 1; });
