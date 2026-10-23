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
    this.master = this.ctx.createDynamicsCompressor();
    this.master.threshold.value = -14;
    this.master.ratio.value = 3;
    this.master.connect(this.ctx.destination);
    this.panners = {};
    for (const ch of Object.keys(PAN)) {
      const g = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = this.pans?.[ch] ?? PAN[ch];
      g.connect(pan).connect(this.master);
      this.channels[ch] = g;
      this.panners[ch] = pan;
    }
    this.applyLevels();
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

  setLevel(ch, v) { this.levels[ch] = v; this.applyLevels(); }
  setMuted(ch, m) { this.muted[ch] = m; this.applyLevels(); }

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
  async loadStems(list, onProgress = () => {}, timeout = 25000) {
    this.ensure();
    this.stems = this.stems || new Map();
    const todo = [...new Set(list.map((s) => s.url))].filter((u) => !this.stems.has(u));
    let done = 0;
    const total = todo.length;
    const failed = [];
    onProgress(0, total);
    await Promise.all(todo.map(async (url) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      try {
        const r = await fetch(url, { signal: ctl.signal });
        if (!r.ok) throw new Error(String(r.status));
        this.stems.set(url, await this.ctx.decodeAudioData(await r.arrayBuffer()));
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
    return map;
  }

  setStemBuffers(map) { this.stemBuffers = map; }

  startStem(e, at, offset = 0) {
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
    if (offset >= buf.duration) return;
    src.start(at, offset);
    this.track([src], g, at + buf.duration - offset);
    this.liveStems = this.liveStems || new Set();
    const item = { src, g };
    this.liveStems.add(item);
    src.addEventListener("ended", () => this.liveStems.delete(item));
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
    if (this.loop && this.playing) {
      const t = this.now();
      if (t < this.loop.a || t >= this.loop.b) this.play(this.loop.a);
    }
  }

  // Scheduling runs ahead of the sound, so the reported position follows its own clock:
  // each entry says "from this context time on, performance t = ctxTime - startAt".
  now() {
    if (!this.playing) return this.pausedAt ?? 0;
    const ct = this.ctx.currentTime;
    let s = this.clock[0].startAt;
    for (const c of this.clock) if (c.from <= ct) s = c.startAt;
    return ct - s;
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
        continue;
      }
      if (!e) break;
      const at = this.startAt + e.t;
      if (at > horizon) break;
      this.next++;
      if (e.stem) { this.startStem(e, at); continue; }
      if (e.silent || at < this.ctx.currentTime - 0.05) continue;
      if (e.ch === "click") this.click(e.p, at, e.v);
      else if (e.ch === "acc" || this.voiceSounds[e.ch] === "piano") this.pianoNote(e.ch, e.p, at, e.dur, e.v * (e.ch === "acc" ? 1 : 0.7));
      else this.choirNote(e.ch, e.p, at, e.dur, e.v);
    }
  }

  /** A MediaStream of everything the engine plays, for recording video. */
  recordStream() {
    this.ensure();
    if (!this.tap) {
      this.tap = this.ctx.createMediaStreamDestination();
      this.master.connect(this.tap);
    }
    return this.tap.stream;
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = this.now();
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
