// Google sign-in (Firebase Auth) + two-way sync with Cloud Firestore.
// Loaded lazily, only when someone signs in or uses an account, so the local-only app stays light.
// Layout: users/{uid}/tasks|notes|folders|habits|settings/{id}, images as users/{uid}/images/{id}
// (metadata) + users/{uid}/images/{id}/c/{n} (base64 chunks, each well under Firestore's 1 MiB doc cap).
import * as fb from './vendor/firebase.js';
import { firebaseConfig, isConfigured } from './firebase-config.js';
import { planMerge, toDoc, chunkString, joinChunks, CHUNK, SYNC_STORES } from './syncmerge.js';

const isLocalHost = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const EMU = isLocalHost && localStorage.getItem('shp-emu') === '1';
const native = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const ALL = [...SYNC_STORES, 'settings', 'images'];
const DEBUG = localStorage.getItem('shp-debug') === '1';

let app, auth, fs, initP;
let uid = null, adapter = null, unsubs = [], started = false;
let pending = 0, lastSync = 0, lastError = null, serverSeen = {}, initialDone = {};
const statusCbs = new Set();
const prevErr = new Map();

function cfg() {
  if (EMU) return { apiKey: 'emulator-fake-key', authDomain: 'localhost', projectId: 'demo-sh-planner', appId: 'demo' };
  if (isConfigured()) return firebaseConfig;
  return null;
}
export const Cloud = {
  native, emulator: EMU,
  get configured() { return !!cfg(); },
  get user() { return auth ? auth.currentUser : null; },

  init() {
    if (initP) return initP;
    initP = (async () => {
      const c = cfg(); if (!c) throw Object.assign(new Error('Cloud sign-in is not set up yet.'), { code: 'shp/not-configured' });
      app = fb.initializeApp(c);
      auth = fb.initializeAuth(app, { persistence: [fb.indexedDBLocalPersistence, fb.browserLocalPersistence], ...(native ? {} : { popupRedirectResolver: fb.browserPopupRedirectResolver }) });
      fs = fb.initializeFirestore(app, { localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }), ignoreUndefinedProperties: true });
      if (EMU) { fb.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true }); fb.connectFirestoreEmulator(fs, '127.0.0.1', 8080); }
      return { auth, fs };
    })();
    return initP;
  },
  /** Resolves with the restored user (or null) once Firebase Auth has read its persisted session. Works offline. */
  async ready() {
    await Cloud.init();
    if (!native) { try { await fb.getRedirectResult(auth); } catch (e) { lastError = friendly(e); } }
    if (auth.authStateReady) await auth.authStateReady();
    return auth.currentUser;
  },
  onUser(cb) { return Cloud.init().then(() => fb.onAuthStateChanged(auth, cb)); },

  /** Google sign-in. Web: popup, falling back to a full-page redirect where popups can't work. APK: native Google picker. */
  async signIn() {
    await Cloud.init();
    if (native) return nativeSignIn();
    const p = new fb.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
    const iosStandalone = navigator.standalone === true;
    if (iosStandalone) { sessionStorage.setItem('shp-redirect', '1'); await fb.signInWithRedirect(auth, p); return null; }
    try { return (await fb.signInWithPopup(auth, p)).user; } catch (e) {
      if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported'].includes(e.code)) {
        sessionStorage.setItem('shp-redirect', '1'); await fb.signInWithRedirect(auth, p); return null;
      }
      throw e;
    }
  },
  /** Sign in with a Google ID token (the APK's native picker hands one over; tests use the emulator's fake tokens). */
  async signInWithIdToken(idToken, accessToken) {
    await Cloud.init();
    return (await fb.signInWithCredential(auth, fb.GoogleAuthProvider.credential(idToken || null, accessToken || null))).user;
  },
  async signOut() {
    await Cloud.init();
    Cloud.stop();
    if (native) { try { await window.Capacitor.registerPlugin('FirebaseAuthentication').signOut(); } catch (_) {} }
    await fb.signOut(auth);
  },
  /** Drop Firestore's offline cache (used on sign-out; the page reloads afterwards). */
  async clearCache() { try { await fb.terminate(fs); await fb.clearIndexedDbPersistence(fs); } catch (e) { console.warn('cache clear', e); } },

  // ---------------- sync ----------------
  /** adapter: { localAll(store), applyRemote(store, recs), imageBlob(id) -> {blob,type,w,h}, putImage(rec), dropImage(id) } */
  start(theUid, theAdapter) {
    if (started) return; started = true; uid = theUid; adapter = theAdapter; serverSeen = {}; initialDone = {};
    for (const store of ALL) {
      let latest = null; let timer = null;
      const runInitial = async (snap) => {
        if (initialDone[store]) return; initialDone[store] = true; clearTimeout(timer);
        await reconcile(store, snap.docs.map((d) => d.data()), true);
      };
      const un = fb.onSnapshot(fb.collection(fs, 'users', uid, store), { includeMetadataChanges: true }, async (snap) => {
        latest = snap;
        if (DEBUG) console.log('[snap]', store, 'docs', snap.size, 'cache', snap.metadata.fromCache, 'pending', snap.metadata.hasPendingWrites, 'changes', snap.docChanges().map((x) => x.type + ':' + x.doc.id + (x.doc.metadata.hasPendingWrites ? '*' : '')).join(','), 'init', !!initialDone[store]);
        try {
          if (!initialDone[store]) {
            // Wait for the server's view before uploading, unless we're offline (then trust the cache).
            if (!snap.metadata.fromCache || !navigator.onLine) await runInitial(snap);
            else if (!timer) timer = setTimeout(() => runInitial(latest).catch(fail), 8000);
          } else {
            const ch = snap.docChanges().filter((c) => c.type !== 'removed' && !c.doc.metadata.hasPendingWrites).map((c) => c.doc.data());
            if (ch.length) await reconcile(store, ch, false);
          }
          if (!snap.metadata.fromCache) { serverSeen[store] = true; if (!snap.metadata.hasPendingWrites) lastSync = Date.now(); }
          emit();
        } catch (e) { fail(e); }
      }, (e) => fail(e));
      unsubs.push(un);
    }
    emit();
  },
  stop() { for (const u of unsubs) try { u(); } catch (_) {} unsubs = []; started = false; emit(); },

  /** Push one changed record (or tombstone). Firestore queues it offline and sends it when back online. */
  push(store, rec) { if (!started || !rec || !rec.id) return; track(fb.setDoc(fb.doc(fs, 'users', uid, store, String(rec.id)), toDoc(rec))); },
  pushMany(store, recs) {
    if (!started) return;
    for (let i = 0; i < recs.length; i += 400) {
      const b = fb.writeBatch(fs);
      for (const r of recs.slice(i, i + 400)) b.set(fb.doc(fs, 'users', uid, store, String(r.id)), toDoc(r));
      track(b.commit());
    }
  },
  imageAdded(id) { if (started) adapter.imageBlob(id).then((r) => r && uploadImage(r)).catch(fail); },
  imageDeleted(id, chunks = 4) { if (started) deleteImage({ id, chunks, updated: Date.now() }); },

  get status() {
    if (!started) return { state: 'off', pending, lastSync };
    if (!navigator.onLine) return { state: 'offline', pending, lastSync };
    if (lastError) return { state: 'error', pending, lastSync, error: lastError };
    const allSeen = ALL.every((s) => serverSeen[s]);
    return { state: pending > 0 || !allSeen ? 'syncing' : 'synced', pending, lastSync };
  },
  onStatus(cb) { statusCbs.add(cb); return () => statusCbs.delete(cb); },
  friendly,
  /** For tests: resolve when every queued write has reached the server. */
  flush() { return fs ? fb.waitForPendingWrites(fs) : Promise.resolve(); },
};

async function nativeSignIn() {
  const FA = window.Capacitor.registerPlugin('FirebaseAuthentication');
  const r = await FA.signInWithGoogle(); // skipNativeAuth: true (capacitor.config.json) → returns the Google credential
  const c = r && r.credential;
  if (!c || !c.idToken) throw Object.assign(new Error('Google sign-in did not return a token'), { code: 'shp/no-token' });
  return Cloud.signInWithIdToken(c.idToken, c.accessToken);
}

async function reconcile(store, remote, initial) {
  const local = await adapter.localAll(store);
  let scope = local;
  if (!initial) { const ids = new Set(remote.map((r) => r.id)); scope = local.filter((r) => ids.has(r.id)); }
  const plan = planMerge(scope, remote, { uploadLocalOnly: initial });
  if (DEBUG) console.log('[reconcile]', store, initial ? 'initial' : 'incr', 'local', scope.length, 'remote', remote.length, 'down', plan.toLocal.length, 'up', plan.toRemote.length);
  if (store === 'images') {
    for (const r of plan.toLocal) { if (r.deleted) await adapter.dropImage(r.id); else await downloadImage(r).catch(fail); }
    for (const r of plan.toRemote) { if (r.deleted) deleteImage(r); else { const full = await adapter.imageBlob(r.id); if (full) await uploadImage(full); } }
  } else {
    if (plan.toLocal.length) await adapter.applyRemote(store, plan.toLocal);
    if (plan.toRemote.length) Cloud.pushMany(store, plan.toRemote);
  }
  return plan;
}

async function uploadImage(r) {
  const b64 = await r.b64();
  const parts = chunkString(b64, CHUNK);
  const batch = fb.writeBatch(fs);
  parts.forEach((d, i) => batch.set(fb.doc(fs, 'users', uid, 'images', r.id, 'c', String(i)), { d }));
  batch.set(fb.doc(fs, 'users', uid, 'images', r.id), { id: r.id, w: r.w || 0, h: r.h || 0, type: r.type || 'image/jpeg', chunks: parts.length, size: b64.length, updated: r.updated || Date.now(), deleted: false });
  track(batch.commit());
}
function deleteImage(r) {
  const batch = fb.writeBatch(fs);
  for (let i = 0; i < Math.max(1, r.chunks || 1); i++) batch.delete(fb.doc(fs, 'users', uid, 'images', r.id, 'c', String(i)));
  batch.set(fb.doc(fs, 'users', uid, 'images', r.id), { id: r.id, deleted: true, updated: r.updated || Date.now() });
  track(batch.commit());
}
async function downloadImage(meta) {
  const snap = await fb.getDocs(fb.collection(fs, 'users', uid, 'images', meta.id, 'c'));
  const parts = snap.docs.map((d) => [Number(d.id), d.data().d]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  if (parts.length < (meta.chunks || 1)) return; // not fully there yet; retried next start
  await adapter.putImage({ id: meta.id, b64: joinChunks(parts), type: meta.type, w: meta.w, h: meta.h, updated: meta.updated });
}

function track(p) {
  pending++; emit();
  p.then(() => { lastSync = Date.now(); if (lastError && /permission|denied/i.test(lastError) === false) lastError = null; })
    .catch(fail)
    .finally(() => { pending = Math.max(0, pending - 1); emit(); });
}
function fail(e) { console.warn('[sync]', e); lastError = friendly(e); emit(); }
let emitT;
function emit() { clearTimeout(emitT); emitT = setTimeout(() => { const s = Cloud.status; for (const cb of statusCbs) try { cb(s); } catch (_) {} }, 50); }
window.addEventListener('online', () => { lastError = null; emit(); });
window.addEventListener('offline', emit);

function friendly(e) {
  const c = (e && e.code) || '';
  const map = {
    'auth/popup-closed-by-user': '', 'auth/cancelled-popup-request': '', 'auth/user-cancelled': '',
    'auth/network-request-failed': 'No internet connection. Connect and try again.',
    'auth/unauthorized-domain': 'This web address isn’t authorized for sign-in yet (Firebase → Authentication → Settings → Authorized domains).',
    'auth/operation-not-allowed': 'Google sign-in isn’t enabled in the Firebase project yet.',
    'auth/internal-error': 'Sign-in failed. Please try again.',
    'permission-denied': 'The cloud refused access (security rules). Sign out and in again.',
    'unavailable': 'Cloud is unreachable right now. Your changes are saved and will sync later.',
    'resource-exhausted': 'Cloud quota reached for today. Changes are saved on this device and will sync later.',
    'shp/not-configured': 'Cloud sign-in isn’t set up yet.',
  };
  if (c in map) return map[c];
  const m = String((e && e.message) || e || 'Something went wrong');
  if (/12501|cancel/i.test(m)) return '';
  return m.replace(/^Firebase:\s*/, '').replace(/\s*\(.*?\)\.?$/, '');
}
