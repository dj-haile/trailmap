#!/usr/bin/env node
// M2 acceptance: the kill-test (plan §9 M2). Spawns a worker that saves in a
// tight loop, SIGKILLs it at a random moment, then proves the live file still
// validates. Repeat N times. Any corruption = atomic write is broken.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { JsonProvider } = require(path.join(here, '../electron/storage/json-provider.js'));

const ROUNDS = Number(process.argv[2] || 30);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-killtest-'));
const seed = path.join(here, '../fixtures/sample-quarter.json');
const worker = path.join(here, 'kill-worker.cjs');

let failures = 0;
for (let i = 0; i < ROUNDS; i++) {
  const child = spawn(process.execPath, [worker, dir, seed], { stdio: 'ignore' });
  const delay = 20 + Math.floor(Math.random() * 120);
  await new Promise(r => setTimeout(r, delay));
  child.kill('SIGKILL');
  await new Promise(r => child.on('exit', r));
  const p = new JsonProvider(dir, { seedPath: seed });
  try {
    await p.load();
  } catch (e) {
    failures++;
    console.error(`round ${i}: LOAD FAILED after kill at ${delay}ms — ${e.message}`);
  }
}
if (failures) {
  console.error(`✗ kill-test FAILED: ${failures}/${ROUNDS} rounds left an unreadable file`);
  process.exit(1);
}
console.log(`✓ kill-test passed: ${ROUNDS} SIGKILLs mid-save, live file valid every time`);
