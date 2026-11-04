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
  }

  /** K (2 plain, 4 harmonic-source) from the output's static dim 1; else from the first run. */
  static kOf(session) {
    const meta = session.outputMetadata?.[0] ?? session.outputMetadata?.y;
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
      v.pulse = null; v.ere = null; v.eim = null; v.edone = 0;
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
        const y = (res.y ?? Object.values(res)[0]);
        pending.push([v, y.data, y.dims[1] / BINS]);
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
    if (K === 4 && !v.pulse) {
      v.pulse = pulseTrain(v.f0, T);
      v.ere = new Float32Array(T * BINS); v.eim = new Float32Array(T * BINS);
    }
    if (K === 4) {
      for (; v.edone < c1; v.edone++) { // STFT of the pulse train: center=True, reflect padding
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
