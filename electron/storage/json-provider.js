// Trailmap v1 storage: one human-readable JSON file + per-save snapshots.
// Plan §4–§5. Atomic writes are NON-NEGOTIABLE: temp file → fsync → rename.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const LIVE_NAME = 'trailmap.json';
const SNAP_DIR = 'snapshots';
const SNAP_PREFIX = 'trailmap-';

// Tiered retention (plan §4.3)
const KEEP_ALL_MS = 24 * 3600 * 1000;        // keep every snapshot from the last 24h
const KEEP_DAILY_MS = 90 * 24 * 3600 * 1000; // older: last-of-day, out to 90 days
const HARD_CAP = 1000;

let logicPromise = null;
function logic() {
  // Shared pure module lives with the renderer (ESM); main is CJS → dynamic import.
  if (!logicPromise) {
    const p = path.join(__dirname, '..', '..', 'renderer', 'logic.js');
    logicPromise = import(pathToFileURL(p).href);
  }
  return logicPromise;
}

class CorruptError extends Error {
  constructor(file, problems) {
    super(`corrupt document at ${file}: ${problems.slice(0, 3).join('; ')}`);
    this.code = 'CORRUPT';
    this.problems = problems;
  }
}

class ConflictError extends Error {
  constructor(raw) {
    super('live file changed on disk since our last write');
    this.code = 'CONFLICT';
    this.raw = raw; // the external content, so the caller can resolve
  }
}

class JsonProvider {
  /**
   * @param {string} dir data directory
   * @param {{fs?: typeof fs, now?: () => Date, seedPath?: string}} [opts]
   *   fs/now are injectable for tests (disk-failure + pruning clock).
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.fs = opts.fs || fs;
    this.now = opts.now || (() => new Date());
    this.seedPath = opts.seedPath || null;
    this.file = path.join(dir, LIVE_NAME);
    this.snapDir = path.join(dir, SNAP_DIR);
    this._lastSaved = null;
    this._logicSync = null; // cached module for sync paths
  }

  lastSavedContent() { return this._lastSaved; }

  liveFileExists() { return this.fs.existsSync(this.file); }

  /** Read-only facts for the "Where Is My Data…" dialog. Never touches the doc. */
  async info() {
    const exists = this.fs.existsSync(this.file);
    const entries = this._entries(); // newest first
    return {
      file: this.file,
      exists,
      snapDir: this.snapDir,
      savedAtISO: exists ? this.fs.statSync(this.file).mtime.toISOString() : null,
      snapshotCount: entries.length,
      newestSnapshotISO: entries.length ? new Date(entries[0].mtime).toISOString() : null,
    };
  }

  _ensureDirs() {
    this.fs.mkdirSync(this.snapDir, { recursive: true });
  }

  async _validate(doc) {
    const L = await logic();
    this._logicSync = L;
    const norm = L.normalizeDoc(doc);
    const errs = L.validateDoc(norm);
    return { norm, errs };
  }

  async load() {
    this._ensureDirs();
    if (!this.fs.existsSync(this.file)) {
      if (!this.seedPath) throw Object.assign(new Error('no data file'), { code: 'MISSING' });
      const seeded = JSON.parse(this.fs.readFileSync(this.seedPath, 'utf8'));
      const { norm, errs } = await this._validate(seeded);
      if (errs.length) throw new CorruptError(this.seedPath, errs);
      await this.save(norm);
      return norm;
    }
    const raw = this.fs.readFileSync(this.file, 'utf8');
    let doc;
    try { doc = JSON.parse(raw); }
    catch (e) { throw new CorruptError(this.file, ['not valid JSON: ' + e.message]); }
    const { norm, errs } = await this._validate(doc);
    if (errs.length) throw new CorruptError(this.file, errs);
    this._lastSaved = raw;
    return norm;
  }

  /** Parse + validate arbitrary content (watcher uses this for external edits). */
  async parseExternal(raw) {
    let doc;
    try { doc = JSON.parse(raw); } catch (e) { return { doc: null, errs: ['not valid JSON'] }; }
    const { norm, errs } = await this._validate(doc);
    return { doc: errs.length ? null : norm, errs };
  }

  /** Rename an unreadable live file aside for forensics (plan §4.2). Returns new path. */
  markCorrupt() {
    const ts = this._ts();
    const dest = `${this.file}.corrupt-${ts}`;
    this.fs.renameSync(this.file, dest);
    return dest;
  }

  /** Throws {code:'CONFLICT'} if the live file changed since our last write —
   *  a debounced save must never clobber an external edit (plan §10). */
  _checkConflict() {
    if (this._lastSaved === null) return; // first write / adopted external
    if (!this.fs.existsSync(this.file)) return;
    const raw = this.fs.readFileSync(this.file, 'utf8');
    if (raw !== this._lastSaved) throw new ConflictError(raw);
  }

  async save(doc) {
    const { errs } = await this._validate(doc);
    if (errs.length) throw new Error('refusing to save invalid document: ' + errs[0]);
    this._checkConflict();
    this._writeAtomicAndSnapshot(JSON.stringify(doc, null, 1));
  }

  /** Save that intentionally overwrites external changes (conflict already resolved by the user). */
  async forceSave(doc) {
    const { errs } = await this._validate(doc);
    if (errs.length) throw new Error('refusing to save invalid document: ' + errs[0]);
    this._writeAtomicAndSnapshot(JSON.stringify(doc, null, 1));
  }

  /** Synchronous flush for before-quit (plan §8). Skips re-validation: the doc
   *  came through the same IPC path save() already validates. */
  saveSync(doc) {
    this._checkConflict();
    this._writeAtomicAndSnapshot(JSON.stringify(doc, null, 1));
  }

  /** Adopt external content as the new baseline (watcher/conflict resolution). */
  adoptExternal(raw) {
    this._lastSaved = raw;
  }

  _writeAtomicAndSnapshot(json) {
    this._ensureDirs();
    const tmp = this.file + '.tmp';
    // Atomic write (plan §5): tmp in the SAME directory, fsync, rename over.
    const fd = this.fs.openSync(tmp, 'w');
    try {
      this.fs.writeSync(fd, json, null, 'utf8');
      this.fs.fsyncSync(fd);
    } finally {
      this.fs.closeSync(fd);
    }
    this.fs.renameSync(tmp, this.file);
    this._lastSaved = json;
    this._snapshot(json);
    this._prune();
  }

  _ts(d = this.now()) {
    return d.toISOString().replace(/[:.]/g, '-');
  }

  _snapshot(json) {
    const name = `${SNAP_PREFIX}${this._ts()}.json`;
    // Snapshots are write-once copies; a torn snapshot can't hurt the live file,
    // but write via tmp+rename anyway so restores never see a partial file.
    const dest = path.join(this.snapDir, name);
    const tmp = dest + '.tmp';
    this.fs.writeFileSync(tmp, json, 'utf8');
    this.fs.renameSync(tmp, dest);
  }

  /** Snapshot arbitrary content (conflict handling: preserve "their" version). */
  snapshotContent(raw, tag = 'external') {
    this._ensureDirs();
    const dest = path.join(this.snapDir, `${SNAP_PREFIX}${this._ts()}-${tag}.json`);
    this.fs.writeFileSync(dest, raw, 'utf8');
  }

  async snapshotNow() {
    if (this._lastSaved == null && this.fs.existsSync(this.file)) {
      this._lastSaved = this.fs.readFileSync(this.file, 'utf8');
    }
    if (this._lastSaved != null) this._snapshot(this._lastSaved);
    this._prune();
  }

  _entries() {
    if (!this.fs.existsSync(this.snapDir)) return [];
    return this.fs.readdirSync(this.snapDir)
      .filter(f => f.startsWith(SNAP_PREFIX) && f.endsWith('.json'))
      .map(f => {
        const p = path.join(this.snapDir, f);
        const st = this.fs.statSync(p);
        return { id: f, path: p, mtime: st.mtimeMs, bytes: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  async listSnapshots() {
    return this._entries().map(e => ({ id: e.id, timeISO: new Date(e.mtime).toISOString(), bytes: e.bytes }));
  }

  async loadSnapshot(id) {
    if (id.includes('/') || id.includes('..')) throw new Error('bad snapshot id');
    const raw = this.fs.readFileSync(path.join(this.snapDir, id), 'utf8');
    const { doc, errs } = await this.parseExternal(raw);
    if (!doc) throw new CorruptError(id, errs);
    return doc;
  }

  /** Tiered pruning (plan §4.3): 24h all / 90d daily / hard cap. */
  _prune() {
    const nowMs = this.now().getTime();
    const entries = this._entries(); // newest first
    const keep = new Set();
    const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
    const seenDays = new Set();
    for (const e of entries) {
      const age = nowMs - e.mtime;
      if (age <= KEEP_ALL_MS) { keep.add(e.id); continue; }
      if (age <= KEEP_DAILY_MS) {
        const d = dayOf(e.mtime);
        if (!seenDays.has(d)) { seenDays.add(d); keep.add(e.id); } // newest of each day
      }
    }
    let kept = entries.filter(e => keep.has(e.id));
    if (kept.length > HARD_CAP) kept = kept.slice(0, HARD_CAP); // drop oldest beyond cap
    const keepIds = new Set(kept.map(e => e.id));
    for (const e of entries) {
      if (!keepIds.has(e.id)) {
        try { this.fs.unlinkSync(e.path); } catch { /* pruning is best-effort */ }
      }
    }
  }
}

module.exports = { JsonProvider, CorruptError, ConflictError, LIVE_NAME, SNAP_DIR };
