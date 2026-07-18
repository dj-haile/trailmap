# Trailmap

A visual quarterly map of your work: goal rings that fill as tasks complete, initiatives with a max-3-visible rule, people-shaped "waiting on" chips that age in days, and one suggested move per day.

Built per `docs/PLAN.md` (the execution plan) from the prototype in `docs/prototype.html`.

## Run

```bash
npm install
npm start
```

## Test

```bash
npm test                      # renderer purity check + unit tests
xvfb-run -a npm run test:e2e  # Playwright e2e (drop xvfb-run on macOS)
```

## Package (macOS, unsigned)

```bash
npm run dist                  # produces dist/Trailmap-*.dmg (arm64)
```

First launch of an unsigned build: right-click the app → Open.

## Data

- Live file: `~/Library/Application Support/Trailmap/trailmap.json` (human-readable JSON)
- Snapshots: `.../Trailmap/snapshots/` — every save, tiered retention (24h all / 90d daily / 1,000 max)
- The file may be edited externally (by hand or by Claude) — the app watches and reloads.

## Manual checklist (per milestone gates)

- [ ] Light and dark mode both render correctly (System Settings → Appearance)
- [ ] Notification click focuses the app — to test quickly, edit a waiting chip's
      `since` date in the data file to 6+ days ago and relaunch
- [ ] Kill-test: force-quit repeatedly during edits; data file always loads
      (automated version: `node scripts/kill-test.mjs 30`)
- [ ] Corrupt-file recovery: mangle the JSON by hand; next launch restores the
      latest snapshot and sets the bad file aside
- [ ] External edit: change `trailmap.json` in a text editor while the app runs;
      the app reloads it (and asks first if you also had unsaved changes)
- [ ] VoiceOver spot-check: rings and chips announce sensibly

## Architecture notes

- `renderer/` is platform-agnostic by rule (plan §2) — enforced by
  `npm run check:renderer`. A future web version reuses it unchanged.
- All persistence goes through `electron/storage/` (StorageProvider contract);
  swapping in SQLite later touches nothing above that interface.
- Every tunable (visible-move cap, aging thresholds, 9am check hour, debounce)
  lives in `CONSTANTS` in `renderer/logic.js`.
