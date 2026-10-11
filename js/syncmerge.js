// Pure sync helpers (no DOM, no Firebase), shared by the app and the unit tests.
// Model: every record has a stable `id` and an `updated` ms timestamp. A delete is a
// tombstone { id, deleted: true, updated } so the delete itself can sync.
// Conflict rule: last write wins per record (higher `updated`); ties keep the remote copy.

export const SYNC_STORES = ['tasks', 'notes', 'folders', 'habits'];
export const TOMBSTONE_TTL = 30 * 864e5; // local tombstones older than 30 days are purged
export const CHUNK = 700000; // chars of base64 per Firestore image chunk doc (doc limit is 1 MiB)

export const ts = (r) => (r && Number(r.updated)) || 0;
export const isDead = (r) => !!(r && r.deleted);
export const live = (list) => (list || []).filter((r) => r && !r.deleted);

/** Does `a` beat `b` under last-write-wins? Missing `b` always loses. */
export function newer(a, b) { if (!b) return true; if (!a) return false; return ts(a) > ts(b); }

export function tombstone(rec, now = Date.now()) {
  return { id: rec.id, deleted: true, created: rec.created || now, updated: Math.max(now, ts(rec) + 1) };
}

/**
 * Plan a two-way merge of one collection.
 *  local, remote: arrays of records (tombstones included).
 *  opts.uploadLocalOnly: push records that only exist locally (default true).
 *  opts.skipDeadLocalOnly: don't upload tombstones the cloud never knew about (default true).
 * Returns { toLocal, toRemote, same } (arrays of records to write on each side).
 */
export function planMerge(local, remote, opts = {}) {
  const { uploadLocalOnly = true, skipDeadLocalOnly = true } = opts;
  const L = new Map((local || []).filter((r) => r && r.id).map((r) => [r.id, r]));
  const R = new Map((remote || []).filter((r) => r && r.id).map((r) => [r.id, r]));
  const toLocal = []; const toRemote = []; let same = 0;
  for (const [id, r] of R) {
    const l = L.get(id);
    if (!l) { toLocal.push(r); continue; } // includes remote tombstones, so the delete is remembered
    if (ts(l) > ts(r)) toRemote.push(l);
    else if (ts(r) > ts(l)) toLocal.push(r);
    else same++;
  }
  if (uploadLocalOnly) for (const [id, l] of L) if (!R.has(id) && !(skipDeadLocalOnly && isDead(l))) toRemote.push(l);
  return { toLocal, toRemote, same };
}

/** Merge two plain record lists (e.g. copying this device's data into an account): LWW per id. */
export function mergeLists(a, b) {
  const m = new Map((a || []).map((r) => [r.id, r]));
  for (const r of b || []) { const c = m.get(r.id); if (!c || ts(r) > ts(c)) m.set(r.id, r); }
  return [...m.values()];
}

/** Records in `src` that `dst` doesn't already hold at the same or a newer version. */
export function missingFrom(src, dst) {
  const d = new Map((dst || []).map((r) => [r.id, r]));
  return live(src).filter((r) => { const x = d.get(r.id); return !x || ts(r) > ts(x); });
}

export function purgeTombstones(list, now = Date.now(), ttl = TOMBSTONE_TTL) {
  const keep = []; const drop = [];
  for (const r of list || []) (isDead(r) && now - ts(r) > ttl ? drop : keep).push(r);
  return { keep, drop };
}

/** Firestore-safe copy: drops undefined/functions, turns NaN/Infinity into null, keeps nesting. */
export function toDoc(rec) {
  const clean = (v) => {
    if (v === undefined || typeof v === 'function') return undefined;
    if (typeof v === 'number' && !Number.isFinite(v)) return null;
    if (Array.isArray(v)) return v.map((x) => { const c = clean(x); return c === undefined ? null : c; });
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) { if (k === '') continue; const c = clean(v[k]); if (c !== undefined) o[k] = c; } return o; }
    return v;
  };
  return clean(rec);
}

export function chunkString(s, size = CHUNK) { const out = []; for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size)); return out.length ? out : ['']; }
export const joinChunks = (parts) => parts.join('');

/** Settings sync: one doc { value, updated }. */
export function mergeSettings(local, remote) {
  if (!remote) return { winner: 'local', value: local ? local.value : null };
  if (!local || ts(remote) > ts(local)) return { winner: 'remote', value: remote.value };
  if (ts(local) > ts(remote)) return { winner: 'local', value: local.value };
  return { winner: 'same', value: local.value };
}

export function countLive(data) { const o = {}; for (const s of SYNC_STORES) o[s] = live(data[s]).length; return o; }
export function describeCounts(c, images = 0) {
  const parts = []; const p = (n, w) => n && parts.push(`${n} ${w}${n === 1 ? '' : 's'}`);
  p(c.tasks, 'task'); p(c.notes, 'note'); p(c.habits, 'habit'); p(c.folders, 'folder'); p(images, 'image');
  return parts.length ? parts.join(', ') : 'nothing';
}
