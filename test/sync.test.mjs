import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
const site = existsSync(new URL('../site/index.html', import.meta.url)) ? new URL('../site/', import.meta.url) : new URL('../', import.meta.url);
const { planMerge, mergeLists, missingFrom, tombstone, purgeTombstones, toDoc, chunkString, joinChunks, mergeSettings, newer, live, countLive, describeCounts, CHUNK } = await import(new URL('js/syncmerge.js', site));

const r = (id, updated, extra = {}) => ({ id, updated, title: id + '@' + updated, ...extra });

test('sync: remote-only records come down, local-only records go up', () => {
  const p = planMerge([r('a', 1)], [r('b', 2)]);
  assert.deepEqual(p.toLocal.map((x) => x.id), ['b']);
  assert.deepEqual(p.toRemote.map((x) => x.id), ['a']);
});

test('sync: last write wins per record in both directions, ties change nothing', () => {
  const p = planMerge([r('a', 5), r('b', 1), r('c', 3)], [r('a', 4), r('b', 9), r('c', 3)]);
  assert.deepEqual(p.toRemote.map((x) => x.title), ['a@5']);
  assert.deepEqual(p.toLocal.map((x) => x.title), ['b@9']);
  assert.equal(p.same, 1);
});

test('sync: a newer tombstone deletes on the other side; an older one loses to an edit', () => {
  const del = tombstone(r('a', 10), 20);
  assert.equal(del.deleted, true); assert.ok(del.updated >= 20);
  let p = planMerge([r('a', 10)], [del]);
  assert.equal(p.toLocal[0].deleted, true);
  p = planMerge([del], [r('a', 10)]);
  assert.equal(p.toRemote[0].deleted, true);
  p = planMerge([tombstone(r('a', 1), 5)], [r('a', 50)]); // edited elsewhere after the delete
  assert.equal(p.toLocal[0].title, 'a@50');
  assert.ok(tombstone(r('x', 100), 50).updated > 100, 'tombstone always beats the record it deletes');
});

test('sync: local-only tombstones are not uploaded; incremental merges skip local-only records', () => {
  const p = planMerge([tombstone(r('gone', 1), 2), r('new', 3)], []);
  assert.deepEqual(p.toRemote.map((x) => x.id), ['new']);
  const q = planMerge([r('x', 1), r('y', 1)], [r('y', 2)], { uploadLocalOnly: false });
  assert.deepEqual(q.toRemote, []); assert.deepEqual(q.toLocal.map((x) => x.id), ['y']);
});

test('sync: first sign-in merge only uploads what the account lacks or has older', () => {
  const local = [r('a', 5), r('b', 1), r('c', 7), tombstone(r('d', 1), 2)];
  const acct = [r('a', 5), r('b', 3)];
  assert.deepEqual(missingFrom(local, acct).map((x) => x.id), ['c']);
  const merged = mergeLists(acct, [r('a', 9), r('b', 2), r('e', 1)]);
  assert.deepEqual(merged.map((x) => x.title).sort(), ['a@9', 'b@3', 'e@1']);
  assert.deepEqual(countLive({ tasks: local, notes: [], folders: [], habits: [r('h', 1)] }), { tasks: 3, notes: 0, folders: 0, habits: 1 });
  assert.equal(describeCounts({ tasks: 3, notes: 1, habits: 0, folders: 0 }, 2), '3 tasks, 1 note, 2 images');
  assert.equal(live(local).length, 3);
});

test('sync: tombstones older than 30 days are purged, fresh ones and live records kept', () => {
  const now = Date.UTC(2026, 9, 11);
  const { keep, drop } = purgeTombstones([tombstone(r('old', 1), now - 40 * 864e5), tombstone(r('new', 1), now - 864e5), r('live', 1)], now);
  assert.deepEqual(drop.map((x) => x.id), ['old']);
  assert.deepEqual(keep.map((x) => x.id).sort(), ['live', 'new']);
});

test('sync: Firestore-safe docs drop undefined and functions, keep nesting', () => {
  const d = toDoc({ id: 't', a: undefined, f() {}, n: NaN, sub: [{ t: 'x', d: undefined }], map: { '2026-10-11': true, '': 1 } });
  assert.deepEqual(d, { id: 't', n: null, sub: [{ t: 'x' }], map: { '2026-10-11': true } });
});

test('sync: images chunk under the 1 MiB doc cap and reassemble exactly', () => {
  const s = 'A'.repeat(CHUNK * 2 + 123);
  const parts = chunkString(s);
  assert.equal(parts.length, 3); assert.ok(parts.every((p) => p.length <= CHUNK && p.length < 1048576 - 1000));
  assert.equal(joinChunks(parts), s);
  assert.deepEqual(chunkString(''), ['']);
});

test('sync: settings merge picks the newer side', () => {
  assert.equal(mergeSettings({ value: { theme: 'dark' }, updated: 5 }, { value: { theme: 'light' }, updated: 9 }).value.theme, 'light');
  assert.equal(mergeSettings({ value: { theme: 'dark' }, updated: 10 }, { value: { theme: 'light' }, updated: 9 }).winner, 'local');
  assert.equal(mergeSettings({ value: { a: 1 }, updated: 1 }, null).winner, 'local');
  assert.equal(newer(r('a', 2), r('a', 1)), true); assert.equal(newer(r('a', 1), r('a', 1)), false); assert.equal(newer(r('a', 1), null), true);
});

test('sync: two devices editing offline converge on the newest edit (self-heal)', () => {
  // A and B both had x@1. A edits offline (x@150), B edits online (x@200). A's queued write lands later.
  let server = r('x', 200); const A = r('x', 150); const B = r('x', 200);
  server = A; // blind set from A's offline queue overwrites
  const onB = planMerge([B], [server], { uploadLocalOnly: false }); // B's listener sees an older remote
  assert.equal(onB.toRemote[0].title, 'x@200');
  server = onB.toRemote[0];
  const onA = planMerge([A], [server], { uploadLocalOnly: false });
  assert.equal(onA.toLocal[0].title, 'x@200');
});
