#!/usr/bin/env node
// Enforces the plan §2 reversibility rule by machine: nothing under renderer/
// may reference Electron, Node built-ins, require(), or process.
// The renderer must stay runnable in a plain browser.
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'renderer');
const FORBIDDEN = [
  /\brequire\s*\(/,
  /\bprocess\.\w/,
  /from\s+['"]electron['"]/,
  /from\s+['"]node:/,
  /import\s*\(\s*['"]node:/,
  /__dirname|__filename/,
  /\bBrowser(Window|View)\b/,
  /\bipcRenderer\b/,
];

let failures = [];
for (const f of fs.readdirSync(RENDERER)) {
  if (!/\.(js|mjs|html)$/.test(f)) continue;
  const text = fs.readFileSync(path.join(RENDERER, f), 'utf8');
  text.split('\n').forEach((line, i) => {
    for (const rx of FORBIDDEN) {
      if (rx.test(line)) failures.push(`renderer/${f}:${i + 1}  matches ${rx}  →  ${line.trim().slice(0, 100)}`);
    }
  });
}

if (failures.length) {
  console.error('✗ Renderer purity check FAILED (plan §2 — renderer must be platform-agnostic):');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('✓ Renderer purity check passed — no platform APIs in renderer/');
