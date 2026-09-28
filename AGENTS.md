# AGENTS.md — Trailmap

Instructions for coding agents working in this repository. `CLAUDE.md` imports this file; keep the two in sync by editing only this one.

## What this is
Trailmap is a macOS desktop app (Electron, vanilla JS, no framework, no build step) that shows a quarter's work as goal rings → initiative cards → moves (next actions) and waiting-on chips, with a Today list and due dates. Design doc: `docs/PLAN.md`. User docs: `README.md`. Recipient install notes: `docs/SHARING.md`.

## Requirements
- macOS is the primary target (notifications, Dock, .dmg). Do not break Linux/Windows gratuitously; do not spend effort on them.
- Node.js >= 20.17.0. `.npmrc` sets `engine-strict=true`, so an older Node fails `npm install` with a clear message.
- No network access at runtime, ever. CSP is `default-src 'self'`; there is no `fetch`.

## Commands
| Task | Command |
|---|---|
| Install dependencies | `npm install` |
| Run from source (dev) | `npm start` |
| Unit tests + renderer purity check | `npm test` |
| End-to-end tests (Playwright, real Electron) | `npm run test:e2e` (Linux CI: `xvfb-run -a npm run test:e2e`) |
| Renderer purity check only | `npm run check:renderer` |
| Build the universal .dmg | `npm run dist` → `dist/Trailmap-<version>-universal.dmg` |
| Verify the GitHub release for the current version | `node scripts/check-release.mjs` |
| Crash-safety kill test | `node scripts/kill-test.mjs 30` |

## Constraints (enforced; violating them is a defect even if the app works)
1. **`renderer/` is platform-agnostic.** Nothing under `renderer/` may reference `require`, `process`, `electron`, or Node built-ins. It talks only to `window.trailmap` (defined in `electron/preload.js`). `npm run check:renderer` fails the build otherwise.
2. **Single writer, atomic saves.** Only the main process touches the user's data, via the `StorageProvider` in `electron/storage/`. Saves write a temp file, fsync, then rename. The renderer calls `bridge.persist(doc)`; main debounces (500 ms) and saves.
3. **External edits win.** Main watches the live JSON; an out-of-band change reloads the UI. Never clobber an external edit with stale in-app state.
4. **Notifications fire once per tier.** `lastNotifiedTier` / `lastDueTier` live in the data model; relaunch must not re-fire.
5. **Unknown JSON fields are preserved** on load → mutate → save (forward compatibility).
6. **User text renders via `textContent` only.** Never `innerHTML` with user strings.
7. **Keyboard operable.** Every control is a `button`/`input` with an `aria-label` where the visible text is not self-explanatory.

## Layout
```
electron/       main.js (lifecycle, IPC, menu, notifications), preload.js (the only bridge), storage/ (provider + JSON impl)
renderer/       index.html, styles.css, app.js (UI; full re-render on every mutation), logic.js (pure domain logic, unit-tested)
test/unit/      node:test — pure logic and repo hygiene (*.test.mjs)
test/e2e/       Playwright `_electron` specs (*.spec.js), one temp data dir per test
fixtures/       sample-quarter.json (the sample map; e2e tests seed from it)
scripts/        check-renderer-purity.js, kill-test.mjs, check-release.mjs
```

## Test environment
- `TRAILMAP_DATA_DIR=<dir>` — where the live JSON and snapshots go (tests use a fresh temp dir; default is `~/Library/Application Support/Trailmap/`).
- `TRAILMAP_SILENT_DIALOGS=1` — suppress informational dialogs (headless runs).
- `TRAILMAP_NOTIFY_FAKE=1` — record notifications to `notifications.log` and informational dialogs to `dialogs.log` (both in the data dir) instead of showing them.
- E2E launches via `electron.launch({ args: [repoRoot], env })`; wait ~1200 ms before closing if you need the debounced save flushed.
- Compute dates the way the app does (local calendar date), not via `toISOString()` (UTC).
- macOS has no `timeout` binary; drive timed runs from Node.

## Working conventions
- Keep changes inside the files the task needs; the codebase is small and reads end to end.
- Add or extend a unit test in `test/unit/` for logic changes and an e2e spec in `test/e2e/` for UI behaviour; the README's test counts are checked by `test/unit/repo-hygiene.test.mjs`, so update them when you add tests.
- Commit messages: short imperative subject, body explains why.
