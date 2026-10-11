// Pure logic: dates, recurrence, quick-add parsing, layout. No DOM. Tested in test/.
export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
export const todayStr = (now = new Date()) => ymd(now);
export const toMin = (t) => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export const fromMin = (m) => { m = Math.max(0, Math.min(24 * 60 - 1, Math.round(m))); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
export const weekStart = (s, monday = true) => { const d = parseYmd(s); const wd = d.getDay(); const diff = monday ? (wd + 6) % 7 : wd; return addDays(s, -diff); };
export const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 864e5);
export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtTime(t, h24 = false) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  if (h24) return t;
  const ap = h >= 12 ? 'pm' : 'am'; const hh = h % 12 || 12;
  return m ? `${hh}:${pad(m)}${ap}` : `${hh}${ap}`;
}
export function fmtRange(a, b) {
  if (!a) return '';
  return b ? `${fmtTime(a)} – ${fmtTime(b)}` : fmtTime(a);
}

// Does a (possibly repeating) task occur on date s?
export function occursOn(task, s) {
  if (!task.date) return false;
  if (task.date === s) return !(task.skip || []).includes(s);
  if (!task.repeat || task.repeat === 'none') return false;
  if (s < task.date) return false;
  if (task.until && s > task.until) return false;
  if ((task.skip || []).includes(s)) return false;
  const d = parseYmd(s).getDay();
  switch (task.repeat) {
    case 'daily': return true;
    case 'weekdays': return d >= 1 && d <= 5;
    case 'weekly': return parseYmd(task.date).getDay() === d;
    case 'monthly': return parseYmd(task.date).getDate() === parseYmd(s).getDate();
    default: return false;
  }
}
export const isRepeating = (t) => t.repeat && t.repeat !== 'none';
export const isDoneOn = (task, s) => isRepeating(task) ? !!(task.doneDates || {})[s] : !!task.done;

export function tasksOn(tasks, s) {
  return tasks.filter((t) => occursOn(t, s)).sort((a, b) => {
    const am = toMin(a.start), bm = toMin(b.start);
    if (am == null && bm == null) return (b.priority || 0) - (a.priority || 0);
    if (am == null) return -1; if (bm == null) return 1; return am - bm;
  });
}

// Overlap layout for timed blocks: assigns col and cols to each item.
export function layoutBlocks(items) {
  const ev = items.map((t) => ({ t, s: toMin(t.start), e: Math.max(toMin(t.end) ?? toMin(t.start) + 60, toMin(t.start) + 20) }))
    .sort((a, b) => a.s - b.s || b.e - a.e);
  const out = []; let group = []; let groupEnd = -1;
  const flush = () => {
    const colsEnd = [];
    for (const g of group) {
      let c = colsEnd.findIndex((e) => e <= g.s);
      if (c === -1) { c = colsEnd.length; colsEnd.push(g.e); } else colsEnd[c] = g.e;
      g.col = c;
    }
    for (const g of group) { g.cols = colsEnd.length; out.push(g); }
    group = [];
  };
  for (const e of ev) {
    if (group.length && e.s >= groupEnd) { flush(); groupEnd = -1; }
    group.push(e); groupEnd = Math.max(groupEnd, e.e);
  }
  if (group.length) flush();
  return out;
}

// ---------- Natural-language quick add ----------
const WD = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const MO = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 };

function to24(h, m, ap) {
  h = Number(h); m = Number(m || 0);
  if (ap) { ap = ap.toLowerCase(); if (ap.startsWith('p') && h < 12) h += 12; if (ap.startsWith('a') && h === 12) h = 0; }
  return h * 60 + m;
}
// Guess am/pm for a bare hour (student-friendly): 1–7 => pm, 8–11 => am, 12 => noon.
function guess(h) { h = Number(h); if (h >= 13 || h === 0) return null; return h <= 7 ? 'pm' : (h === 12 ? 'pm' : 'am'); }

export function parseQuickAdd(input, now = new Date()) {
  let text = ' ' + input.trim() + ' ';
  const today = ymd(now);
  const r = { title: '', date: today, start: null, end: null, repeat: 'none', priority: 0, category: null, dateExplicit: false };
  const take = (re, fn) => { const m = text.match(re); if (m) { text = text.replace(m[0], ' '); fn(m); return true; } return false; };

  // category / tag
  take(/\s#([\w-]+)/i, (m) => { r.category = m[1].toLowerCase(); });
  // priority
  take(/\s(!high|!!!|!!|p1|urgent|important)(?=\s)/i, () => { r.priority = 3; }) ||
    take(/\s(!med|!medium|p2)(?=\s)/i, () => { r.priority = 2; }) ||
    take(/\s(!low|p3)(?=\s)/i, () => { r.priority = 1; }) ||
    take(/\s(!)(?=\s)/i, () => { r.priority = 2; });
  // repeat
  take(/\s(every\s?day|daily)(?=\s)/i, () => { r.repeat = 'daily'; }) ||
    take(/\s(every\s?weekday|weekdays)(?=\s)/i, () => { r.repeat = 'weekdays'; }) ||
    take(/\severy\s+(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)[a-z]*(?=\s)/i, (m) => { r.repeat = 'weekly'; r._wd = WD[m[1].toLowerCase()]; }) ||
    take(/\s(every\s?week|weekly)(?=\s)/i, () => { r.repeat = 'weekly'; }) ||
    take(/\s(every\s?month|monthly)(?=\s)/i, () => { r.repeat = 'monthly'; });

  // time range: 6-8pm, 6pm-8pm, 6:30 - 8, from 6 to 8 pm, 18:00-19:30
  const T = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?';
  const rangeRe = new RegExp(`\\s(?:from\\s+)?${T}\\s*(?:-|–|to|till|until)\\s*${T}(?=\\s)`, 'i');
  const gotRange = take(rangeRe, (m) => {
    let [, h1, m1, a1, h2, m2, a2] = m;
    if (!a2 && !a1) { a2 = guess(h2); a1 = guess(h1); }
    if (!a1 && a2 && Number(h1) <= 12 && Number(h2) <= 12) {
      // "6-8pm" => both pm; "10-12pm" => 10am-12pm; "11-1pm" => 11am-1pm
      a1 = a2;
      if (to24(h1, m1, a1) >= to24(h2, m2, a2)) a1 = a2.toLowerCase().startsWith('p') ? 'am' : 'pm';
    }
    if (a1 && !a2 && Number(h2) <= 12) { a2 = a1; if (to24(h1, m1, a1) >= to24(h2, m2, a2)) a2 = a1.toLowerCase().startsWith('a') ? 'pm' : 'am'; }
    let s = to24(h1, m1, a1), e = to24(h2, m2, a2);
    if (e <= s) e = Math.min(s + 60, 24 * 60 - 1);
    r.start = fromMin(s); r.end = fromMin(e);
  });
  if (!gotRange) {
    take(/\s(noon|midday)(?=\s)/i, () => { r.start = '12:00'; }) ||
      take(/\s(midnight)(?=\s)/i, () => { r.start = '00:00'; }) ||
      take(new RegExp(`\\s(?:at|@)\\s*${T}(?=\\s)`, 'i'), (m) => { r.start = fromMin(to24(m[1], m[2], m[3] || (m[2] || Number(m[1]) > 12 ? null : guess(m[1])))); }) ||
      take(/\s(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?=\s)/i, (m) => { r.start = fromMin(to24(m[1], m[2], m[3])); }) ||
      take(/\s([01]?\d|2[0-3]):([0-5]\d)(?=\s)/, (m) => { r.start = fromMin(to24(m[1], m[2])); });
    if (r.start) take(/\sfor\s+(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minutes)(?=\s)/i, (m) => {
      const mins = /^h/i.test(m[2]) ? Number(m[1]) * 60 : Number(m[1]);
      r.end = fromMin(toMin(r.start) + mins);
    });
    if (r.start && !r.end) r.end = fromMin(Math.min(toMin(r.start) + 60, 24 * 60 - 1));
  }
  if (/\stonight(?=\s)/i.test(text)) { text = text.replace(/\stonight(?=\s)/i, ' '); if (!r.start) { r.start = '20:00'; r.end = '21:00'; } }

  // estimate: ~2h, ~45m
  take(/\s~\s?(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins)(?=\s)/i, (m) => { r.estimate = /^h/i.test(m[2]) ? Math.round(Number(m[1]) * 60) : Number(m[1]); });
  // deadline wording: "by fri", "due 20 oct"
  let isDue = false;
  take(/\s(by|due|before|deadline)(?=\s)/i, () => { isDue = true; });
  // date
  const setDate = (s) => { r.date = s; r.dateExplicit = true; };
  take(/\s(day after tomorrow|day after tmrw|overmorrow)(?=\s)/i, () => setDate(addDays(today, 2))) ||
    take(/\s(tomorrow|tmrw|tmr|tmrrw|tomo)(?=\s)/i, () => setDate(addDays(today, 1))) ||
    take(/\s(today|tdy)(?=\s)/i, () => setDate(today)) ||
    take(/\sin\s+(\d+)\s+days?(?=\s)/i, (m) => setDate(addDays(today, Number(m[1])))) ||
    take(/\s(next\s+week)(?=\s)/i, () => setDate(addDays(weekStart(today), 7))) ||
    take(/\s(?:on\s+)?(next\s+)?(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|sday|nesday|rsday|urday)?(?=\s)/i, (m) => {
      const target = WD[m[2].toLowerCase()]; const cur = now.getDay();
      let diff = (target - cur + 7) % 7; if (diff === 0) diff = 7; if (m[1] && diff < 7) diff += 0;
      setDate(addDays(today, diff));
    }) ||
    take(/\s(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*(?:\s+(\d{4}))?(?=\s)/i, (m) => setDate(mkDate(m[1], MO[m[2].toLowerCase()], m[3], now))) ||
    take(/\s(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?=\s)/i, (m) => setDate(mkDate(m[2], MO[m[1].toLowerCase()], m[3], now))) ||
    take(/\s(\d{4})-(\d{2})-(\d{2})(?=\s)/, (m) => setDate(`${m[1]}-${m[2]}-${m[3]}`)) ||
    take(/\s(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s)/, (m) => setDate(mkDate(m[1], Number(m[2]) - 1, m[3], now))); // Indian dd/mm

  if (r._wd != null && !r.dateExplicit) { const diff = (r._wd - now.getDay() + 7) % 7; r.date = addDays(today, diff); }
  delete r._wd;
  if (isDue && r.dateExplicit) {
    r.due = r.date; r.date = null;
    if (r.start) { r.dueTime = r.start; r.start = null; r.end = null; }
  }
  // If only a time was given and it's already past today, keep today (user may be logging) — no auto-shift.
  r.title = text.replace(/\s+(at|on|from|by)\s*$/i, ' ').replace(/\s{2,}/g, ' ').trim();
  r.title = r.title.replace(/^(at|on)\s+/i, '');
  if (!r.title) r.title = 'Untitled';
  r.title = r.title.charAt(0).toUpperCase() + r.title.slice(1);
  return r;
}
function mkDate(d, mo, y, now) {
  let year = y ? Number(y.length === 2 ? '20' + y : y) : now.getFullYear();
  let dt = new Date(year, mo, Number(d));
  if (!y && ymd(dt) < ymd(now) && daysBetween(ymd(dt), ymd(now)) > 7) dt = new Date(year + 1, mo, Number(d));
  return ymd(dt);
}

// ---------- notes helpers ----------
export function htmlToText(html) {
  return String(html || '').replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
}
export function searchScore(q, fields) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean); if (!terms.length) return 0;
  let score = 0;
  for (const term of terms) {
    let hit = false;
    fields.forEach(([txt, wgt]) => { const i = (txt || '').toLowerCase().indexOf(term); if (i >= 0) { hit = true; score += wgt * (i === 0 ? 2 : 1); } });
    if (!hit) return 0;
  }
  return score;
}
export function checklistProgress(html) {
  const all = (String(html).match(/<li[^>]*data-checked=/g) || []).length;
  const done = (String(html).match(/<li[^>]*data-checked="true"/g) || []).length;
  return { all, done };
}

// ---------- ICS export ----------
const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
const icsDT = (date, time) => date.replace(/-/g, '') + (time ? 'T' + time.replace(':', '') + '00' : '');
export function toICS(tasks, stamp = new Date()) {
  const st = stamp.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SH PLANNER//EN', 'CALSCALE:GREGORIAN'];
  for (const t of tasks) {
    if (!t.date) continue;
    lines.push('BEGIN:VEVENT', `UID:${t.id}@shplanner`, `DTSTAMP:${st}`, `SUMMARY:${icsEsc(t.title)}`);
    if (t.start) {
      lines.push(`DTSTART;TZID=Asia/Kolkata:${icsDT(t.date, t.start)}`, `DTEND;TZID=Asia/Kolkata:${icsDT(t.date, t.end || fromMin(toMin(t.start) + 60))}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${icsDT(t.date)}`, `DTEND;VALUE=DATE:${icsDT(addDays(t.date, 1))}`);
    }
    const rr = { daily: 'FREQ=DAILY', weekly: 'FREQ=WEEKLY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', monthly: 'FREQ=MONTHLY' }[t.repeat];
    if (rr) lines.push(`RRULE:${rr}${t.until ? ';UNTIL=' + icsDT(t.until) : ''}`);
    if (t.start && t.remind != null && t.remind !== '') lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(t.title)}`, `TRIGGER:-PT${Number(t.remind)}M`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

export function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

export function validateBackup(obj) {
  if (!obj || typeof obj !== 'object') return 'Not a backup file';
  if (obj.app !== 'sh-planner') return 'This file is not an SH PLANNER backup';
  for (const k of ['tasks', 'notes', 'folders']) if (!Array.isArray(obj[k])) return `Backup is missing "${k}"`;
  return null;
}

// ---------- Reminder / notification schedule (shared by web + Android) ----------
export function hashId(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 1) % 2000000000 + 1; // positive 31-bit int, never 0
}
export const atOf = (date, time) => { const d = parseYmd(date); const [h, m] = time.split(':').map(Number); d.setHours(h, m, 0, 0); return d.getTime(); };

export function computeNotifications(tasks, settings = {}, now = new Date(), days = 14, max = 60) {
  const out = []; const nowMs = now.getTime(); const today = ymd(now);
  const deadlineTime = settings.deadlineTime || '09:00';
  for (let i = 0; i < days; i++) {
    const date = addDays(today, i);
    for (const t of tasks) {
      if (!t.start || t.remind == null || t.remind === '' || !occursOn(t, date) || isDoneOn(t, date)) continue;
      const at = atOf(date, t.start) - Number(t.remind) * 60000;
      if (at <= nowMs) continue;
      const lead = Number(t.remind);
      out.push({ key: `r:${t.id}:${date}`, kind: 'reminder', taskId: t.id, date, at,
        title: t.title, body: `${fmtRange(t.start, t.end)} · ${lead ? `starts in ${lead} min` : 'starting now'}` });
    }
    if (settings.dailyPlanOn && settings.dailyPlanTime) {
      const at = atOf(date, settings.dailyPlanTime);
      if (at > nowMs) {
        const n = tasks.filter((t) => occursOn(t, date) && !isDoneOn(t, date)).length;
        out.push({ key: `p:${date}`, kind: 'plan', date, at, title: 'Plan your day ☀️',
          body: n ? `${n} task${n > 1 ? 's' : ''} on today. Open SH PLANNER to line them up.` : 'Nothing planned yet. Take 2 minutes to plan today.' });
      }
    }
  }
  for (const t of tasks) {
    if (!t.due || (isRepeating(t) ? false : t.done)) continue;
    const marks = [
      { key: `d1:${t.id}:${t.due}`, at: atOf(addDays(t.due, -1), deadlineTime), body: `Due tomorrow${t.dueTime ? ' at ' + fmtTime(t.dueTime) : ''}` },
      { key: `d0:${t.id}:${t.due}`, at: atOf(t.due, deadlineTime), body: `Due today${t.dueTime ? ' at ' + fmtTime(t.dueTime) : ''}` },
    ];
    if (t.dueTime) marks.push({ key: `dh:${t.id}:${t.due}`, at: atOf(t.due, t.dueTime) - 3600000, body: `Due in 1 hour (${fmtTime(t.dueTime)})` });
    for (const m of marks) if (m.at > nowMs && m.at < nowMs + days * 864e5) out.push({ ...m, kind: 'deadline', taskId: t.id, date: t.due, title: `⏰ ${t.title}` });
  }
  out.sort((a, b) => a.at - b.at);
  const seen = new Set();
  return out.filter((n) => (seen.has(n.key) ? false : seen.add(n.key))).slice(0, max).map((n) => ({ ...n, id: hashId(n.key) }));
}

// ---------- Habits ----------
export const habitDueOn = (h, s) => (h.days && h.days.length ? h.days.includes(parseYmd(s).getDay()) : true) && (!h.created || s >= h.created);
export function habitStreak(h, today) {
  let s = today, n = 0, guard = 0;
  const log = h.log || {};
  if (habitDueOn(h, s) && !log[s]) s = addDays(s, -1); // today not done yet doesn't break the streak
  while (guard++ < 2000) {
    if (h.created && s < h.created) break;
    if (habitDueOn(h, s)) { if (log[s]) n++; else break; }
    s = addDays(s, -1);
  }
  return n;
}
export function habitBest(h, today) {
  const log = h.log || {}; const dates = Object.keys(log).filter((d) => log[d]).sort();
  if (!dates.length) return 0;
  let best = 0, cur = 0, s = dates[0];
  while (s <= today) {
    if (habitDueOn(h, s)) { if (log[s]) { cur++; best = Math.max(best, cur); } else if (s !== today) cur = 0; }
    s = addDays(s, 1);
  }
  return best;
}
export function habitWeek(h, today) {
  const ws = weekStart(today); let due = 0, done = 0;
  for (let i = 0; i < 7; i++) { const s = addDays(ws, i); if (s > today) break; if (habitDueOn(h, s)) { due++; if ((h.log || {})[s]) done++; } }
  return { due, done, pct: due ? Math.round((done / due) * 100) : 0 };
}

// ---------- Smart slot suggestions ----------
export function suggestSlots(tasks, date, now = new Date(), opts = {}) {
  const dayStart = toMin(opts.dayStart || '07:00'), dayEnd = toMin(opts.dayEnd || '23:00'), buffer = opts.buffer ?? 10;
  let from = dayStart;
  if (date === ymd(now)) from = Math.max(dayStart, Math.ceil((now.getHours() * 60 + now.getMinutes() + 5) / 15) * 15);
  const busy = tasks.filter((t) => t.start && occursOn(t, date))
    .map((t) => [toMin(t.start), toMin(t.end) ?? toMin(t.start) + 60]).sort((a, b) => a[0] - b[0]);
  const urgency = (t) => {
    let s = (t.priority || 0) * 10;
    if (t.due) { const d = daysBetween(date, t.due); s += d < 0 ? 40 : d === 0 ? 30 : d === 1 ? 20 : d <= 3 ? 10 : d <= 7 ? 5 : 0; }
    if (t.date === date) s += 8;
    return s;
  };
  const cands = tasks.filter((t) => !t.start && !isDoneOn(t, t.date || date) && !isRepeating(t) &&
    (t.date === date || (!t.date && (!t.due || t.due >= date)) || (t.date && t.date < date && !t.done && t.due && t.due >= date)))
    .sort((a, b) => urgency(b) - urgency(a) || (a.estimate || 60) - (b.estimate || 60));
  const out = [];
  for (const t of cands) {
    const dur = Number(t.estimate) || 60;
    let cursor = from, placed = null;
    const sorted = busy.slice().sort((a, b) => a[0] - b[0]);
    for (const [bs, be] of sorted) {
      if (bs - cursor >= dur) { placed = cursor; break; }
      cursor = Math.max(cursor, be + buffer);
    }
    if (placed == null && dayEnd - cursor >= dur) placed = cursor;
    if (placed == null) continue;
    busy.push([placed, placed + dur]);
    const why = [];
    if (t.priority >= 3) why.push('high priority'); else if (t.priority === 2) why.push('medium priority');
    if (t.due) { const d = daysBetween(date, t.due); why.push(d < 0 ? 'overdue' : d === 0 ? 'due today' : d === 1 ? 'due tomorrow' : `due in ${d} days`); }
    why.push(`${dur >= 60 ? (dur / 60) + 'h' : dur + 'm'} free slot`);
    out.push({ taskId: t.id, title: t.title, date, start: fromMin(placed), end: fromMin(placed + dur), reason: why.join(' · ') });
  }
  return out.sort((a, b) => toMin(a.start) - toMin(b.start));
}
