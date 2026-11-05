// Live singing with Warble in the player (sing/tiny/RUNTIME.md). The score is turned into
// features here (frontend.js, cheap); the singing is made by a pool of Web Workers, one voice of
// one pass per job, each worker with its own onnxruntime-web (WASM) session. The result is one
// AudioBuffer per voice and pass, used exactly like a recorded stem (offsetSec -0.3).
import { passFrames, SR, LEAD } from "./frontend.js";
import { writeBin } from "./bin.js";

const IDB = "ah-warble", STORE = "models";
const VOICE_GAIN = 0.5; // the reference mix: 2 / 4 voices

// ---- model cache: IndexedDB, keyed by sha256 (one model kept)
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  try {
    const db = await idb();
    return await new Promise((res) => { const q = db.transaction(STORE).objectStore(STORE).get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
  } catch { return null; }
}
async function idbHas(key) {
  try {
    const db = await idb();
    return await new Promise((res) => { const q = db.transaction(STORE).objectStore(STORE).getKey(key); q.onsuccess = () => res(q.result !== undefined); q.onerror = () => res(false); });
  } catch { return false; }
}
async function idbPutOnly(key, value) {
  try {
    const db = await idb();
    await new Promise((res) => {
      const tx = db.transaction(STORE, "readwrite"), st = tx.objectStore(STORE);
      // keep the models singing.json still offers (the listener may switch between live voices); drop the rest
      const q = st.getAllKeys();
      q.onsuccess = () => { for (const k of q.result) if (k !== key && !Warble.keep.has(k)) st.delete(k); st.put(value, key); };
      tx.oncomplete = res; tx.onerror = res; tx.onabort = res;
    });
  } catch { /* private mode or full: sing without saving */ }
}
async function sha256(buf) {
  if (!crypto?.subtle) return null; // not a secure context: cannot check
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// a rhythm variant of a hymn (the player's syncopation) sings differently: number each one
const variants = new WeakMap();
let variantCount = 0;
const variantId = (h) => { if (!variants.has(h)) variants.set(h, ++variantCount); return variants.get(h); };

export class Warble {
  /** cfg: data/singing.json's "warble" object; base: the URL singing.json came from */
  constructor(cfg, base) {
    this.cfg = cfg;
    this.id = cfg.id || "";
    this.engine = this.id ? `warble-${this.id}` : "warble"; // the first live voice is plain "warble"
    this.label = cfg.label || "Live singers";
    this.speakers = cfg.speakers || undefined; // { S, A, T, B } singer numbers; the frontend's default when absent
    this.modelUrl = new URL(cfg.model, base).href;
    this.workers = [];
    this.ready = null;
    this.lex = null;
    this.cache = new Map(); // pass key -> { voices: { S: AudioBuffer, ... }, T }
    this.cacheHymn = null;
    this.gen = 0;
    this.jobs = new Map();
    this.nextId = 1;
    this.speed = null; // measured x real time per voice per worker
  }

  /** The app's native engine (AHNative.warble), if this page runs inside the Android app. */
  static native() {
    try { const n = window.AHNative?.warble; return n && typeof n.available === "function" && JSON.parse(n.available() || "null") ? n : null; } catch { return null; }
  }

  /** The words' pronunciations (sing/warble_lexicon.py). */
  async lexicon() {
    if (!this.lex) this.lex = fetch(new URL("./lexicon.json", import.meta.url)).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    return this.lex;
  }

  /** Download (or take from IndexedDB) the model and start the workers. onProgress(fraction, text) */
  start(onProgress = () => {}) {
    if (!this.ready) {
      this.ready = this.boot(onProgress).catch((e) => { this.ready = null; throw e; });
    }
    return this.ready;
  }

  async boot(onProgress) {
    const want = (this.cfg.sha256 || "").toLowerCase();
    let bytes = want ? await idbGet(want) : null;
    if (!bytes) {
      const r = await fetch(this.modelUrl);
      if (!r.ok) throw new Error(`the singing model could not be downloaded (${r.status})`);
      const total = Number(r.headers.get("content-length")) || 0;
      const parts = [];
      let got = 0;
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); got += value.length;
        onProgress(total ? got / total : 0, `Downloading the singing model… ${(got / 1e6).toFixed(1)}${total ? ` of ${(total / 1e6).toFixed(1)}` : ""} MB (once)`);
      }
      const all = new Uint8Array(got);
      let o = 0;
      for (const p of parts) { all.set(p, o); o += p.length; }
      bytes = all.buffer;
      const sum = await sha256(bytes);
      if (want && sum && sum !== want) throw new Error("the singing model arrived damaged (checksum); try again");
      if (want) idbPutOnly(want, bytes);
    }
    onProgress(1, "Starting the singers…");
    const cores = navigator.hardwareConcurrency || 4;
    const n = Math.max(1, Math.min(4, cores - 1));
    const t0 = performance.now();
    this.workers = await Promise.all(Array.from({ length: n }, () => new Promise((res, rej) => {
      const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      w.onmessage = (ev) => {
        if (ev.data.type === "ready") { w.onmessage = (e) => this.onMessage(w, e.data); res(w); } else if (ev.data.type === "error") rej(new Error(ev.data.message));
      };
      w.onerror = (e) => rej(new Error(e.message || "the singing worker failed to start"));
      w.postMessage({ type: "init", bytes: bytes.slice(0), threads: 1 }, []);
    })));
    this.busy = new Map(this.workers.map((w) => [w, null]));
    this.queue = [];
    this.startMs = performance.now() - t0;
    return this;
  }

  /** Forget this hymn's singing (another hymn is opening) and stop work in progress. */
  drop() {
    this.cache.clear();
    this.cancelAll();
  }

  cancelAll() {
    this.gen++;
    this.queue = [];
    for (const [w, job] of this.busy || []) if (job) w.postMessage({ type: "cancel", id: job.id });
    for (const job of this.jobs.values()) job.reject?.(Object.assign(new Error("cancelled"), { cancelled: true }));
    this.jobs.clear();
  }

  passKey(h, verse, tempo, transpose) { return `${this.id ? `${this.id}/` : ""}${h.id}${h.tune ? `@${h.tune.key}` : ""}${h.variant ? `~${variantId(h)}` : ""}:${verse === "solfa" ? "solfa" : `v${verse}`}:t${tempo}:k${transpose}`; }

  /** The features for one pass (all the hymn's voices, SATB order). */
  async features(h, verse, tempo, transpose) {
    const lex = await this.lexicon();
    const voices = "SATB".split("").filter((k) => h.voices[k]);
    const pass = passFrames(h, voices, verse, tempo, transpose, lex, this.speakers);
    return { ...pass, letters: voices.join("") };
  }

  /** .bin bytes of a pass, for the app's native engine */
  static bin(pass) { return writeBin(pass); }

  /**
   * Sing passes: list of { verse, transpose } for hymn h at tempo. Calls onPass(passKey, { S: AudioBuffer… })
   * as each pass is complete (in list order of priority), onProgress(doneSec, totalSec). Resolves when all are done.
   */
  async sing(ctx, h, tempo, list, { onPass = () => {}, onProgress = () => {} } = {}) {
    await this.start();
    if (this.cacheHymn !== h.id) { this.drop(); this.cacheHymn = h.id; }
    else this.cancelAll();
    const gen = this.gen;
    const keys = list.map((p) => this.passKey(h, p.verse, tempo, p.transpose));
    // keep only what this request needs (memory: a phone holds a few hymns' worth at most)
    for (const k of [...this.cache.keys()]) if (!keys.includes(k)) this.cache.delete(k);
    const todo = [];
    let total = 0, done = 0;
    for (let i = 0; i < list.length; i++) {
      const key = keys[i];
      if (this.cache.has(key)) { onPass(key, this.cache.get(key).voices); continue; }
      if (todo.some((t) => t.key === key)) continue;
      const pass = await this.features(h, list[i].verse, tempo, list[i].transpose);
      total += pass.T * pass.voices.length;
      todo.push({ key, pass });
    }
    const secs = (frames) => (frames * 512) / SR;
    onProgress(0, secs(total));
    const progress = new Map();
    const report = () => onProgress(secs(done + [...progress.values()].reduce((a, b) => a + b, 0)), secs(total));
    await Promise.all(todo.map(async ({ key, pass }) => {
      const pcms = await Promise.all(pass.voices.map((v) => this.render(pass.T, v, gen, (f, id) => { progress.set(id, f); report(); })));
      if (gen !== this.gen) return;
      const voices = {};
      pass.voices.forEach((v, i) => {
        const buf = ctx.createBuffer(1, pcms[i].length, SR);
        const ch = buf.getChannelData(0);
        for (let s = 0; s < ch.length; s++) ch[s] = pcms[i][s] * VOICE_GAIN;
        voices[v.voice] = buf;
      });
      done += pass.T * pass.voices.length;
      this.cache.set(key, { voices, T: pass.T });
      onPass(key, voices);
    }));
    return gen === this.gen;
  }

  render(T, v, gen, onFrames) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const job = { id, gen, msg: { type: "render", id, T, speaker: v.speaker, ph: v.ph, prog: v.prog, f0: v.f0, chunk: 344 }, resolve, reject, onFrames, t0: 0 };
      this.jobs.set(id, job);
      this.queue.push(job);
      this.pump();
    });
  }

  pump() {
    for (const [w, cur] of this.busy) {
      if (cur || !this.queue.length) continue;
      const job = this.queue.shift();
      this.busy.set(w, job);
      job.t0 = performance.now();
      w.postMessage(job.msg);
    }
  }

  onMessage(w, m) {
    const job = this.jobs.get(m.id);
    if (m.type === "progress") { job?.onFrames(m.frames, m.id); return; }
    if (m.type === "done" || m.type === "cancelled" || m.type === "error") {
      if (this.busy.get(w)?.id === m.id) this.busy.set(w, null);
      if (job) {
        this.jobs.delete(m.id);
        if (m.type === "done") {
          job.onFrames(job.msg.T, m.id);
          const audio = (job.msg.T * 512) / SR;
          this.speed = audio / (m.ms / 1000);
          job.resolve(m.pcm);
        } else job.reject(new Error(m.message || "cancelled"));
      }
      this.pump();
    }
  }

  /** Is the singing model saved on this device (no download needed)? */
  async saved() { const sha = (this.cfg.sha256 || "").toLowerCase(); return !!sha && idbHas(sha); }

  credits() { return this.cfg.credits || "Live singing: Warble, trained on GTSinger (Zhang et al., NeurIPS 2024), CC BY-NC-SA 4.0."; }
}

/** data/singing.json -> { default, warble, voices }: voices are the live singers offered (singing.json's
 *  "voices" list, else its one "warble"), each a Warble; warble is the first (engine "warble"), null when none. */
export async function loadSinging(urls) {
  for (const url of urls) {
    try {
      const r = await fetch(url, { cache: "no-cache" });
      if (!r.ok) continue;
      const cfg = await r.json();
      const base = new URL(url, location.href);
      const list = (Array.isArray(cfg.voices) && cfg.voices.length ? cfg.voices : [cfg.warble]).filter((c) => c?.model);
      Warble.keep = new Set(list.map((c) => (c.sha256 || "").toLowerCase()).filter(Boolean));
      const voices = [];
      for (const [i, c] of list.entries()) {
        const w = new Warble(i === 0 ? { ...c, id: "" } : c, base);
        // offered only where it can sing: the model saved on this device, or reachable
        const sha = (c.sha256 || "").toLowerCase();
        const appHas = () => { try { return !!sha && !!window.AHNative?.warble?.cached?.(sha); } catch { return false; } };
        if (!(sha && (appHas() || (await idbHas(sha))))) {
          const ok = await fetch(w.modelUrl, { method: "HEAD" }).then((x) => x.ok, () => false);
          if (!ok) continue;
        }
        voices.push(w);
      }
      if (voices[0] && voices[0].id) { voices[0].id = ""; voices[0].engine = "warble"; } // the first that can sing is "warble"
      const dflt = cfg.default && voices.some((w) => w.engine === cfg.default) ? cfg.default : "stems";
      return { default: dflt, warble: voices[0] || null, voices };
    } catch { /* offline or absent: try the next */ }
  }
  return { default: "stems", warble: null, voices: [] };
}
Warble.keep = new Set();

export { LEAD };
