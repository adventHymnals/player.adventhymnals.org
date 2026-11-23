// node web/warble/test/part-render.mjs PASS.bin OUT_DIR TAG S.onnx A.onnx T.onnx B.onnx [speakers "1,2,3,4"]
// Sings a pass the way the page's workers do with one model per part (worker.js: one voice per job, chunk 344),
// writes OUT_DIR/TAG-<S|A|T|B>.wav (16-bit, 44.1 kHz) and the speed of each part. For checks of the engine against
// the PyTorch render of the same pass (sing/tiny/svc/dips.py).
import fs from "node:fs";
import path from "node:path";
import * as ort from "../../vendor/onnxruntime-web-1.30.0/ort.wasm.min.mjs";
import { Synth, SR } from "../synth.js";
import { readBin } from "../bin.js";
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmBinary = fs.readFileSync(new URL("../../vendor/onnxruntime-web-1.30.0/ort-wasm-simd-threaded.wasm", import.meta.url));
const [bin, out, tag, ...rest] = process.argv.slice(2);
const models = rest.slice(0, 4), spk = (rest[4] || "1,2,3,4").split(",").map(Number);
const pass = readBin(fs.readFileSync(bin));
fs.mkdirSync(out, { recursive: true });
for (const [i, p] of [..."SATB"].entries()) {
  const session = await ort.InferenceSession.create(fs.readFileSync(models[i] || models[0]), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  const v = pass.voices[i];
  const t0 = performance.now();
  const job = new Synth(ort, session).start({ T: pass.T, voices: [{ speaker: spk[i], ph: v.ph, prog: v.prog, f0: v.f0, part: i }] }, { chunk: Number(process.env.CHUNK || 344) });
  while (await job.next());
  const secs = (performance.now() - t0) / 1000, x = job.out[0];
  const pcm = Buffer.alloc(44 + x.length * 2); pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + x.length * 2, 4); pcm.write("WAVEfmt ", 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(SR, 24); pcm.writeUInt32LE(SR * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(x.length * 2, 40);
  for (let s = 0; s < x.length; s++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[s] * 32767))), 44 + s * 2);
  fs.writeFileSync(path.join(out, `${tag}-${p}.wav`), pcm);
  console.log(`${tag}-${p}: ${(pass.T * 512 / SR).toFixed(1)} s in ${secs.toFixed(1)} s = ${((pass.T * 512 / SR) / secs).toFixed(2)}x real time`);
}
