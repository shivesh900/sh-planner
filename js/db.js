// Local-first storage on IndexedDB. Everything lives on this device.
// Records carry id + updated so a future sync layer can merge by last-write-wins.
const DB_NAME = 'sh-planner'; const VERSION = 1;
const STORES = ['tasks', 'notes', 'folders', 'habits', 'images', 'kv'];
let dbp;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => { const db = req.result; for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' }); };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return open().then((db) => new Promise((res, rej) => {
    const t = db.transaction(store, mode); const st = t.objectStore(store); let out;
    Promise.resolve(fn(st)).then((v) => { out = v; });
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
export const db = {
  all: (store) => tx(store, 'readonly', (st) => reqP(st.getAll())),
  get: (store, id) => tx(store, 'readonly', (st) => reqP(st.get(id))),
  put: (store, obj) => tx(store, 'readwrite', (st) => { st.put(obj); }),
  del: (store, id) => tx(store, 'readwrite', (st) => { st.delete(id); }),
  clear: (store) => tx(store, 'readwrite', (st) => { st.clear(); }),
  bulkPut: (store, arr) => tx(store, 'readwrite', (st) => { for (const o of arr) st.put(o); }),
  async persist() { try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {} return false; },
  async estimate() { try { return await navigator.storage.estimate(); } catch (e) { return null; } },
};
