// Engraved scores kept on the device (IndexedDB), so a hymn opened again shows at once instead of being
// engraved again (Brian asked for load speed; on the phone the same hymns are opened again and again).
// Keyed by the engraver and a hash of the exact MusicXML and engraving options: the hymn's notes and
// words, its version, the verses, tune, staves, key, width and zoom all change the key. Holds what
// Verovio gave (the SVG pages and the timemap); the page aligns and measures it as before.
// Anything failing (no IndexedDB, storage cleared or full) just means engraving as before.

const DB = "ah-engraved", STORE = "scores", META = "meta"; // meta: key -> { at, size } (eviction reads only this)
export const ENGRAVER = "verovio-6.2.0/2"; // change it when the engraving options or Verovio change
const MAX_BYTES = 40e6, MAX_AGE = 30 * 24 * 3600e3;

/** A 53-bit hash of a string (cyrb53). */
function hash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const engraveKey = (xml, opts) => `${ENGRAVER}:${hash(JSON.stringify(opts))}:${hash(xml)}:${xml.length}`;

let dbp = null;
function db() {
  dbp ??= new Promise((res, rej) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(STORE); r.result.createObjectStore(META); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error("blocked"));
    } catch (e) { rej(e); }
  }).catch(() => null);
  return dbp;
}

/** { pages: [svg], timemap } or null; gives up after `ms` (the page then engraves). */
export async function getEngraved(key, ms = 400) {
  const d = await Promise.race([db(), new Promise((r) => setTimeout(() => r(null), ms))]);
  if (!d) return null;
  return Promise.race([
    new Promise((res) => {
      try {
        const q = d.transaction(STORE).objectStore(STORE).get(key);
        q.onsuccess = () => res(q.result?.pages ? q.result : null);
        q.onerror = () => res(null);
      } catch { res(null); }
    }),
    new Promise((r) => setTimeout(() => r(null), ms)),
  ]);
}

/** Keep an engraving; the oldest go when the store passes 40 MB or are older than 30 days. */
export async function putEngraved(key, { pages, timemap }) {
  const d = await db();
  if (!d) return;
  const size = pages.reduce((a, p) => a + p.length * 2, 0) + JSON.stringify(timemap).length * 2;
  if (size > MAX_BYTES / 4) return; // one score never takes most of the store
  try {
    await new Promise((res, rej) => {
      const tx = d.transaction([STORE, META], "readwrite");
      tx.objectStore(STORE).put({ pages, timemap }, key);
      tx.objectStore(META).put({ at: Date.now(), size }, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
    // evict: the oldest first, past the size or age limit
    const all = await new Promise((res) => {
      const out = [];
      const c = d.transaction(META).objectStore(META).openCursor();
      c.onsuccess = () => { const cur = c.result; if (!cur) { res(out); return; } out.push({ k: cur.key, at: cur.value.at || 0, size: cur.value.size || 0 }); cur.continue(); };
      c.onerror = () => res(out);
    });
    all.sort((a, b) => a.at - b.at);
    let total = all.reduce((a, x) => a + x.size, 0);
    const drop = [];
    for (const x of all) if (total > MAX_BYTES || Date.now() - x.at > MAX_AGE) { drop.push(x.k); total -= x.size; }
    if (drop.length) {
      const tx = d.transaction([STORE, META], "readwrite");
      for (const k of drop) { tx.objectStore(STORE).delete(k); tx.objectStore(META).delete(k); }
    }
  } catch { /* full or cleared: engraving as before */ }
}
