// The Warble feature file (sing/tiny/RUNTIME.md section 2), also what the app's native engine
// takes (AHNative.warble.load): int32 nVoices, int32 T, per voice int32 speaker, int16 ph[T],
// float32 prog[T], float32 f0[T], little-endian.

/** pass { T, voices: [{ speaker, ph, prog, f0 }] } -> Uint8Array */
export function writeBin(pass) {
  const { T, voices } = pass;
  const buf = new ArrayBuffer(8 + voices.length * (4 + T * 10));
  const dv = new DataView(buf);
  dv.setInt32(0, voices.length, true); dv.setInt32(4, T, true);
  let o = 8;
  for (const v of voices) {
    dv.setInt32(o, v.speaker, true); o += 4;
    for (let t = 0; t < T; t++, o += 2) dv.setInt16(o, v.ph[t], true);
    for (let t = 0; t < T; t++, o += 4) dv.setFloat32(o, v.prog[t], true);
    for (let t = 0; t < T; t++, o += 4) dv.setFloat32(o, v.f0[t], true);
  }
  return new Uint8Array(buf);
}

/** Uint8Array -> pass */
export function readBin(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nv = dv.getInt32(0, true), T = dv.getInt32(4, true);
  let o = 8;
  const voices = [];
  for (let v = 0; v < nv; v++) {
    const speaker = dv.getInt32(o, true); o += 4;
    const ph = new Int16Array(T), prog = new Float32Array(T), f0 = new Float32Array(T);
    for (let t = 0; t < T; t++, o += 2) ph[t] = dv.getInt16(o, true);
    for (let t = 0; t < T; t++, o += 4) prog[t] = dv.getFloat32(o, true);
    for (let t = 0; t < T; t++, o += 4) f0[t] = dv.getFloat32(o, true);
    voices.push({ speaker, ph, prog, f0 });
  }
  return { T, voices };
}
