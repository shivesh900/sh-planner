import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
// Works both in the dev layout (project/site + project/test) and in the repo (site files at the root).
const site = existsSync(new URL('../site/index.html', import.meta.url)) ? new URL('../site/', import.meta.url) : new URL('../', import.meta.url);
const L = await import(new URL('js/logic.js', site));
const read = (p) => readFileSync(new URL(p, site), 'utf8');
const now = new Date(2026, 9, 11, 15, 55); // Sun 11 Oct 2026, 3:55 PM

test('index.html: title, viewport, manifest, local assets only', () => {
  const html = read('index.html');
  assert.match(html, /<title>SH PLANNER/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1/);
  assert.match(html, /rel="manifest" href="manifest.webmanifest"/);
  for (const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    if (/^https?:/.test(m[1])) continue;
    assert.ok(existsSync(new URL(m[1], site)), 'missing asset ' + m[1]);
  }
  assert.doesNotMatch(html, /lorem ipsum|TODO|PLACEHOLDER/i);
});
test('manifest + service worker cache every shell file', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.name, 'SH PLANNER'); assert.equal(m.display, 'standalone');
  for (const i of m.icons) assert.ok(existsSync(new URL(i.src, site)), i.src);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  const sw = read('sw.js');
  const shell = JSON.parse(sw.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
  for (const f of shell) if (f !== './') assert.ok(existsSync(new URL(f, site)), 'sw shell file missing: ' + f);
  for (const f of ['js/app.js', 'js/logic.js', 'js/db.js', 'js/notify.js', 'js/images.js']) assert.ok(shell.includes(f), f + ' not precached');
});
test('quick add parses times, dates, repeat, priority, deadlines', () => {
  let r = L.parseQuickAdd('Study DSA 6-8pm tomorrow', now);
  assert.deepEqual([r.title, r.date, r.start, r.end], ['Study DSA', '2026-10-12', '18:00', '20:00']);
  r = L.parseQuickAdd('Gym at 7am daily', now); assert.deepEqual([r.title, r.start, r.repeat], ['Gym', '07:00', 'daily']);
  r = L.parseQuickAdd('Call mom fri 5pm', now); assert.deepEqual([r.date, r.start], ['2026-10-16', '17:00']);
  r = L.parseQuickAdd('Lab record 10-12pm 15/10', now); assert.deepEqual([r.date, r.start, r.end], ['2026-10-15', '10:00', '12:00']);
  r = L.parseQuickAdd('Submit OS assignment by 20 oct !high ~3h #college', now);
  assert.deepEqual([r.title, r.date, r.due, r.priority, r.estimate, r.category], ['Submit OS assignment', null, '2026-10-20', 3, 180, 'college']);
  r = L.parseQuickAdd('DBMS project due fri 11:59pm', now); assert.deepEqual([r.due, r.dueTime, r.start], ['2026-10-16', '23:59', null]);
  r = L.parseQuickAdd('Read 30 pages every mon', now); assert.deepEqual([r.repeat, r.date], ['weekly', '2026-10-12']);
  r = L.parseQuickAdd('Revise CN at 9 for 2h', now); assert.deepEqual([r.start, r.end], ['09:00', '11:00']);
});
test('recurrence: daily, weekdays, weekly, skips, per-day done', () => {
  const t = { id: 'x', date: '2026-10-12', repeat: 'weekdays', skip: ['2026-10-14'], doneDates: { '2026-10-13': true } };
  assert.equal(L.occursOn(t, '2026-10-11'), false);
  assert.equal(L.occursOn(t, '2026-10-12'), true);
  assert.equal(L.occursOn(t, '2026-10-14'), false);
  assert.equal(L.occursOn(t, '2026-10-17'), false);
  assert.equal(L.isDoneOn(t, '2026-10-13'), true); assert.equal(L.isDoneOn(t, '2026-10-12'), false);
  assert.equal(L.occursOn({ date: '2026-10-11', repeat: 'weekly' }, '2026-10-18'), true);
  assert.equal(L.occursOn({ date: '2026-10-11', repeat: 'weekly' }, '2026-10-19'), false);
});
test('notification schedule: reminders, deadlines, daily plan, stable ids, skips done/past', () => {
  const tasks = [
    { id: 'a', title: 'Class', date: '2026-10-11', start: '16:30', end: '17:30', remind: 10, repeat: 'daily', doneDates: { '2026-10-12': true } },
    { id: 'b', title: 'Old', date: '2026-10-11', start: '09:00', remind: 0 },
    { id: 'c', title: 'OS', due: '2026-10-13', dueTime: '23:59' },
    { id: 'd', title: 'Done thing', date: '2026-10-11', start: '18:00', remind: 5, done: true },
  ];
  const list = L.computeNotifications(tasks, { dailyPlanOn: true, dailyPlanTime: '08:00', deadlineTime: '09:00' }, now, 3);
  const keys = list.map((n) => n.key);
  assert.ok(keys.includes('r:a:2026-10-11')); assert.ok(!keys.includes('r:a:2026-10-12'), 'done occurrence skipped'); assert.ok(keys.includes('r:a:2026-10-13'));
  assert.ok(!keys.some((k) => k.startsWith('r:b')), 'past reminder skipped'); assert.ok(!keys.some((k) => k.startsWith('r:d')), 'done task skipped');
  assert.ok(keys.includes('d1:c:2026-10-13') && keys.includes('d0:c:2026-10-13') && keys.includes('dh:c:2026-10-13'));
  assert.ok(keys.includes('p:2026-10-12') && !keys.includes('p:2026-10-11'));
  const r = list.find((n) => n.key === 'r:a:2026-10-11'); assert.equal(new Date(r.at).getHours() * 60 + new Date(r.at).getMinutes(), 16 * 60 + 20);
  for (let i = 1; i < list.length; i++) assert.ok(list[i].at >= list[i - 1].at, 'sorted');
  for (const n of list) { assert.ok(Number.isInteger(n.id) && n.id > 0 && n.id < 2 ** 31); }
  assert.equal(L.hashId('r:a:2026-10-11'), L.hashId('r:a:2026-10-11'));
  assert.equal(new Set(list.map((n) => n.id)).size, list.length, 'ids unique');
  assert.ok(L.computeNotifications(tasks, {}, now, 14, 5).length <= 5, 'capped');
});
test('habits: streaks and weekly consistency', () => {
  const h = { days: [], created: '2026-10-01', log: { '2026-10-08': true, '2026-10-09': true, '2026-10-10': true } };
  assert.equal(L.habitStreak(h, '2026-10-11'), 3, "today not done yet keeps yesterday's streak");
  h.log['2026-10-11'] = true; assert.equal(L.habitStreak(h, '2026-10-11'), 4);
  const wk = { days: [1, 3, 5], created: '2026-10-01', log: { '2026-10-05': true, '2026-10-07': true } };
  assert.deepEqual(L.habitWeek(wk, '2026-10-11'), { due: 3, done: 2, pct: 67 });
  assert.equal(L.habitStreak(wk, '2026-10-11'), 0, 'missed Friday breaks it');
  assert.equal(L.habitBest(h, '2026-10-11'), 4);
});
test('smart slots: urgent first, avoids busy blocks, fits the day', () => {
  const tasks = [
    { id: 'busy', title: 'Class', date: '2026-10-11', start: '16:00', end: '17:00' },
    { id: 'os', title: 'OS assignment', date: null, due: '2026-10-12', priority: 3, estimate: 120 },
    { id: 'rd', title: 'Read', date: '2026-10-11', estimate: 30 },
    { id: 'done', title: 'Done', date: '2026-10-11', done: true },
  ];
  const s = L.suggestSlots(tasks, '2026-10-11', now, { dayStart: '07:00', dayEnd: '23:00' });
  assert.equal(s.length, 2);
  const os = s.find((x) => x.taskId === 'os');
  assert.ok(L.toMin(os.start) >= 17 * 60, 'after the class'); assert.equal(L.toMin(os.end) - L.toMin(os.start), 120);
  assert.match(os.reason, /high priority/);
  const rd = s.find((x) => x.taskId === 'rd'); assert.ok(L.toMin(rd.start) >= L.toMin(os.end), 'no overlap');
});
test('overlap layout puts clashing blocks side by side', () => {
  const out = L.layoutBlocks([{ start: '10:00', end: '11:00' }, { start: '10:30', end: '11:30' }, { start: '12:00', end: '13:00' }]);
  assert.equal(out[0].cols, 2); assert.equal(out[1].cols, 2); assert.notEqual(out[0].col, out[1].col); assert.equal(out[2].cols, 1);
});
test('ics export and backup validation', () => {
  const ics = L.toICS([{ id: 'a', title: 'Study, DSA', date: '2026-10-12', start: '18:00', end: '20:00', repeat: 'weekly', remind: 10 }], now);
  assert.match(ics, /DTSTART;TZID=Asia\/Kolkata:20261012T180000/); assert.match(ics, /RRULE:FREQ=WEEKLY/); assert.match(ics, /TRIGGER:-PT10M/); assert.match(ics, /SUMMARY:Study\\, DSA/);
  assert.equal(L.validateBackup({ app: 'sh-planner', tasks: [], notes: [], folders: [] }), null);
  assert.ok(L.validateBackup({ app: 'other' }));
});
test('notes helpers: text extraction, search, checklist progress', () => {
  assert.equal(L.htmlToText('<h2>Hi</h2><p>a &amp; b</p>'), 'Hi\na & b');
  assert.ok(L.searchScore('graph bfs', [['DSA graph', 3], ['use BFS', 1]]) > 0);
  assert.equal(L.searchScore('graph xyz', [['DSA graph', 3]]), 0);
  assert.deepEqual(L.checklistProgress('<ul class="checklist"><li data-checked="true">a</li><li data-checked="false">b</li></ul>'), { all: 2, done: 1 });
});
