// Change the tempo of a recording without changing its pitch (WSOLA: waveform-similarity overlap-add).
// The singers are recorded at one tempo; this lets them sing at the tempo on the slider.
// ratio = new length / old length (slower > 1, faster < 1).

const N = 2048; // frame (about 46 ms at 44.1 kHz)
const HS = N / 2; // output hop: Hann frames at half overlap sum to one
const DELTA = 160; // how far (samples) a frame may shift to line up with the waveform it follows
const WIN = (() => { const w = new Float32Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); return w; })();

/** Positions in the input of each output frame, chosen on the first channel. */
function framePositions(x, ratio, outLen) {
  const ha = HS / ratio;
  const pos = [0];
  for (let k = 1; k * HS < outLen; k++) {
    const nominal = Math.round(k * ha);
    if (nominal + N >= x.length) break;
    const natural = pos[k - 1] + HS; // what would follow the previous frame in the input
    let best = nominal;
    let bestC = -Infinity;
    const lo = Math.max(0, nominal - DELTA);
    const hi = Math.min(x.length - N - 1, nominal + DELTA);
    for (let p = lo; p <= hi; p += 2) {
      let c = 0;
      for (let i = 0; i < HS; i += 4) c += x[p + i] * x[natural + i];
      if (c > bestC) { bestC = c; best = p; }
    }
    pos.push(best);
  }
  return pos;
}

/** A new AudioBuffer ratio times as long, same pitch. */
export function stretchBuffer(ctx, buf, ratio) {
  if (Math.abs(ratio - 1) < 1e-3) return buf;
  const outLen = Math.round(buf.length * ratio);
  const out = ctx.createBuffer(buf.numberOfChannels, outLen, buf.sampleRate);
  const pos = framePositions(buf.getChannelData(0), ratio, outLen);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const x = buf.getChannelData(ch);
    const y = new Float32Array(outLen + N);
    pos.forEach((p, k) => {
      const o = k * HS;
      for (let i = 0; i < N && p + i < x.length; i++) y[o + i] += x[p + i] * WIN[i];
    });
    // the first half-frame has no partner frame before it: undo its window
    for (let i = 0; i < HS; i++) y[i] = x[i] ?? 0;
    out.copyToChannel(y.subarray(0, outLen), ch);
  }
  return out;
}
