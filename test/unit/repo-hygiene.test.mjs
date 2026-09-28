// Repo hygiene: the things a newcomer (or their coding agent) copies verbatim
// must be true. Spec: thoughts/shared/specs/2026-09-26-shareable-repo.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../../', import.meta.url);
const read = rel => fs.readFileSync(new URL(rel, ROOT), 'utf8');
const exists = rel => fs.existsSync(new URL(rel, ROOT));
const pkg = JSON.parse(read('package.json'));

function countTests(dir, ext) {
  const abs = new URL(dir, ROOT);
  return fs.readdirSync(abs).filter(f => f.endsWith(ext))
    .reduce((n, f) => n + (fs.readFileSync(path.join(abs.pathname, f), 'utf8').match(/^test\(/gm) || []).length, 0);
}

test('LICENSE is MIT with the owner as copyright holder and package.json agrees', () => {
  assert.ok(exists('LICENSE'), 'LICENSE file missing');
  const lic = read('LICENSE');
  assert.match(lic, /MIT License/);
  assert.match(lic, /Copyright \(c\) \d{4} Dj Haile/);
  assert.match(lic, /Permission is hereby granted, free of charge/);
  assert.equal(pkg.license, 'MIT');
});

test('README install section is copy-paste correct and its test counts match the repo', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /<this repo>/, 'clone placeholder still present');
  assert.match(readme, /git clone https:\/\/github\.com\/dj-haile\/trailmap\.git/);
  assert.match(readme, /github\.com\/dj-haile\/trailmap\/releases/, 'no Releases install path');
  assert.match(readme, /Open Anyway/, 'Gatekeeper step not explained');
  const unit = countTests('test/unit/', '.test.mjs');
  const e2e = countTests('test/e2e/', '.spec.js');
  assert.match(readme, new RegExp(`\\b${unit} unit tests\\b`), `README should say ${unit} unit tests`);
  assert.match(readme, new RegExp(`\\b${e2e} Playwright e2e tests\\b`), `README should say ${e2e} Playwright e2e tests`);
});

test('AGENTS.md names real npm scripts and the key constraints; CLAUDE.md imports it', () => {
  assert.ok(exists('AGENTS.md'), 'AGENTS.md missing');
  const agents = read('AGENTS.md');
  for (const cmd of ['npm install', 'npm start', 'npm test', 'npm run test:e2e', 'npm run dist']) {
    assert.ok(agents.includes(cmd), `AGENTS.md should name \`${cmd}\``);
  }
  for (const m of agents.matchAll(/npm run ([a-z0-9:-]+)/g)) {
    assert.ok(pkg.scripts[m[1]], `AGENTS.md names \`npm run ${m[1]}\` but package.json has no such script`);
  }
  assert.match(agents, /renderer\/.*(platform-agnostic|no Electron)/i, 'renderer rule not stated');
  for (const v of ['TRAILMAP_DATA_DIR', 'TRAILMAP_SILENT_DIALOGS', 'TRAILMAP_NOTIFY_FAKE']) {
    assert.ok(agents.includes(v), `AGENTS.md should document ${v}`);
  }
  assert.ok(exists('CLAUDE.md'), 'CLAUDE.md missing');
  assert.match(read('CLAUDE.md'), /^@AGENTS\.md\s*$/m, 'CLAUDE.md should import AGENTS.md');
});

test('README names the Where Is My Data menu item', () => {
  const readme = read('README.md');
  // one line: the new bullet must itself mention snapshots, not rely on the ones below it
  assert.match(readme, /Where Is My Data….*snapshot/, 'README should describe File → Where Is My Data… and its snapshot summary');
});
