import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { digest, verifyManifest } from '../scripts/verify-artifacts.mjs';
describe('release artifact verification', () => {
  it('rejects incomplete inventories, altered binaries and traversal paths', () => {
    const path = mkdtempSync(join(tmpdir(), 'sitrem-artifact-test-'));
    try {
      const names = ['SitremPrinter-1.0.0-arm64.exe', 'SitremPrinter-1.0.0-arm64.exe.blockmap'];
      names.forEach((name) => writeFileSync(join(path, name), 'verified'));
      const manifest = { schemaVersion: 1, platform: 'windows', arch: 'arm64', version: '1.0.0',
        files: names.map((name) => ({ name, size: 8, sha256: digest(join(path, name)) })) };
      expect(() => verifyManifest(path, manifest)).not.toThrow();
      expect(() => verifyManifest(path, { ...manifest, files: manifest.files.slice(0, 1) })).toThrow();
      writeFileSync(join(path, names[0]), 'modified');
      expect(() => verifyManifest(path, manifest)).toThrow('mismatch');
      expect(() => verifyManifest(path, { ...manifest, files: [{ name: '../file', size: 8, sha256: 'hash' }] })).toThrow();
    } finally { rmSync(path, { recursive: true, force: true }); }
  });
});
