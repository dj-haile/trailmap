// Trailmap renderer. Platform-agnostic (plan §2 reversibility rule):
// talks ONLY to window.trailmap — no Electron, no Node, no network.
import {
  CONSTANTS, ageDays, ageClass, initPct, goalPct, momentumCounts,
  pickTodaysMove, goalHorizon, nextHorizon, newId, quarterLabel,
  dueTier, toISODate, findMoveById, todayItems, pruneToday, suggestionReason, setMoveLabel,
} from './logic.js';

const COLORS = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'];

let S = null;              // the document
let editMode = false;
let heroSkip = 0;
let openForm = null;       // { type: 'move'|'wait'|'init'|'goal', id?: string }
const expanded = new Set(); // initiative ids with the later pile expanded

const bridge = window.trailmap;
const $ = id => document.getElementById(id);
const todayNow = () => new Date();

// ---------- persistence ----------
function persist() {
  // Fire-and-forget; main process debounces and owns the disk (plan §5 single-writer).
  bridge.persist(JSON.parse(JSON.stringify(S)));
}
function mutate(fn) {
  fn();
  persist();
  render();
}

// ---------- helpers ----------
const goalColor = g => g ? `var(${COLORS[S.goals.indexOf(g) % COLORS.length]})` : 'var(--muted)';
const todayISO = () => toISODate(todayNow());
const findMove = id => {
  const f = findMoveById(S, id);
  return f ? { g: f.goal, it: f.init, m: f.move } : null;
};

// ---------- actions ----------
function completeMove(id) {
  mutate(() => {
    const f = findMove(id);
    if (f && !f.m.done) { f.m.done = true; f.m.doneAt = todayISO(); }
  });
}
function uncompleteMove(id) {
  mutate(() => {
    const f = findMove(id);
    if (f && f.m.done) { f.m.done = false; delete f.m.doneAt; }
  });
}
function deleteMove(id) {
  mutate(() => {
    for (const g of S.goals) for (const it of g.inits) it.moves = it.moves.filter(m => m.id !== id);
    S.loose = (S.loose || []).filter(m => m.id !== id);
    S.today = (S.today || []).filter(t => t.moveId !== id);
  });
}
function renameMove(moveId, labelEl) {
  const f = findMove(moveId);
  if (!f || !labelEl) return;
  renameInline(labelEl, f.m.label, v => setMoveLabel(S, moveId, v));
}
// Edit-mode affordances for a move row: a ✎ control, and the label text itself.
function editButton(m, span) {
  const b = document.createElement('button'); b.className = 'rowdel rowedit'; b.textContent = '✎';
  b.title = 'Edit label'; b.setAttribute('aria-label', `Edit: ${m.label}`);
  b.onclick = () => renameMove(m.id, span);
  return b;
}
function editableLabel(m, span) {
  span.classList.add('editable');
  span.onclick = () => renameMove(m.id, span);
}

// ---------- Today workbench (v0.2) ----------
function isPinned(moveId) {
  return (S.today || []).some(t => t.moveId === moveId);
}
function addToToday(moveId) {
  if (isPinned(moveId)) return;
  mutate(() => { (S.today ||= []).push({ id: newId('t'), moveId, addedOn: todayISO() }); });
}
function removeFromToday(moveId) {
  mutate(() => { S.today = (S.today || []).filter(t => t.moveId !== moveId); });
}
function quickAddToday(label) {
  mutate(() => {
    const m = { id: newId('m'), label, done: false };
    (S.loose ||= []).push(m);
    (S.today ||= []).push({ id: newId('t'), moveId: m.id, addedOn: todayISO() });
  });
}
function setDue(moveId, iso) {
  mutate(() => {
    const f = findMove(moveId);
    if (!f) return;
    if (iso) { f.m.due = iso; f.m.lastDueTier = 0; }
    else { delete f.m.due; delete f.m.lastDueTier; }
  });
}
function fileLooseInto(moveId, initId) {
  mutate(() => {
    const idx = (S.loose || []).findIndex(m => m.id === moveId);
    if (idx < 0) return;
    for (const g of S.goals) for (const it of g.inits) {
      if (it.id === initId) {
        it.moves.push(S.loose.splice(idx, 1)[0]);
        return;
      }
    }
  });
}
function bumpMove(id) {
  mutate(() => {
    for (const g of S.goals) for (const it of g.inits) {
      const i = it.moves.findIndex(m => m.id === id);
      if (i > 0) { const [m] = it.moves.splice(i, 1); it.moves.unshift(m); }
    }
  });
}
function receiveWaiting(itId, wId) {
  mutate(() => {
    for (const g of S.goals) for (const it of g.inits) {
      if (it.id === itId) it.waiting = it.waiting.filter(w => w.id !== wId);
    }
  });
}
function deleteInit(id) {
  mutate(() => { for (const g of S.goals) g.inits = g.inits.filter(it => it.id !== id); });
}
function deleteGoal(id) {
  mutate(() => { S.goals = S.goals.filter(g => g.id !== id); });
}
function cycleHorizon(goal) {
  mutate(() => { goal.horizon = nextHorizon(goalHorizon(goal)); });
}

// ---------- inline forms & rename ----------
function formHTML(type) {
  if (type === 'wait') return `
    <input placeholder="Who (person/team)" data-f="1" aria-label="Who are you waiting on">
    <input placeholder="What you're waiting for" data-f="2" aria-label="What are you waiting for">
    <button data-ok>Add</button>`;
  if (type === 'goal') return `
    <input placeholder="Priority name" data-f="1" aria-label="Priority name">
    <input placeholder="Short tagline (optional)" data-f="2" aria-label="Tagline">
    <button data-ok>Add</button>`;
  return `<input placeholder="${type === 'init' ? 'Initiative name' : 'Next move — start with a verb'}" data-f="1" aria-label="${type === 'init' ? 'Initiative name' : 'Move label'}">
    <button data-ok>Add</button>`;
}
function mountForm(container, type, onsubmit) {
  const f = document.createElement('div');
  f.className = 'inline-form';
  f.innerHTML = formHTML(type);
  container.appendChild(f);
  const i1 = f.querySelector('[data-f="1"]');
  i1.focus();
  const submit = () => {
    if (!i1.value.trim()) return;
    const v2el = f.querySelector('[data-f="2"]');
    openForm = null;
    mutate(() => onsubmit(i1.value.trim(), v2el ? v2el.value.trim() : ''));
  };
  f.querySelector('[data-ok]').addEventListener('click', submit);
  f.addEventListener('keydown', e => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') { openForm = null; render(); }
  });
}
function renameInline(el, current, save) {
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = current;
  el.replaceChildren(input);
  input.focus(); input.select();
  input.addEventListener('blur', () => {
    if (input.value.trim()) mutate(() => save(input.value.trim()));
    else render();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') render();
  });
}

// ---------- render ----------
function render() {
  const today = todayNow();

  // title
  const titleEl = $('title-text');
  titleEl.textContent = S.title;
  document.title = S.title;
  titleEl.style.cursor = editMode ? 'text' : 'default';
  titleEl.onclick = editMode ? () => renameInline(titleEl, S.title, v => { S.title = v; }) : null;

  // momentum
  const mc = momentumCounts(S, today);
  $('momentum').innerHTML =
    `<b>▲ ${mc.quarter} move${mc.quarter === 1 ? '' : 's'} shipped</b> in ${quarterLabel(today)} · ${mc.week} this week`;

  // edit toggle
  const et = $('editToggle');
  et.classList.toggle('active', editMode);
  et.setAttribute('aria-pressed', String(editMode));
  et.textContent = editMode ? '✓ Done editing' : '✎ Edit the map';
  $('addgoal').hidden = !editMode;

  renderHero(today);
  renderGoals(today);
  renderLoose(today);

  if (openForm && openForm.type === 'goal' && !document.getElementById('goalform')) {
    const holder = document.createElement('div');
    holder.id = 'goalform';
    holder.className = 'init';
    mountForm(holder, 'goal', (v1, v2) => S.goals.push({ id: newId('g'), name: v1, sub: v2, inits: [] }));
    $('goals').appendChild(holder);
  }
}

function dueChip(m, today) {
  const tier = dueTier(m, today);
  if (!m.due || m.done) return null;
  const chip = document.createElement('span');
  chip.className = 'due-chip' + (tier === 2 ? ' overdue' : tier === 1 ? ' duetoday' : '');
  const t = toISODate(today);
  if (tier === 2) {
    const days = Math.round((new Date(t) - new Date(m.due)) / 86400000);
    chip.textContent = `⚑ overdue ${days}d`;
  } else if (tier === 1) chip.textContent = '⚑ due today';
  else chip.textContent = `⚑ due ${m.due.slice(5).replace('-', '/')}`;
  return chip;
}

function renderHero(today) {
  const hero = $('hero');
  hero.classList.remove('alldone');
  hero.replaceChildren();

  // Welcome state: a brand-new empty map (no goals, nothing captured yet)
  if (!S.goals.length && !(S.today || []).length && !(S.loose || []).some(m => !m.done)) {
    const wrap = document.createElement('div'); wrap.className = 'welcome';
    const h = document.createElement('div'); h.className = 'welcome-title';
    h.textContent = '🗺 Your map is empty — plant the first flag';
    const p = document.createElement('div'); p.className = 'welcome-body';
    p.textContent = 'Add a quarterly priority, then initiatives under it, then the next moves. Or quick-add a to-do below to just get moving. (File → Load Sample Data shows a filled-in example.)';
    const b = document.createElement('button'); b.className = 'welcome-cta';
    b.textContent = '＋ Add your first priority';
    b.onclick = () => { editMode = true; openForm = { type: 'goal' }; render(); };
    const qa = document.createElement('div'); qa.className = 'quickadd';
    const input = document.createElement('input');
    input.id = 'quickadd';
    input.placeholder = 'Add a to-do for today…';
    input.setAttribute('aria-label', 'Add a to-do for today');
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && input.value.trim()) quickAddToday(input.value.trim());
    });
    qa.appendChild(input);
    wrap.append(h, p, b, qa);
    hero.appendChild(wrap);
    return;
  }

  const head = document.createElement('div'); head.className = 'today-head';
  const lbl = document.createElement('div'); lbl.className = 'lbl';
  lbl.textContent = '☀️ Today — before the meetings eat you';
  head.appendChild(lbl);
  hero.appendChild(head);

  // pinned items
  const items = todayItems(S);
  for (const { entry, goal, init, move } of items) {
    const row = document.createElement('div');
    row.className = 'today-item' + (move.done ? ' done' : '');
    const chk = document.createElement('button'); chk.className = 'chk'; chk.textContent = '✓';
    if (move.done) { chk.style.background = goalColor(goal); chk.classList.add('checked'); }
    else { chk.title = 'Done'; chk.setAttribute('aria-label', `Complete: ${move.label}`); chk.onclick = () => completeMove(move.id); }
    const mid = document.createElement('div'); mid.className = 'ti-mid';
    const lab = document.createElement('span'); lab.className = 'ti-label mlabel'; lab.textContent = move.label;
    const src = document.createElement('span'); src.className = 'ti-src';
    src.textContent = init ? init.name : 'loose end';
    const dot = document.createElement('span'); dot.className = 'ti-dot'; dot.style.background = goalColor(goal);
    mid.append(dot, lab, src);
    const d = dueChip(move, today); if (d) mid.appendChild(d);
    const unpin = document.createElement('button'); unpin.className = 'ti-unpin'; unpin.textContent = '✕';
    unpin.title = 'Remove from Today (keeps the task)';
    unpin.setAttribute('aria-label', `Remove from Today: ${move.label}`);
    unpin.onclick = () => removeFromToday(move.id);
    row.append(chk, mid, unpin);
    row.addEventListener('contextmenu', e => openContextMenu(e, move.id));
    hero.appendChild(row);
  }

  // quick add
  const qa = document.createElement('div'); qa.className = 'quickadd';
  const input = document.createElement('input');
  input.id = 'quickadd';
  input.placeholder = items.length ? 'Add another to-do for today…' : 'Add a to-do for today…';
  input.setAttribute('aria-label', 'Add a to-do for today');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && input.value.trim()) quickAddToday(input.value.trim());
  });
  qa.appendChild(input);
  hero.appendChild(qa);

  // suggestion fills the gap when nothing is pinned (or on demand via ↻)
  const openPinned = items.filter(x => !x.move.done);
  if (openPinned.length === 0) {
    const pick = pickTodaysMove(S, heroSkip, today);
    const sug = document.createElement('div'); sug.className = 'suggestion';
    if (!pick) {
      sug.classList.add('alldone');
      sug.textContent = items.length
        ? '🎉 Today is done. Add more, or go home proud.'
        : '🎉 Every visible move is shipped. Promote something from “later,” or go home early.';
    } else {
      const slbl = document.createElement('div'); slbl.className = 'sug-lbl'; slbl.textContent = 'Suggestion';
      const mv = document.createElement('div'); mv.className = 'move';
      const dot = document.createElement('span'); dot.style.color = goalColor(pick.goal); dot.textContent = '● ';
      mv.append(dot, document.createTextNode(pick.move.label));
      const dch = dueChip(pick.move, today); if (dch) mv.appendChild(dch);
      const why = document.createElement('div'); why.className = 'why';
      why.textContent = suggestionReason(pick, today);
      const actions = document.createElement('div'); actions.className = 'actions';
      const skip = document.createElement('button'); skip.title = 'Suggest something else'; skip.textContent = '↻';
      skip.setAttribute('aria-label', 'Suggest a different move');
      skip.onclick = () => { heroSkip++; render(); };
      const pin = document.createElement('button'); pin.textContent = '☀ Pin to Today';
      pin.setAttribute('aria-label', `Pin to Today: ${pick.move.label}`);
      pin.onclick = () => addToToday(pick.move.id);
      const done = document.createElement('button'); done.className = 'primary'; done.textContent = 'Done ✓';
      done.onclick = () => completeMove(pick.move.id);
      actions.append(skip, pin, done);
      const mid = document.createElement('div'); mid.append(slbl, mv, why);
      sug.append(mid, actions);
    }
    hero.appendChild(sug);
  }
}

// ---------- loose ends (v0.2) ----------
function renderLoose(today) {
  const existing = document.getElementById('loose-card');
  if (existing) existing.remove();
  const open = (S.loose || []).filter(m => !m.done);
  if (!open.length) return;
  const card = document.createElement('div');
  card.id = 'loose-card';
  card.className = 'init loose-card';
  const head = document.createElement('div'); head.className = 'init-head';
  const iname = document.createElement('span'); iname.className = 'iname'; iname.textContent = 'Loose ends';
  const note = document.createElement('span'); note.className = 'ipct'; note.textContent = 'not tied to a goal — right-click to file';
  head.append(iname, note);
  card.appendChild(head);
  for (const m of open) {
    const row = document.createElement('div'); row.className = 'move-row';
    const chk = document.createElement('button'); chk.className = 'chk'; chk.textContent = '✓';
    chk.title = 'Done'; chk.setAttribute('aria-label', `Complete: ${m.label}`);
    chk.onclick = () => completeMove(m.id);
    const span = document.createElement('span'); span.className = 'mlabel'; span.textContent = m.label;
    row.append(chk, span);
    const d = dueChip(m, today); if (d) row.appendChild(d);
    if (editMode) { editableLabel(m, span); row.appendChild(editButton(m, span)); }
    row.addEventListener('contextmenu', e => openContextMenu(e, m.id));
    card.appendChild(row);
  }
  $('goals').after(card);
}

// ---------- context menu (v0.2; pure DOM — no platform APIs) ----------
function closeContextMenu() {
  document.getElementById('ctx-menu')?.remove();
}
function openContextMenu(e, moveId) {
  e.preventDefault();
  closeContextMenu();
  const f = findMove(moveId);
  if (!f || (f.m.done && !isPinned(moveId))) return;
  const menu = document.createElement('div');
  menu.id = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  const add = (label, fn, cls) => {
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = (ev) => {
      ev.stopPropagation(); // keep the document-level dismiss from racing what fn() opens
      document.removeEventListener('click', closeContextMenu);
      closeContextMenu();
      fn();
    };
    menu.appendChild(b);
  };
  const labelEl = e.currentTarget?.querySelector?.('.mlabel');
  if (labelEl) add('✎ Edit label…', () => renameMove(moveId, labelEl));
  if (!f.m.done) {
    if (isPinned(moveId)) add('✕ Remove from Today', () => removeFromToday(moveId));
    else add('☀ Add to Today', () => addToToday(moveId));
    if (f.m.due) {
      add('⚑ Change due date…', () => promptDue(moveId, f.m.due));
      add('Clear due date', () => setDue(moveId, null));
    } else {
      add('⚑ Set due date…', () => promptDue(moveId, ''));
    }
    if (!f.it) {
      for (const g of S.goals) for (const it of g.inits) {
        add(`→ file under: ${it.name}`, () => fileLooseInto(moveId, it.id), 'ctx-file');
      }
    }
  }
  add('🗑 Delete', () => deleteMove(moveId), 'ctx-del');
  document.body.appendChild(menu);
  const { innerWidth: W, innerHeight: H } = window;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(e.clientX, W - r.width - 8) + 'px';
  menu.style.top = Math.min(e.clientY, H - r.height - 8) + 'px';
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
    document.addEventListener('keydown', function esc(ev) {
      if (ev.key === 'Escape') { closeContextMenu(); document.removeEventListener('keydown', esc); }
    });
  }, 0);
}
function promptDue(moveId, current) {
  closeContextMenu();
  const wrap = document.createElement('div');
  wrap.id = 'ctx-menu';
  wrap.addEventListener('click', e => e.stopPropagation()); // clicks inside must not dismiss
  const input = document.createElement('input');
  input.type = 'date';
  input.value = current || todayISO();
  const ok = document.createElement('button'); ok.textContent = 'Set due date';
  ok.onclick = () => { if (input.value) setDue(moveId, input.value); closeContextMenu(); };
  wrap.append(input, ok);
  document.body.appendChild(wrap);
  wrap.style.left = '50%'; wrap.style.top = '30%'; wrap.style.transform = 'translateX(-50%)';
  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
  input.focus();
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') ok.click();
    if (e.key === 'Escape') closeContextMenu();
  });
}

function renderGoals(today) {
  const root = $('goals');
  root.replaceChildren();
  for (const g of S.goals) root.appendChild(renderGoal(g, today));
}

function renderGoal(g, today) {
  const c = goalColor(g);
  const pct = goalPct(g);
  const sec = document.createElement('div');
  sec.className = 'goal';

  // left column
  const left = document.createElement('div'); left.className = 'goal-left';
  const r = 30, circ = 2 * Math.PI * r;
  const ring = document.createElement('div'); ring.className = 'ring';
  ring.setAttribute('role', 'img');
  ring.setAttribute('aria-label', `${g.name}: ${Math.round(pct * 100)} percent complete`);
  ring.innerHTML = `
    <svg width="74" height="74" viewBox="0 0 74 74" aria-hidden="true">
      <circle cx="37" cy="37" r="${r}" fill="none" stroke="var(--grid)" stroke-width="7"/>
      <circle cx="37" cy="37" r="${r}" fill="none" stroke="${c}" stroke-width="7"
        stroke-linecap="round" stroke-dasharray="${circ * pct} ${circ}"
        style="transition: stroke-dasharray 0.6s ease;"/>
    </svg>
    <div class="pct">${pct === 1 ? '✓' : Math.round(pct * 100) + '%'}</div>`;
  const nameWrap = document.createElement('div');
  const gname = document.createElement('div'); gname.className = 'gname'; gname.textContent = g.name;
  const gsub = document.createElement('div'); gsub.className = 'gsub'; gsub.textContent = g.sub || '';
  nameWrap.append(gname, gsub);
  const hz = goalHorizon(g);
  if (editMode) {
    const tag = document.createElement('button');
    tag.className = 'horizon-tag';
    tag.textContent = hz;
    tag.title = 'Click to cycle horizon: quarter → half → year';
    tag.onclick = () => cycleHorizon(g);
    nameWrap.appendChild(tag);
  } else if (hz !== 'quarter') {
    const tag = document.createElement('span');
    tag.className = 'horizon-tag';
    tag.textContent = hz;
    nameWrap.appendChild(tag);
  }
  left.append(ring, nameWrap);
  if (editMode) {
    const ge = document.createElement('div'); ge.className = 'goal-edit';
    const addInit = document.createElement('button'); addInit.textContent = '＋ initiative';
    addInit.onclick = () => { openForm = { type: 'init', id: g.id }; render(); };
    const ren = document.createElement('button'); ren.textContent = 'rename';
    ren.onclick = () => renameInline(gname, g.name, v => { g.name = v; });
    const del = document.createElement('button'); del.textContent = 'delete'; del.className = 'del';
    del.onclick = () => deleteGoal(g.id);
    ge.append(addInit, ren, del);
    left.appendChild(ge);
  }

  // trunk
  const trunk = document.createElement('div'); trunk.className = 'trunk';
  trunk.innerHTML = `<svg preserveAspectRatio="none" viewBox="0 0 26 100" aria-hidden="true">
    ${g.inits.length > 1
      ? `<path d="M 0 50 C 14 50, 12 25, 26 25" fill="none" stroke="${c}" stroke-width="1.5" opacity="0.5"/>
         <path d="M 0 50 C 14 50, 12 75, 26 75" fill="none" stroke="${c}" stroke-width="1.5" opacity="0.5"/>`
      : `<path d="M 0 50 L 26 50" fill="none" stroke="${c}" stroke-width="1.5" opacity="0.5"/>`}
  </svg>`;

  // right column
  const right = document.createElement('div'); right.className = 'goal-right';
  for (const it of g.inits) right.appendChild(renderInit(g, it, c, today));
  if (openForm && openForm.type === 'init' && openForm.id === g.id) {
    const holder = document.createElement('div'); holder.className = 'init';
    mountForm(holder, 'init', v1 => g.inits.push({ id: newId('i'), name: v1, moves: [], waiting: [] }));
    right.appendChild(holder);
  }

  sec.append(left, trunk, right);
  return sec;
}

function renderInit(g, it, c, today) {
  const card = document.createElement('div');
  card.className = 'init';
  const ip = initPct(it);

  const head = document.createElement('div'); head.className = 'init-head';
  const iname = document.createElement('span'); iname.className = 'iname'; iname.textContent = it.name;
  const ipctEl = document.createElement('span'); ipctEl.className = 'ipct'; ipctEl.textContent = Math.round(ip * 100) + '%';
  head.append(iname, ipctEl);
  const bar = document.createElement('div'); bar.className = 'initbar';
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `${it.name}: ${Math.round(ip * 100)} percent complete`);
  const fill = document.createElement('div');
  fill.style.width = (ip * 100) + '%';
  fill.style.background = c;
  bar.appendChild(fill);
  card.append(head, bar);

  // done moves
  const doneMoves = it.moves.filter(m => m.done);
  const shownDone = doneMoves.slice(-CONSTANTS.VISIBLE_DONE);
  const hiddenDone = doneMoves.length - shownDone.length;
  for (const m of shownDone) {
    const row = document.createElement('div');
    row.className = 'move-row done';
    const chk = document.createElement('button'); chk.className = 'chk';
    chk.style.background = c; chk.textContent = '✓';
    chk.title = editMode ? 'Un-complete' : 'Done';
    chk.setAttribute('aria-label', `${m.label} — completed${editMode ? '; activate to un-complete' : ''}`);
    if (editMode) chk.onclick = () => uncompleteMove(m.id);
    const span = document.createElement('span'); span.className = 'mlabel'; span.textContent = m.label;
    row.append(chk, span);
    if (editMode) { editableLabel(m, span); row.appendChild(editButton(m, span)); }
    card.appendChild(row);
  }
  if (hiddenDone > 0) {
    const sn = document.createElement('div'); sn.className = 'shipped-note';
    sn.textContent = `✓ ${hiddenDone} more shipped earlier`;
    card.appendChild(sn);
  }

  // open moves
  const openM = it.moves.filter(m => !m.done);
  const isExpanded = expanded.has(it.id);
  const shownOpen = isExpanded ? openM : openM.slice(0, CONSTANTS.VISIBLE_OPEN);
  for (const m of shownOpen) {
    const row = document.createElement('div');
    row.className = 'move-row';
    const chk = document.createElement('button'); chk.className = 'chk'; chk.textContent = '✓';
    chk.title = 'Done'; chk.setAttribute('aria-label', `Complete: ${m.label}`);
    chk.onclick = () => completeMove(m.id);
    const span = document.createElement('span'); span.className = 'mlabel'; span.textContent = m.label;
    row.append(chk, span);
    const dch = dueChip(m, today); if (dch) row.appendChild(dch);
    if (isPinned(m.id)) {
      const sun = document.createElement('span'); sun.className = 'pin-mark'; sun.textContent = '☀';
      sun.title = 'On today’s list';
      row.appendChild(sun);
    }
    row.addEventListener('contextmenu', e => openContextMenu(e, m.id));
    if (editMode) {
      editableLabel(m, span);
      row.appendChild(editButton(m, span)); // first control: .rowdel's margin-left:auto pushes the group right
      const bump = document.createElement('button'); bump.className = 'rowdel'; bump.textContent = '↑';
      bump.title = 'Move to top'; bump.setAttribute('aria-label', `Move to top: ${m.label}`);
      bump.onclick = () => bumpMove(m.id);
      const del = document.createElement('button'); del.className = 'rowdel'; del.textContent = '✕';
      del.title = 'Delete'; del.setAttribute('aria-label', `Delete: ${m.label}`);
      del.onclick = () => deleteMove(m.id);
      row.append(bump, del);
    }
    card.appendChild(row);
  }
  const laterCount = openM.length - Math.min(openM.length, CONSTANTS.VISIBLE_OPEN);
  if (laterCount > 0 && !isExpanded) {
    const ln = document.createElement('button'); ln.className = 'later-note';
    ln.textContent = `+ ${laterCount} more waiting invisibly — click to peek`;
    ln.onclick = () => { expanded.add(it.id); render(); };
    card.appendChild(ln);
  } else if (isExpanded && openM.length > CONSTANTS.VISIBLE_OPEN) {
    const ln = document.createElement('button'); ln.className = 'later-note';
    ln.textContent = '– hide the later pile again';
    ln.onclick = () => { expanded.delete(it.id); render(); };
    card.appendChild(ln);
  }

  // waiting shelf
  if (it.waiting.length > 0) {
    const shelf = document.createElement('div'); shelf.className = 'wait-shelf';
    const lbl = document.createElement('span'); lbl.className = 'shelf-lbl'; lbl.textContent = 'Waiting on';
    shelf.appendChild(lbl);
    for (const w of it.waiting) {
      const d = ageDays(w.since, today);
      const chip = document.createElement('button');
      chip.className = 'chip ' + ageClass(d);
      chip.title = 'Click to mark received';
      chip.setAttribute('aria-label', `Waiting on ${w.who} for ${w.what}, ${d} days; activate to mark received`);
      const icon = document.createElement('span'); icon.className = 'icon'; icon.textContent = d >= CONSTANTS.AGE_CRIT_DAYS ? '⚠' : '⏳';
      const label = document.createElement('span');
      const who = document.createElement('span'); who.className = 'who'; who.textContent = w.who;
      label.append(who, document.createTextNode(` — ${w.what}`));
      const age = document.createElement('span'); age.className = 'age'; age.textContent = `${d}d`;
      chip.append(icon, label, age);
      chip.onclick = () => receiveWaiting(it.id, w.id);
      shelf.appendChild(chip);
    }
    card.appendChild(shelf);
  }

  // edit bar
  if (editMode) {
    const eb = document.createElement('div'); eb.className = 'editbar';
    const mk = (txt, fn, cls) => {
      const b = document.createElement('button'); b.textContent = txt; if (cls) b.className = cls; b.onclick = fn; return b;
    };
    eb.append(
      mk('＋ move', () => { openForm = { type: 'move', id: it.id }; render(); }),
      mk('＋ waiting on', () => { openForm = { type: 'wait', id: it.id }; render(); }),
      mk('rename', () => renameInline(iname, it.name, v => { it.name = v; })),
      mk('delete initiative', () => deleteInit(it.id), 'del'),
    );
    card.appendChild(eb);
  }

  if (openForm && openForm.id === it.id && (openForm.type === 'move' || openForm.type === 'wait')) {
    const type = openForm.type;
    mountForm(card, type, (v1, v2) => {
      if (type === 'move') it.moves.push({ id: newId('m'), label: v1, done: false });
      else it.waiting.push({ id: newId('w'), who: v1, what: v2 || '…', since: todayISO(), lastNotifiedTier: 0 });
    });
  }

  return card;
}

// ---------- boot ----------
async function boot() {
  S = await bridge.load();
  if (pruneToday(S, todayNow())) persist(); // day rollover: yesterday's done items leave Today
  // external changes (plan §10): main watched the file and re-read it
  if (bridge.onExternalChange) {
    bridge.onExternalChange(doc => {
      S = doc; heroSkip = 0;
      if (pruneToday(S, todayNow())) persist();
      render();
    });
  }
  wire();
  render();
}

function wire() {
  $('editToggle').addEventListener('click', () => { editMode = !editMode; openForm = null; render(); });
  $('addgoal').addEventListener('click', () => { openForm = { type: 'goal' }; render(); });
}

boot();
