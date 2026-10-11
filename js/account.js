// Accounts: welcome screen, Google sign-in, first-sign-in merge, sign-out, sync wiring + status UI.
// Modes (localStorage "shp-acct"): unset → welcome screen; "local" → no account, data only on this
// device (IndexedDB "sh-planner"); "account" → signed in, data in "sh-planner-u-<uid>" mirrored to Firestore.
import { db, LOCAL_DB, accountDbName } from './db.js';
import { Images, blobToB64, b64ToBlob } from './images.js';
import { SYNC_STORES, live, tombstone, mergeLists, missingFrom, countLive, describeCounts, purgeTombstones } from './syncmerge.js';
import { isConfigured } from './firebase-config.js';

let ctx; // { S, defaults, render, toast, openSheet, closeSheet, esc, ic, applyTheme, notifySync }
let Cloud = null; let cloudP = null;
export const mode = () => localStorage.getItem('shp-acct') || '';
export const accountUid = () => localStorage.getItem('shp-uid') || '';
export const isAccount = () => mode() === 'account' && !!accountUid();
const profile = () => { try { return JSON.parse(localStorage.getItem('shp-profile') || 'null'); } catch (_) { return null; } };
const emuOK = () => /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && localStorage.getItem('shp-emu') === '1';
export const cloudAvailable = () => isConfigured() || emuOK();

export function loadCloud() {
  if (!cloudP) cloudP = import('./cloud.js').then((m) => (Cloud = m.Cloud));
  return cloudP;
}

/** Called by app.js before load(): picks the database for the current mode. */
export function selectDb() {
  if (new URLSearchParams(location.search).get('emu') === '1' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) localStorage.setItem('shp-emu', '1');
  db.use(isAccount() ? accountDbName(accountUid()) : LOCAL_DB);
}

// ---------------- sync hooks used by app.js ----------------
export function push(store, rec) { if (Cloud && isAccount()) Cloud.push(store, rec); }
export function pushMany(store, recs) { if (Cloud && isAccount() && recs.length) Cloud.pushMany(store, recs); }

let settingsUpdated = 0;
export function settingsStamp(v) { if (v != null) settingsUpdated = v; return settingsUpdated; }

let pendingRender = false; let renderT;
function remoteChanged(what) {
  clearTimeout(renderT);
  renderT = setTimeout(() => {
    if (what === 'tasks' || what === 'settings') ctx.notifySync();
    const busy = document.querySelector('#sheetRoot .sheet') || (document.activeElement && document.activeElement.closest && document.activeElement.closest('#view input, #view textarea, #view [contenteditable=true]'));
    if (busy || location.hash.startsWith('#/note/')) { pendingRender = true; return; }
    ctx.render();
  }, 150);
}
setInterval(() => { if (!pendingRender) return; const busy = document.querySelector('#sheetRoot .sheet') || (document.activeElement && document.activeElement.closest && document.activeElement.closest('#view input, #view textarea, #view [contenteditable=true]')); if (!busy && !location.hash.startsWith('#/note/')) { pendingRender = false; ctx.render(); } }, 1500);

async function imgTombs() { const r = await db.get('kv', 'imgTomb').catch(() => null); return (r && r.map) || {}; }
const adapter = {
  async localAll(store) {
    const S = ctx.S;
    if (SYNC_STORES.includes(store)) return db.all(store);
    if (store === 'settings') return [{ id: 'prefs', value: { ...S.settings }, updated: settingsUpdated }];
    if (store === 'images') {
      const imgs = (await db.all('images')).map((r) => ({ id: r.id, updated: r.created || 1 }));
      const t = await imgTombs(); for (const id of Object.keys(t)) if (!imgs.find((x) => x.id === id)) imgs.push({ id, deleted: true, updated: t[id] });
      return imgs;
    }
    return [];
  },
  async applyRemote(store, recs) {
    const S = ctx.S;
    if (store === 'settings') {
      const r = recs.find((x) => x.id === 'prefs'); if (!r || !r.value) return;
      S.settings = { ...ctx.defaults, ...r.value }; settingsUpdated = r.updated || 0;
      await db.put('kv', { id: 'settings', value: S.settings, updated: settingsUpdated });
      if (r.value.theme) ctx.applyTheme(r.value.theme);
      remoteChanged('settings'); return;
    }
    await db.bulkPut(store, recs);
    const ids = new Set(recs.map((r) => r.id));
    S[store] = S[store].filter((x) => !ids.has(x.id)).concat(recs.filter((r) => !r.deleted));
    remoteChanged(store);
  },
  async imageBlob(id) { const r = await Images.raw(id); if (!r) return null; return { id, type: r.type, w: r.w, h: r.h, updated: r.created || 1, b64: () => blobToB64(r.blob) }; },
  async putImage(m) { await Images.putRaw({ id: m.id, blob: b64ToBlob(m.b64, m.type || 'image/jpeg'), type: m.type || 'image/jpeg', w: m.w, h: m.h, created: m.updated || Date.now() }); remoteChanged('images'); },
  async dropImage(id) { await Images.delLocal(id); remoteChanged('images'); },
};

/** Boot-time account work, after the local data has rendered. */
export async function initAccounts(c) {
  ctx = c;
  if (!isAccount()) {
    if (sessionStorage.getItem('shp-redirect') && cloudAvailable()) { // coming back from a sign-in redirect
      sessionStorage.removeItem('shp-redirect');
      try { await loadCloud(); const u = await Cloud.ready(); if (u) return afterSignIn(u); } catch (e) { ctx.toast(friendlyErr(e) || 'Sign-in failed'); }
    }
    if (!mode()) showWelcome();
    return;
  }
  Images.hooks.add = (id) => Cloud && Cloud.imageAdded(id);
  Images.hooks.del = async (id) => { const t = await imgTombs(); t[id] = Date.now(); await db.put('kv', { id: 'imgTomb', map: t }); if (Cloud) Cloud.imageDeleted(id); };
  paintIndicator({ state: 'syncing' });
  try {
    await loadCloud();
    Cloud.onStatus(paintIndicator);
    sessionStorage.removeItem('shp-redirect');
    const u = await Cloud.ready();
    if (!u || u.uid !== accountUid()) { paintIndicator({ state: 'signedout' }); return; }
    saveProfile(u);
    Cloud.start(u.uid, adapter);
  } catch (e) { console.warn(e); paintIndicator({ state: navigator.onLine ? 'error' : 'offline', error: friendlyErr(e) }); }
}

function saveProfile(u) { localStorage.setItem('shp-profile', JSON.stringify({ name: u.displayName || '', email: u.email || '', photo: u.photoURL || '' })); }
function friendlyErr(e) { return Cloud ? Cloud.friendly(e) : String((e && e.message) || e); }

// ---------------- sign in ----------------
export async function startSignIn(btn) {
  const label = btn ? btn.innerHTML : '';
  const setBusy = (b) => { if (btn) { btn.disabled = b; btn.innerHTML = b ? '<span class="spin"></span> Signing in…' : label; } };
  if (!navigator.onLine) { ctx.toast('You’re offline. Connect to the internet to sign in.'); return; }
  setBusy(true);
  // If the Google window is closed without signing in, the SDK takes several seconds to notice; free the button sooner.
  const onFocus = () => setTimeout(() => { if (btn && btn.disabled) setBusy(false); }, 3000);
  window.addEventListener('focus', onFocus, { once: true });
  try {
    await loadCloud();
    const u = await Cloud.signIn();
    if (u) await afterSignIn(u); else setBusy(false); // null = redirecting away
  } catch (e) { setBusy(false); const m = friendlyErr(e); if (m) { ctx.toast(m, null, null, 6000); const er = document.querySelector('#welcome .w-err'); if (er) er.textContent = m; } }
}

async function readAll(name) {
  const h = db.on(name); const o = {};
  for (const s of [...SYNC_STORES, 'images', 'kv']) o[s] = await h.all(s).catch(() => []);
  return o;
}
async function afterSignIn(u) {
  saveProfile(u);
  const local = await readAll(LOCAL_DB);
  const acct = await readAll(accountDbName(u.uid));
  const miss = {}; let n = 0;
  for (const s of SYNC_STORES) { miss[s] = missingFrom(local[s], acct[s]); n += miss[s].length; }
  const accImg = new Set(acct.images.map((r) => r.id));
  const missImg = local.images.filter((r) => !accImg.has(r.id));
  const finish = async (merge) => {
    const h = db.on(accountDbName(u.uid));
    if (merge) {
      for (const s of SYNC_STORES) if (miss[s].length) await h.bulkPut(s, miss[s]);
      if (missImg.length) await h.bulkPut('images', missImg);
      const ls = local.kv.find((k) => k.id === 'settings'); const as = acct.kv.find((k) => k.id === 'settings');
      if (ls && !as) await h.put('kv', { id: 'settings', value: ls.value, updated: ls.updated || 1 });
    }
    await h.put('kv', { id: 'seeded', value: true });
    localStorage.setItem('shp-acct', 'account'); localStorage.setItem('shp-uid', u.uid);
    localStorage.setItem('shp-toast', merge ? `Signed in. Uploading ${describeCounts(countLive(miss), missImg.length)} to your account…` : `Signed in as ${u.email || u.displayName || 'you'}`);
    location.reload();
  };
  if (n + missImg.length === 0) return finish(false);
  hideWelcome();
  ctx.openSheet(`<h3>Upload this device’s data?</h3>
    <p class="muted">This device has <b>${describeCounts(countLive(miss), missImg.length)}</b> that aren’t in your Google account yet. Upload them so they sync everywhere?</p>
    <p class="muted small">Nothing in your account gets deleted. If the same item was edited in both places, the newer edit wins.</p>
    <div class="sheet-actions"><button class="btn ghost" data-no>Don’t upload</button><button class="btn primary" data-yes>Upload & merge</button></div>`, (sh) => {
    sh.querySelector('[data-yes]').onclick = () => finish(true);
    sh.querySelector('[data-no]').onclick = () => finish(false);
    const scrim = document.querySelector('#sheetRoot .scrim'); if (scrim) scrim.onclick = null; // must choose
  });
}

// ---------------- sign out ----------------
export function openSignOut() {
  const st = Cloud ? Cloud.status : { state: 'off', pending: 0 };
  const warn = st.pending > 0 ? `<div class="note-box warn"><b>${st.pending} change${st.pending === 1 ? '' : 's'} not uploaded yet</b>${st.state === 'offline' ? ' (you’re offline)' : ''}. Choose “Keep a copy” so nothing is lost, or wait until it says Synced.</div>` : '';
  ctx.openSheet(`<h3>Sign out?</h3>${warn}
    <button class="opt-row" data-keep><b>Keep a copy on this device</b><span>Your tasks, notes and habits stay here, so you can keep using SH PLANNER without an account.</span></button>
    <button class="opt-row" data-clear><b>Remove from this device</b><span>Everything stays safe in your Google account. Sign in again any time to get it back.</span></button>
    <div class="sheet-actions"><button class="btn ghost" data-close>Cancel</button></div>`, (sh) => {
    sh.querySelector('[data-close]').onclick = ctx.closeSheet;
    sh.querySelector('[data-keep]').onclick = () => doSignOut(true);
    sh.querySelector('[data-clear]').onclick = () => doSignOut(false);
  });
}
async function doSignOut(keep) {
  ctx.closeSheet();
  const uid = accountUid(); const acctName = accountDbName(uid);
  try {
    if (keep) {
      const a = await readAll(acctName); const l = await readAll(LOCAL_DB); const h = db.on(LOCAL_DB);
      for (const s of SYNC_STORES) { const merged = mergeLists(l[s], live(a[s])); await h.bulkPut(s, merged); }
      const li = new Set(l.images.map((r) => r.id)); await h.bulkPut('images', a.images.filter((r) => !li.has(r.id)));
      const as = a.kv.find((k) => k.id === 'settings'); if (as) await h.put('kv', { id: 'settings', value: as.value, updated: as.updated || 1 });
      await h.put('kv', { id: 'seeded', value: true });
    }
    try { await loadCloud(); await Cloud.signOut(); await Cloud.clearCache(); } catch (e) { console.warn(e); }
    await db.drop(acctName);
  } finally {
    localStorage.removeItem('shp-uid'); localStorage.removeItem('shp-profile');
    if (keep) localStorage.setItem('shp-acct', 'local'); else localStorage.removeItem('shp-acct');
    localStorage.setItem('shp-toast', keep ? 'Signed out. Your data is kept on this device.' : 'Signed out and removed from this device.');
    location.hash = '#/home'; location.reload();
  }
}

/** Erase everything: in account mode the deletes sync to every device. */
export async function eraseAll() {
  const S = ctx.S; const now = Date.now();
  for (const s of SYNC_STORES) { const t = S[s].map((r) => tombstone(r, now)); await db.bulkPut(s, t); pushMany(s, t); S[s] = []; }
  for (const r of await db.all('images')) await Images.del(r.id);
}

export async function purgeOld() {
  for (const s of SYNC_STORES) { const all = await db.all(s).catch(() => []); const { drop } = purgeTombstones(all); if (drop.length) await db.bulkDel(s, drop.map((r) => r.id)); }
}

// ---------------- welcome ----------------
const G = '<svg class="g" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
export const googleBtn = (label = 'Continue with Google') => `<button class="g-btn" data-google>${G}<span>${label}</span></button>`;
export function showWelcome() {
  if (document.getElementById('welcome')) return;
  const el = document.createElement('div'); el.id = 'welcome'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Welcome to SH PLANNER');
  const can = cloudAvailable();
  el.innerHTML = `<div class="w-card">
    <img class="w-logo" src="icons/icon-192.png" alt="" width="84" height="84">
    <h1>SH <b>PLANNER</b></h1>
    <p class="w-tag">Plan your day, take notes, build habits.</p>
    <ul class="w-feats">
      <li><span class="i i-cloud"></span><span><b>Sync everywhere.</b> Phone, web, any device.</span></li>
      <li><span class="i i-offline"></span><span><b>Works offline.</b> Syncs when you’re back online.</span></li>
      <li><span class="i i-lock"></span><span><b>Private.</b> Only you can see your data.</span></li>
    </ul>
    ${can ? googleBtn() : `<button class="g-btn" disabled>${G}<span>Google sign-in coming soon</span></button>`}
    <p class="w-err" aria-live="polite">${!navigator.onLine ? 'You’re offline. Sign-in needs internet, or continue without an account.' : ''}</p>
    <button class="w-local" data-local>Continue without account <span>(local only)</span></button>
    <p class="w-fine">Sign up and sign in are the same: just pick your Google account. Without an account, everything stays on this device only. You can sign in later from Settings.</p>
  </div>`;
  document.body.append(el);
  document.documentElement.classList.add('welcome-on');
  const g = el.querySelector('[data-google]'); if (g) g.onclick = () => startSignIn(g);
  el.querySelector('[data-local]').onclick = async () => {
    localStorage.setItem('shp-acct', 'local');
    hideWelcome();
    await ctx.seedIfNew();
    ctx.render();
  };
}
export function hideWelcome() { const el = document.getElementById('welcome'); if (el) el.remove(); document.documentElement.classList.remove('welcome-on'); }

// ---------------- status UI ----------------
const LABEL = { synced: 'Synced', syncing: 'Syncing…', offline: 'Offline · changes saved on this device', error: 'Sync problem', signedout: 'Signed out on this device', off: 'Not syncing' };
let lastStatus = { state: 'off' };
function paintIndicator(s) {
  lastStatus = s;
  const ind = document.getElementById('syncInd');
  if (ind) {
    ind.hidden = !isAccount();
    ind.dataset.state = s.state;
    const icon = { synced: 'cloud-check', syncing: 'cloud-sync', offline: 'cloud-off', error: 'cloud-alert', signedout: 'cloud-alert', off: 'cloud' }[s.state] || 'cloud';
    ind.innerHTML = `<span class="i i-${icon}"></span>`;
    ind.title = LABEL[s.state] || ''; ind.setAttribute('aria-label', 'Sync status: ' + (LABEL[s.state] || s.state));
  }
  const row = document.getElementById('syncRow');
  if (row) row.innerHTML = syncRowHtml(s);
}
function syncRowHtml(s) {
  const when = s.lastSync ? new Date(s.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const extra = s.state === 'synced' && when ? ` · ${when}` : s.state === 'syncing' && s.pending ? ` · ${s.pending} pending` : s.state === 'error' && s.error ? `: ${ctx.esc(s.error)}` : '';
  return `<span class="sync-dot" data-state="${s.state}"></span><span>${LABEL[s.state] || s.state}${extra}</span>`;
}
const initials = (p) => ((p && (p.name || p.email)) || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('');

/** The Account block at the top of Settings. */
export function accountSectionHtml() {
  const { esc, ic } = ctx;
  if (isAccount()) {
    const p = profile() || {};
    const signedOut = lastStatus.state === 'signedout';
    return `<div class="h-row" style="margin-top:4px"><h3 class="h2">${ic('user')} Account</h3></div>
    <div class="set-group">
      <div class="set-row acct"><div class="avatar">${p.photo ? `<img src="${esc(p.photo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span>${esc(initials(p))}</span></div>
        <div class="lbl"><b>${esc(p.name || 'Google account')}</b><span>${esc(p.email || '')}</span></div></div>
      <div class="set-row"><div class="lbl"><b>Cloud sync</b><span class="sync-line" id="syncRow">${syncRowHtml(lastStatus)}</span></div></div>
      ${signedOut ? `<div class="set-row"><div class="lbl"><b>Session ended</b><span>Sign in again to resume syncing</span></div>${googleBtn('Sign in')}</div>` : ''}
      <div class="set-row"><div class="lbl"><b>Sign out</b><span>Keep or remove this device’s copy, your choice</span></div><button class="btn sm" data-signout>${ic('logout')}Sign out</button></div>
    </div>`;
  }
  return `<div class="h-row" style="margin-top:4px"><h3 class="h2">${ic('user')} Account</h3></div>
    <div class="set-group">
      <div class="set-row"><div class="lbl"><b>Not signed in</b><span>Your data is only on this device. Sign in with Google to back it up and sync it across your phone and the web.</span></div></div>
      <div class="set-row center">${cloudAvailable() ? googleBtn() : '<span class="muted small">Google sign-in is coming soon.</span>'}</div>
    </div>`;
}
export function bindAccountSection(el) {
  const g = el.querySelector('[data-google]'); if (g) g.onclick = () => startSignIn(g);
  const so = el.querySelector('[data-signout]'); if (so) so.onclick = openSignOut;
}
export function privacyNote() {
  return isAccount()
    ? '<b>Private & offline-first.</b> Everything is saved on this device first and works without internet. While you’re signed in, changes sync to your own private space in the cloud, which only your Google account can read. Images sync too (compressed).'
    : '<b>Private & offline-first.</b> No account, no server, no tracking. Everything is saved in this browser’s storage on your device and works without internet. Sign in with Google above to back up and sync. Without an account, move data between devices with Export / Restore.';
}
export function consumeToast() { const t = localStorage.getItem('shp-toast'); if (t) { localStorage.removeItem('shp-toast'); setTimeout(() => ctx.toast(t, null, null, 4500), 300); } }
