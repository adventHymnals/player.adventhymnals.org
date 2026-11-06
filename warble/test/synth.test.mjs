// node web/warble/test/synth.test.mjs [model.onnx] [case ...]
// Sings test vectors with onnxruntime-web (WASM, the browser's engine) and compares the mix
// with the PyTorch reference: correlation >= 0.999 for warble.onnx (fp32), >= 0.94 for int8.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as ort from "../../vendor/onnxruntime-web-1.30.0/ort.wasm.min.mjs";
import { Synth, mixdown, SR } from "../synth.js";
import { readBin } from "../bin.js";

const TV = process.env.TV || "/home/i/big/AH/hymn-satb/sing/tiny-work/testvec"; // TV=<dir> for another model's refs (e.g. a consistent-source export)
const model = process.argv[2] || "/home/i/big/AH/hymn-satb/sing/tiny-work/models/current/warble.onnx";
const cases = process.argv.slice(3).length ? process.argv.slice(3) : ["sdah108-v1-t96", "sdah108-v3-t72-k-2", "sdah73-v1-t96", "nzk1-v1-t96", "wn15-v1-t96"];
const need = /int8/.test(model) ? 0.94 : 0.999;
ort.env.wasm.numThreads = Number(process.env.THREADS || Math.min(4, os.cpus().length));
// node's fetch can't read file:// URLs, so hand the engine its WebAssembly directly
ort.env.wasm.wasmBinary = fs.readFileSync(new URL("../../vendor/onnxruntime-web-1.30.0/ort-wasm-simd-threaded.wasm", import.meta.url));

function readWav(buf) { // 16-bit PCM mono
  let o = 12, data = null;
  while (o < buf.length) { const id = buf.toString("ascii", o, o + 4), n = buf.readUInt32LE(o + 4); if (id === "data") { data = buf.subarray(o + 8, o + 8 + n); break; } o += 8 + n; }
  const x = new Float32Array(data.length / 2);
  for (let i = 0; i < x.length; i++) x[i] = data.readInt16LE(i * 2) / 32768;
  return x;
}
const corr = (a, b) => { let sab = 0, saa = 0, sbb = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) { sab += a[i] * b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; } return sab / Math.sqrt(saa * sbb); };

const t0 = performance.now();
const session = await ort.InferenceSession.create(fs.readFileSync(model), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
console.log(`${path.basename(model)} loaded in ${((performance.now() - t0) / 1000).toFixed(2)} s, threads ${ort.env.wasm.numThreads}, inputs ${session.inputNames}, outputs ${session.outputNames}`);
let bad = 0;
for (const name of cases) {
  const pass = readBin(fs.readFileSync(path.join(TV, `${name}.bin`)));
  const synth = new Synth(ort, session);
  const s0 = performance.now();
  const job = synth.start(pass, { chunk: Number(process.env.CHUNK || 172) });
  while (await job.next());
  const secs = (performance.now() - s0) / 1000, audio = pass.T * 512 / SR;
  const mix = mixdown(job.out);
  const ref = readWav(fs.readFileSync(path.join(TV, `${name}.ref.wav`)));
  const c = corr(mix, ref);
  bad += c < need;
  console.log(`${c >= need ? "ok  " : "FAIL"} ${name}: corr ${c.toFixed(5)} (need ${need}), ${audio.toFixed(1)} s of ${pass.voices.length} voices in ${secs.toFixed(1)} s = ${(audio / secs).toFixed(2)}x real time (len ${mix.length} vs ref ${ref.length})`);
  if (process.env.OUT) {
    const pcm = Buffer.alloc(44 + mix.length * 2); pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + mix.length * 2, 4); pcm.write("WAVEfmt ", 8);
    pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(SR, 24); pcm.writeUInt32LE(SR * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(mix.length * 2, 40);
    for (let i = 0; i < mix.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mix[i] * 32767))), 44 + i * 2);
    fs.writeFileSync(path.join(process.env.OUT, `${name}.js.wav`), pcm);
  }
}
process.exit(bad ? 1 : 0);
