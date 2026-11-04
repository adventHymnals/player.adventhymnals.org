// Warble worker: one model session; sings one voice of one pass per job, reporting progress.
//   in:  {type:"init", bytes: ArrayBuffer (the .onnx), threads}
//        {type:"render", id, T, speaker, ph: Int16Array, prog, f0: Float32Array, chunk}
//        {type:"cancel", id}
//   out: {type:"ready", ms} | {type:"error", id?, message}
//        {type:"progress", id, frames} | {type:"done", id, pcm: Float32Array (transferred), ms}
import * as ort from "../vendor/onnxruntime-web-1.30.0/ort.wasm.min.mjs";
import { Synth } from "./synth.js";

ort.env.wasm.wasmPaths = new URL("../vendor/onnxruntime-web-1.30.0/", import.meta.url).href;
let synth = null;
const cancelled = new Set();
let queue = Promise.resolve();

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "cancel") { cancelled.add(m.id); return; }
  queue = queue.then(() => handle(m)).catch((e) => self.postMessage({ type: "error", id: m.id, message: String(e?.message || e) }));
};

async function handle(m) {
  if (m.type === "init") {
    const t0 = performance.now();
    ort.env.wasm.numThreads = m.threads || 1;
    const session = await ort.InferenceSession.create(new Uint8Array(m.bytes), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    synth = new Synth(ort, session);
    self.postMessage({ type: "ready", ms: performance.now() - t0 });
    return;
  }
  if (m.type !== "render") return;
  if (cancelled.has(m.id)) { cancelled.delete(m.id); return; }
  const t0 = performance.now();
  const job = synth.start({ T: m.T, voices: [{ speaker: m.speaker, ph: m.ph, prog: m.prog, f0: m.f0 }] }, { chunk: m.chunk || 344 });
  while (await job.next()) {
    if (cancelled.has(m.id)) { cancelled.delete(m.id); self.postMessage({ type: "cancelled", id: m.id }); return; }
    self.postMessage({ type: "progress", id: m.id, frames: job.c0 });
  }
  const pcm = job.out[0];
  self.postMessage({ type: "done", id: m.id, pcm, ms: performance.now() - t0 }, [pcm.buffer]);
}
