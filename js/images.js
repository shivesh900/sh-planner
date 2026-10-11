// Images stored as compressed Blobs in IndexedDB (store "images").
import { db } from './db.js';
const urls = new Map();
const uid = () => 'img_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
async function compress(file, max = 1600, q = 0.82) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (_) {
    bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  }
  const w0 = bmp.width, h0 = bmp.height; const s = Math.min(1, max / Math.max(w0, h0));
  const w = Math.round(w0 * s), h = Math.round(h0 * s);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', q));
  if (!blob) throw new Error('encode failed');
  return { blob: blob.size < file.size || s < 1 ? blob : file, w, h };
}
const toDataURL = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
export const Images = {
  async add(file) { const { blob, w, h } = await compress(file); const id = uid(); await db.put('images', { id, blob, type: blob.type, w, h, created: Date.now() }); return id; },
  async url(id) { if (urls.has(id)) return urls.get(id); const r = await db.get('images', id).catch(() => null); if (!r) return null; const u = URL.createObjectURL(r.blob); urls.set(id, u); return u; },
  async del(id) { await db.del('images', id); if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); } },
  async exportAll() { const all = await db.all('images'); const out = []; for (const r of all) out.push({ id: r.id, w: r.w, h: r.h, data: await toDataURL(r.blob) }); return out; },
  async importAll(list) { let n = 0; for (const im of list) { try { const blob = await (await fetch(im.data)).blob(); await db.put('images', { id: im.id, blob, type: blob.type, w: im.w, h: im.h, created: Date.now() }); n++; } catch (_) {} } return n; },
};
