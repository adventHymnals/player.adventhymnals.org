// Warble synthesis (sing/tiny/RUNTIME.md sections 3-4): model output -> spectrum (+ harmonic
// source excitation) -> inverse FFT -> overlap-add. Same maths as sing/tiny/warble/warble_live.c,
// but every voice is kept separate (the player mutes and solos voices), which costs one extra
// inverse FFT per voice and frame: small next to the model.
// Runs anywhere `ort` (onnxruntime-web) runs: a Web Worker in the browser, or node for tests.

export const SR = 44100, HOP = 512, NFFT = 2048, BINS = NFFT / 2 + 1, CTX = 48;

// ---- radix-2 complex FFT, in place, on Float64Arrays (forward; inverse via conjugation)
const LOG = Math.log2(NFFT);
const REV = new Uint16Array(NFFT);
for (let i = 0; i < NFFT; i++) { let r = 0; for (let b = 0; b < LOG; b++) r |= ((i >> b) & 1) << (LOG - 1 - b); REV[i] = r; }
const COS = new Float64Array(NFFT / 2), SIN = new Float64Array(NFFT / 2);
for (let i = 0; i < NFFT / 2; i++) { COS[i] = Math.cos((2 * Math.PI * i) / NFFT); SIN[i] = -Math.sin((2 * Math.PI * i) / NFFT); }
export const WIN = new Float64Array(NFFT);
for (let i = 0; i < NFFT; i++) WIN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT); // periodic Hann

function fft(re, im) {
  for (let i = 0; i < NFFT; i++) {
    const j = REV[i];
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= NFFT; len <<= 1) {
    const half = len >> 1, step = NFFT / len;
    for (let i = 0; i < NFFT; i += len) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const a = i + k, b = a + half;
        const wr = COS[w], wi = SIN[w];
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}

/** model.excitation(): the pulse train at f0 for a whole pass (phase in double). */
export function pulseTrain(f0, T) {
  const NS = T * HOP, pulse = new Float32Array(NS);
  let p = 0;
  for (let n = 0; n < NS; n++) {
    let x = (n + 0.5) / HOP - 0.5;
    if (x < 0) x = 0; if (x > T - 1) x = T - 1;
    const i0 = Math.floor(x), i1 = Math.min(i0 + 1, T - 1), w = x - i0;
    const fs = f0[i0] * (1 - w) + f0[i1] * w;
    const voiced = f0[Math.round(x)] > 0; // C lround: x >= 0, halves up, like Math.round
    const step = voiced ? fs / SR : 0, prev = p;
    p += step;
    if (voiced && Math.floor(p) > Math.floor(prev)) {
      const a = (p - Math.floor(p)) / Math.max(step, 1e-12);
      pulse[n] += 1 - a;
      if (n > 0) pulse[n - 1] += a;
    }
  }
  return pulse;
}

/** RUNTIME.md 4b: the noise of part 0..3 (S/A/T/B) for a consistent-source model: T*HOP samples of
 * unit-variance uniform noise from a counter-based mulberry32 hash (model_cs.part_noise, bit for bit). */
export function partNoise(T, part) {
  const NS = T * HOP, out = new Float32Array(NS), base = Math.imul(part + 1, 0x9e3779b9) >>> 0, s3 = Math.sqrt(3);
  for (let n = 0; n < NS; n++) {
    let t = (base + Math.imul(n + 1, 0x6d2b79f5)) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[n] = (2 * (((t ^ (t >>> 14)) >>> 0) / 4294967296) - 1) * s3;
  }
  return out;
}

/**
 * Sings one pass, one voice at a time or all together, chunk by chunk.
 * session: an ort.InferenceSession of warble*.onnx; ort: the onnxruntime module.
 */
export class Synth {
  constructor(ort, session) {
    this.ort = ort;
    this.session = session;
    this.re = new Float64Array(NFFT);
    this.im = new Float64Array(NFFT);
    // consistent-source models (RUNTIME.md 4b) name their output "ycs": [1, 2*BINS, W] log-magnitudes
    this.cs = Synth.isCS(session);
    if (this.cs) for (const k of ["nr", "ni", "hr", "hi"]) this[k] = new Float64Array(BINS);
  }

  static isCS(session) { return (session.outputNames || []).includes("ycs"); }

  /** K (2 plain or consistent-source, 4 harmonic-source) from the output's static dim 1; else from the first run. */
  static kOf(session) {
    const meta = session.outputMetadata?.[0] ?? session.outputMetadata?.y ?? session.outputMetadata?.ycs;
    const d = meta?.shape?.[1];
    return typeof d === "number" ? d / BINS : null;
  }

  /**
   * pass: { T, voices: [{ speaker, ph: Int16Array, prog, f0 }] } (frontend.passFrames).
   * Returns a job: { out: [Float32Array per voice] (T*HOP samples), next(): Promise<bool> } where
   * each next() sings `chunk` more frames for every voice; out[v][s] is final for s < job.ready.
   */
  start(pass, { chunk = 172, voices = null } = {}) {
    const { T } = pass;
    const NS = T * HOP;
    const vs = pass.voices.map((v, i) => ({ ...v, i })).filter((v) => !voices || voices.includes(v.i));
    const job = {
      T, done: false, ready: 0, c0: 0,
      out: pass.voices.map(() => new Float32Array(NS)),
      env: new Float32Array(NS + NFFT),
    };
    for (const v of vs) {
      v.ph64 = BigInt64Array.from(v.ph, (x) => BigInt(x));
      v.pulse = null; v.ere = null; v.eim = null; v.edone = 0; v.noise = null;
      v.part = v.part ?? ("SATB".includes(v.voice) && v.voice ? "SATB".indexOf(v.voice) : v.i); // noise seed (4b)
    }
    // the window's squared sum, once per frame position: the same for every voice
    for (let t = 0; t < T; t++) {
      const pos = t * HOP - NFFT / 2;
      for (let i = 0; i < NFFT; i++) { const s = pos + i; if (s >= 0 && s < NS) job.env[s] += WIN[i] * WIN[i]; }
    }
    job.next = async () => {
      if (job.c0 >= T) return false;
      const c0 = job.c0, c1 = Math.min(T, c0 + chunk), a = Math.max(0, c0 - CTX), b = Math.min(T, c1 + CTX), W = b - a;
      const pending = []; // run the voices' models, then the DSP (keeps the worker's code simple)
      for (const v of vs) {
        const feeds = {
          ph: new this.ort.Tensor("int64", v.ph64.subarray(a, b), [1, W]),
          prog: new this.ort.Tensor("float32", v.prog.subarray(a, b), [1, W]),
          f0: new this.ort.Tensor("float32", v.f0.subarray(a, b), [1, W]),
          spk: new this.ort.Tensor("int64", BigInt64Array.of(BigInt(v.speaker)), [1]),
        };
        const res = await this.session.run(feeds);
        const y = this.cs ? res.ycs : (res.y ?? Object.values(res)[0]);
        pending.push([v, y.data, this.cs ? "cs" : y.dims[1] / BINS]);
        for (const t of Object.values(feeds)) t.dispose?.();
      }
      for (const [v, y, K] of pending) this.dsp(job, v, y, K, a, W, c0, c1, NS);
      job.c0 = c1;
      job.ready = c1 >= T ? NS : c1 * HOP - NFFT / 2;
      job.done = c1 >= T;
      return !job.done;
    };
    return job;
  }

  dsp(job, v, y, K, a, W, c0, c1, NS) {
    const { re, im } = this, T = job.T;
    if (K === "cs") return this.dspCS(job, v, y, a, W, c0, c1, NS);
    if (K === 4) this.excite(v, c1, T, NS);
    const out = job.out[v.i];
    for (let t = c0; t < c1; t++) {
      const col = t - a;
      for (let k = 0; k < BINS; k++) {
        const l0 = y[k * W + col], p0 = y[(BINS + k) * W + col];
        const m = Math.exp(l0 < 8 ? l0 : 8);
        let r = m * Math.cos(p0), i = m * Math.sin(p0);
        if (K === 4) {
          const l1 = y[(2 * BINS + k) * W + col], p1 = y[(3 * BINS + k) * W + col];
          const hm = Math.exp(l1 < 8 ? l1 : 8), hr = hm * Math.cos(p1), hi = hm * Math.sin(p1);
          const er = v.ere[t * BINS + k], ei = v.eim[t * BINS + k];
          r += hr * er - hi * ei; i += hr * ei + hi * er;
        }
        // inverse via the forward FFT: conjugate in, (conjugate out: real part only needed)
        re[k] = r; im[k] = -i;
        if (k > 0 && k < NFFT / 2) { re[NFFT - k] = r; im[NFFT - k] = i; }
      }
      fft(re, im);
      const pos = t * HOP - NFFT / 2;
      for (let i = 0; i < NFFT; i++) {
        const s = pos + i;
        if (s >= 0 && s < NS) out[s] += (re[i] / NFFT) * WIN[i];
      }
    }
    this.finish(job, v, c1, NS);
  }

  /** The pulse train's STFT frames up to c1 (center=True, reflect padding), cached per voice. */
  excite(v, c1, T, NS) {
    const { re, im } = this;
    if (!v.pulse) { v.pulse = pulseTrain(v.f0, T); v.ere = new Float32Array(T * BINS); v.eim = new Float32Array(T * BINS); }
    for (; v.edone < c1; v.edone++) {
      const t = v.edone;
      for (let i = 0; i < NFFT; i++) {
        let s = t * HOP - NFFT / 2 + i;
        if (s < 0) s = -s; if (s >= NS) s = 2 * (NS - 1) - s;
        re[i] = v.pulse[s] * WIN[i]; im[i] = 0;
      }
      fft(re, im);
      const o = t * BINS;
      for (let k = 0; k < BINS; k++) { v.ere[o + k] = re[k]; v.eim[o + k] = im[k]; }
    }
  }

  /**
   * RUNTIME.md 4b, consistent source: y = [noise log-mag; harmonic log-mag] per frame.
   * S = exp(min(ln,8)) x STFT(noise)/sqrt(NFFT/2) + minphase(min(lh,8)) x E.
   */
  dspCS(job, v, y, a, W, c0, c1, NS) {
    const { re, im, nr, ni, hr, hi } = this, T = job.T;
    this.excite(v, c1, T, NS);
    if (!v.noise) v.noise = partNoise(T, v.part);
    const ns = 1 / Math.sqrt(NFFT / 2), out = job.out[v.i];
    for (let t = c0; t < c1; t++) {
      const col = t - a;
      for (let i = 0; i < NFFT; i++) { // the noise frame (center=True, reflect padding)
        let s = t * HOP - NFFT / 2 + i;
        if (s < 0) s = -s; if (s >= NS) s = 2 * (NS - 1) - s;
        re[i] = v.noise[s] * WIN[i]; im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k < BINS; k++) { nr[k] = re[k] * ns; ni[k] = im[k] * ns; }
      // minimum phase from the harmonic log-magnitude: real cepstrum, fold, back, exp
      for (let k = 0; k < BINS; k++) { const l = y[(BINS + k) * W + col]; re[k] = l < 8 ? l : 8; im[k] = 0; }
      for (let k = 1; k < NFFT / 2; k++) { re[NFFT - k] = re[k]; im[NFFT - k] = 0; }
      fft(re, im); // real and even in, so this is NFFT x the cepstrum
      re[0] /= NFFT; re[NFFT / 2] /= NFFT; im[0] = 0; im[NFFT / 2] = 0;
      for (let n = 1; n < NFFT / 2; n++) { re[n] *= 2 / NFFT; im[n] = 0; }
      for (let n = NFFT / 2 + 1; n < NFFT; n++) { re[n] = 0; im[n] = 0; }
      fft(re, im);
      for (let k = 0; k < BINS; k++) { const m = Math.exp(re[k]); hr[k] = m * Math.cos(im[k]); hi[k] = m * Math.sin(im[k]); }
      const o = t * BINS;
      for (let k = 0; k < BINS; k++) {
        const l0 = y[k * W + col], m = Math.exp(l0 < 8 ? l0 : 8);
        const er = v.ere[o + k], ei = v.eim[o + k];
        const r = m * nr[k] + hr[k] * er - hi[k] * ei, i = m * ni[k] + hr[k] * ei + hi[k] * er;
        re[k] = r; im[k] = -i;
        if (k > 0 && k < NFFT / 2) { re[NFFT - k] = r; im[NFFT - k] = i; }
      }
      fft(re, im);
      const pos = t * HOP - NFFT / 2;
      for (let i = 0; i < NFFT; i++) {
        const s = pos + i;
        if (s >= 0 && s < NS) out[s] += (re[i] / NFFT) * WIN[i];
      }
    }
    this.finish(job, v, c1, NS);
  }

  finish(job, v, c1, NS) {
    const out = job.out[v.i], T = job.T;
    // normalise what is final now (no later frame reaches it)
    const ready = c1 >= T ? NS : c1 * HOP - NFFT / 2;
    const from = v.normed ?? 0;
    for (let s = from; s < ready; s++) out[s] = job.env[s] > 1e-8 ? out[s] / job.env[s] : 0;
    v.normed = ready;
  }
}

/** Mix voices as RUNTIME.md does (gain 2/n above two voices): for tests. */
export function mixdown(outs) {
  const n = outs.length, g = n > 2 ? 2 / n : 1, mix = new Float32Array(outs[0].length);
  for (const o of outs) for (let s = 0; s < mix.length; s++) mix[s] += o[s] * g;
  return mix;
}
