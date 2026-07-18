// Trailmap renderer. Platform-agnostic (plan §2 reversibility rule):
// talks ONLY to window.trailmap — no Electron, no Node, no network.
import {
  CONSTANTS, ageDays, ageClass, initPct, goalPct, momentumCounts,
  pickTodaysMove, goalHorizon, nextHorizon, newId, quarterLabel,
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
const goalColor = g => `var(${COLORS[S.goals.indexOf(g) % COLORS.length]})`;
const todayISO = () => {
  const d = todayNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function findMove(id) {
  for (const g of S.goals) for (const it of g.inits) {
    const m = it.moves.find(m => m.id === id);
    if (m) return { g, it, m };
  }
  return null;
}

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

  if (openForm && openForm.type === 'goal' && !document.getElementById('goalform')) {
    const holder = document.createElement('div');
    holder.id = 'goalform';
    holder.className = 'init';
    mountForm(holder, 'goal', (v1, v2) => S.goals.push({ id: newId('g'), name: v1, sub: v2, inits: [] }));
    $('goals').appendChild(holder);
  }
}

function renderHero(today) {
  const hero = $('hero');
  const pick = pickTodaysMove(S, heroSkip);
  hero.classList.toggle('alldone', !pick);
  if (!pick) {
    hero.textContent = '🎉 Every visible move is shipped. Promote something from “later,” or go home early.';
    return;
  }
  hero.replaceChildren();
  const sun = document.createElement('div'); sun.className = 'sun'; sun.textContent = '☀️';
  const mid = document.createElement('div');
  const lbl = document.createElement('div'); lbl.className = 'lbl'; lbl.textContent = 'Today’s move — before the meetings eat you';
  const mv = document.createElement('div'); mv.className = 'move';
  const dot = document.createElement('span'); dot.style.color = goalColor(pick.goal); dot.textContent = '● ';
  mv.append(dot, document.createTextNode(pick.move.label));
  const why = document.createElement('div'); why.className = 'why';
  why.textContent = `because “${pick.goal.name}” has the least momentum right now`;
  mid.append(lbl, mv, why);
  const actions = document.createElement('div'); actions.className = 'actions';
  const skip = document.createElement('button'); skip.title = 'Suggest something else'; skip.textContent = '↻';
  skip.setAttribute('aria-label', 'Suggest a different move');
  skip.onclick = () => { heroSkip++; render(); };
  const done = document.createElement('button'); done.className = 'primary'; done.textContent = 'Done ✓';
  done.onclick = () => completeMove(pick.move.id);
  actions.append(skip, done);
  hero.append(sun, mid, actions);
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
    const span = document.createElement('span'); span.textContent = m.label;
    row.append(chk, span);
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
    const span = document.createElement('span'); span.textContent = m.label;
    row.append(chk, span);
    if (editMode) {
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
  // external changes (plan §10): main watched the file and re-read it
  if (bridge.onExternalChange) {
    bridge.onExternalChange(doc => { S = doc; heroSkip = 0; render(); });
  }
  wire();
  render();
}

function wire() {
  $('editToggle').addEventListener('click', () => { editMode = !editMode; openForm = null; render(); });
  $('addgoal').addEventListener('click', () => { openForm = { type: 'goal' }; render(); });
}

boot();
