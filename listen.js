// The quick player: a hymn plays at once, with no score drawn. A hymn page on adventhymnals.org loads
// this module (and the sound engine and the music's timing, nothing else: no Verovio), so Play starts in a
// moment instead of waiting for the whole Studio. The recorded singers sing where the hymn has them (the
// first verse is fetched first, the rest while it plays); where it has none, or until they arrive, the
// piano plays the four parts.
//
//   const qp = new QuickPlayer();
//   qp.prime();                // inside the click, so the browser lets the sound start
//   await qp.open("SDAH-86");  // the hymn's music and its list of recordings
//   await qp.play();
//   qp.on((type, qp) => …);    // "load", "state", "time", "end"

import { performance, passTime, locate } from "./core.js";
import { Engine } from "./audio.js";

const STORE = "https://pub-843ae84f0c864d21b1ee26ef78dea9a0.r2.dev/";
const VOICES = ["S", "A", "T", "B"];

export class QuickPlayer {
  constructor({ data = STORE, audio = STORE } = {}) {
    this.data = data;
    this.audio = audio;
    this.engine = new Engine();
    this.fns = new Set();
    this.gen = 0;
    this.hymn = null;
    this.manifest = null;
    this.stemInfo = new Map();
    this.sound = "sung"; // "sung": the recorded singers where there are any; "piano": the piano plays the parts
    this.muted = {};
    this.status = "";
    this.perf = null;
  }

  /** Call inside the click (or tap) that starts the music: the browser lets sound start only then. */
  prime() {
    this.engine.ensure();
    this.engine.ctx.resume?.().catch(() => {});
    this.engine.loadPiano();
  }

  on(fn) { this.fns.add(fn); return () => this.fns.delete(fn); }
  emit(type) { for (const f of this.fns) { try { f(type, this); } catch { /* a listener's own problem */ } } }
  say(s) { this.status = s; this.emit("state"); }

  get playing() { return this.engine.playing; }
  get duration() { return this.perf?.total ?? 0; }
  get time() { return Math.min(this.duration, this.engine.now()); }
  /** Has recorded singers. */
  get recorded() { return !!this.manifest; }
  /** The verse playing (its number) and how many there are. */
  where() {
    const loc = this.perf ? locate(this.perf, this.time) : null;
    return { verse: loc?.verse ?? this.verses?.[0] ?? 1, of: this.verses?.length ?? 0 };
  }

  /** Open a hymn ("SDAH-86"): its music and its recordings' list. Resolves to the hymn, or null when another
   *  hymn was opened meanwhile. */
  async open(id) {
    const gen = ++this.gen;
    this.stop();
    this.engine.dropStems();
    this.id = id;
    this.hymn = null;
    this.manifest = null;
    this.stemInfo = new Map();
    this.loaded = new Set();
    this.perf = null;
    this.say("Opening…");
    this.emit("load");
    const cut = id.indexOf("-");
    const r = await fetch(`${this.data}data/${id.slice(0, cut)}/${id.slice(cut + 1)}.json`);
    if (!r.ok) { this.say("This hymn isn't ready to play yet."); throw new Error(`hymn ${id}: ${r.status}`); }
    const h = await r.json();
    if (gen !== this.gen) return null;
    let m = null;
    try {
      const mr = await fetch(`${this.audio}audio/${id}/manifest.json`);
      if (mr.ok) m = await mr.json();
    } catch { /* no recordings: the piano plays */ }
    if (gen !== this.gen) return null;
    if (m?.stems?.length && !h.tune) {
      m.stems.forEach((s) => { s.url = new URL(s.url, this.audio).href; });
      this.manifest = m;
    }
    this.hymn = h;
    this.verses = h.verses?.length ? h.verses.map((_, i) => i + 1) : [1];
    this.build();
    this.say("");
    this.emit("load");
    return h;
  }

  /** The recordings' tempo nearest the hymn's own: the singers play as recorded, never stretched. */
  recTempo() {
    const ts = [...new Set(this.manifest.stems.map((s) => s.tempo))];
    return ts.reduce((a, b) => (Math.abs(b - this.hymn.tempo) < Math.abs(a - this.hymn.tempo) ? b : a), ts[0]);
  }
  sung() { return this.sound === "sung" && !!this.manifest; }
  tempo() { return this.sung() ? this.recTempo() : this.hymn.tempo; }

  /** The recordings of these verses (each voice), as the engine loads them. */
  stemsOf(verses) {
    const t = this.recTempo();
    const out = [];
    for (const v of verses) for (const k of VOICES) {
      if (!this.hymn.voices[k]) continue;
      const st = this.manifest.stems.find((x) => x.voice === k && x.tempo === t && (x.transpose ?? 0) === 0 && x.verse === v);
      if (st) out.push({ key: `${k}:${v}:0`, url: st.url, offsetSec: st.offsetSec ?? 0 });
    }
    return out;
  }

  /** Fetch the singers for these verses; true once they are in. */
  async loadSung(verses, gen) {
    const want = this.stemsOf(verses.filter((v) => !this.loaded.has(v)));
    if (!want.length) return true;
    const all = this.stemsOf([...this.loaded, ...verses]);
    const bufs = await this.engine.loadStems(all, () => {}, 20000);
    if (gen !== this.gen || bufs.stale) return false;
    this.engine.setStemBuffers(bufs);
    for (const w of all) if (bufs.has(w.key)) this.stemInfo.set(w.key, { offsetSec: w.offsetSec, duration: bufs.get(w.key).duration });
    for (const v of verses) this.loaded.add(v);
    return true;
  }

  /** Lay out the performance; while playing, the place and the sound carry on. */
  build(seamless = false) {
    const h = this.hymn;
    if (!h) return;
    for (const k of VOICES) this.engine.voiceSounds[k] = "piano"; // the piano wherever no one sings
    const e = this.engine;
    const wasPlaying = e.playing;
    const loc = this.perf ? locate(this.perf, e.now()) : null;
    this.perf = performance(h, { tempo: this.tempo(), verses: this.verses, accomp: "off", countIn: false, stems: this.sung() ? this.stemInfo : new Map(), intro: "none", interlude: "none" });
    if (seamless && wasPlaying) { e.swap(this.perf.events); return; }
    e.load(this.perf.events);
    let t = 0;
    if (loc) {
      const k = this.perf.passes.findIndex((p) => p.kind === loc.kind && p.verse === loc.verse);
      if (k >= 0) t = passTime(this.perf, k, loc.q);
    }
    if (wasPlaying) e.play(t);
    else e.pausedAt = t;
  }

  async play(from) {
    if (!this.hymn) return;
    const gen = this.gen;
    this.prime();
    let t = from ?? this.engine.pausedAt ?? 0;
    if (t >= this.duration - 0.05) t = 0;
    if (this.sung() && !this.loaded.size) {
      // the first verse's singers first (a few seconds); the piano plays at once if they are slow
      this.say("Loading the singers…");
      const first = this.where().verse;
      const ok = await Promise.race([this.loadSung([first], gen), new Promise((r) => setTimeout(() => r(false), 8000))]);
      if (gen !== this.gen) return;
      if (ok) this.build();
      this.say("");
      this.loadRest(gen);
    }
    await this.engine.loadPiano();
    if (gen !== this.gen) return;
    this.applyMutes();
    await this.engine.play(t);
    this.tick();
    this.emit("state");
  }

  /** The other verses' singers, while the first plays; each is swapped in without a break. */
  async loadRest(gen) {
    for (const v of this.verses) {
      if (this.loaded.has(v)) continue;
      if (!(await this.loadSung([v], gen))) return;
      if (gen !== this.gen || !this.sung()) return;
      this.build(true);
    }
  }

  pause() { this.engine.pause(); clearInterval(this.timer); this.emit("state"); }
  toggle() { return this.playing ? this.pause() : this.play(); }
  stop() { this.engine.stop(); clearInterval(this.timer); this.emit("state"); }

  seek(t) {
    t = Math.max(0, Math.min(this.duration, t));
    if (this.playing) this.engine.play(t);
    else this.engine.pausedAt = t;
    this.emit("time");
  }

  /** Start of a verse (its number). */
  verseAt(v) {
    const k = this.perf?.passes.findIndex((p) => p.kind === "verse" && p.verse === v) ?? -1;
    return k >= 0 ? this.perf.passes[k].t0 : 0;
  }

  setSound(s) {
    if (s === this.sound) return;
    this.sound = s;
    this.build();
    if (this.sung() && this.loaded.size < this.verses.length) this.loadRest(this.gen);
    this.emit("state");
  }

  /** Mute (true) or bring back a voice ("S", "A", "T", "B"). */
  setMuted(k, m) { this.muted[k] = m; this.applyMutes(); this.emit("state"); }
  applyMutes() { for (const k of VOICES) this.engine.setMuted(k, !!this.muted[k]); }

  tick() {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.playing) { clearInterval(this.timer); return; }
      if (this.engine.now() >= this.duration + 0.4) {
        this.engine.stop();
        clearInterval(this.timer);
        this.emit("state");
        this.emit("end");
        return;
      }
      this.emit("time");
    }, 250);
  }
}
