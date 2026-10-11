// Reminders. Android app (Capacitor): real OS alarms via LocalNotifications that fire when the
// app is closed, offline or after a reboot. Web: in-app timers + Notification API while open.
import { computeNotifications } from './logic.js';
const CH = 'shp-reminders';
let list = []; let hooks = {}; let tick = null; let syncing = Promise.resolve();
const cap = () => window.Capacitor;
const isNative = () => !!(cap() && cap().isNativePlatform && cap().isNativePlatform());
let LN = null;
const plugin = () => { if (LN) return LN; const C = cap(); if (!C) return null; LN = (C.Plugins && C.Plugins.LocalNotifications) || (C.registerPlugin ? C.registerPlugin('LocalNotifications') : null); return LN; };
const firedKey = 'shp-fired';
const fired = () => { try { return JSON.parse(localStorage.getItem(firedKey) || '{}'); } catch (_) { return {}; } };
async function showWeb(n) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return false;
    const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
    const opts = { body: n.body, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: n.key, data: { date: n.date, taskId: n.taskId }, vibrate: [120, 60, 120] };
    if (reg && reg.showNotification) await reg.showNotification(n.title, opts); else new Notification(n.title, opts);
    return true;
  } catch (_) { return false; }
}
function webTick() {
  const now = Date.now(); const f = fired(); let dirty = false;
  for (const n of list) {
    if (n.at <= now && now - n.at < 15 * 60000 && !f[n.key]) { f[n.key] = n.at; dirty = true; showWeb(n); hooks.onFire && hooks.onFire(n); }
  }
  for (const k in f) if (now - f[k] > 3 * 864e5) { delete f[k]; dirty = true; }
  if (dirty) localStorage.setItem(firedKey, JSON.stringify(f));
}
export const Notify = {
  isNative,
  upcoming: (tasks, settings) => computeNotifications(tasks, settings),
  async init(h) {
    hooks = h || {};
    if (isNative()) {
      const p = plugin(); if (!p) return;
      try { await p.createChannel({ id: CH, name: 'Reminders', description: 'Task reminders, deadlines and daily planning', importance: 5, visibility: 1, vibration: true, lights: true, lightColor: '#FF4655' }); } catch (_) {}
      try { p.addListener('localNotificationActionPerformed', (a) => hooks.onOpen && hooks.onOpen(a.notification && a.notification.extra)); } catch (_) {}
      try { p.addListener('localNotificationReceived', (n) => hooks.onFire && hooks.onFire({ title: n.title, body: n.body })); } catch (_) {}
      return;
    }
    if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'open') hooks.onOpen && hooks.onOpen(e.data.data); });
    clearInterval(tick); tick = setInterval(webTick, 20000);
  },
  async status() {
    if (isNative()) {
      const p = plugin(); if (!p) return { label: 'Notifications unavailable', granted: false, canAsk: false };
      let perm = 'prompt'; try { perm = (await p.checkPermissions()).display; } catch (_) {}
      let exact = 'granted'; try { exact = (await p.checkExactNotificationSetting()).exact_alarm; } catch (_) {}
      let pending = null; try { pending = (await p.getPending()).notifications.length; } catch (_) {}
      return { granted: perm === 'granted', canAsk: perm !== 'granted', exact, pending,
        label: perm === 'granted' ? 'On · real alarms, even when the app is closed' : perm === 'denied' ? 'Blocked. Turn on in Android Settings → Apps → SH PLANNER' : 'Off. Tap Enable to get reminders' };
    }
    if (!('Notification' in window)) return { label: 'Not supported in this browser. In-app alerts only.', granted: false, canAsk: false };
    const p = Notification.permission;
    return { granted: p === 'granted', canAsk: p === 'default', label: p === 'granted' ? 'On · fires while the app is open' : p === 'denied' ? 'Blocked in browser settings. In-app alerts still show.' : 'Off. Tap Enable' };
  },
  async ensurePermission(interactive) {
    if (isNative()) {
      const p = plugin(); if (!p) return false;
      let perm = (await p.checkPermissions().catch(() => ({}))).display;
      if (perm !== 'granted' && interactive) perm = (await p.requestPermissions().catch(() => ({}))).display;
      if (perm === 'granted') { try { const ex = await p.checkExactNotificationSetting(); if (ex.exact_alarm !== 'granted' && interactive) await p.changeExactNotificationSetting(); } catch (_) {} }
      return perm === 'granted';
    }
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'default' && interactive) { try { await Notification.requestPermission(); } catch (_) {} }
    return Notification.permission === 'granted';
  },
  async openExactSettings() { const p = plugin(); if (p) try { await p.changeExactNotificationSetting(); } catch (_) {} },
  async test() {
    const n = { key: 'test:' + Date.now(), title: 'SH PLANNER 🔔', body: 'Reminders are working. You’ll get alerts like this before your tasks.', date: null };
    if (isNative()) { const p = plugin(); await p.schedule({ notifications: [{ id: 1, title: n.title, body: n.body, channelId: CH, smallIcon: 'ic_stat_shp', iconColor: '#FF4655', schedule: { at: new Date(Date.now() + 3000), allowWhileIdle: true } }] }); hooks.onFire && hooks.onFire({ title: 'Test scheduled', body: 'arrives in 3 seconds' }); return; }
    const ok = await showWeb(n); if (!ok) hooks.onFire && hooks.onFire({ title: n.title, body: n.body });
  },
  sync(tasks, settings) {
    list = computeNotifications(tasks, settings, new Date(), 14, 60);
    if (!isNative()) { webTick(); return Promise.resolve(list); }
    syncing = syncing.then(async () => {
      const p = plugin(); if (!p) return;
      try {
        const perm = (await p.checkPermissions()).display; if (perm !== 'granted') return;
        const pend = (await p.getPending()).notifications || [];
        const want = new Set(list.map((n) => n.id));
        const stale = pend.filter((x) => !want.has(Number(x.id)) && Number(x.id) !== 1);
        if (stale.length) await p.cancel({ notifications: stale.map((x) => ({ id: Number(x.id) })) });
        if (list.length) await p.schedule({ notifications: list.map((n) => ({ id: n.id, title: n.title, body: n.body, channelId: CH, smallIcon: 'ic_stat_shp', iconColor: '#FF4655', schedule: { at: new Date(n.at), allowWhileIdle: true }, extra: { date: n.date, taskId: n.taskId || null, kind: n.kind } })) });
      } catch (e) { console.warn('notify sync failed', e); }
    });
    return syncing.then(() => list);
  },
};
