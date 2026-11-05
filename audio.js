import { stretchBuffer } from "./stretch.js";
// Audio engine: synthesized choir "aah" per voice, sampled piano, count-in click.
// A look-ahead scheduler plays performance events (see core.performance).

const FORMANTS = { // "ah", lowered for deeper voices
  S: [[850, 1], [1220, 0.5], [2810, 0.25]],
  A: [[800, 1], [1150, 0.5], [2800, 0.22]],
  T: [[650, 1], [1080, 0.45], [2650, 0.2]],
  B: [[600, 1], [1040, 0.4], [2250, 0.16]],
};
const PAN = { S: -0.35, A: -0.12, T: 0.12, B: 0.35, acc: 0, click: 0 };
const PIANO_URL = "https://tonejs.github.io/audio/salamander/";
const SAMPLE_NAMES = ["C", "Ds", "Fs", "A"];
const STEM_XF = 0.03; // crossfade between two stretches of singing (core.js XF)
const freq = (p) => 440 * 2 ** ((p - 69) / 12);

export class Engine {
  constructor() {
    this.ctx = null;
    this.channels = {};
    this.levels = { S: 0.8, A: 0.8, T: 0.8, B: 0.8, acc: 0.7, click: 0.6 };
    this.muted = {};
    this.voiceSounds = {}; // per voice: "choir" (synthesised aah) or "piano"
    this.piano = null; // Map midi -> AudioBuffer
    this.pianoLoading = null;
    this.events = [];
    this.playing = false;
    this.startAt = 0; // ctx time when performance t=0
    this.next = 0;
    this.live = new Set();
  }

  ensure() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.buildGraph();
  }

  buildGraph(instant = false) {
    // four sung stems plus the piano can sum past full scale (crackle), so the output is limited:
    // a gentle compressor, then a hard limiter just under 0 dB
    this.master = this.ctx.createDynamicsCompressor();
    this.master.threshold.value = -14;
    this.master.ratio.value = 3;
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    const trim = this.ctx.createGain();
    trim.gain.value = 0.85;
    this.master.connect(trim).connect(limiter).connect(this.ctx.destination);
    this.out = limiter;
    this.panners = {};
    for (const ch of Object.keys(PAN)) {
      const g = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = this.pans?.[ch] ?? PAN[ch];
      g.connect(pan).connect(this.master);
      this.channels[ch] = g;
      this.panners[ch] = pan;
    }
    if (instant) for (const [ch, g] of Object.entries(this.channels)) g.gain.value = this.muted[ch] ? 0 : this.levels[ch] ?? 0.8;
    else this.applyLevels();
  }

  /** Stereo position of a channel, -1 (left) to 1 (right). Remembered until the context exists. */
  setPan(ch, v) {
    this.pans = { ...(this.pans || {}), [ch]: v };
    if (this.panners?.[ch]) this.panners[ch].pan.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  applyLevels() {
    if (!this.ctx) return;
    for (const [ch, g] of Object.entries(this.channels)) {
      const v = this.muted[ch] ? 0 : this.levels[ch] ?? 0.8;
      g.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
    }
  }

  setLevel(ch, v) { this.levels[ch] = v; this.applyLevels(); this.nativeGains(); }
  setMuted(ch, m) { this.muted[ch] = m; this.applyLevels(); this.nativeGains(); }

  // ---- the Android app's own live singer (AHNative.warble, sing/tiny/RUNTIME.md) ----
  // Stem events marked `native` (a pass key) are sung by the app, not by Web Audio: the app gets the
  // passes' places on the timeline, and while it sings its audio is the clock.
  setNative(n) { this.native = n; }
  nativeSegs() {
    const segs = new Map();
    // at: where the pass's audio starts; a stretch of it (a key change inside the verse) also has from/to
    for (const e of this.stemEvents || []) {
      const id = `${e.native}@${e.t.toFixed(3)}`;
      if (!e.native || segs.has(id)) continue;
      segs.set(id, e.off || e.cut ? { key: e.native, at: e.t - (e.off || 0), from: e.t, to: e.t + e.dur } : { key: e.native, at: e.t });
    }
    return [...segs.values()];
  }
  nativePlay(fromT) {
    const segs = this.native ? this.nativeSegs() : [];
    if (!segs.length) { this.nativeStop(); return; }
    this.nativeGains(true);
    try { this.native.play(JSON.stringify({ from: fromT, segs })); this.nativeOn = true; } catch { this.nativeOn = false; }
  }
  nativeStop() {
    clearTimeout(this.nativeWrap);
    if (this.nativeOn) { try { this.native.stop(); } catch { /* the app went away */ } }
    this.nativeOn = false;
  }
  nativeGains(force = false) {
    if (!this.native) return;
    // with each voice's place between the ears (the app sings them in stereo; older apps read only the letters)
    const g = JSON.stringify({ ...Object.fromEntries(["S", "A", "T", "B"].map((k) => [k, this.muted[k] ? 0 : this.levels[k] ?? 0.8])),
      pan: Object.fromEntries(["S", "A", "T", "B"].map((k) => [k, this.pans?.[k] ?? PAN[k]])) });
    if (g === this.nativeG && !force) return; // only changes (the mixer sets every channel at once)
    this.nativeG = g;
    try { this.native.gains(g); } catch { /* not singing */ }
  }

  loadPiano() {
    if (this.pianoLoading) return this.pianoLoading;
    this.ensure();
    const jobs = [];
    const map = new Map();
    for (let oct = 1; oct <= 7; oct++) {
      SAMPLE_NAMES.forEach((n, i) => {
        const midi = 12 * (oct + 1) + i * 3;
        jobs.push(fetch(`${PIANO_URL}${n}${oct}.mp3`)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
          .then((b) => this.ctx.decodeAudioData(b))
          .then((buf) => map.set(midi, buf))
          .catch(() => {}));
      });
    }
    this.pianoLoading = Promise.all(jobs).then(() => { this.piano = map.size ? map : null; return !!this.piano; });
    return this.pianoLoading;
  }

  // ---- instruments --------------------------------------------------------

  choirNote(ch, p, t, dur, vel) {
    const c = this.ctx;
    const out = c.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.16 * vel, t + 0.07);
    out.gain.setTargetAtTime(0.13 * vel, t + 0.07, 0.2);
    const end = t + Math.max(0.08, dur - 0.03);
    out.gain.setTargetAtTime(0, end, 0.06);
    const sum = c.createGain();
    for (const [f, g] of FORMANTS[ch] || FORMANTS.A) {
      const bp = c.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = f;
      bp.Q.value = 7;
      const bg = c.createGain();
      bg.gain.value = g * 3;
      sum.connect(bp).connect(bg).connect(out);
    }
    const lfo = c.createOscillator();
    lfo.frequency.value = 5.2;
    const depth = c.createGain();
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(14, t + Math.min(0.5, dur * 0.6)); // vibrato in cents
    lfo.connect(depth);
    const nodes = [lfo];
    for (const det of [-5, 5]) {
      const o = c.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = freq(p);
      o.detune.value = det;
      depth.connect(o.detune);
      o.connect(sum);
      nodes.push(o);
    }
    out.connect(this.channels[ch]);
    const stop = end + 0.4;
    for (const n of nodes) { n.start(t); n.stop(stop); }
    this.track(nodes, out, stop);
  }

  pianoNote(ch, p, t, dur, vel) {
    const c = this.ctx;
    const g = c.createGain();
    const end = t + Math.max(0.1, dur);
    g.gain.setValueAtTime(0.9 * vel, t);
    g.gain.setTargetAtTime(0, end, 0.12);
    g.connect(this.channels[ch]);
    if (this.piano) {
      let best = null;
      for (const m of this.piano.keys()) if (best === null || Math.abs(m - p) < Math.abs(best - p)) best = m;
      const src = c.createBufferSource();
      src.buffer = this.piano.get(best);
      src.playbackRate.value = 2 ** ((p - best) / 12);
      src.connect(g);
      src.start(t);
      src.stop(end + 1);
      this.track([src], g, end + 1);
    } else { // fallback until samples load: soft triangle with decay
      const o = c.createOscillator();
      o.type = "triangle";
      o.frequency.value = freq(p);
      g.gain.setValueAtTime(0.35 * vel, t);
      g.gain.setTargetAtTime(0.0, t + 0.02, Math.min(0.8, dur));
      o.connect(g);
      o.start(t);
      o.stop(end + 0.3);
      this.track([o], g, end + 0.3);
    }
  }

  click(p, t, vel) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.value = freq(p);
    g.gain.setValueAtTime(0.5 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    o.connect(g).connect(this.channels.click);
    o.start(t);
    o.stop(t + 0.07);
    this.track([o], g, t + 0.07);
  }

  track(sources, gain, until) {
    const item = { sources, gain, until };
    this.live.add(item);
    sources[sources.length - 1].onended = () => { gain.disconnect(); this.live.delete(item); };
    return item;
  }

  // ---- transport ----------------------------------------------------------

  load(events) {
    this.events = events;
    this.stemEvents = events.filter((e) => e.stem);
  }

  /**
   * Decode sung stems: list of { key: "S:1", url }. Resolves to Map key -> AudioBuffer for the
   * stems that arrived; a stem that fails or takes longer than `timeout` ms is left out (its
   * voice falls back to the synth). onProgress(done, total) reports each one.
   */
  /** Let go of every decoded recording (a new hymn is opening). */
  dropStems() { this.stems?.clear(); this.stemGen = (this.stemGen || 0) + 1; this.setStemBuffers(new Map()); }

  async loadStems(list, onProgress = () => {}, timeout = 25000) {
    this.ensure();
    this.stems = this.stems || new Map();
    // Only this hymn's recordings stay decoded: each is tens of MB of samples, and keeping every
    // hymn's made a phone run out of memory (and hang) after a few songs.
    const keep = new Set(list.map((s) => s.url));
    for (const u of [...this.stems.keys()]) if (!keep.has(u)) this.stems.delete(u);
    const gen = (this.stemGen = (this.stemGen || 0) + 1); // a newer call makes this one's late arrivals unwanted
    const todo = [...keep].filter((u) => !this.stems.has(u));
    let done = 0;
    const total = todo.length;
    const failed = [];
    onProgress(0, total);
    await Promise.all(todo.map(async (url) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      try {
        const buf = await this.ctx.decodeAudioData(await singers.fetch(url, ctl.signal));
        if (gen === this.stemGen) this.stems.set(url, buf);

      } catch {
        failed.push(url);
      } finally {
        clearTimeout(timer);
        onProgress(++done, total);
      }
    }));
    const map = new Map();
    for (const s of list) if (this.stems.has(s.url)) map.set(s.key, this.stems.get(s.url));
    map.failed = failed;
    map.stale = gen !== this.stemGen; // another hymn (or other verses) asked since
    return map;
  }

  setStemBuffers(map) { this.stemBuffers = map; }

  // a recording stretched to another tempo; only the current tempo's copies are kept
  stretched(buf, ratio) {
    const k = ratio.toFixed(4);
    if (this.stretchKey !== k) { this.stretchKey = k; this.stretchCache = new WeakMap(); }
    if (!this.stretchCache.has(buf)) this.stretchCache.set(buf, stretchBuffer(this.ctx, buf, ratio));
    return this.stretchCache.get(buf);
  }

  startStem(e, at, offset = 0) {
    if (e.native) return; // the app sings it
    const buf = this.stemBuffers?.get(e.stem);
    if (!buf) return;
    const c = this.ctx;
    const g = c.createGain();
    g.gain.value = 1;
    g.connect(this.channels[e.ch]);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(g);
    // a stem may begin before the pass (pickup consonants); start partway in if so
    const now = c.currentTime;
    if (at < now) { offset += now - at; at = now; }
    const dur = Math.min(e.dur ?? buf.duration, buf.duration - (e.off || 0));
    if (offset >= dur) return;
    // a stretch of the recording (a key change inside the verse): fade in where it takes over
    if (e.off && offset < STEM_XF) { g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(1, at + STEM_XF - offset); }
    src.start(at, (e.off || 0) + offset);
    this.liveStems = this.liveStems || new Set();
    const item = { src, g, id: `${e.stem}@${e.t.toFixed(3)}`, end: Infinity };
    this.liveStems.add(item);
    src.addEventListener("ended", () => this.liveStems.delete(item));
    item.tracked = this.track([src], g, at + dur - offset);
    if (e.cut) this.endStem(item, at + dur - offset);
  }

  /** A playing stem ends at ctx time `end`, fading out over the crossfade (another stretch takes over). */
  endStem(item, end) {
    if (Math.abs(item.end - end) < 1e-4) return;
    item.end = end;
    const g = item.g.gain, at = Math.max(this.ctx.currentTime, end - STEM_XF);
    g.cancelScheduledValues(at);
    g.setValueAtTime(g.value, at);
    g.linearRampToValueAtTime(0, Math.max(at + 0.005, end));
    try { item.src.stop(end + 0.01); } catch { /* already stopped */ }
    if (item.tracked) item.tracked.until = end + 0.01;
  }

  /** New events on the same timeline while playing (singers arrived): no restart. Stems that should be
   * sounding now join in; what is already scheduled plays on. */
  swap(events) {
    const before = JSON.stringify(this.nativeSegs());
    this.load(events);
    if (!this.playing) return;
    if (this.native && JSON.stringify(this.nativeSegs()) !== before) this.nativePlay(this.now());
    const ct = this.ctx.currentTime;
    const horizonT = ct + 0.2 - this.startAt; // scheduled up to here
    this.next = this.indexAt(horizonT);
    // recordings no longer in the performance (the singers changed) stop now, with a short fade
    const keep = new Map(this.stemEvents.map((e) => [`${e.stem}@${e.t.toFixed(3)}`, e]));
    for (const item of [...(this.liveStems || [])]) {
      const e = keep.get(item.id);
      if (e && this.stemBuffers?.get(e.stem) === item.src.buffer) {
        // the same stretch plays on; a key change may have moved where it ends
        if (e.cut) this.endStem(item, this.startAt + e.t + e.dur);
        continue;
      }
      try { item.g.gain.setTargetAtTime(0, ct, 0.03); item.src.stop(ct + 0.15); } catch { /* already stopped */ }
      this.liveStems.delete(item);
    }
    const live = new Set([...(this.liveStems || [])].map((s) => s.id));
    for (const e of this.stemEvents) {
      if (e.t < horizonT && e.t + e.dur > ct - this.startAt && !live.has(`${e.stem}@${e.t.toFixed(3)}`)) this.startStem(e, this.startAt + e.t);
    }
  }

  // stems that should already be sounding at performance time t (after a seek or a loop wrap)
  resumeStems(t, ctxAt) {
    for (const e of this.stemEvents || []) {
      if (e.t < t - 1e-6 && e.t + e.dur > t) this.startStem(e, ctxAt, t - e.t);
    }
  }

  stopStemsAt(when) {
    for (const s of this.liveStems || []) { try { s.src.stop(when); } catch { /* already stopped */ } }
  }

  /** Loop between performance times a and b (seconds), or clear with null. */
  setLoop(a, b) {
    this.loop = a === null || b <= a ? null : { a, b };
    if (!this.loop) clearTimeout(this.nativeWrap); // out of a repeat: the app's singer just sings on
    if (this.loop && this.playing) {
      const t = this.now();
      if (t < this.loop.a || t >= this.loop.b) this.play(this.loop.a);
    }
  }

  // Scheduling runs ahead of the sound, so the reported position follows its own clock:
  // each entry says "from this context time on, performance t = ctxTime - startAt".
  // The position is what is heard now: sound reaches the speakers outputLatency (+ baseLatency)
  // after currentTime (0.1-0.3 s on Bluetooth and phones), so without this the score runs ahead.
  now() {
    if (!this.playing) return this.pausedAt ?? 0;
    if (this.nativeOn) { // the app's singer is the clock while it sings
      const p = Number(this.native.pos());
      if (p >= 0) return p;
    }
    const ct = this.ctx.currentTime - this.latency();
    let s = this.clock[0].startAt;
    for (const c of this.clock) if (c.from <= ct) s = c.startAt;
    return Math.max(0, ct - s);
  }

  latency() {
    return this.ctx ? (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0) : 0;
  }

  indexAt(t) {
    const i = this.events.findIndex((e) => e.t >= t - 1e-6);
    return i < 0 ? this.events.length : i;
  }

  async play(fromT = 0) {
    this.ensure();
    await this.ctx.resume();
    this.stopSources();
    if (this.loop && (fromT < this.loop.a || fromT >= this.loop.b)) fromT = this.loop.a;
    this.startAt = this.ctx.currentTime + 0.12 - fromT;
    this.clock = [{ from: -Infinity, startAt: this.startAt }];
    this.next = this.indexAt(fromT);
    this.resumeStems(fromT, this.startAt + fromT);
    this.nativePlay(fromT);
    this.playing = true;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.pump(), 25);
    this.pump();
  }

  pump() {
    const horizon = this.ctx.currentTime + 0.2;
    for (;;) {
      const e = this.events[this.next];
      // at the loop end, carry on seamlessly from the loop start
      if (this.loop && (!e || e.t >= this.loop.b - 1e-6)) {
        if (this.startAt + this.loop.b > horizon) break;
        const wrapAt = this.startAt + this.loop.b;
        this.stopStemsAt(wrapAt);
        this.startAt += this.loop.b - this.loop.a;
        this.clock.push({ from: wrapAt, startAt: this.startAt });
        while (this.clock.length > 1 && this.clock[1].from <= this.ctx.currentTime) this.clock.shift();
        this.next = this.indexAt(this.loop.a);
        this.resumeStems(this.loop.a, wrapAt);
        if (this.nativeOn) { const a = this.loop.a; clearTimeout(this.nativeWrap); this.nativeWrap = setTimeout(() => this.nativePlay(a), Math.max(0, (wrapAt - this.ctx.currentTime) * 1000)); }
        continue;
      }
      if (!e) break;
      const at = this.startAt + e.t;
      if (at > horizon) break;
      this.next++;
      if (e.stem) { this.startStem(e, at); continue; }
      if (e.silent || at < this.ctx.currentTime - 0.05) continue;
      this.sound(e, at);
    }
  }

  sound(e, at) {
    if (e.ch === "click") this.click(e.p, at, e.v);
    // an introduction's voice lines (inst) are piano, whatever the voice sounds like in the verses
    else if (e.ch === "acc" || e.inst || this.voiceSounds[e.ch] === "piano") this.pianoNote(e.ch, e.p, at, e.dur, e.v * (e.ch === "acc" ? 1 : 0.7));
    else this.choirNote(e.ch, e.p, at, e.dur, e.v);
  }

  /**
   * The whole performance rendered ahead of time (no live clock, so nothing can stutter), with the current
   * levels, mutes and sounds. Returns an AudioBuffer of `seconds` length.
   */
  async renderOffline(events, seconds, sampleRate = 48000) {
    this.ensure();
    const keep = ["ctx", "channels", "panners", "master", "out", "live", "liveStems"].map((k) => [k, this[k]]);
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    this.ctx = ctx;
    this.channels = {};
    this.live = new Set();
    this.liveStems = new Set();
    try {
      this.buildGraph(true);
      for (const e of events) {
        if (e.stem) { if (!this.muted[e.ch]) this.startStem(e, e.t); }
        else if (!e.silent && !this.muted[e.ch]) this.sound(e, Math.max(0, e.t));
      }
      return await ctx.startRendering();
    } finally {
      for (const [k, v] of keep) this[k] = v;
    }
  }

  /** A MediaStream of everything the engine plays, for recording video. */
  recordStream() {
    this.ensure();
    if (!this.tap) {
      this.tap = this.ctx.createMediaStreamDestination();
      this.out.connect(this.tap);
    }
    return this.tap.stream;
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = this.now();
    this.nativeStop();
    this.playing = false;
    clearInterval(this.timer);
    this.stopSources();
  }

  stop() {
    this.pause();
    this.pausedAt = 0;
  }

  stopSources() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const item of this.live) {
      item.gain.gain.cancelScheduledValues(t);
      item.gain.gain.setTargetAtTime(0, t, 0.02);
      for (const s of item.sources) { try { s.stop(t + 0.1); } catch { /* not started yet */ } }
    }
  }
}

// ---- saved singers (?app) ---------------------------------------------------------------------------
// In the app the recordings (and each hymn's list of them) are kept on the phone once heard, as the
// small compressed files, so a hymn sung before plays again offline and without downloading. The
// app lists them by hymn, with their size, and clears all or chosen hymns. Elsewhere this is off.
const SINGERS = "ah-singers";
const hymnOf = (url) => decodeURIComponent((new URL(url).pathname.match(/\/audio\/([^/]+)\//) || [])[1] || "");
export const singers = {
  on: false,
  async cache() { if (!this.on) return null; try { return await caches.open(SINGERS); } catch { return null; } },
  /** A recording's bytes: from the phone when saved, else downloaded (and saved). */
  async fetch(url, signal) {
    const c = await this.cache();
    const hit = c && (await c.match(url).catch(() => null));
    if (hit) return hit.arrayBuffer();
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(String(r.status));
    if (c) c.put(url, r.clone()).catch(() => { /* phone full: play without saving */ });
    return r.arrayBuffer();
  },
  /** A hymn's list of recordings: fresh when online (and saved), the saved one when not. */
  async manifest(url) {
    const c = await this.cache();
    try {
      // never wait for good on a weak connection (the hymn would never finish opening): 8 s, then the saved list
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(url, { cache: "no-cache", signal: ctl.signal }).finally(() => clearTimeout(t));
      if (r.ok) { c?.put(url, r.clone()).catch(() => {}); return r; }
      if (r.status === 404) return r;
    } catch { /* offline, or too slow */ }
    const hit = c && (await c.match(url).catch(() => null));
    return hit || fetch(url, { cache: "force-cache" });
  },
  /** [{ hymn, bytes, files }] for every hymn with saved singers, largest first. */
  async list() {
    const c = await this.cache();
    if (!c) return [];
    const by = new Map();
    for (const req of await c.keys()) {
      const id = hymnOf(req.url);
      if (!id) continue;
      const r = await c.match(req);
      const n = Number(r?.headers.get("content-length")) || (await r?.blob())?.size || 0;
      const x = by.get(id) || { hymn: id, bytes: 0, files: 0 };
      x.bytes += n; if (!req.url.endsWith("manifest.json")) x.files++;
      by.set(id, x);
    }
    return [...by.values()].filter((x) => x.files).sort((a, b) => b.bytes - a.bytes);
  },
  /** Clear the saved singers of these hymns, or of every hymn when ids is null. */
  async clear(ids) {
    const c = await this.cache();
    if (!c) return;
    const want = ids ? new Set(ids) : null;
    for (const req of await c.keys()) if (!want || want.has(hymnOf(req.url))) await c.delete(req);
  },
};
