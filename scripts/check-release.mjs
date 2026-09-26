#!/usr/bin/env node
// Did we publish this version? Exits 0 when GitHub release v<package.json version>
// exists and carries Trailmap-<version>-universal.dmg; exits 1 with the reason otherwise.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const tag = `v${version}`;
const wanted = `Trailmap-${version}-universal.dmg`;
let rel;
try {
  rel = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--json', 'tagName,assets,isDraft'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
} catch (e) {
  console.error(`FAIL: no GitHub release ${tag} (${(e.stderr || e.message).toString().trim()})`);
  process.exit(1);
}
const names = (rel.assets || []).map(a => a.name);
if (!names.includes(wanted)) {
  console.error(`FAIL: release ${tag} exists but has no asset ${wanted}; assets: ${names.join(', ') || '(none)'}`);
  process.exit(1);
}
if (rel.isDraft) { console.error(`FAIL: release ${tag} is still a draft`); process.exit(1); }
console.log(`OK: release ${tag} carries ${wanted}`);
