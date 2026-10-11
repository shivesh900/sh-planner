// Local-first storage on IndexedDB. Everything lives on this device.
// "sh-planner" holds the no-account (local only) data; each signed-in Google account gets
// its own database "sh-planner-u-<uid>", which mirrors that account's cloud data.
// Records carry id + updated (+ deleted tombstones) so sync can merge by last-write-wins.
const VERSION = 1;
export const LOCAL_DB = 'sh-planner';
export const accountDbName = (uid) => 'sh-planner-u-' + uid;
const STORES = ['tasks', 'notes', 'folders', 'habits', 'images', 'kv'];
const conns = new Map();
let current = LOCAL_DB;
function openDb(name) {
  if (conns.has(name)) return conns.get(name);
  const p = new Promise((res, rej) => {
    const req = indexedDB.open(name, VERSION);
    req.onupgradeneeded = () => { const db = req.result; for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' }); };
    req.onsuccess = () => { const d = req.result; d.onversionchange = () => { d.close(); conns.delete(name); }; res(d); };
    req.onerror = () => rej(req.error);
  });
  conns.set(name, p);
  return p;
}
function txOn(name, store, mode, fn) {
  return openDb(name).then((db) => new Promise((res, rej) => {
    const t = db.transaction(store, mode); const st = t.objectStore(store); let out;
    Promise.resolve(fn(st)).then((v) => { out = v; });
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
function api(nameFn) {
  const tx = (store, mode, fn) => txOn(nameFn(), store, mode, fn);
  return {
    all: (store) => tx(store, 'readonly', (st) => reqP(st.getAll())),
    get: (store, id) => tx(store, 'readonly', (st) => reqP(st.get(id))),
    put: (store, obj) => tx(store, 'readwrite', (st) => { st.put(obj); }),
    del: (store, id) => tx(store, 'readwrite', (st) => { st.delete(id); }),
    clear: (store) => tx(store, 'readwrite', (st) => { st.clear(); }),
    bulkPut: (store, arr) => tx(store, 'readwrite', (st) => { for (const o of arr) st.put(o); }),
    bulkDel: (store, ids) => tx(store, 'readwrite', (st) => { for (const id of ids) st.delete(id); }),
  };
}
export const db = {
  ...api(() => current),
  /** Switch the app's active database (call before load()). */
  use(name) { current = name; },
  get name() { return current; },
  /** Same API on another database, e.g. db.on('sh-planner').all('tasks'). */
  on(name) { return api(() => name); },
  async drop(name) {
    const c = conns.get(name); if (c) { try { (await c).close(); } catch (_) {} conns.delete(name); }
    await new Promise((res) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  },
  async persist() { try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {} return false; },
  async estimate() { try { return await navigator.storage.estimate(); } catch (e) { return null; } },
};
