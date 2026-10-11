import * as L from './logic.js';
import { db } from './db.js';
import { Notify } from './notify.js';
import { Images } from './images.js';
import * as Acct from './account.js';
import { live, tombstone } from './syncmerge.js';

const { ymd, addDays, parseYmd, toMin, fromMin, fmtTime, fmtRange, DOW, MONTHS } = L;
export const VERSION = '1.1.1';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n) => `<span class="i i-${n}" aria-hidden="true"></span>`;
const today = () => ymd(new Date());

export const CATS = [
  { id: 'study', name: 'Study', c: '#8B6CFF' }, { id: 'college', name: 'College', c: '#4FB3FF' },
  { id: 'personal', name: 'Personal', c: '#2FD8A0' }, { id: 'health', name: 'Health', c: '#FFB443' },
  { id: 'gaming', name: 'Gaming', c: '#FF4655' }, { id: 'work', name: 'Work', c: '#F06BC7' }, { id: 'other', name: 'Other', c: '#8E97AD' },
];
const catOf = (id) => CATS.find((c) => c.id === id) || (id ? { id, name: id[0].toUpperCase() + id.slice(1), c: '#8E97AD' } : CATS[CATS.length - 1]);
const colorOf = (t) => t.color || catOf(t.category).c;
const PRIOS = [{ v: 0, n: 'None' }, { v: 1, n: 'Low', c: '#4FB3FF' }, { v: 2, n: 'Medium', c: '#FFB443' }, { v: 3, n: 'High', c: '#FF4655' }];

// ---------------- state ----------------
const defaults = { name: '', theme: 'dark', weekMonday: true, dayStart: '07:00', dayEnd: '23:00', dailyPlanOn: false, dailyPlanTime: '08:00', deadlineTime: '09:00', defaultRemind: 10, notifOn: false };
export const S = { tasks: [], notes: [], folders: [], habits: [], settings: { ...defaults } };
let saveTimer;
async function load() {
  const [tasks, notes, folders, habits, kv] = await Promise.all(['tasks', 'notes', 'folders', 'habits', 'kv'].map((s) => db.all(s).catch(() => [])));
  Object.assign(S, { tasks: live(tasks), notes: live(notes), folders: live(folders), habits: live(habits) });
  const set = kv.find((k) => k.id === 'settings');
  S.settings = { ...defaults, ...(set ? set.value : {}) };
  Acct.settingsStamp(set ? set.updated || 0 : 0);
  seeded = !!kv.find((k) => k.id === 'seeded');
  if (!seeded && Acct.mode() === 'local') await seed();
}
let seeded = true;
async function seedIfNew() { if (!seeded && !S.tasks.length && !S.notes.length) { await seed(); seeded = true; } }
// Deletes are tombstones ({id, deleted, updated}) so they sync; old ones are purged after 30 days.
async function tomb(store, rec) { if (!rec) return; const t = tombstone(rec); await db.put(store, t); Acct.push(store, t); }
const stamp = (o) => { o.updated = Date.now(); if (!o.created) o.created = Date.now(); return o; };
export async function putTask(t) { stamp(t); delete t.deleted; const i = S.tasks.findIndex((x) => x.id === t.id); if (i >= 0) S.tasks[i] = t; else S.tasks.push(t); await db.put('tasks', t); Acct.push('tasks', t); changed('tasks'); }
export async function delTask(id) { const old = S.tasks.find((t) => t.id === id); S.tasks = S.tasks.filter((t) => t.id !== id); await tomb('tasks', old); S.notes.filter((n) => (n.taskIds || []).includes(id)).forEach((n) => { n.taskIds = n.taskIds.filter((x) => x !== id); putNote(n, true); }); changed('tasks'); }
export async function putNote(n, quiet) { stamp(n); delete n.deleted; const i = S.notes.findIndex((x) => x.id === n.id); if (i >= 0) S.notes[i] = n; else S.notes.push(n); await db.put('notes', n); Acct.push('notes', n); if (!quiet) changed('notes'); }
async function delNote(id) { const n = S.notes.find((x) => x.id === id); S.notes = S.notes.filter((x) => x.id !== id); await tomb('notes', n); if (n) for (const im of n.images || []) Images.del(im); changed('notes'); }
async function putHabit(h) { stamp(h); delete h.deleted; const i = S.habits.findIndex((x) => x.id === h.id); if (i >= 0) S.habits[i] = h; else S.habits.push(h); await db.put('habits', h); Acct.push('habits', h); changed('habits'); }
async function putFolder(f) { stamp(f); delete f.deleted; const i = S.folders.findIndex((x) => x.id === f.id); if (i >= 0) S.folders[i] = f; else S.folders.push(f); await db.put('folders', f); Acct.push('folders', f); changed('folders'); }
export async function saveSettings(patch) { Object.assign(S.settings, patch); const updated = Acct.settingsStamp(Date.now()); await db.put('kv', { id: 'settings', value: S.settings, updated }); Acct.push('settings', { id: 'prefs', value: { ...S.settings }, updated }); changed('settings'); }
function changed(what) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => Notify.sync(S.tasks, S.settings), 400);
  if (what !== 'quiet' && !editing) render();
}
let editing = false; // true while the note editor owns the view

async function seed() {
  const d = today();
  const t = (o) => ({ id: L.uid(), priority: 0, repeat: 'none', done: false, doneDates: {}, subtasks: [], images: [], ...o });
  const tasks = [
    t({ title: 'Welcome to SH PLANNER 👋 tap me', date: d, category: 'personal', info: 'Tap a task to edit it. Long-press a block in the timeline to drag it, or drag its bottom edge to resize.\n\nTry quick add: "Study DSA 6-8pm tomorrow", "Gym 7am daily", "OS assignment by fri !high ~2h".' }),
    t({ title: 'Study DSA: graphs', date: d, start: '18:00', end: '20:00', category: 'study', priority: 3, remind: 10, subtasks: [{ id: L.uid(), t: 'BFS / DFS revision', d: true }, { id: L.uid(), t: '3 LeetCode mediums', d: false }] }),
    t({ title: 'Valo ranked with the squad', date: d, start: '21:00', end: '22:30', category: 'gaming' }),
    t({ title: 'OS assignment', date: null, due: addDays(d, 2), category: 'college', priority: 3, estimate: 90 }),
  ];
  const folder = { id: L.uid(), name: 'College', color: '#4FB3FF' };
  const notes = [{ id: L.uid(), title: 'DSA: graph cheatsheet', folderId: folder.id, tags: ['dsa', 'placements'], pinned: true, taskIds: [tasks[1].id],
    html: '<h2>Graph traversal</h2><ul><li><b>BFS</b>: queue, shortest path in unweighted graphs</li><li><b>DFS</b>: stack / recursion, cycles, topo sort</li></ul><ul class="checklist"><li data-checked="true">Number of islands</li><li data-checked="false">Course schedule</li><li data-checked="false">Rotting oranges</li></ul>' }];
  for (const x of tasks) { stamp(x); S.tasks.push(x); }
  for (const n of notes) { stamp(n); S.notes.push(n); }
  stamp(folder); S.folders.push(folder);
  const hab = [{ id: L.uid(), name: 'Drink water', emoji: '💧', color: '#4FB3FF', days: [], log: {}, created: addDays(d, -6) }, { id: L.uid(), name: 'LeetCode 1 problem', emoji: '🧠', color: '#8B6CFF', days: [1, 2, 3, 4, 5], log: {}, created: addDays(d, -6) }];
  for (let i = 1; i <= 5; i++) hab[0].log[addDays(d, -i)] = true;
  for (const h of hab) { stamp(h); S.habits.push(h); }
  await Promise.all([db.bulkPut('tasks', S.tasks), db.bulkPut('notes', S.notes), db.bulkPut('folders', S.folders), db.bulkPut('habits', S.habits), db.put('kv', { id: 'seeded', value: true })]);
}

// ---------------- helpers ----------------
export function toast(msg, action, fn, ms = 3200) {
  const el = document.createElement('div'); el.className = 'toast'; el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  $('#toasts').append(el);
  if (action) el.querySelector('button').onclick = () => { fn(); el.remove(); };
  setTimeout(() => el.remove(), ms);
}
const dayLabel = (s) => { const t = today(); if (s === t) return 'Today'; if (s === addDays(t, 1)) return 'Tomorrow'; if (s === addDays(t, -1)) return 'Yesterday'; const d = parseYmd(s); return `${DOW[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const longDate = (s) => { const d = parseYmd(s); return `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const greet = () => { const h = new Date().getHours(); return h < 5 ? 'Late night grind' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const dueLabel = (t) => { if (!t.due) return ''; const d = L.daysBetween(today(), t.due); const cls = d < 0 ? 'red' : d <= 1 ? 'warn' : ''; const txt = d < 0 ? `Overdue ${-d}d` : d === 0 ? 'Due today' : d === 1 ? 'Due tomorrow' : `Due ${dayLabel(t.due)}`; return `<span class="badge ${cls}">${ic('flag')}${txt}${t.dueTime ? ' ' + fmtTime(t.dueTime) : ''}</span>`; };
const notesForTask = (id) => S.notes.filter((n) => (n.taskIds || []).includes(id));
const notesForDay = (d) => S.notes.filter((n) => n.date === d || n.daily === d);
const dailyNote = (d) => S.notes.find((n) => n.daily === d);

function taskRow(t, date) {
  const done = L.isDoneOn(t, date || t.date || today());
  const meta = [];
  if (t.start) meta.push(`${ic('clock')}${fmtRange(t.start, t.end)}`.replace('<span', '<span style="width:13px;height:13px"'));
  if (!date && t.date) meta.push(dayLabel(t.date));
  if (L.isRepeating(t)) meta.push(`↻ ${t.repeat}`);
  if (t.estimate && !t.start) meta.push(`~${t.estimate >= 60 ? t.estimate / 60 + 'h' : t.estimate + 'm'}`);
  const subs = t.subtasks || []; if (subs.length) meta.push(`☑ ${subs.filter((s) => s.d).length}/${subs.length}`);
  const nn = notesForTask(t.id).length; if (nn) meta.push(`📝 ${nn}`);
  if ((t.images || []).length) meta.push(`🖼 ${t.images.length}`);
  if (t.remind != null && t.remind !== '' && t.start) meta.push('🔔');
  return `<div class="trow ${done ? 'done' : ''}" style="--c:${colorOf(t)}" data-open-task="${t.id}" data-date="${date || t.date || ''}">
    <button class="chk ${done ? 'on' : ''}" data-toggle="${t.id}" data-date="${date || t.date || today()}" aria-label="${done ? 'Mark not done' : 'Mark done'}">${ic('check')}</button>
    <div class="body"><div class="t">${esc(t.title)}</div><div class="m">${meta.join('<span class="faint">·</span>')} ${dueLabel(t)}</div></div>
    ${t.priority ? `<span class="prio p${t.priority}" title="${PRIOS[t.priority].n} priority"></span>` : ''}</div>`;
}
async function toggleDone(id, date) {
  const t = S.tasks.find((x) => x.id === id); if (!t) return;
  if (L.isRepeating(t)) { t.doneDates = t.doneDates || {}; if (t.doneDates[date]) delete t.doneDates[date]; else t.doneDates[date] = true; }
  else t.done = !t.done;
  if (navigator.vibrate) navigator.vibrate(12);
  await putTask(t);
  if (L.isDoneOn(t, date)) toast('Nice, done ✅', 'Undo', () => toggleDone(id, date));
}

// ---------------- router ----------------
const NAV = [
  { r: 'home', n: 'Home', i: 'home' }, { r: 'plan', n: 'Planner', i: 'cal' }, { r: 'fab' }, { r: 'notes', n: 'Notes', i: 'note' }, { r: 'habits', n: 'Habits', i: 'flame' },
];
function route() { const h = location.hash.replace(/^#\/?/, '') || 'home'; const [path, q] = h.split('?'); return { parts: path.split('/'), q: new URLSearchParams(q || '') }; }
function renderNav(cur) {
  $('#bottomNav').innerHTML = NAV.map((n) => n.r === 'fab' ? `<button class="fab" data-act="capture" aria-label="Quick capture">${ic('plus')}</button>`
    : `<a class="nav-i ${cur === n.r ? 'on' : ''}" href="#/${n.r}">${ic(n.i)}<span>${n.n}</span></a>`).join('');
  $('#sideNav').innerHTML = NAV.filter((n) => n.r !== 'fab').concat([{ r: 'settings', n: 'Settings', i: 'gear' }]).map((n) => `<a class="nav-i ${cur === n.r ? 'on' : ''}" href="#/${n.r}">${ic(n.i)}<span>${n.n}</span></a>`).join('');
}
const views = {};
let lastRoute = '';
export function render() {
  const { parts, q } = route();
  const key = parts[0];
  const v = views[key] || views.home;
  const navKey = key === 'note' ? 'notes' : key;
  renderNav(navKey);
  const titles = { home: 'SH PLANNER', plan: 'Planner', notes: 'Notebook', note: 'Note', habits: 'Habits', settings: 'Settings' };
  $('#topTitle').textContent = titles[key] || 'SH PLANNER';
  const view = $('#view');
  const routeKey = location.hash;
  const keepScroll = routeKey === lastRoute;
  const tl = $('.tl-wrap'); const tlScroll = tl ? tl.scrollTop : null; const tlScrollX = tl ? tl.scrollLeft : null;
  const y = window.scrollY;
  editing = key === 'note';
  v(view, parts, q);
  if (keepScroll) { window.scrollTo(0, y); const t2 = $('.tl-wrap'); if (t2 && tlScroll != null) { t2.scrollTop = tlScroll; t2.scrollLeft = tlScrollX; } }
  else { window.scrollTo(0, 0); view.style.animation = 'none'; view.offsetHeight; view.style.animation = ''; }
  lastRoute = routeKey;
  $('[data-act=theme] .i').className = 'i i-' + (document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon');
}
window.addEventListener('hashchange', render);

// ---------------- global events ----------------
document.addEventListener('click', (e) => {
  const tg = e.target.closest('[data-toggle]');
  if (tg) { e.stopPropagation(); e.preventDefault(); toggleDone(tg.dataset.toggle, tg.dataset.date); return; }
  const ot = e.target.closest('[data-open-task]');
  if (ot && !e.target.closest('a,button:not([data-open-task])')) { openTask(ot.dataset.openTask, ot.dataset.date); return; }
  const on = e.target.closest('[data-open-note]');
  if (on) { e.preventDefault(); closeSheet(); location.hash = '#/note/' + on.dataset.openNote; return; }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const act = a.dataset.act;
  if (act === 'capture') openCapture();
  else if (act === 'search') openSearch();
  else if (act === 'theme') setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});
function setTheme(t) {
  localStorage.setItem('shp-theme', t);
  const eff = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
  document.documentElement.dataset.theme = eff;
  $('meta[name=theme-color]').content = eff === 'dark' ? '#0A0C12' : '#F4F5FA';
  saveSettings({ theme: t });
}

export { $, $$, esc, ic, today, views, catOf, colorOf, PRIOS, dayLabel, longDate, greet, dueLabel, notesForTask, notesForDay, dailyNote, taskRow, toggleDone, putHabit, putFolder, delNote };

// ================= HOME / DASHBOARD =================
views.home = (el) => {
  const d = today();
  const todays = L.tasksOn(S.tasks, d);
  const done = todays.filter((t) => L.isDoneOn(t, d));
  const pending = todays.filter((t) => !L.isDoneOn(t, d));
  const pct = todays.length ? Math.round((done.length / todays.length) * 100) : 0;
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const timed = pending.filter((t) => t.start);
  const cur = timed.find((t) => toMin(t.start) <= nowM && (toMin(t.end) ?? toMin(t.start) + 60) > nowM);
  const next = timed.find((t) => toMin(t.start) > nowM);
  const deadlines = S.tasks.filter((t) => t.due && !t.done && L.daysBetween(d, t.due) <= 7).sort((a, b) => (a.due + (a.dueTime || '')).localeCompare(b.due + (b.dueTime || '')));
  const inbox = S.tasks.filter((t) => !t.date && !t.done);
  const sugg = L.suggestSlots(S.tasks, d, new Date(), S.settings);
  const habs = S.habits.filter((h) => !h.archived && L.habitDueOn(h, d));
  const bestStreak = Math.max(0, ...S.habits.map((h) => L.habitStreak(h, d)));
  const dn = dailyNote(d);
  const mins = (m) => m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? (m % 60) + 'm' : ''}`.trim() : `${m}m`;
  el.innerHTML = `
  <section class="hero">
    <div class="ring" style="--p:${pct}"><div><span>${pct}%</span><small>today</small></div></div>
    <div><p class="muted small">${longDate(d)}</p><h2>${greet()}${S.settings.name ? ', ' + esc(S.settings.name) : ''} 👋</h2>
    <p class="muted small">${todays.length ? `${done.length} of ${todays.length} done${pending.length ? ` · ${pending.length} to go` : ' · all clear 🎉'}` : 'Nothing planned yet. Add something below.'}</p></div>
  </section>
  <div class="stats">
    <a class="stat" href="#/plan/day/${d}"><b>${pending.length}</b><span>Pending</span></a>
    <a class="stat" href="#/plan/day/${d}"><b style="color:var(--ok)">${done.length}</b><span>Completed</span></a>
    <a class="stat" href="#deadlines"><b style="color:var(--warn)">${deadlines.length}</b><span>Deadlines</span></a>
    <a class="stat" href="#/habits"><b>🔥${bestStreak}</b><span>Best streak</span></a>
  </div>
  <div class="grid2" style="margin-top:4px">
  <div>
    ${cur || next ? `<div class="h-row"><h3 class="h2">${cur ? 'Happening now' : 'Up next'}</h3></div>
    <div class="card now-card" data-open-task="${(cur || next).id}" data-date="${d}" style="cursor:pointer">
      <div class="now-bar" style="background:${colorOf(cur || next)}"></div>
      <div style="flex:1;min-width:0"><b style="font-size:16px">${esc((cur || next).title)}</b>
      <div class="muted small">${fmtRange((cur || next).start, (cur || next).end)} · ${cur ? `${mins((toMin(cur.end) ?? toMin(cur.start) + 60) - nowM)} left` : `in ${mins(toMin(next.start) - nowM)}`}</div></div>
      ${cur && next ? `<div class="small muted" style="text-align:right">Next<br><b style="color:var(--text)">${fmtTime(next.start)}</b></div>` : ''}
    </div>` : ''}
    <div class="h-row"><h3 class="h2">Today's schedule</h3><a class="link-btn" href="#/plan/day/${d}">Open timeline →</a></div>
    <div class="tlist">${todays.length ? todays.map((t) => taskRow(t, d)).join('') : `<div class="empty card"><span class="big">🗓️</span>Your day is empty. Tap <b>+</b> to add a task.</div>`}</div>
    ${sugg.length ? `<div class="h-row"><h3 class="h2">${ic('spark')} Smart slots</h3><button class="link-btn" data-sugg-all>Accept all</button></div>
    <p class="small muted" style="margin:-4px 0 8px">Free time picked for your unscheduled tasks, by priority, deadline and length.</p>
    <div class="tlist">${sugg.map((s) => `<div class="sugg"><div class="body"><div class="t">${esc(s.title)}</div><div class="small muted">${fmtRange(s.start, s.end)} · ${esc(s.reason)}</div></div><button class="btn sm primary" data-sugg='${esc(JSON.stringify(s))}'>${ic('check')}Accept</button></div>`).join('')}</div>` : ''}
  </div>
  <div>
    <div class="h-row" id="deadlines"><h3 class="h2">Upcoming deadlines</h3></div>
    <div class="tlist">${deadlines.length ? deadlines.map((t) => taskRow(t)).join('') : `<div class="empty card">No deadlines in the next 7 days 😌</div>`}</div>
    ${habs.length ? `<div class="h-row"><h3 class="h2">Habits today</h3><a class="link-btn" href="#/habits">All habits →</a></div>
    <div class="hab-row">${habs.map((h) => `<button class="hab-pill ${(h.log || {})[d] ? 'on' : ''}" data-hab="${h.id}" data-date="${d}"><span class="em">${(h.log || {})[d] ? '✓' : esc(h.emoji || '⭐')}</span>${esc(h.name)} <span class="faint small">🔥${L.habitStreak(h, d)}</span></button>`).join('')}</div>` : ''}
    <div class="h-row"><h3 class="h2">Daily note</h3></div>
    <div class="lnote" data-daily="${d}">${ic('note')}<div class="body"><div class="t">${dn ? esc(dn.title) : 'Write today\'s note'}</div><div class="s">${dn ? esc(L.htmlToText(dn.html).slice(0, 90)) || 'Empty' : 'Plans, thoughts, class notes for ' + dayLabel(d).toLowerCase()}</div></div>${ic('chevr')}</div>
    ${inbox.length ? `<div class="h-row"><h3 class="h2">${ic('inbox')} Inbox (no date)</h3></div><div class="tlist">${inbox.map((t) => taskRow(t)).join('')}</div>` : ''}
  </div></div>`;
};
async function acceptSugg(s) { const t = S.tasks.find((x) => x.id === s.taskId); if (!t) return; Object.assign(t, { date: s.date, start: s.start, end: s.end }); if (t.remind == null) t.remind = S.settings.defaultRemind; await putTask(t); }
document.addEventListener('click', async (e) => {
  const sg = e.target.closest('[data-sugg]'); if (sg) { const s = JSON.parse(sg.dataset.sugg); await acceptSugg(s); toast(`Scheduled ${s.title} at ${fmtTime(s.start)}`); return; }
  const sa = e.target.closest('[data-sugg-all]'); if (sa) { const list = L.suggestSlots(S.tasks, today(), new Date(), S.settings); for (const s of list) await acceptSugg(s); toast(`Scheduled ${list.length} task${list.length > 1 ? 's' : ''}`); return; }
  const hb = e.target.closest('[data-hab]'); if (hb) { const h = S.habits.find((x) => x.id === hb.dataset.hab); const dd = hb.dataset.date; h.log = h.log || {}; if (h.log[dd]) delete h.log[dd]; else { h.log[dd] = true; if (navigator.vibrate) navigator.vibrate(12); } await putHabit(h); return; }
  const dl = e.target.closest('[data-daily]'); if (dl) { openDaily(dl.dataset.daily); return; }
});
async function openDaily(d) {
  let n = dailyNote(d);
  if (!n) { n = { id: L.uid(), title: `Daily note · ${dayLabel(d) === 'Today' ? longDate(d) : longDate(d)}`, html: '', tags: ['daily'], daily: d, date: d, taskIds: [], pinned: false, folderId: null }; await putNote(n, true); }
  closeSheet(); location.hash = '#/note/' + n.id;
}

// ================= PLANNER =================
views.plan = (el, parts) => {
  const mode = parts[1] || localStorage.getItem('shp-mode') || 'day';
  const d = parts[2] || today();
  localStorage.setItem('shp-mode', mode);
  const step = mode === 'day' ? 1 : mode === 'week' ? 7 : 0;
  const prev = mode === 'month' ? ymd(new Date(parseYmd(d).getFullYear(), parseYmd(d).getMonth() - 1, 1)) : addDays(d, -step);
  const next = mode === 'month' ? ymd(new Date(parseYmd(d).getFullYear(), parseYmd(d).getMonth() + 1, 1)) : addDays(d, step);
  const pd = parseYmd(d);
  const ws = L.weekStart(d, S.settings.weekMonday);
  const title = mode === 'day' ? dayLabel(d) : mode === 'week' ? `${parseYmd(ws).getDate()} ${MONTHS[parseYmd(ws).getMonth()]} – ${parseYmd(addDays(ws, 6)).getDate()} ${MONTHS[parseYmd(addDays(ws, 6)).getMonth()]}` : `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][pd.getMonth()]} ${pd.getFullYear()}`;
  let html = `<div class="ph"><div class="ph-date"><a class="icon-btn" href="#/plan/${mode}/${prev}" aria-label="Previous">${ic('chevl')}</a><h2>${title}</h2><a class="icon-btn" href="#/plan/${mode}/${next}" aria-label="Next">${ic('chevr')}</a></div>
    <div style="display:flex;gap:8px;align-items:center">${d !== today() ? `<a class="btn sm" href="#/plan/${mode}/${today()}">Today</a>` : ''}<div class="seg">${['day', 'week', 'month'].map((m) => `<a class="${m === mode ? 'on' : ''}" href="#/plan/${m}/${d}">${m[0].toUpperCase() + m.slice(1)}</a>`).join('')}</div></div></div>`;
  if (mode !== 'month') html += quickAddHtml(d);
  if (mode === 'day') {
    html += `<div class="wstrip">${[0, 1, 2, 3, 4, 5, 6].map((i) => { const s = addDays(ws, i); const n = L.tasksOn(S.tasks, s).length; return `<a class="wd ${s === d ? 'on' : ''} ${s === today() ? 'today' : ''}" href="#/plan/day/${s}">${DOW[parseYmd(s).getDay()]}<b>${parseYmd(s).getDate()}</b><span class="dots">${'<i></i>'.repeat(Math.min(n, 3))}</span></a>`; }).join('')}</div>`;
    const list = L.tasksOn(S.tasks, d); const any = list.filter((t) => !t.start);
    if (any.length) html += `<div class="h-row" style="margin-top:0"><h3 class="h2">Anytime</h3></div><div class="anytime">${any.map((t) => taskRow(t, d)).join('')}</div>`;
    const sugg = L.suggestSlots(S.tasks, d, new Date(), S.settings);
    if (sugg.length && d >= today()) html += `<div class="sugg" style="margin-bottom:12px">${ic('spark')}<div class="body"><div class="t">${sugg.length} smart slot${sugg.length > 1 ? 's' : ''} found</div><div class="small muted">${sugg.map((s) => `${esc(s.title)} → ${fmtTime(s.start)}`).join(' · ')}</div></div><button class="btn sm primary" data-sugg-day="${d}">Accept</button></div>`;
    html += timelineHtml([d]);
    const dn = dailyNote(d); const dayNotes = notesForDay(d).filter((n) => n !== dn);
    html += `<div class="h-row"><h3 class="h2">Notes for this day</h3><button class="link-btn" data-new-day-note="${d}">+ Attach note</button></div><div class="tlist">
      <div class="lnote" data-daily="${d}">${ic('note')}<div class="body"><div class="t">${dn ? esc(dn.title) : 'Daily note'}</div><div class="s">${dn ? esc(L.htmlToText(dn.html).slice(0, 100)) || 'Empty' : 'Tap to start today\'s page'}</div></div>${ic('chevr')}</div>
      ${dayNotes.map(noteLinkHtml).join('')}</div>`;
  } else if (mode === 'week') {
    html += timelineHtml([0, 1, 2, 3, 4, 5, 6].map((i) => addDays(ws, i)), true);
    const any = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(ws, i)).flatMap((s) => L.tasksOn(S.tasks, s).filter((t) => !t.start).map((t) => [t, s]));
    if (any.length) html += `<div class="h-row"><h3 class="h2">Anytime this week</h3></div><div class="tlist">${any.map(([t, s]) => taskRow(t, s).replace('<div class="m">', `<div class="m"><span>${dayLabel(s)}</span>`)).join('')}</div>`;
  } else {
    html += monthHtml(d);
  }
  el.innerHTML = html;
  bindQuickAdd(el, d);
  const wrap = $('.tl-wrap', el);
  if (wrap && !wrap.dataset.scrolled) {
    const nowM = new Date().getHours() * 60;
    const first = L.tasksOn(S.tasks, d).find((t) => t.start);
    const target = (parts[2] && parts[2] !== today()) ? (first ? toMin(first.start) - 60 : toMin(S.settings.dayStart)) : Math.max(nowM - 90, 0);
    requestAnimationFrame(() => { wrap.scrollTop = (target / 60) * HOUR; });
    wrap.dataset.scrolled = '1';
  }
  if (wrap) bindTimeline(wrap);
};
const HOUR = 60; // px per hour (matches --hour)
function timelineHtml(dates, multi) {
  const cols = dates.length;
  const tmpl = `52px repeat(${cols}, minmax(${multi ? 92 : 0}px, 1fr))`;
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const head = multi ? `<div class="tl-head" style="grid-template-columns:${tmpl}"><span></span>${dates.map((s) => `<a class="${s === today() ? 'today' : ''}" href="#/plan/day/${s}">${DOW[parseYmd(s).getDay()]}<b>${parseYmd(s).getDate()}</b></a>`).join('')}</div>` : '';
  const gut = `<div class="tl-gut" style="height:${24 * HOUR}px">${Array.from({ length: 23 }, (_, i) => `<span style="top:${(i + 1) * HOUR}px">${fmtTime(L.pad(i + 1) + ':00')}</span>`).join('')}</div>`;
  const colsHtml = dates.map((s) => {
    const blocks = L.layoutBlocks(L.tasksOn(S.tasks, s).filter((t) => t.start)).map((b) => {
      const t = b.t; const top = (b.s / 60) * HOUR; const h = Math.max(((b.e - b.s) / 60) * HOUR - 2, 22);
      const w = 100 / b.cols; const done = L.isDoneOn(t, s);
      return `<div class="blk ${done ? 'done' : ''}" data-blk="${t.id}" data-date="${s}" style="--c:${colorOf(t)};top:${top}px;height:${h}px;left:calc(${b.col * w}% + 2px);width:calc(${w}% - 4px)">
        <b>${t.priority >= 3 ? '❗' : ''}${esc(t.title)}</b>${h > 34 ? `<span>${fmtRange(t.start, t.end)}${L.isRepeating(t) ? ' ↻' : ''}</span>` : ''}<div class="rs" data-rs></div></div>`;
    }).join('');
    return `<div class="tl-col ${s === today() ? 'today' : ''}" data-col="${s}" style="height:${24 * HOUR}px">${blocks}${s === today() ? `<div class="now-line" style="top:${(nowM / 60) * HOUR}px"></div>` : ''}</div>`;
  }).join('');
  return `<div class="tl-wrap">${head}<div class="tl" style="grid-template-columns:${tmpl}">${gut}${colsHtml}</div></div>`;
}
function monthHtml(d) {
  const pd = parseYmd(d); const first = ymd(new Date(pd.getFullYear(), pd.getMonth(), 1));
  const start = L.weekStart(first, S.settings.weekMonday);
  const dows = S.settings.weekMonday ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  let h = `<div class="mgrid">${dows.map((i) => `<div class="mdow">${DOW[i]}</div>`).join('')}`;
  for (let i = 0; i < 42; i++) {
    const s = addDays(start, i); const ps = parseYmd(s);
    if (i === 35 && ps.getMonth() !== pd.getMonth()) break;
    const ts = L.tasksOn(S.tasks, s); const dues = S.tasks.filter((t) => t.due === s && !t.done);
    h += `<a class="mcell ${ps.getMonth() !== pd.getMonth() ? 'out' : ''} ${s === today() ? 'today' : ''}" href="#/plan/day/${s}"><span class="n">${ps.getDate()}</span>
      ${ts.slice(0, 3).map((t) => `<span class="ev" style="--c:${colorOf(t)}">${t.start ? fmtTime(t.start) + ' ' : ''}${esc(t.title)}</span>`).join('')}${ts.length > 3 ? `<span class="tiny faint ev" style="--c:transparent">+${ts.length - 3} more</span>` : ''}
      ${dues.map((t) => `<span class="ev" style="--c:#FF4655">⏰ ${esc(t.title)}</span>`).join('')}
      <span class="mdots">${ts.slice(0, 4).map((t) => `<i style="--c:${colorOf(t)}"></i>`).join('')}${dues.length ? '<i style="--c:#FF4655"></i>' : ''}</span></a>`;
  }
  return h + '</div>';
}
function noteLinkHtml(n) { return `<div class="lnote" data-open-note="${n.id}">${ic('note')}<div class="body"><div class="t">${esc(n.title || 'Untitled')}</div><div class="s">${esc(L.htmlToText(n.html).slice(0, 90)) || 'Empty note'}</div></div>${ic('chevr')}</div>`; }
function quickAddHtml(d) {
  return `<form class="qa" data-qa><input name="q" placeholder='Quick add: "Study DSA 6-8pm tomorrow"' autocomplete="off" enterkeyhint="done" aria-label="Quick add task"><button class="btn primary" aria-label="Add">${ic('plus')}</button></form><div class="qa-preview" data-qa-prev></div>`;
}
function previewChips(p) {
  const bits = [];
  if (p.date) bits.push(`📅 ${dayLabel(p.date)}`); else bits.push('📥 Inbox');
  if (p.start) bits.push(`🕒 ${fmtRange(p.start, p.end)}`);
  if (p.due) bits.push(`⏰ due ${dayLabel(p.due)}${p.dueTime ? ' ' + fmtTime(p.dueTime) : ''}`);
  if (p.repeat !== 'none') bits.push(`↻ ${p.repeat}`);
  if (p.priority) bits.push(`${['', '🔵', '🟠', '🔴'][p.priority]} ${PRIOS[p.priority].n}`);
  if (p.category) bits.push(`#${p.category}`);
  if (p.estimate) bits.push(`~${p.estimate}m`);
  return bits.map((b) => `<span class="badge">${esc(b)}</span>`).join('');
}
function bindQuickAdd(el, d) {
  const f = $('[data-qa]', el); if (!f) return;
  const prev = $('[data-qa-prev]', el);
  const base = d === today() ? new Date() : (() => { const x = parseYmd(d); x.setHours(new Date().getHours(), new Date().getMinutes()); return x; })();
  f.q.addEventListener('input', () => { const v = f.q.value.trim(); prev.innerHTML = v ? `<span class="faint">Will add:</span> <b>${esc(L.parseQuickAdd(v, base).title)}</b> ${previewChips(L.parseQuickAdd(v, base))}` : ''; });
  f.addEventListener('submit', async (e) => { e.preventDefault(); const v = f.q.value.trim(); if (!v) return; const t = taskFromParse(L.parseQuickAdd(v, base)); await putTask(t); toast(`Added "${t.title}"${t.date ? ' · ' + dayLabel(t.date) : ''}${t.start ? ' ' + fmtTime(t.start) : ''}`, 'Edit', () => openTask(t.id, t.date)); setTimeout(() => { const i = $('[data-qa] input'); if (i) i.focus(); }, 50); });
}
function taskFromParse(p) {
  const t = { id: L.uid(), title: p.title, date: p.date, start: p.start, end: p.end, repeat: p.repeat, priority: p.priority, category: p.category && CATS.find((c) => c.id === p.category) ? p.category : (p.category || null), due: p.due || null, dueTime: p.dueTime || null, estimate: p.estimate || null, done: false, doneDates: {}, subtasks: [], images: [] };
  if (t.start) t.remind = S.settings.defaultRemind;
  return t;
}
document.addEventListener('click', async (e) => {
  const sd = e.target.closest('[data-sugg-day]'); if (sd) { const list = L.suggestSlots(S.tasks, sd.dataset.suggDay, new Date(), S.settings); for (const s of list) await acceptSugg(s); toast(`Scheduled ${list.length} task${list.length > 1 ? 's' : ''} into free slots`); }
  const nd = e.target.closest('[data-new-day-note]'); if (nd) openAttachNote({ date: nd.dataset.newDayNote });
});

// ---- timeline drag / resize / tap-to-create ----
function bindTimeline(wrap) {
  let drag = null; let lpTimer = null;
  const snap = (m) => Math.round(m / 15) * 15;
  const colAt = (x) => $$('.tl-col', wrap).find((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x < r.right; });
  const minAt = (col, y) => (y - col.getBoundingClientRect().top) / HOUR * 60;
  const start = (e, blk, mode) => {
    const t = S.tasks.find((x) => x.id === blk.dataset.blk); if (!t) return;
    const col = blk.parentElement;
    drag = { t, blk, mode, date: blk.dataset.date, s0: toMin(t.start), e0: toMin(t.end) ?? toMin(t.start) + 60, y0: e.clientY, x0: e.clientX, col, moved: false, newDate: blk.dataset.date };
    blk.classList.add('drag'); if (navigator.vibrate) navigator.vibrate(15);
  };
  wrap.addEventListener('pointerdown', (e) => {
    const blk = e.target.closest('.blk'); if (!blk) return;
    const rs = e.target.closest('[data-rs]');
    const p0 = { x: e.clientX, y: e.clientY, id: e.pointerId };
    if (rs) { e.preventDefault(); start(e, blk, 'resize'); blk.setPointerCapture(e.pointerId); return; }
    if (e.pointerType === 'mouse') { blk._pending = { e, p0 }; return; }
    lpTimer = setTimeout(() => { start(e, blk, 'move'); try { blk.setPointerCapture(p0.id); } catch (_) {} }, 320);
    blk._p0 = p0;
  });
  wrap.addEventListener('pointermove', (e) => {
    const blk = e.target.closest('.blk');
    if (!drag && blk && blk._pending && Math.hypot(e.clientX - blk._pending.p0.x, e.clientY - blk._pending.p0.y) > 5) { start(blk._pending.e, blk, 'move'); blk._pending = null; blk.setPointerCapture(e.pointerId); }
    if (!drag && lpTimer && blk && blk._p0 && Math.hypot(e.clientX - blk._p0.x, e.clientY - blk._p0.y) > 8) { clearTimeout(lpTimer); lpTimer = null; }
    if (!drag) return;
    e.preventDefault();
    const dy = (e.clientY - drag.y0) / HOUR * 60; drag.moved = true;
    if (drag.mode === 'resize') {
      const ne = Math.max(drag.s0 + 15, Math.min(24 * 60, snap(drag.e0 + dy)));
      drag.blk.style.height = `${((ne - drag.s0) / 60) * HOUR - 2}px`; drag.ns = drag.s0; drag.ne = ne;
    } else {
      const len = drag.e0 - drag.s0; const ns = Math.max(0, Math.min(24 * 60 - len, snap(drag.s0 + dy)));
      drag.blk.style.top = `${(ns / 60) * HOUR}px`; drag.ns = ns; drag.ne = ns + len;
      const c = colAt(e.clientX);
      if (c && c !== drag.blk.parentElement) { c.append(drag.blk); drag.newDate = c.dataset.col; drag.blk.style.left = '2px'; drag.blk.style.width = 'calc(100% - 4px)'; }
    }
    const sp = drag.blk.querySelector('span'); if (sp) sp.textContent = fmtRange(fromMin(drag.ns), fromMin(drag.ne));
  }, { passive: false });
  wrap.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
  const end = async (e) => {
    clearTimeout(lpTimer); lpTimer = null;
    const blk = e.target.closest && e.target.closest('.blk'); if (blk) blk._pending = null;
    if (!drag) return;
    const d = drag; drag = null; d.blk.classList.remove('drag');
    if (!d.moved || d.ns == null) { render(); return; }
    d.blk._justDragged = Date.now();
    const t = d.t; const moveDay = d.newDate !== d.date;
    if (L.isRepeating(t) && (moveDay || d.mode === 'move')) {
      // move only this occurrence: skip the date in the series and create a one-off copy
      if (d.ns !== d.s0 || moveDay || d.ne !== d.e0) {
        t.skip = [...(t.skip || []), d.date];
        const copy = { ...t, id: L.uid(), repeat: 'none', date: d.newDate, start: fromMin(d.ns), end: fromMin(d.ne), skip: [], doneDates: {}, done: !!(t.doneDates || {})[d.date], created: null };
        await putTask(t); await putTask(copy); toast('Moved this occurrence only');
      }
    } else {
      t.start = fromMin(d.ns); t.end = fromMin(d.ne); if (moveDay) t.date = d.newDate;
      await putTask(t); toast(`${t.title} → ${moveDay ? dayLabel(t.date) + ' ' : ''}${fmtRange(t.start, t.end)}`);
    }
  };
  wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', (e) => { if (drag) { drag.blk.classList.remove('drag'); drag = null; render(); } clearTimeout(lpTimer); });
  wrap.addEventListener('click', (e) => {
    const blk = e.target.closest('.blk');
    if (blk) { if (blk._justDragged && Date.now() - blk._justDragged < 400) return; openTask(blk.dataset.blk, blk.dataset.date); return; }
    const col = e.target.closest('.tl-col'); if (!col) return;
    const m = Math.floor(minAt(col, e.clientY) / 30) * 30;
    openTask(null, col.dataset.col, { start: fromMin(m), end: fromMin(m + 60) });
  });
  wrap.addEventListener('contextmenu', (e) => { if (e.target.closest('.blk')) e.preventDefault(); });
}

// ================= SHEETS =================
function openSheet(html, onMount) {
  closeSheet();
  const root = $('#sheetRoot');
  root.innerHTML = `<div class="scrim" data-close></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  const sh = $('.sheet', root);
  $('.scrim', root).onclick = closeSheet;
  document.addEventListener('keydown', escClose);
  if (onMount) onMount(sh);
  const f = sh.querySelector('[autofocus]'); if (f && matchMedia('(min-width:700px)').matches) f.focus();
  return sh;
}
function escClose(e) { if (e.key === 'Escape') closeSheet(); }
function closeSheet() { $('#sheetRoot').innerHTML = ''; document.removeEventListener('keydown', escClose); }
const REMINDS = [['', 'No reminder'], ['0', 'At start'], ['5', '5 min before'], ['10', '10 min before'], ['15', '15 min before'], ['30', '30 min before'], ['60', '1 hour before'], ['1440', '1 day before']];
const ESTS = [['', '—'], ['15', '15 min'], ['30', '30 min'], ['45', '45 min'], ['60', '1 hour'], ['90', '1.5 hours'], ['120', '2 hours'], ['180', '3 hours'], ['240', '4 hours']];
const opt = (list, v) => list.map(([k, n]) => `<option value="${k}" ${String(v ?? '') === k ? 'selected' : ''}>${n}</option>`).join('');

function openTask(id, date, preset = {}) {
  const isNew = !id;
  const orig = id ? S.tasks.find((t) => t.id === id) : null;
  if (id && !orig) return;
  const t = orig ? JSON.parse(JSON.stringify(orig)) : { id: L.uid(), title: '', date: date || today(), start: null, end: null, priority: 0, repeat: 'none', category: 'study', done: false, doneDates: {}, subtasks: [], images: [], remind: preset.start ? S.settings.defaultRemind : null, ...preset };
  const occ = date || t.date || today();
  const linked = () => notesForTask(t.id);
  const sh = openSheet(`
    <input class="f-title" name="title" placeholder="What do you need to do?" value="${esc(t.title)}" autofocus aria-label="Task title">
    ${!isNew ? `<div style="display:flex;gap:8px;margin:-4px 0 12px;align-items:center"><button class="chk ${L.isDoneOn(t, occ) ? 'on' : ''}" data-done aria-label="Done">${ic('check')}</button><span class="small muted">${L.isDoneOn(t, occ) ? 'Completed' : 'Mark complete'}${L.isRepeating(t) ? ' for ' + dayLabel(occ) : ''}</span></div>` : ''}
    <div class="row2"><div class="field"><label for="f-date">Date</label><input class="inp" id="f-date" type="date" name="date" value="${t.date || ''}"></div>
    <div class="field"><label for="f-rep">Repeat</label><select class="inp" id="f-rep" name="repeat">${opt([['none', 'Never'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Every week'], ['monthly', 'Every month']], t.repeat)}</select></div></div>
    <div class="row2"><div class="field"><label for="f-s">Start</label><input class="inp" id="f-s" type="time" name="start" value="${t.start || ''}"></div>
    <div class="field"><label for="f-e">End</label><input class="inp" id="f-e" type="time" name="end" value="${t.end || ''}"></div></div>
    <div class="row2"><div class="field"><label for="f-r">Reminder</label><select class="inp" id="f-r" name="remind">${opt(REMINDS, t.remind)}</select></div>
    <div class="field"><label for="f-est">Est. duration</label><select class="inp" id="f-est" name="estimate">${opt(ESTS, t.estimate)}</select></div></div>
    <div class="row2"><div class="field"><label for="f-due">Deadline</label><input class="inp" id="f-due" type="date" name="due" value="${t.due || ''}"></div>
    <div class="field"><label for="f-dt">Due time</label><input class="inp" id="f-dt" type="time" name="dueTime" value="${t.dueTime || ''}"></div></div>
    <div class="field"><span class="flabel">Priority</span><div class="opts" data-prio>${PRIOS.map((p) => `<button type="button" class="opt ${t.priority === p.v ? 'on' : ''}" data-v="${p.v}" style="--c:${p.c || 'var(--line2)'}">${p.c ? '<span class="dot"></span>' : ''}${p.n}</button>`).join('')}</div></div>
    <div class="field"><span class="flabel">Category</span><div class="opts" data-cat>${CATS.map((c) => `<button type="button" class="opt ${t.category === c.id ? 'on' : ''}" data-v="${c.id}" style="--c:${c.c}"><span class="dot"></span>${c.name}</button>`).join('')}</div></div>
    <div class="field"><span class="flabel">Checklist</span><div class="sub-list" data-subs></div><button type="button" class="link-btn" data-addsub style="align-self:flex-start;margin-top:4px">+ Add item</button></div>
    <div class="field"><label for="f-info">Important info</label><textarea class="inp" id="f-info" name="info" placeholder="Room no., links, what to bring…">${esc(t.info || '')}</textarea></div>
    <div class="field"><span class="flabel">Images</span><div class="imgs" data-imgs></div></div>
    <div class="field"><span class="flabel">Linked notes</span><div class="tlist" data-lnotes></div>
      <div style="display:flex;gap:14px;margin-top:6px"><button type="button" class="link-btn" data-newnote>+ New note</button><button type="button" class="link-btn" data-linknote>${ic('link').replace('i-link', 'i-link" style="width:14px;height:14px')} Link existing</button></div></div>
    <div class="sheet-actions">${!isNew ? `<button type="button" class="btn danger" data-del>${ic('trash')}Delete</button>` : '<span></span>'}<div style="display:flex;gap:8px"><button type="button" class="btn ghost" data-cancel>Cancel</button><button type="button" class="btn primary" data-save>${isNew ? 'Add task' : 'Save'}</button></div></div>`, (sh) => {
    const q = (n) => sh.querySelector(`[name=${n}]`);
    const read = () => {
      t.title = q('title').value.trim() || 'Untitled'; t.date = q('date').value || null; t.repeat = q('repeat').value;
      t.start = q('start').value || null; t.end = q('end').value || null;
      if (t.start && (!t.end || toMin(t.end) <= toMin(t.start))) t.end = fromMin(toMin(t.start) + 60);
      if (!t.start) t.end = null;
      t.remind = q('remind').value === '' ? null : Number(q('remind').value);
      t.estimate = q('estimate').value ? Number(q('estimate').value) : null;
      t.due = q('due').value || null; t.dueTime = q('dueTime').value || null; t.info = q('info').value;
    };
    sh.querySelector('[data-prio]').onclick = (e) => { const b = e.target.closest('.opt'); if (!b) return; t.priority = Number(b.dataset.v); $$('.opt', b.parentElement).forEach((x) => x.classList.toggle('on', x === b)); };
    sh.querySelector('[data-cat]').onclick = (e) => { const b = e.target.closest('.opt'); if (!b) return; t.category = b.dataset.v; t.color = null; $$('.opt', b.parentElement).forEach((x) => x.classList.toggle('on', x === b)); };
    const subsEl = sh.querySelector('[data-subs]');
    const drawSubs = () => { subsEl.innerHTML = (t.subtasks || []).map((s, i) => `<div class="sub ${s.d ? 'done' : ''}"><button type="button" class="chk ${s.d ? 'on' : ''}" data-si="${i}">${ic('check')}</button><input type="text" value="${esc(s.t)}" data-st="${i}" placeholder="Checklist item" aria-label="Checklist item"><button type="button" class="icon-btn" data-sx="${i}" aria-label="Remove item" style="width:32px;height:32px">${ic('x')}</button></div>`).join(''); };
    drawSubs();
    subsEl.addEventListener('click', (e) => { const c = e.target.closest('[data-si]'); if (c) { const s = t.subtasks[c.dataset.si]; s.d = !s.d; drawSubs(); } const x = e.target.closest('[data-sx]'); if (x) { t.subtasks.splice(x.dataset.sx, 1); drawSubs(); } });
    subsEl.addEventListener('input', (e) => { const i = e.target.dataset.st; if (i != null) t.subtasks[i].t = e.target.value; });
    subsEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.st != null) { e.preventDefault(); sh.querySelector('[data-addsub]').click(); } });
    sh.querySelector('[data-addsub]').onclick = () => { t.subtasks = t.subtasks || []; t.subtasks.push({ id: L.uid(), t: '', d: false }); drawSubs(); const ins = $$('[data-st]', subsEl); ins[ins.length - 1].focus(); };
    const imgsEl = sh.querySelector('[data-imgs]');
    const drawImgs = async () => {
      imgsEl.innerHTML = (t.images || []).map((id) => `<div class="im" data-im="${id}"><button type="button" data-imx="${id}" aria-label="Remove image">${ic('x')}</button></div>`).join('') + `<label class="add-img" aria-label="Add image">${ic('image')}<input type="file" accept="image/*" multiple hidden data-imgin></label>`;
      for (const id of t.images || []) { const u = await Images.url(id); const el = imgsEl.querySelector(`[data-im="${id}"]`); if (el && u) el.style.backgroundImage = `url(${u})`; }
    };
    drawImgs();
    imgsEl.addEventListener('change', async (e) => { if (!e.target.matches('[data-imgin]')) return; for (const f of e.target.files) { try { const id = await Images.add(f); t.images = [...(t.images || []), id]; } catch (err) { toast('Could not read that image'); } } drawImgs(); });
    imgsEl.addEventListener('click', async (e) => { const x = e.target.closest('[data-imx]'); if (x) { e.preventDefault(); t.images = t.images.filter((i) => i !== x.dataset.imx); drawImgs(); return; } const im = e.target.closest('[data-im]'); if (im) viewImage(im.dataset.im); });
    const drawLinked = () => { const ls = linked(); sh.querySelector('[data-lnotes]').innerHTML = ls.length ? ls.map(noteLinkHtml).join('') : '<span class="small faint">No notes yet. Attach class notes, links or a checklist.</span>'; };
    drawLinked();
    sh.querySelector('[data-newnote]').onclick = async () => { read(); if (isNew || !S.tasks.find((x) => x.id === t.id)) await putTask(t); const n = { id: L.uid(), title: t.title, html: '', tags: [], taskIds: [t.id], pinned: false, folderId: null, date: null }; await putNote(n, true); closeSheet(); location.hash = '#/note/' + n.id; };
    sh.querySelector('[data-linknote]').onclick = () => { read(); const keep = t; pickNote((n) => { n.taskIds = [...new Set([...(n.taskIds || []), keep.id])]; (S.tasks.find((x) => x.id === keep.id) ? Promise.resolve() : putTask(keep)).then(() => putNote(n, true)).then(() => { openTask(keep.id, occ); toast('Note linked'); }); }); };
    const dn = sh.querySelector('[data-done]'); if (dn) dn.onclick = async () => { read(); Object.assign(orig, t); closeSheet(); await toggleDone(t.id, occ); };
    sh.querySelector('[data-cancel]').onclick = closeSheet;
    sh.querySelector('[data-save]').onclick = async () => { read(); closeSheet(); await putTask(t); if (t.remind != null && t.start) Notify.ensurePermission(true); toast(isNew ? 'Task added' : 'Saved'); };
    sh.querySelector('[name=title]').addEventListener('keydown', (e) => { if (e.key === 'Enter') sh.querySelector('[data-save]').click(); });
    const del = sh.querySelector('[data-del]');
    if (del) del.onclick = async () => {
      if (L.isRepeating(orig)) {
        openSheet(`<h3>Delete repeating task</h3><p class="muted">“${esc(orig.title)}” repeats ${orig.repeat}.</p><div class="tlist"><button class="btn" data-one>Only ${dayLabel(occ)}</button><button class="btn danger" data-all>All occurrences</button><button class="btn ghost" data-close>Cancel</button></div>`, (s2) => {
          s2.querySelector('[data-one]').onclick = async () => { orig.skip = [...(orig.skip || []), occ]; closeSheet(); await putTask(orig); toast('Removed for that day'); };
          s2.querySelector('[data-all]').onclick = async () => { closeSheet(); await delTask(orig.id); toast('Deleted'); };
          s2.querySelector('[data-close]').onclick = closeSheet;
        });
      } else { const copy = { ...orig }; closeSheet(); await delTask(orig.id); toast('Task deleted', 'Undo', () => putTask(copy)); }
    };
  });
}
function pickNote(cb) {
  const list = [...S.notes].sort((a, b) => b.updated - a.updated);
  openSheet(`<h3>Link a note</h3><div class="searchbar">${ic('search')}<input placeholder="Search notes" data-pq autofocus></div><div class="pick-list" data-pl></div>`, (sh) => {
    const draw = (q) => { const r = q ? list.filter((n) => L.searchScore(q, [[n.title, 3], [L.htmlToText(n.html), 1], [(n.tags || []).join(' '), 2]])) : list; sh.querySelector('[data-pl]').innerHTML = r.length ? r.map((n) => `<div class="lnote" data-pick="${n.id}">${ic('note')}<div class="body"><div class="t">${esc(n.title || 'Untitled')}</div><div class="s">${esc(L.htmlToText(n.html).slice(0, 80))}</div></div></div>`).join('') : '<div class="empty">No notes found</div>'; };
    draw('');
    sh.querySelector('[data-pq]').oninput = (e) => draw(e.target.value);
    sh.querySelector('[data-pl]').onclick = (e) => { const p = e.target.closest('[data-pick]'); if (p) { e.stopPropagation(); const n = S.notes.find((x) => x.id === p.dataset.pick); closeSheet(); cb(n); } };
  });
}
function openAttachNote({ date }) {
  openSheet(`<h3>Attach a note to ${dayLabel(date)}</h3><div class="tlist"><button class="btn primary" data-n>${ic('plus')} New note for this day</button><button class="btn" data-l>${ic('link')} Link an existing note</button></div>`, (sh) => {
    sh.querySelector('[data-n]').onclick = async () => { const n = { id: L.uid(), title: '', html: '', tags: [], taskIds: [], pinned: false, folderId: null, date }; await putNote(n, true); closeSheet(); location.hash = '#/note/' + n.id; };
    sh.querySelector('[data-l]').onclick = () => pickNote(async (n) => { n.date = date; await putNote(n); toast('Note attached'); });
  });
}
async function viewImage(id) { const u = await Images.url(id); if (!u) return; openSheet(`<img src="${u}" alt="Attached image" style="width:100%;border-radius:14px;display:block">`); }

// ---- quick capture (FAB) ----
function openCapture() {
  let mode = 'task';
  openSheet(`<div class="seg cap-tabs"><button class="on" data-m="task">Task</button><button data-m="note">Note</button></div>
    <div data-pane="task"><input class="f-title" data-cq placeholder='e.g. "Study DSA 6-8pm tomorrow"' autofocus aria-label="Task in plain words"><div class="qa-preview" data-cp style="margin:0 0 12px"></div>
      <p class="small faint" style="margin:0 0 12px">Understands: today/tomorrow/fri/20 oct · 6-8pm, at 7am · daily/weekdays/every mon · by fri (deadline) · !high · #college · ~2h</p></div>
    <div data-pane="note" hidden><input class="f-title" data-nt placeholder="Note title"><textarea class="inp" data-nb rows="5" placeholder="Jot it down…"></textarea></div>
    <div class="sheet-actions"><button class="btn ghost" data-more>More options</button><button class="btn primary" data-go>Add</button></div>`, (sh) => {
    const cq = sh.querySelector('[data-cq]'); const cp = sh.querySelector('[data-cp]');
    cq.oninput = () => { const v = cq.value.trim(); cp.innerHTML = v ? previewChips(L.parseQuickAdd(v)) : ''; };
    $$('.cap-tabs button', sh).forEach((b) => b.onclick = () => { mode = b.dataset.m; $$('.cap-tabs button', sh).forEach((x) => x.classList.toggle('on', x === b)); $$('[data-pane]', sh).forEach((p) => p.hidden = p.dataset.pane !== mode); sh.querySelector('[data-more]').textContent = mode === 'task' ? 'More options' : 'Open editor'; (mode === 'task' ? cq : sh.querySelector('[data-nt]')).focus(); });
    const go = async (more) => {
      if (mode === 'task') {
        const v = cq.value.trim(); if (!v && !more) return cq.focus();
        if (!v) { closeSheet(); return openTask(null, today()); }
        const t = taskFromParse(L.parseQuickAdd(v)); closeSheet();
        if (more) { openTask(null, t.date, t); return; }
        await putTask(t); toast(`Added "${t.title}"`, 'Edit', () => openTask(t.id, t.date));
      } else {
        const title = sh.querySelector('[data-nt]').value.trim(); const body = sh.querySelector('[data-nb]').value;
        if (!title && !body && !more) return;
        const n = { id: L.uid(), title, html: body ? body.split('\n').map((l) => `<p>${esc(l) || '<br>'}</p>`).join('') : '', tags: [], taskIds: [], pinned: false, folderId: null, date: null };
        await putNote(n, true); closeSheet();
        if (more) location.hash = '#/note/' + n.id; else { toast('Note saved', 'Open', () => location.hash = '#/note/' + n.id); render(); }
      }
    };
    sh.querySelector('[data-go]').onclick = () => go(false);
    sh.querySelector('[data-more]').onclick = () => go(true);
    cq.onkeydown = (e) => { if (e.key === 'Enter') go(false); };
  });
}

// ================= NOTES =================
const imgCache = {};
views.notes = (el, parts, q) => {
  const folder = q.get('f') || 'all'; const tag = q.get('t') || ''; const query = q.get('q') || '';
  let list = [...S.notes];
  if (folder === 'pinned') list = list.filter((n) => n.pinned);
  else if (folder === 'daily') list = list.filter((n) => n.daily);
  else if (folder === 'linked') list = list.filter((n) => (n.taskIds || []).length || n.date);
  else if (folder !== 'all') list = list.filter((n) => n.folderId === folder);
  if (tag) list = list.filter((n) => (n.tags || []).includes(tag));
  if (query) list = list.map((n) => [n, L.searchScore(query, [[n.title, 4], [(n.tags || []).join(' '), 3], [L.htmlToText(n.html), 1]])]).filter((x) => x[1]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  else list.sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
  const tags = [...new Set(S.notes.flatMap((n) => n.tags || []))].sort();
  const link = (f, t) => `#/notes?${new URLSearchParams({ ...(f && f !== 'all' ? { f } : {}), ...(t ? { t } : {}) })}`;
  el.innerHTML = `
    <div class="searchbar">${ic('search')}<input type="search" placeholder="Search all notes…" value="${esc(query)}" data-nsearch aria-label="Search notes"></div>
    <div class="chips">${[['all', 'All'], ['pinned', '📌 Pinned'], ['daily', '🗓 Daily'], ['linked', '🔗 Linked']].map(([k, n]) => `<a class="chip ${folder === k ? 'on' : ''}" href="${link(k, tag)}">${n}</a>`).join('')}
      ${S.folders.map((f) => `<a class="chip ${folder === f.id ? 'on' : ''}" href="${link(f.id, tag)}"><span class="dot" style="background:${f.color}"></span>${esc(f.name)}</a>`).join('')}
      <button class="chip" data-newfolder>${ic('plus').replace('i-plus', 'i-plus" style="width:14px;height:14px')} Folder</button></div>
    ${tags.length ? `<div class="chips">${tags.map((t) => `<a class="chip ${tag === t ? 'on' : ''}" href="${link(folder, tag === t ? '' : t)}">#${esc(t)}</a>`).join('')}</div>` : ''}
    <div class="h-row"><h3 class="h2">${list.length} note${list.length === 1 ? '' : 's'}${folder !== 'all' && S.folders.find((f) => f.id === folder) ? ` <button class="link-btn" data-editfolder="${folder}">Edit folder</button>` : ''}</h3><button class="btn sm primary" data-newnote-list>${ic('plus')} New note</button></div>
    <div class="ngrid">${list.length ? list.map(noteCard).join('') : `<div class="empty card" style="grid-column:1/-1"><span class="big">📝</span>${query ? 'No notes match that search.' : 'No notes here yet.'}</div>`}</div>`;
  const s = $('[data-nsearch]', el);
  s.addEventListener('input', () => { clearTimeout(s._t); s._t = setTimeout(() => { const p = new URLSearchParams(location.hash.split('?')[1] || ''); if (s.value) p.set('q', s.value); else p.delete('q'); history.replaceState(null, '', '#/notes?' + p); render(); const n = $('[data-nsearch]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 120); });
  for (const n of list) if ((n.images || []).length) Images.url(n.images[0]).then((u) => { const th = $(`[data-thumb="${n.id}"]`); if (th && u) th.style.backgroundImage = `url(${u})`; });
};
function noteCard(n) {
  const txt = L.htmlToText(n.html); const cp = L.checklistProgress(n.html);
  const f = S.folders.find((x) => x.id === n.folderId);
  const tasks = (n.taskIds || []).map((id) => S.tasks.find((t) => t.id === id)).filter(Boolean);
  return `<a class="ncard" href="#/note/${n.id}">${(n.images || []).length ? `<div class="thumb" data-thumb="${n.id}"></div>` : ''}
    ${n.pinned ? `<span class="pin">${ic('pin')}</span>` : ''}<h3>${esc(n.title || 'Untitled')}</h3><p>${esc(txt.slice(0, 220)) || '<span class="faint">Empty</span>'}</p>
    <div class="foot">${cp.all ? `<span class="badge ${cp.done === cp.all ? 'ok' : ''}">☑ ${cp.done}/${cp.all}</span>` : ''}${f ? `<span class="badge"><span class="dot" style="width:7px;height:7px;border-radius:50%;background:${f.color}"></span>${esc(f.name)}</span>` : ''}
    ${tasks.length ? `<span class="badge">🔗 ${esc(tasks[0].title.slice(0, 18))}${tasks.length > 1 ? ' +' + (tasks.length - 1) : ''}</span>` : ''}${n.daily ? `<span class="badge">🗓 ${dayLabel(n.daily)}</span>` : n.date ? `<span class="badge">📅 ${dayLabel(n.date)}</span>` : ''}
    ${(n.tags || []).filter((t) => t !== 'daily').slice(0, 3).map((t) => `<span class="tagc">#${esc(t)}</span>`).join('')}<span class="tiny faint" style="margin-left:auto">${relTime(n.updated)}</span></div></a>`;
}
function relTime(ms) { const s = (Date.now() - ms) / 1000; if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; }
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-newnote-list]')) { const p = new URLSearchParams(location.hash.split('?')[1] || ''); const f = p.get('f'); const n = { id: L.uid(), title: '', html: '', tags: p.get('t') ? [p.get('t')] : [], taskIds: [], pinned: f === 'pinned', folderId: S.folders.find((x) => x.id === f) ? f : null, date: null }; await putNote(n, true); location.hash = '#/note/' + n.id; }
  if (e.target.closest('[data-newfolder]')) folderSheet();
  const ef = e.target.closest('[data-editfolder]'); if (ef) folderSheet(S.folders.find((f) => f.id === ef.dataset.editfolder));
});
const FCOLORS = ['#FF4655', '#8B6CFF', '#4FB3FF', '#2FD8A0', '#FFB443', '#F06BC7', '#8E97AD'];
function folderSheet(f) {
  const x = f ? { ...f } : { id: L.uid(), name: '', color: FCOLORS[S.folders.length % FCOLORS.length] };
  openSheet(`<h3>${f ? 'Edit folder' : 'New folder'}</h3><input class="f-title" data-fn placeholder="Folder name, e.g. DBMS" value="${esc(x.name)}" autofocus>
    <div class="field"><span class="flabel">Color</span><div class="opts" data-fc>${FCOLORS.map((c) => `<button type="button" class="opt ${x.color === c ? 'on' : ''}" data-v="${c}" style="--c:${c}"><span class="dot"></span></button>`).join('')}</div></div>
    <div class="sheet-actions">${f ? `<button class="btn danger" data-fdel>${ic('trash')}Delete</button>` : '<span></span>'}<button class="btn primary" data-fsave>Save</button></div>`, (sh) => {
    sh.querySelector('[data-fc]').onclick = (e) => { const b = e.target.closest('.opt'); if (!b) return; x.color = b.dataset.v; $$('.opt', b.parentElement).forEach((o) => o.classList.toggle('on', o === b)); };
    sh.querySelector('[data-fsave]').onclick = async () => { x.name = sh.querySelector('[data-fn]').value.trim() || 'Folder'; closeSheet(); await putFolder(x); if (!f) location.hash = '#/notes?f=' + x.id; };
    const d = sh.querySelector('[data-fdel]'); if (d) d.onclick = async () => { closeSheet(); for (const n of S.notes.filter((n) => n.folderId === f.id)) { n.folderId = null; await putNote(n, true); } S.folders = S.folders.filter((y) => y.id !== f.id); await tomb('folders', f); location.hash = '#/notes'; render(); toast('Folder deleted (notes kept)'); };
  });
}

// ---- note editor ----
const ALLOWED = new Set(['P', 'DIV', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'A', 'IMG', 'SPAN', 'HR']);
export function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const walk = (node) => {
    for (const c of [...node.childNodes]) {
      if (c.nodeType === 1) {
        if (!ALLOWED.has(c.tagName)) { if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].includes(c.tagName)) c.remove(); else { walk(c); c.replaceWith(...c.childNodes); } continue; }
        for (const a of [...c.attributes]) {
          const ok = (a.name === 'class' && /^checklist$/.test(a.value)) || a.name === 'data-checked' || a.name === 'data-img' || (a.name === 'href' && /^(https?:|mailto:)/i.test(a.value));
          if (!ok) c.removeAttribute(a.name);
        }
        if (c.tagName === 'A') { c.setAttribute('target', '_blank'); c.setAttribute('rel', 'noopener'); }
        walk(c);
      }
    }
  };
  walk(doc.body.firstChild);
  return doc.body.firstChild.innerHTML;
}
views.note = (el, parts) => {
  const n = S.notes.find((x) => x.id === parts[1]);
  if (!n) { el.innerHTML = `<div class="empty card"><span class="big">🤷</span>Note not found. <a href="#/notes">Back to notes</a></div>`; return; }
  const tasks = (n.taskIds || []).map((id) => S.tasks.find((t) => t.id === id)).filter(Boolean);
  el.innerHTML = `
    <div class="ed-top"><a class="icon-btn" href="#/notes" aria-label="Back to notes" data-back>${ic('chevl')}</a><span class="saved" data-saved>Saved on this device</span><span style="flex:1"></span>
      <button class="icon-btn" data-pin aria-label="${n.pinned ? 'Unpin' : 'Pin'}" style="${n.pinned ? 'color:var(--accent)' : ''}">${ic('pin')}</button>
      <button class="icon-btn" data-ndel aria-label="Delete note">${ic('trash')}</button></div>
    <input class="ed-title" data-title placeholder="Title" value="${esc(n.title)}" aria-label="Note title">
    <div class="toolbar" role="toolbar" aria-label="Formatting">
      <button data-cmd="h1" aria-label="Heading 1">${ic('h1')}</button><button data-cmd="h2" aria-label="Heading 2">${ic('h2')}</button><span class="sep"></span>
      <button data-cmd="bold" aria-label="Bold">${ic('bold')}</button><button data-cmd="italic" aria-label="Italic">${ic('italic')}</button><button data-cmd="underline" aria-label="Underline">${ic('under')}</button><button data-cmd="strikeThrough" aria-label="Strikethrough">${ic('strike')}</button><span class="sep"></span>
      <button data-cmd="insertUnorderedList" aria-label="Bullet list">${ic('list')}</button><button data-cmd="insertOrderedList" aria-label="Numbered list">${ic('olist')}</button><button data-cmd="checklist" aria-label="Checklist">${ic('checklist')}</button><button data-cmd="quote" aria-label="Quote">${ic('quote')}</button><button data-cmd="code" aria-label="Code block">${ic('code')}</button><span class="sep"></span>
      <label class="tbtn" aria-label="Insert image" style="flex:none;width:38px;height:36px;border-radius:9px;display:grid;place-items:center;color:var(--muted);cursor:pointer">${ic('image')}<input type="file" accept="image/*" hidden data-edimg></label>
      <button data-cmd="p" aria-label="Normal text" style="font-weight:800;font-size:13px">Aa</button>
    </div>
    <div class="editor" contenteditable="true" data-ph="Start writing… Try “# ” for a heading, “- ” for bullets, “[] ” for a checklist." spellcheck="true"></div>
    <div class="meta-row">${ic('folder')}<select class="inp" data-folder style="width:auto;height:36px">${`<option value="">No folder</option>` + S.folders.map((f) => `<option value="${f.id}" ${n.folderId === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></div>
    <div class="meta-row">${ic('tag')}<div class="tag-input" data-tags></div></div>
    <div class="meta-row">${ic('link')}<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex:1">
      ${tasks.map((t) => `<span class="badge" style="cursor:pointer" data-open-task="${t.id}" data-date="${t.date || ''}">☑ ${esc(t.title)}</span>`).join('')}
      ${n.daily ? `<a class="badge" href="#/plan/day/${n.daily}">🗓 Daily note · ${dayLabel(n.daily)}</a>` : n.date ? `<a class="badge" href="#/plan/day/${n.date}">📅 ${dayLabel(n.date)}</a>` : ''}
      <button class="link-btn" data-linktask>+ Link to task</button>${!n.daily ? `<label class="link-btn" style="cursor:pointer">+ Attach to day<input type="date" data-nday value="${n.date || ''}" style="width:1px;height:1px;opacity:0;position:absolute"></label>` : ''}</div></div>`;
  const ed = $('.editor', el);
  ed.innerHTML = sanitize(n.html);
  const ph = () => ed.classList.toggle('is-empty', !ed.textContent.trim() && !ed.querySelector('img,li,h1,h2,h3'));
  ph(); ed.addEventListener('input', ph);
  hydrateImages(ed);
  let t; const save = (quiet) => { clearTimeout(t); t = setTimeout(async () => { n.title = $('[data-title]', el).value; n.html = serialize(ed); n.images = [...ed.querySelectorAll('img[data-img]')].map((i) => i.dataset.img); await putNote(n, true); const s = $('[data-saved]'); if (s) s.textContent = 'Saved ✓'; }, quiet ? 0 : 350); const s = $('[data-saved]'); if (s) s.textContent = 'Saving…'; };
  ed.addEventListener('input', () => save());
  $('[data-title]', el).addEventListener('input', () => save());
  $('[data-title]', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ed.focus(); } });
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) {}
  ed.addEventListener('focus', () => { if (!ed.innerHTML.trim()) { ed.innerHTML = '<p><br></p>'; const r = document.createRange(); r.setStart(ed.firstChild, 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); } });
  $('.toolbar', el).addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('.toolbar', el).addEventListener('click', (e) => { const b = e.target.closest('[data-cmd]'); if (!b) return; ed.focus(); fmt(b.dataset.cmd, ed); save(); });
  $('[data-edimg]', el).addEventListener('change', async (e) => { for (const f of e.target.files) { try { const id = await Images.add(f); ed.focus(); const u = await Images.url(id); document.execCommand('insertHTML', false, `<img data-img="${id}" src="${u}" alt=""><p><br></p>`); } catch (_) { toast('Could not read that image'); } } e.target.value = ''; save(); });
  ed.addEventListener('click', (e) => { const li = e.target.closest('ul.checklist > li'); if (li && e.offsetX < 26) { li.dataset.checked = li.dataset.checked === 'true' ? 'false' : 'true'; save(); } const a = e.target.closest('a[href]'); if (a && (e.ctrlKey || e.metaKey)) window.open(a.href, '_blank'); });
  ed.addEventListener('keydown', (e) => mdShortcuts(e, ed, save));
  ed.addEventListener('paste', (e) => { const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')); if (items.length) { e.preventDefault(); items.forEach(async (it) => { const id = await Images.add(it.getAsFile()); const u = await Images.url(id); document.execCommand('insertHTML', false, `<img data-img="${id}" src="${u}" alt="">`); save(); }); return; } const html = e.clipboardData?.getData('text/html'); if (html) { e.preventDefault(); document.execCommand('insertHTML', false, sanitize(html)); } });
  $('[data-folder]', el).onchange = (e) => { n.folderId = e.target.value || null; save(true); };
  $('[data-pin]', el).onclick = async () => { n.pinned = !n.pinned; await putNote(n, true); render(); };
  $('[data-ndel]', el).onclick = async () => { const copy = { ...n }; await delNote(n.id); location.hash = '#/notes'; toast('Note deleted', 'Undo', () => { putNote(copy).then(() => location.hash = '#/note/' + copy.id); }); };
  $('[data-linktask]', el).onclick = () => pickTask(async (tk) => { n.taskIds = [...new Set([...(n.taskIds || []), tk.id])]; await putNote(n, true); render(); toast('Linked to ' + tk.title); });
  const nd = $('[data-nday]', el); if (nd) { nd.onchange = async () => { n.date = nd.value || null; await putNote(n, true); render(); }; nd.parentElement.onclick = (e) => { if (e.target === nd) return; try { nd.showPicker(); } catch (_) { nd.click(); } }; }
  const tagsEl = $('[data-tags]', el);
  const drawTags = () => { tagsEl.innerHTML = (n.tags || []).map((t, i) => `<span class="tagx">#${esc(t)}<button data-tx="${i}" aria-label="Remove tag">${ic('x')}</button></span>`).join('') + `<input data-tin placeholder="Add tag…" aria-label="Add tag" enterkeyhint="done">`; };
  drawTags();
  tagsEl.addEventListener('click', (e) => { const x = e.target.closest('[data-tx]'); if (x) { n.tags.splice(x.dataset.tx, 1); drawTags(); save(true); } });
  tagsEl.addEventListener('keydown', (e) => { if (e.target.matches('[data-tin]') && (e.key === 'Enter' || e.key === ',' || e.key === ' ')) { e.preventDefault(); const v = e.target.value.trim().replace(/^#/, '').toLowerCase(); if (v) { n.tags = [...new Set([...(n.tags || []), v])]; drawTags(); save(true); tagsEl.querySelector('[data-tin]').focus(); } } });
  tagsEl.addEventListener('focusout', (e) => { if (e.target.matches('[data-tin]') && e.target.value.trim()) { const v = e.target.value.trim().replace(/^#/, '').toLowerCase(); n.tags = [...new Set([...(n.tags || []), v])]; drawTags(); save(true); } });
  if (!n.title && !n.html) setTimeout(() => $('[data-title]', el).focus(), 60);
  window.onbeforeunload = null;
};
function serialize(ed) { const c = ed.cloneNode(true); c.querySelectorAll('img[data-img]').forEach((i) => i.removeAttribute('src')); return sanitize(c.innerHTML); }
async function hydrateImages(root) { for (const img of root.querySelectorAll('img[data-img]')) { const u = await Images.url(img.dataset.img); if (u) img.src = u; else img.alt = '[image missing]'; } }
function fmt(cmd, ed) {
  const block = (tag) => { const cur = document.queryCommandValue('formatBlock').toLowerCase(); document.execCommand('formatBlock', false, cur === tag ? 'p' : tag); };
  if (cmd === 'h1' || cmd === 'h2') return block(cmd);
  if (cmd === 'quote') return block('blockquote');
  if (cmd === 'code') return block('pre');
  if (cmd === 'p') return document.execCommand('formatBlock', false, 'p');
  if (cmd === 'checklist') {
    const sel = getSelection(); const li = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).closest('li');
    const ul = li && li.parentElement;
    if (ul && ul.tagName === 'UL') { if (ul.classList.contains('checklist')) { ul.classList.remove('checklist'); ul.querySelectorAll('li').forEach((x) => x.removeAttribute('data-checked')); } else { ul.classList.add('checklist'); ul.querySelectorAll('li').forEach((x) => x.dataset.checked = 'false'); } return; }
    document.execCommand('insertUnorderedList');
    const n2 = getSelection().anchorNode; const ul2 = n2 && (n2.nodeType === 1 ? n2 : n2.parentElement).closest('ul');
    if (ul2) { ul2.classList.add('checklist'); ul2.querySelectorAll('li').forEach((x) => { if (!x.dataset.checked) x.dataset.checked = 'false'; }); }
    return;
  }
  document.execCommand(cmd);
}
function mdShortcuts(e, ed, save) {
  if (e.key === 'Enter') { // new checklist items start unchecked
    setTimeout(() => { ed.querySelectorAll('ul.checklist li:not([data-checked])').forEach((x) => x.dataset.checked = 'false'); const n = getSelection().anchorNode; const li = n && (n.nodeType === 1 ? n : n.parentElement).closest('ul.checklist li'); if (li && li.dataset.checked === 'true' && !li.textContent.trim()) li.dataset.checked = 'false'; }, 0);
    return;
  }
  if (e.key !== ' ') return;
  const sel = getSelection(); if (!sel.rangeCount || !sel.isCollapsed) return; const node = sel.anchorNode; if (!node || node.nodeType !== 3) return;
  const before = node.textContent.slice(0, sel.anchorOffset);
  const map = { '#': 'h1', '##': 'h2', '###': 'h3', '-': 'ul', '*': 'ul', '1.': 'ol', '[]': 'cl', '>': 'quote' };
  const k = map[before];
  if (!k) return;
  // only at the very start of a block
  const block = node.parentElement.closest('p,div,h1,h2,h3,li,blockquote,pre');
  const r0 = document.createRange(); r0.selectNodeContents(block && ed.contains(block) && block !== ed ? block : ed); r0.setEnd(node, sel.anchorOffset);
  if (r0.toString() !== before) return;
  e.preventDefault();
  for (let i = 0; i < before.length; i++) document.execCommand('delete');
  if (node.parentElement === ed || !block || block === ed) document.execCommand('formatBlock', false, 'p');
  if (k === 'h1' || k === 'h2' || k === 'h3') document.execCommand('formatBlock', false, k);
  else if (k === 'ul') document.execCommand('insertUnorderedList');
  else if (k === 'ol') document.execCommand('insertOrderedList');
  else if (k === 'quote') document.execCommand('formatBlock', false, 'blockquote');
  else if (k === 'cl') fmt('checklist', ed);
  save();
}
function pickTask(cb) {
  const list = [...S.tasks].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  openSheet(`<h3>Link to a task</h3><div class="searchbar">${ic('search')}<input placeholder="Search tasks" data-pq autofocus></div><div class="pick-list" data-pl></div>`, (sh) => {
    const draw = (q) => { const r = q ? list.filter((t) => L.searchScore(q, [[t.title, 1]])) : list; sh.querySelector('[data-pl]').innerHTML = r.length ? r.slice(0, 60).map((t) => `<div class="lnote" data-pick="${t.id}" style="--c:${colorOf(t)}"><span class="prio" style="background:${colorOf(t)}"></span><div class="body"><div class="t">${esc(t.title)}</div><div class="s">${t.date ? dayLabel(t.date) : 'Inbox'} ${t.start ? fmtRange(t.start, t.end) : ''}</div></div></div>`).join('') : '<div class="empty">No tasks found</div>'; };
    draw(''); sh.querySelector('[data-pq]').oninput = (e) => draw(e.target.value);
    sh.querySelector('[data-pl]').onclick = (e) => { const p = e.target.closest('[data-pick]'); if (p) { e.stopPropagation(); closeSheet(); cb(S.tasks.find((t) => t.id === p.dataset.pick)); } };
  });
}

// ================= HABITS =================
views.habits = (el) => {
  const d = today(); const ws = L.weekStart(d, S.settings.weekMonday);
  const habs = S.habits.filter((h) => !h.archived);
  const totalWeek = habs.reduce((a, h) => { const w = L.habitWeek(h, d); return [a[0] + w.done, a[1] + w.due]; }, [0, 0]);
  const pct = totalWeek[1] ? Math.round((totalWeek[0] / totalWeek[1]) * 100) : 0;
  el.innerHTML = `
    <section class="hero"><div class="ring" style="--p:${pct}"><div><span>${pct}%</span><small>this week</small></div></div>
      <div><h2>Habits</h2><p class="muted small">${habs.length ? `${totalWeek[0]} of ${totalWeek[1]} check-ins this week. Keep the streaks alive 🔥` : 'Build small daily wins. Add your first habit.'}</p></div></section>
    <div class="h-row"><h3 class="h2">Your habits</h3><button class="btn sm primary" data-newhab>${ic('plus')} New habit</button></div>
    <div class="grid2" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">${habs.length ? habs.map((h) => habitCard(h, d, ws)).join('') : `<div class="empty card"><span class="big">🌱</span>No habits yet. Try “Drink water”, “Gym”, “1 LeetCode problem”.</div>`}</div>`;
};
function habitCard(h, d, ws) {
  const streak = L.habitStreak(h, d), best = L.habitBest(h, d), wk = L.habitWeek(h, d);
  const heat = []; const hs = addDays(L.weekStart(d, S.settings.weekMonday), -7 * 11);
  for (let i = 0; i < 84; i++) { const s = addDays(hs, i); if (s > d) heat.push('<i style="visibility:hidden"></i>'); else heat.push(`<i class="${(h.log || {})[s] ? 'on' : ''} ${L.habitDueOn(h, s) ? '' : 'na'}" title="${s}"></i>`); }
  return `<div class="hcard" style="--c:${h.color || '#8B6CFF'}">
    <div class="hhead"><div class="em">${esc(h.emoji || '⭐')}</div><div class="nm"><b>${esc(h.name)}</b><span class="small muted">${h.days && h.days.length && h.days.length < 7 ? h.days.map((x) => DOW[x]).join(' ') : 'Every day'} · best ${best}</span></div>
      <div class="streak" title="Current streak">${ic('flame')}${streak}</div><button class="icon-btn" data-edithab="${h.id}" aria-label="Edit habit">${ic('more')}</button></div>
    <div class="hweek">${[0, 1, 2, 3, 4, 5, 6].map((i) => { const s = addDays(ws, i); const due = L.habitDueOn(h, s); const on = (h.log || {})[s]; return `<div class="hday ${s === d ? 'today' : ''}">${DOW[parseYmd(s).getDay()][0]}<button class="${on ? 'on' : ''} ${!due ? 'off' : ''}" data-hab="${h.id}" data-date="${s}" ${s > d ? 'disabled' : ''} aria-label="${DOW[parseYmd(s).getDay()]} ${on ? 'done' : 'not done'}">${ic('check')}</button></div>`; }).join('')}</div>
    <div><div style="display:flex;justify-content:space-between" class="small muted"><span>Weekly consistency</span><b style="color:var(--text)">${wk.pct}%</b></div><div class="hbar"><i style="width:${wk.pct}%"></i></div></div>
    <div class="heat" aria-label="Last 12 weeks">${heat.join('')}</div></div>`;
}
const EMOJIS = ['💧', '🏋️', '🧠', '📚', '🧘', '🏃', '😴', '🥗', '💻', '🎯', '✍️', '🎮', '🚭', '💊', '🙏', '🎸'];
function habitSheet(h) {
  const x = h ? JSON.parse(JSON.stringify(h)) : { id: L.uid(), name: '', emoji: '🎯', color: FCOLORS[S.habits.length % FCOLORS.length], days: [], log: {}, created: today() };
  openSheet(`<h3>${h ? 'Edit habit' : 'New habit'}</h3><input class="f-title" data-hn placeholder="Habit name, e.g. Gym" value="${esc(x.name)}" autofocus>
    <div class="field"><span class="flabel">Icon</span><div class="opts" data-he>${EMOJIS.map((e) => `<button type="button" class="opt ${x.emoji === e ? 'on' : ''}" data-v="${e}" style="font-size:17px">${e}</button>`).join('')}</div></div>
    <div class="field"><span class="flabel">Color</span><div class="opts" data-hc>${FCOLORS.map((c) => `<button type="button" class="opt ${x.color === c ? 'on' : ''}" data-v="${c}" style="--c:${c}"><span class="dot"></span></button>`).join('')}</div></div>
    <div class="field"><span class="flabel">Days (none = every day)</span><div class="opts" data-hd>${[1, 2, 3, 4, 5, 6, 0].map((i) => `<button type="button" class="opt ${x.days.includes(i) ? 'on' : ''}" data-v="${i}">${DOW[i]}</button>`).join('')}</div></div>
    <div class="sheet-actions">${h ? `<button class="btn danger" data-hdel>${ic('trash')}Delete</button>` : '<span></span>'}<button class="btn primary" data-hsave>Save</button></div>`, (sh) => {
    const one = (sel, key, num) => sh.querySelector(sel).onclick = (e) => { const b = e.target.closest('.opt'); if (!b) return; x[key] = num ? Number(b.dataset.v) : b.dataset.v; $$('.opt', b.parentElement).forEach((o) => o.classList.toggle('on', o === b)); };
    one('[data-he]', 'emoji'); one('[data-hc]', 'color');
    sh.querySelector('[data-hd]').onclick = (e) => { const b = e.target.closest('.opt'); if (!b) return; const v = Number(b.dataset.v); x.days = x.days.includes(v) ? x.days.filter((y) => y !== v) : [...x.days, v]; b.classList.toggle('on'); };
    sh.querySelector('[data-hsave]').onclick = async () => { x.name = sh.querySelector('[data-hn]').value.trim() || 'Habit'; closeSheet(); await putHabit(x); };
    const del = sh.querySelector('[data-hdel]'); if (del) del.onclick = async () => { closeSheet(); S.habits = S.habits.filter((y) => y.id !== h.id); await tomb('habits', h); render(); toast('Habit deleted', 'Undo', () => putHabit(h)); };
  });
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-newhab]')) habitSheet(); const eh = e.target.closest('[data-edithab]'); if (eh) habitSheet(S.habits.find((h) => h.id === eh.dataset.edithab)); });

// ================= SEARCH =================
function openSearch() {
  const root = $('#sheetRoot');
  root.innerHTML = `<div class="so" role="dialog" aria-label="Search"><div class="so-in"><div class="searchbar" style="margin-top:4px">${ic('search')}<input type="search" placeholder="Search tasks, notes, habits…" data-gq aria-label="Search everything"><button class="icon-btn" data-gx aria-label="Close search">${ic('x')}</button></div><div data-gr><p class="muted small" style="padding:8px 4px">Search runs on your device, instantly, even offline.</p></div></div></div>`;
  const inp = $('[data-gq]', root); inp.focus();
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', k); };
  const k = (e) => { if (e.key === 'Escape') close(); }; document.addEventListener('keydown', k);
  $('[data-gx]', root).onclick = close;
  const hl = (s, q) => { let out = esc(s); for (const t of q.split(/\s+/).filter(Boolean)) out = out.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`); return out; };
  inp.oninput = () => {
    const q = inp.value.trim(); const gr = $('[data-gr]', root); if (!q) { gr.innerHTML = ''; return; }
    const ts = S.tasks.map((t) => [t, L.searchScore(q, [[t.title, 3], [t.info, 1], [(t.subtasks || []).map((s) => s.t).join(' '), 1], [t.category, 1]])]).filter((x) => x[1]).sort((a, b) => b[1] - a[1]).slice(0, 20);
    const ns = S.notes.map((n) => [n, L.searchScore(q, [[n.title, 4], [(n.tags || []).join(' '), 3], [L.htmlToText(n.html), 1]])]).filter((x) => x[1]).sort((a, b) => b[1] - a[1]).slice(0, 30);
    const hs = S.habits.filter((h) => L.searchScore(q, [[h.name, 1]]));
    gr.innerHTML = (ts.length ? `<div class="res-h">Tasks</div><div class="tlist">${ts.map(([t]) => taskRow(t)).join('')}</div>` : '') +
      (ns.length ? `<div class="res-h">Notes</div><div class="tlist">${ns.map(([n]) => { const txt = L.htmlToText(n.html); const i = Math.max(0, txt.toLowerCase().indexOf(q.split(/\s+/)[0].toLowerCase()) - 30); return `<div class="lnote" data-open-note="${n.id}">${ic('note')}<div class="body"><div class="t">${hl(n.title || 'Untitled', q)}</div><div class="s">${hl(txt.slice(i, i + 110), q)}</div></div></div>`; }).join('')}</div>` : '') +
      (hs.length ? `<div class="res-h">Habits</div><div class="tlist">${hs.map((h) => `<a class="lnote" href="#/habits">${esc(h.emoji)} <div class="body"><div class="t">${hl(h.name, q)}</div></div></a>`).join('')}</div>` : '') +
      (!ts.length && !ns.length && !hs.length ? '<div class="empty">Nothing found</div>' : '');
  };
  root.addEventListener('click', (e) => { if (e.target.closest('[data-open-note],a[href]')) close(); });
}

// ================= SETTINGS =================
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (route().parts[0] === 'settings') render(); });
const sw = (name, on) => `<label class="switch"><input type="checkbox" data-set="${name}" ${on ? 'checked' : ''}><span></span></label>`;
views.settings = async (el) => {
  const st = S.settings; const ns = await Notify.status();
  const est = await db.estimate();
  const theme = localStorage.getItem('shp-theme') || 'dark';
  const native = Notify.isNative();
  el.innerHTML = `
    ${Acct.accountSectionHtml()}
    <div class="h-row"><h3 class="h2">Profile & look</h3></div>
    <div class="set-group">
      <div class="set-row"><div class="lbl"><b>Your name</b><span>Used in the greeting</span></div><input class="inp" style="max-width:170px" data-set-text="name" value="${esc(st.name)}" placeholder="Name"></div>
      <div class="set-row"><div class="lbl"><b>Theme</b></div><div class="seg">${['dark', 'light', 'system'].map((t) => `<button class="${theme === t ? 'on' : ''}" data-theme-set="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
      <div class="set-row"><div class="lbl"><b>Week starts Monday</b></div>${sw('weekMonday', st.weekMonday)}</div>
    </div>
    <div class="h-row"><h3 class="h2">${ic('bell')} Reminders & notifications</h3></div>
    <div class="set-group">
      <div class="set-row"><div class="lbl"><b>Notifications</b><span>${esc(ns.label)}</span></div>${ns.canAsk ? `<button class="btn sm primary" data-notif-enable>Enable</button>` : ns.granted ? `<button class="btn sm" data-notif-test>Test</button>` : ''}</div>
      ${ns.exact === 'denied' ? `<div class="set-row"><div class="lbl"><b>Exact alarms are off</b><span>Reminders may arrive a few minutes late. Allow “Alarms & reminders” for on-time alerts.</span></div><button class="btn sm" data-exact>Allow</button></div>` : ''}
      <div class="set-row"><div class="lbl"><b>Default reminder</b><span>For new timed tasks</span></div><select class="inp" style="max-width:170px" data-set-sel="defaultRemind">${opt(REMINDS, st.defaultRemind)}</select></div>
      <div class="set-row"><div class="lbl"><b>Daily planning nudge</b><span>A morning notification to plan your day</span></div>${sw('dailyPlanOn', st.dailyPlanOn)}</div>
      <div class="set-row"><div class="lbl"><b>Planning time</b></div><input class="inp" type="time" style="max-width:130px" data-set-text="dailyPlanTime" value="${st.dailyPlanTime}"></div>
      <div class="set-row"><div class="lbl"><b>Deadline alerts at</b><span>On the due day and the day before</span></div><input class="inp" type="time" style="max-width:130px" data-set-text="deadlineTime" value="${st.deadlineTime}"></div>
      <div class="set-row"><div class="lbl"><b>Upcoming alerts</b><span>${ns.pending != null ? ns.pending + ' scheduled' : Notify.upcoming(S.tasks, S.settings).length + ' in the next 14 days'}</span></div></div>
    </div>
    <div class="note-box">${native ? '<b>Android app:</b> reminders are real system alarms. They fire even when SH PLANNER is closed, offline, or after a phone restart.' : '<b>How reminders work on the web:</b> in a browser tab or the installed web app, alerts only fire while SH PLANNER is open (or was just backgrounded). Browsers don’t let websites set alarms that wake up a closed app. <b>For reminders that always fire, use the Android APK</b>, or export your tasks to Google Calendar below.'}</div>
    <div class="h-row"><h3 class="h2">Smart planner</h3></div>
    <div class="set-group">
      <div class="set-row"><div class="lbl"><b>Day starts</b><span>Smart slots won’t suggest before this</span></div><input class="inp" type="time" style="max-width:130px" data-set-text="dayStart" value="${st.dayStart}"></div>
      <div class="set-row"><div class="lbl"><b>Day ends</b></div><input class="inp" type="time" style="max-width:130px" data-set-text="dayEnd" value="${st.dayEnd}"></div>
    </div>
    <div class="h-row"><h3 class="h2">Backup & data</h3></div>
    <div class="set-group">
      <div class="set-row"><div class="lbl"><b>Export backup</b><span>Everything incl. images, as one .json file</span></div><button class="btn sm" data-export>${ic('download')}Export</button></div>
      <div class="set-row"><div class="lbl"><b>Restore backup</b><span>Merges into what’s here (newer edits win)</span></div><label class="btn sm">${ic('upload')}Import<input type="file" accept="application/json,.json" hidden data-import></label></div>
      <div class="set-row"><div class="lbl"><b>Export to calendar</b><span>.ics with reminders, for Google Calendar</span></div><button class="btn sm" data-ics>${ic('cal')}.ics</button></div>
      <div class="set-row"><div class="lbl"><b>Storage on this device</b><span>${S.tasks.length} tasks · ${S.notes.length} notes · ${S.habits.length} habits${est ? ` · ${(est.usage / 1048576).toFixed(1)} MB used` : ''}</span></div></div>
      <div class="set-row"><div class="lbl"><b>Erase everything</b><span>${Acct.isAccount() ? 'Deletes all data in your account, on every device' : 'Deletes all data on this device'}</span></div><button class="btn sm danger" data-wipe>Erase</button></div>
    </div>
    <div class="note-box">${Acct.privacyNote()}</div>
    <div class="h-row"><h3 class="h2">Get the app</h3></div>
    <div class="set-group">
      ${!native ? `<div class="set-row"><div class="lbl"><b>Android app (APK)</b><span>Real reminders that fire when the app is closed</span></div><a class="btn sm primary" href="downloads/SH-PLANNER.apk" download>${ic('download')}APK</a></div>` : ''}
      ${installEvt ? `<div class="set-row"><div class="lbl"><b>Install web app</b><span>Add SH PLANNER to your home screen</span></div><button class="btn sm" data-install>Install</button></div>` : ''}
      <div class="set-row"><div class="lbl"><b>SH PLANNER</b><span>v${VERSION} · by Shivesh · ${native ? 'Android app' : 'web'}</span></div><a class="link-btn" href="https://shivesh900.github.io/">More SH apps</a></div>
    </div>`;
  Acct.bindAccountSection(el);
  el.querySelectorAll('[data-set]').forEach((i) => i.onchange = () => saveSettings({ [i.dataset.set]: i.checked }).then(() => { if (i.dataset.set === 'dailyPlanOn' && i.checked) Notify.ensurePermission(true); }));
  el.querySelectorAll('[data-set-text]').forEach((i) => i.onchange = () => saveSettings({ [i.dataset.setText]: i.value }));
  el.querySelectorAll('[data-set-sel]').forEach((i) => i.onchange = () => saveSettings({ [i.dataset.setSel]: i.value === '' ? null : Number(i.value) }));
  el.querySelectorAll('[data-theme-set]').forEach((b) => b.onclick = () => setTheme(b.dataset.themeSet));
  const en = $('[data-notif-enable]', el); if (en) en.onclick = async () => { await Notify.ensurePermission(true); render(); };
  const te = $('[data-notif-test]', el); if (te) te.onclick = () => Notify.test();
  const ex = $('[data-exact]', el); if (ex) ex.onclick = () => Notify.openExactSettings();
  const ins = $('[data-install]', el); if (ins) ins.onclick = async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; render(); };
  $('[data-export]', el).onclick = exportBackup;
  $('[data-import]', el).onchange = (e) => importBackup(e.target.files[0]);
  $('[data-ics]', el).onclick = () => { const ics = L.toICS(S.tasks.filter((t) => t.date && !t.done)); download(new Blob([ics], { type: 'text/calendar' }), `sh-planner-${today()}.ics`); if (!Notify.isNative()) toast('Calendar file saved. Open it to add to Google Calendar.'); };
  $('[data-wipe]', el).onclick = () => openSheet(`<h3>Erase all data?</h3><p class="muted">${Acct.isAccount() ? 'This deletes every task, note, habit and image in your account, on all your devices.' : 'This deletes every task, note, habit and image on this device.'} Export a backup first if you might want it back.</p><div class="sheet-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn danger" data-yes>Erase everything</button></div>`, (sh) => {
    sh.querySelector('[data-close]').onclick = closeSheet;
    sh.querySelector('[data-yes]').onclick = async () => { if (Acct.isAccount()) { await Acct.eraseAll(); closeSheet(); changed(); toast('All data erased'); return; } for (const s of ['tasks', 'notes', 'folders', 'habits', 'images']) await db.clear(s); await db.put('kv', { id: 'seeded', value: true }); Object.assign(S, { tasks: [], notes: [], folders: [], habits: [] }); closeSheet(); changed(); toast('All data erased'); };
  });
};
async function download(blob, name) {
  if (Notify.isNative()) {
    try {
      const C = window.Capacitor; const FS = C.registerPlugin('Filesystem'); const SH = C.registerPlugin('Share');
      const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
      const w = await FS.writeFile({ path: name, data, directory: 'CACHE' });
      await SH.share({ title: name, dialogTitle: 'Save or send ' + name, files: [w.uri] });
      return;
    } catch (e) { if (!/cancel/i.test(String(e && e.message))) toast('Could not share the file: ' + (e && e.message || e)); return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); }
async function exportBackup() {
  const images = await Images.exportAll();
  const data = { app: 'sh-planner', version: 1, exportedAt: new Date().toISOString(), tasks: S.tasks, notes: S.notes, folders: S.folders, habits: S.habits, settings: S.settings, images };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  await download(blob, `sh-planner-backup-${today()}.json`);
  toast(`Backup saved (${S.tasks.length} tasks, ${S.notes.length} notes, ${images.length} images)`);
}
async function importBackup(file) {
  if (!file) return;
  let data; try { data = JSON.parse(await file.text()); } catch (_) { toast('That file isn’t valid JSON'); return; }
  const err = L.validateBackup(data); if (err) { toast(err); return; }
  const merge = (store, cur, inc) => { const map = new Map(cur.map((x) => [x.id, x])); for (const x of inc) { const c = map.get(x.id); if (!c || (x.updated || 0) >= (c.updated || 0)) map.set(x.id, x); } return [...map.values()]; };
  S.tasks = merge('tasks', S.tasks, data.tasks); S.notes = merge('notes', S.notes, data.notes); S.folders = merge('folders', S.folders, data.folders); S.habits = merge('habits', S.habits, data.habits || []);
  await Promise.all([db.bulkPut('tasks', S.tasks), db.bulkPut('notes', S.notes), db.bulkPut('folders', S.folders), db.bulkPut('habits', S.habits)]);
  for (const s of ['tasks', 'notes', 'folders', 'habits']) Acct.pushMany(s, S[s]);
  const n = await Images.importAll(data.images || []);
  changed(); toast(`Restored ${data.tasks.length} tasks, ${data.notes.length} notes, ${n} images`);
}

// ================= BOOT =================
function applyTheme(t) {
  localStorage.setItem('shp-theme', t);
  const eff = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
  document.documentElement.dataset.theme = eff;
  $('meta[name=theme-color]').content = eff === 'dark' ? '#0A0C12' : '#F4F5FA';
}
async function boot() {
  Acct.selectDb();
  try { await load(); } catch (e) { console.error(e); $('#view').innerHTML = `<div class="card"><b>Storage unavailable.</b><p class="muted">This browser blocked local storage (private mode?). SH PLANNER needs IndexedDB to save your data.</p></div>`; return; }
  const th = localStorage.getItem('shp-theme'); if (!th && S.settings.theme) setTheme(S.settings.theme);
  render();
  Acct.initAccounts({ S, defaults, render, toast, openSheet, closeSheet, esc, ic, applyTheme, seedIfNew, notifySync: () => Notify.sync(S.tasks, S.settings) });
  Acct.consumeToast();
  Acct.purgeOld().catch(() => {});
  db.persist();
  Notify.init({ onOpen: (data) => { if (data && data.date) location.hash = `#/plan/day/${data.date}`; }, onFire: (n) => toast(`🔔 ${n.title}: ${n.body}`, null, null, 6000) });
  Notify.sync(S.tasks, S.settings);
  setInterval(() => { const k = route().parts[0]; if ((k === 'home' || k === 'plan') && !$('#sheetRoot').innerHTML && !(document.activeElement && document.activeElement.matches('input,textarea'))) render(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { Notify.sync(S.tasks, S.settings); const k = route().parts[0]; if ((k === 'home' || k === 'plan') && !$('#sheetRoot').innerHTML) render(); } });
  if ('serviceWorker' in navigator && !Notify.isNative() && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (route().q.get('capture')) openCapture();
}
boot();
window.SHP = { S, L, render };
