import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function digest(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
export function verifyManifest(directory, manifest) {
  if (manifest.schemaVersion !== 1 || !['macos', 'windows'].includes(manifest.platform) || !['x64', 'arm64'].includes(manifest.arch)) throw new Error('Invalid artifact manifest');
  const extension = manifest.platform === 'macos' ? 'dmg' : 'exe';
  const base = `SitremPrinter-${manifest.version}-${manifest.arch}.${extension}`;
  if (manifest.files.length !== 2 || !manifest.files.some((f) => f.name === base) || !manifest.files.some((f) => f.name === `${base}.blockmap`)) throw new Error('Incomplete artifact inventory');
  for (const file of manifest.files) {
    if (!/^[A-Za-z0-9._-]+$/.test(file.name)) throw new Error('Unsafe artifact filename');
    const path = join(directory, file.name);
    if (file.size < 1 || statSync(path).size !== file.size || digest(path) !== file.sha256) throw new Error(`Artifact mismatch: ${file.name}`);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [platform, arch, directory = 'dist'] = process.argv.slice(2);
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const extension = platform === 'macos' ? 'dmg' : 'exe';
  const base = `SitremPrinter-${version}-${arch}.${extension}`;
  const manifest = { schemaVersion: 1, platform, arch, version, commit: process.env.GITHUB_SHA || 'local',
    runId: process.env.GITHUB_RUN_ID || 'local', signed: process.env.SIGNED_BUILD === 'true',
    files: [base, `${base}.blockmap`].map((name) => ({ name, size: statSync(join(directory, name)).size, sha256: digest(join(directory, name)) })) };
  verifyManifest(directory, manifest);
  writeFileSync(join(directory, `SitremPrinter-${version}-${platform}-${arch}.manifest.json`), JSON.stringify(manifest, null, 2));
  console.log(`Verified ${platform}/${arch}: installer and blockmap`);
}
