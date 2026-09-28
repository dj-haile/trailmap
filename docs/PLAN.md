# Trailmap (formerly Quarter Map) — Desktop App Execution Plan

**For:** a coding agent executing autonomously.
**Owner:** Dj (single user for v1; design nothing that *blocks* multi-user later, build nothing that *serves* it yet).
**Companion file:** `quarter-map.html` — the working single-file prototype. It is the UI spec. Port it; do not redesign it.

---

## 1. What this app is

Quarter Map is a visual quarterly to-do tool for a person whose work fans out through people (a VP of Engineering). It rejects text task-lists in favor of one picture:

- **Quarterly priorities (goals)** shown as progress rings that fill as any task beneath them completes.
- **Initiatives** under each goal, as cards with progress bars.
- **Moves** — the user's own next actions — max **3 visible** per initiative ("Now/Later rule"); the rest wait in a collapsed pile.
- **Waiting-on chips** — people-shaped dependencies ("Priya — headcount plan") that **age in days**, turning amber at 5 days and red at 10.
- **Today's Move** — a single suggested action, chosen from the goal with the least momentum.
- **Momentum counter** — "N moves shipped this quarter · M this week."

The prototype implements all of this in one HTML file with in-memory state and manual JSON export/import. **The entire point of the desktop app is real persistence** plus native niceties (notifications). Everything the prototype does, the app must do.

## 2. Locked decisions (do not revisit)

| Decision | Choice | Notes |
|---|---|---|
| Shell | **Electron** (current LTS-compatible version) | Reuse prototype HTML/CSS/JS nearly verbatim in the renderer |
| Language | **Vanilla JS + JSDoc type annotations** | Match the prototype; no framework, no TypeScript build step |
| Data store | **Single JSON file + timestamped snapshots** | Behind a storage interface (§5) so a future SQLite/other swap is a module change. Owner explicitly wants a better storage option *eventually* — not now |
| Platform | **macOS first** (Apple Silicon at minimum) | Don't break Windows/Linux gratuitously, but don't spend time on them |
| Distribution | **Unsigned local build** (.app in a .dmg) | No signing, no notarization, no auto-update in v1 |
| v1 scope | Prototype parity + persistence + **aging-chip notifications** | Everything else → §10 roadmap |
| Reversibility | **The renderer must stay platform-agnostic** | Owner may later want a web app. No Electron/Node APIs, no `require`/`process`, nothing platform-specific inside `renderer/` — the renderer talks only to the `window.trailmap` interface (§6.3). A future web version keeps the renderer verbatim and reimplements that interface over HTTP. Violating this rule is a defect even if the app works |

## 3. Repository layout

```
quarter-map/
  package.json
  electron/
    main.js            # app lifecycle, window, IPC, notifications scheduler
    preload.js         # contextBridge API surface (the ONLY bridge)
    storage/
      provider.js      # StorageProvider interface (JSDoc typedef) + factory
      json-provider.js # the v1 implementation
  renderer/
    index.html         # ported from quarter-map.html (markup + styles)
    app.js             # ported logic, refactored per §6
    styles.css
  assets/
    icon.icns          # simple generated icon is fine (ring motif)
  test/
    unit/              # node:test — pure-logic tests
    e2e/               # Playwright — drives the built app
  fixtures/
    sample-quarter.json
```

## 4. Data model

### 4.1 Document shape (schema v1)

```json
{
  "schemaVersion": 1,
  "title": "Q3 — The Quarter Map",
  "goals": [
    {
      "id": "g_abc123",
      "name": "Ship the platform re-architecture",
      "sub": "the big technical bet",
      "horizon": "quarter",
      "inits": [
        {
          "id": "i_def456",
          "name": "Service-mesh migration",
          "moves": [
            { "id": "m_1", "label": "Review Marco's rollout plan", "done": false },
            { "id": "m_2", "label": "Announce at all-hands", "done": true, "doneAt": "2026-07-03" }
          ],
          "waiting": [
            { "id": "w_1", "who": "Marco", "what": "arch review draft", "since": "2026-07-10", "lastNotifiedTier": 0 }
          ]
        }
      ]
    }
  ]
}
```

Rules:

- IDs: short random strings, generated in the renderer (`crypto.randomUUID()` truncated is fine). Never reuse.
- `doneAt` / `since`: ISO date strings (`YYYY-MM-DD`), local dates.
- `lastNotifiedTier`: 0 = never notified, 1 = 5-day notice sent, 2 = 10-day notice sent. Added by the app; absent means 0.
- `horizon` (goal-level, optional): `"quarter"` (default when absent) | `"half"` | `"year"`. Goals are not time-boxed in v1 — they live until deleted — but the horizon is recorded now so the v2 quarter-rollover feature can carry long-horizon goals (e.g. a year-long hiring goal) forward instead of archiving them. **UI:** a small muted tag next to the goal name (e.g. "year"), settable in edit mode via a 3-option cycle; quarter-horizon goals show no tag. This is the single sanctioned addition to the ported UI.
- The prototype's export format is this document minus `schemaVersion` and `lastNotifiedTier`. **Import must accept it** (treat missing `schemaVersion` as 1, default missing fields).

### 4.2 Validation on load

On every load, validate structurally: `goals` is an array; every goal/init/move/waiting entry has an `id` and the required string fields; dates parse. On failure: do **not** crash and do **not** overwrite — offer (dialog) to load the most recent valid snapshot, and rename the bad file to `trailmap.json.corrupt-<timestamp>` for forensics.

**Forward compatibility:** unknown fields anywhere in the document are preserved and written back untouched (parse → mutate known fields → serialize the same object). A future app version's data opened by this version must not be stripped. Unit-test the round-trip with a fixture containing extra fields at every level.

### 4.3 Files on disk

- Live file: `~/Library/Application Support/Trailmap/trailmap.json` (use `app.getPath('userData')`).
- Snapshots: `.../Trailmap/snapshots/trailmap-<ISO-timestamp>.json`.
- Snapshot policy: **every save produces a snapshot** (saves are already debounced to 500 ms, so this is one small file per edit burst), plus one on app launch. Retention is tiered: keep every snapshot from the last 24 hours; older than that, thin to the last snapshot of each calendar day; drop day-snapshots older than 90 days. Hard cap 1,000 files (prune oldest first). Pruning runs after each save.
- First run (no live file): load `fixtures/sample-quarter.json` (the prototype's sample data) and save it as the live file.

## 5. Storage interface — the future-proofing requirement

All persistence goes through one interface. Nothing in the renderer or main touches `fs` for user data outside the provider.

```js
/**
 * @typedef {Object} StorageProvider
 * @property {() => Promise<QuarterDoc>} load        // validated doc, or throws {code:'CORRUPT'|'MISSING'}
 * @property {(doc: QuarterDoc) => Promise<void>} save   // ATOMIC (see below)
 * @property {() => Promise<SnapshotInfo[]>} listSnapshots
 * @property {(id: string) => Promise<QuarterDoc>} loadSnapshot
 * @property {() => Promise<void>} snapshotNow
 */
```

**Atomic write rule (non-negotiable):** `save()` writes to `trailmap.json.tmp` in the same directory, `fsync`s, then `rename()`s over the live file. A crash at any moment must leave either the old or the new file intact, never a torn one.

**Single-writer rule:** only the **main process** writes. The renderer sends state via IPC; main debounces (500 ms) and saves. Any future surface (quick-add hotkey window, menu bar widget) must route writes through the same main-process channel.

## 6. Porting the renderer

Start from `quarter-map.html`. Split into `index.html` / `styles.css` / `app.js` with **zero visual redesign** — colors, spacing, dark mode (`prefers-color-scheme`), and all interactions stay as-is (single sanctioned addition: the goal-horizon tag, §4.1). Structural changes required:

1. **State flows through the bridge.** Replace the in-memory `S` initialization with `await window.trailmap.load()`. After every mutation, call `window.trailmap.persist(S)` (fire-and-forget; main debounces). Remove nothing else about how `render()` works — it's a full re-render on change and that is fine at this scale.
2. **Remove the export/import `<details>` panel** from the page. Its jobs move to the app menu (§8): Export/Import as file dialogs. The "ask Claude" hint disappears (the JSON file on disk now serves that purpose).
3. **Preload bridge (`contextBridge`) exposes exactly:** `load()`, `persist(doc)`, `exportToFile()`, `importFromFile()`, `listSnapshots()`, `restoreSnapshot(id)`, `openDataFolder()`, and one event subscription `onExternalChange(cb)` (fires with the reloaded doc when the live file changes out-of-band — see §10 external-modification safety). Nothing else. *(v0.3: the File → Where Is My Data… view is a native dialog driven from main; the bridge is unchanged.)* `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, strict CSP meta tag (`default-src 'self'`), no remote content ever.
4. **Keep** the Today's-Move selection logic (least-momentum goal first, skip cycles through candidates), the Now/Later visibility rule (3 open moves visible, expandable), aging thresholds (amber ≥5d, red ≥10d), and the "this week" momentum window (`doneAt` within 7 days) exactly as the prototype computes them. **One correction to the prototype:** "N moves shipped this quarter" must count moves whose `doneAt` falls within the *current calendar quarter* (derived from today's date), not all completed moves ever — goals may now outlive a quarter (see `horizon`, §4.1) and the counter must stay truthful. All such thresholds/windows live in one exported constants block.
5. Extract the pure functions (`goalPct`, `initPct`, `momentumCounts`, `ageClass`, today's-move selection, waiting-age computation) into an importable module shared with unit tests.

## 7. Notifications (the one new v1 feature)

macOS user notifications via Electron's `Notification` API, scheduled in the main process:

- **Check times:** on app launch, and daily at 9:00 local (a `setTimeout`-to-next-9am chain is fine; no cron dependency).
- **Trigger:** any waiting-on chip crossing a tier — ≥5 days (tier 1): "⏳ Priya — headcount plan has been waiting 6 days"; ≥10 days (tier 2): "⚠ Sam — error-budget dashboard has been waiting 12 days. Time to nudge."
- **No spam:** fire only when `lastNotifiedTier < tier`; update `lastNotifiedTier` (and persist) after firing. Marking a chip received deletes it and its state. One notification per chip per tier, ever.
- Clicking a notification focuses/opens the main window.
- If notification permission is denied, fail silent — never block the app on it.

## 8. App shell details

- **Menu:** standard macOS menu plus: File → Export Data… (save dialog, writes pretty-printed JSON), File → Import Data… (open dialog, validates before replacing, snapshots current state first), File → Snapshot Now, File → Restore Snapshot… (submenu or simple picker listing snapshots by date), File → Where Is My Data… (native dialog: live file path, last save, snapshot count; Copy Path / Reveal / Back Up / Snapshot History), File → Open Data Folder, plus standard Edit menu (needed for text-field copy/paste to work on macOS).
- **Window:** single window, default 1080×860, min 720×600; remember size/position across launches (a tiny separate `window-state.json` is fine — not part of user data).
- **App name/ID:** "Trailmap", `com.dj.trailmap`. Dock icon: simple ring motif on the palette blue (#2a78d6); generated is fine.
- Quit saves synchronously if a debounced save is pending (`before-quit` flushes).

## 9. Milestones — each with acceptance criteria the agent must verify before moving on

**M1 — Scaffold & parity.** Electron app opens showing the ported UI with sample data (in-memory only). ✅ Accept: `npm start` opens the window; every prototype interaction works (check moves, hero done/skip, edit mode CRUD for goals/initiatives/moves/waiting, later-pile expand, rings/bars animate); dark mode follows the OS; no console errors. Verify with a Playwright script that exercises each interaction, plus screenshots reviewed against the prototype.

**M2 — Persistence.** Storage provider wired end-to-end. ✅ Accept: edits survive quit/relaunch; the live JSON is human-readable; `.tmp`-then-rename observable in the code; kill-test passes (start a save loop, `kill -9` the app repeatedly, file never fails validation on next load); corrupting the live file by hand → next launch offers snapshot restore and preserves the corrupt file; every save produces a snapshot and tiered pruning behaves per §4.3 (verify with a clock-mocked unit test); external-modification watching works per §10 (out-of-band edit while running → UI reloads, nothing clobbered); disk-full/permission failures leave the old file intact; first run seeds sample data.

**M3 — Notifications.** ✅ Accept: unit tests cover tier logic (crossing 5d fires once, 10d fires once, received chips never fire, already-tier-2 chips stay silent); a manual/scripted run with a fixture containing 4d/6d/11d chips fires exactly two notifications; relaunch fires none again; 9am scheduler survives sleep/wake (timer re-arms on `powerMonitor` resume).

**M4 — Shell polish.** ✅ Accept: all File-menu items work (export → file matches live doc; import of a prototype-format export succeeds and snapshots first; restore-snapshot round-trips); window state persists; copy/paste works in edit fields; app has name + icon.

**M5 — Package.** `electron-builder` produces an unsigned universal (or at minimum arm64) `.dmg`. ✅ Accept: on a clean account/machine simulation, mounting the dmg, dragging to Applications, right-click → Open launches; data lands in Application Support; a second launch finds it.

Do the milestones in order; do not start M(n+1) with M(n) acceptance failing.

## 10. Testing strategy (cross-cutting)

- **Unit (node:test):** all pure logic from §6.5 — percentage math, momentum windows (both the 7-day week and the calendar-quarter window, including Q4→Q1 year boundary), age tiers, today's-move selection (including the least-momentum ordering and skip cycling), validation, import-format tolerance, snapshot pruning.
- **Date-math edge cases:** aging and momentum computations tested across DST transitions (spring-forward and fall-back), year boundaries, and system-timezone changes. The 9am notification timer must re-arm correctly after sleep/wake (`powerMonitor` resume) and across DST — test with mocked clocks.
- **External-modification safety (required — this file WILL be edited by other tools):** the owner's workflow includes editing the live JSON by hand or via Claude while the app may be open. Main process watches the live file; on an external change (mtime/content differs from last self-write), reload and re-render — and if there are unsaved in-app changes, prompt which side wins, snapshotting both first. The app must never silently overwrite an external edit with stale state. E2E test: modify the file out-of-band while the app runs; assert the UI updates and no data is lost.
- **Injection safety:** every user-text field (goal/initiative/move names, sub, who/what, title) rendered via `textContent`/attribute-safe paths only. Automated test seeds a fixture whose every field is `<img src=x onerror="document.title='pwned'">` and asserts nothing executes and the strings render literally.
- **Disk misbehavior:** simulated `ENOSPC` (disk full) and `EACCES` (permissions) on save → old file remains intact and valid, user sees a non-fatal error notice, app keeps running. Unit-test the provider with an injected failing `fs`.
- **Reversibility enforcement:** an automated check (lint rule or a simple CI script) fails the build if anything under `renderer/` references `require`, `process`, `electron`, or Node built-ins. The §2 rule is enforced by machine, not honor.
- **Accessibility floor:** the whole app is operable by keyboard alone (tab to any check/chip/button, Enter/Space activates); focus states visible; rings and progress bars carry `role="img"`/`aria-label` with goal name + percentage; `prefers-reduced-motion` disables the pulse/fill animations. Playwright asserts the keyboard path for the core loop (complete a move, mark a chip received).
- **E2E (Playwright, `_electron` launcher):** the M1 interaction sweep, a persistence round-trip (edit → relaunch → assert), an import/export round-trip, the external-modification test, and the keyboard-only core loop.
- **Manual checklist** (write it in the README): dark/light, notification click-through, kill-test, corrupt-file recovery, VoiceOver spot-check.

## 11. Non-goals for v1 — explicitly out

No sync, no multi-user, no accounts, no signing/notarization, no auto-update, no quarter archive, no global hotkey, no menu bar widget, no analytics, no network calls of any kind (the app must work fully offline; a CSP and the absence of any `fetch` should make this auditable).

## 12. Roadmap — future update considerations (design now, build later)

Recorded here at the owner's request so v1 decisions don't foreclose them:

1. **Quarter archive & rollover.** "Close quarter" ceremony: archive the live doc to `archives/2026-Q3.json`, generate a what-shipped retrospective view, carry unfinished moves forward selectively. **Rollover must respect `horizon` (§4.1):** quarter-horizon goals get the close-out treatment; half/year goals carry forward automatically with their history intact, and the retrospective reports their "progress this quarter" from `doneAt` dates. *v1 hook: the `horizon` field and quarter-windowed momentum math already exist.*
2. **Better storage.** Owner wants a more robust store eventually (likely when archives accumulate and cross-quarter queries appear). *v1 hook: the StorageProvider interface (§5) is the contract; a SQLite provider slots in behind it. Keep the interface honest — no `fs` leaks.*
3. **Global quick-add hotkey.** System-wide keystroke → tiny capture window → move lands in a chosen initiative. *v1 hook: the single-writer IPC rule (§5) already accommodates a second window.*
4. **Signed & notarized distribution** (+ auto-update) when "anyone can use" becomes real. *v1 hook: keep electron-builder config in one file so identity/notarization is additive.*
5. **Menu bar mini-view** (today's move + worst aging chip at a glance).
6. **Web app.** Owner may eventually want Quarter Map in a browser (which is also the realistic road to multi-device and "anyone can use"). *v1 hook: the platform-agnostic-renderer rule (§2) plus the `window.trailmap` interface are the whole strategy — a web build swaps the preload bridge for an HTTP client and the JSON provider for a server-side store; the renderer ships unchanged.*
7. **Inbound integrations** (calendar/email → suggested moves) — far future, revisit deliberately.

## 13. Open items the agent may decide alone

Icon aesthetics; exact snapshot-picker UI (menu vs. simple dialog); Playwright version pinning; whether to add a subtle "saved ✓" indicator in the window (nice, not required). Anything beyond these — especially anything that changes §2 decisions or visible behavior — stop and ask the owner.
