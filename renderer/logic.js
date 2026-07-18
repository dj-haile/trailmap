// Trailmap — pure domain logic. Platform-agnostic: no DOM, no Electron, no Node.
// Every threshold/window the app uses lives in CONSTANTS below (plan §6.4).

export const CONSTANTS = Object.freeze({
  VISIBLE_OPEN: 3,      // Now/Later rule: open moves visible per initiative
  VISIBLE_DONE: 2,      // completed moves shown before collapsing to a count
  AGE_WARN_DAYS: 5,     // waiting-on chip turns amber
  AGE_CRIT_DAYS: 10,    // waiting-on chip turns red
  WEEK_WINDOW_DAYS: 7,  // "this week" momentum window
  SAVE_DEBOUNCE_MS: 500,
  NOTIFY_HOUR: 9,       // daily notification check, local time
});

export const HORIZONS = Object.freeze(['quarter', 'half', 'year']);

/**
 * Days elapsed from an ISO date (YYYY-MM-DD) to `today` (Date). Never negative.
 * Compares calendar dates (local midnights), so time-of-day never skews the
 * count, and Math.round absorbs the ±1h from DST transitions.
 */
export function ageDays(sinceISO, today) {
  const since = new Date(sinceISO + 'T00:00:00');
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.round((t - since) / 86400000));
}

export function ageClass(days) {
  if (days >= CONSTANTS.AGE_CRIT_DAYS) return 'crit';
  if (days >= CONSTANTS.AGE_WARN_DAYS) return 'warn';
  return 'ok';
}

export function initPct(init) {
  if (!init.moves.length) return 0;
  return init.moves.filter(m => m.done).length / init.moves.length;
}

export function goalPct(goal) {
  const all = goal.inits.flatMap(it => it.moves);
  if (!all.length) return 0;
  return all.filter(m => m.done).length / all.length;
}

/** First day of the calendar quarter containing `today`, as YYYY-MM-DD. */
export function quarterStartISO(today) {
  const q = Math.floor(today.getMonth() / 3);
  const m = q * 3 + 1;
  return `${today.getFullYear()}-${String(m).padStart(2, '0')}-01`;
}

/** Quarter label like "Q3 2026" for `today`. */
export function quarterLabel(today) {
  return `Q${Math.floor(today.getMonth() / 3) + 1} ${today.getFullYear()}`;
}

/**
 * Momentum counters. "Quarter" counts moves whose doneAt falls in the current
 * calendar quarter (plan §6.4 correction — goals may outlive a quarter).
 * "Week" counts doneAt within the last WEEK_WINDOW_DAYS days.
 * Moves marked done without a doneAt date are excluded from both windows.
 */
export function momentumCounts(doc, today) {
  const qStart = quarterStartISO(today);
  const done = doc.goals.flatMap(g => g.inits.flatMap(it => it.moves))
    .filter(m => m.done && typeof m.doneAt === 'string');
  return {
    quarter: done.filter(m => m.doneAt >= qStart).length,
    week: done.filter(m => ageDays(m.doneAt, today) <= CONSTANTS.WEEK_WINDOW_DAYS).length,
  };
}

/** Open moves eligible for Today's Move: the visible (first VISIBLE_OPEN open) moves of every initiative. */
export function candidateMoves(doc) {
  const out = [];
  for (const g of doc.goals) {
    for (const it of g.inits) {
      for (const m of it.moves.filter(m => !m.done).slice(0, CONSTANTS.VISIBLE_OPEN)) {
        out.push({ goal: g, init: it, move: m });
      }
    }
  }
  return out;
}

/**
 * Today's Move: candidates ordered by least goal momentum (ties keep document
 * order — stable sort), then `skip` cycles through them.
 * Returns null when nothing is open.
 */
export function pickTodaysMove(doc, skip = 0) {
  const cands = candidateMoves(doc);
  if (!cands.length) return null;
  const sorted = [...cands].sort((a, b) => goalPct(a.goal) - goalPct(b.goal));
  return sorted[((skip % sorted.length) + sorted.length) % sorted.length];
}

/** Goal horizon with default (plan §4.1). */
export function goalHorizon(goal) {
  return HORIZONS.includes(goal.horizon) ? goal.horizon : 'quarter';
}

/** Cycle to the next horizon value (edit-mode control). */
export function nextHorizon(h) {
  return HORIZONS[(HORIZONS.indexOf(h) + 1) % HORIZONS.length];
}

/** Short random id. */
export function newId(prefix) {
  const rand = (globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2)).replace(/-/g, '').slice(0, 8);
  return `${prefix}_${rand}`;
}

/** Notification tier for a waiting chip aged `days`: 0 none, 1 warn (≥5d), 2 crit (≥10d). */
export function waitingTier(days) {
  if (days >= CONSTANTS.AGE_CRIT_DAYS) return 2;
  if (days >= CONSTANTS.AGE_WARN_DAYS) return 1;
  return 0;
}

/**
 * Waiting-on chips whose tier has risen past what was already notified
 * (plan §7 — one notification per chip per tier, ever). Pure: does not mutate.
 */
export function pendingWaitingNotifications(doc, today) {
  const out = [];
  for (const g of doc.goals) {
    for (const it of g.inits) {
      for (const w of it.waiting) {
        const days = ageDays(w.since, today);
        const tier = waitingTier(days);
        const last = w.lastNotifiedTier || 0;
        if (tier > last) {
          out.push({ waitId: w.id, who: w.who, what: w.what, days, tier, goalName: g.name, initName: it.name });
        }
      }
    }
  }
  return out;
}

/** Record that a chip has been notified at `tier` (never lowers the recorded tier). */
export function applyNotifiedTier(doc, waitId, tier) {
  for (const g of doc.goals) for (const it of g.inits) for (const w of it.waiting) {
    if (w.id === waitId) w.lastNotifiedTier = Math.max(w.lastNotifiedTier || 0, tier);
  }
}

/**
 * Structural validation (plan §4.2). Returns a list of problems; empty = valid.
 * Tolerant of unknown extra fields (forward compatibility, §4.2).
 */
export function validateDoc(doc) {
  const errs = [];
  const isStr = v => typeof v === 'string';
  const isDate = v => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
  if (!doc || typeof doc !== 'object') return ['document is not an object'];
  if (!isStr(doc.title)) errs.push('title missing');
  if (!Array.isArray(doc.goals)) return [...errs, 'goals is not an array'];
  doc.goals.forEach((g, gi) => {
    if (!isStr(g?.id)) errs.push(`goal[${gi}] missing id`);
    if (!isStr(g?.name)) errs.push(`goal[${gi}] missing name`);
    if (g?.horizon !== undefined && !HORIZONS.includes(g.horizon)) errs.push(`goal[${gi}] bad horizon`);
    if (!Array.isArray(g?.inits)) { errs.push(`goal[${gi}] inits not an array`); return; }
    g.inits.forEach((it, ii) => {
      if (!isStr(it?.id)) errs.push(`goal[${gi}].init[${ii}] missing id`);
      if (!isStr(it?.name)) errs.push(`goal[${gi}].init[${ii}] missing name`);
      if (!Array.isArray(it?.moves)) errs.push(`goal[${gi}].init[${ii}] moves not an array`);
      else it.moves.forEach((m, mi) => {
        if (!isStr(m?.id)) errs.push(`goal[${gi}].init[${ii}].move[${mi}] missing id`);
        if (!isStr(m?.label)) errs.push(`goal[${gi}].init[${ii}].move[${mi}] missing label`);
        if (typeof m?.done !== 'boolean') errs.push(`goal[${gi}].init[${ii}].move[${mi}] missing done`);
        if (m?.doneAt !== undefined && !isDate(m.doneAt)) errs.push(`goal[${gi}].init[${ii}].move[${mi}] bad doneAt`);
      });
      if (!Array.isArray(it?.waiting)) errs.push(`goal[${gi}].init[${ii}] waiting not an array`);
      else it.waiting.forEach((w, wi) => {
        if (!isStr(w?.id)) errs.push(`goal[${gi}].init[${ii}].wait[${wi}] missing id`);
        if (!isStr(w?.who)) errs.push(`goal[${gi}].init[${ii}].wait[${wi}] missing who`);
        if (!isStr(w?.what)) errs.push(`goal[${gi}].init[${ii}].wait[${wi}] missing what`);
        if (!isDate(w?.since)) errs.push(`goal[${gi}].init[${ii}].wait[${wi}] bad since`);
      });
    });
  });
  return errs;
}

/** Accept the prototype's export format: missing schemaVersion → 1; defaults filled, unknown fields preserved. */
export function normalizeDoc(doc) {
  if (doc.schemaVersion === undefined) doc.schemaVersion = 1;
  for (const g of doc.goals ?? []) {
    if (g && g.sub === undefined) g.sub = '';
    for (const it of g?.inits ?? []) {
      for (const w of it?.waiting ?? []) {
        if (w && w.lastNotifiedTier === undefined) w.lastNotifiedTier = 0;
      }
    }
  }
  return doc;
}
