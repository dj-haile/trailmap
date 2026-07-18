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
- [ ] Notification click focuses the app (M3+)
- [ ] Kill-test: force-quit repeatedly during edits; data file always loads
- [ ] Corrupt-file recovery: mangle the JSON by hand; next launch offers snapshot restore
- [ ] VoiceOver spot-check: rings and chips announce sensibly
