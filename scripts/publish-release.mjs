import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyManifest, digest } from './verify-artifacts.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
const directory = process.argv[2] || 'artifacts';
const sha = process.env.RELEASE_SHA || process.env.GITHUB_SHA;
if (!repo || !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag || '') || !sha) throw new Error('Repository, version tag and commit are required');
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' });
const ref = JSON.parse(gh('api', `repos/${repo}/git/ref/tags/${tag}`));
let target = ref.object;
while (target.type === 'tag') target = JSON.parse(gh('api', `repos/${repo}/git/tags/${target.sha}`)).object;
if (target.type !== 'commit' || target.sha !== sha) throw new Error('Tag does not match the verified build commit');
const manifests = readdirSync(directory).filter((name) => name.endsWith('.manifest.json'));
const expected = new Set(['macos/x64', 'macos/arm64', 'windows/x64', 'windows/arm64']);
const assets = [];
let signed = true;
for (const name of manifests) {
  const manifest = JSON.parse(readFileSync(join(directory, name), 'utf8'));
  verifyManifest(directory, manifest);
  if (process.env.SOURCE_RUN_ID && manifest.runId !== process.env.SOURCE_RUN_ID) throw new Error('Artifact belongs to a different workflow run');
  if (manifest.commit !== sha || `v${manifest.version}` !== tag || !expected.delete(`${manifest.platform}/${manifest.arch}`)) throw new Error('Build provenance/version/architecture mismatch');
  signed &&= manifest.signed === true;
  assets.push(name, ...manifest.files.map((f) => f.name));
}
if (expected.size) throw new Error('Missing platform artifacts');
let release;
try { release = JSON.parse(gh('release', 'view', tag, '--repo', repo, '--json', 'isDraft,assets')); }
catch {
  gh('release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', '--generate-notes', '--title', `${tag}${signed ? '' : ' — unsigned pilot'}`);
  release = JSON.parse(gh('release', 'view', tag, '--repo', repo, '--json', 'isDraft,assets'));
}
const temporary = mkdtempSync(join(tmpdir(), 'sitrem-release-'));
try {
  for (const name of assets) {
    if (release.assets.some((asset) => asset.name === name)) {
      gh('release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', temporary);
      if (digest(join(temporary, name)) !== digest(join(directory, name))) throw new Error(`Published asset has a conflicting hash: ${name}`);
    } else {
      if (!release.isDraft) throw new Error('Published release is incomplete; refusing to mutate it');
      gh('release', 'upload', tag, join(directory, name), '--repo', repo);
    }
  }
  if (release.isDraft) gh('release', 'edit', tag, '--repo', repo, '--draft=false', `--prerelease=${!signed}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
