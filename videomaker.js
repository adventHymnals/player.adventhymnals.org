// Videos made ahead of time instead of filmed live: every frame is drawn at its exact moment and encoded,
// and the sound is rendered offline, so a busy or slow browser cannot make the video stutter.
// Several takes (the choir, then each voice) share the frames after the introduction: only the
// introduction looks different per take, so the rest is drawn and encoded once.
import { Muxer, ArrayBufferTarget } from "./vendor/mp4-muxer-5.1.3.mjs";

export const FPS = 30;
const SAMPLE_RATE = 48000;
const breathe = () => new Promise((r) => setTimeout(r, 0));

export const canMakeVideo = () => typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined"
  && typeof OfflineAudioContext !== "undefined";

async function videoCodec(width, height) {
  // H.264 first (plays everywhere), VP9 when the browser cannot encode H.264
  for (const [codec, mux] of [["avc1.640028", "avc"], ["avc1.4d0028", "avc"], ["avc1.42e028", "avc"], ["vp09.00.40.08", "vp9"]]) {
    const cfg = { codec, width, height, bitrate: 8_000_000, framerate: FPS, ...(mux === "avc" ? { avc: { format: "avc" } } : {}) };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return { cfg, mux }; } catch { /* not this one */ }
  }
  throw new Error("This browser cannot encode video.");
}

async function audioCodec() {
  for (const [codec, mux] of [["mp4a.40.2", "aac"], ["opus", "opus"]]) {
    const cfg = { codec, sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 192_000 };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, mux }; } catch { /* not this one */ }
  }
  throw new Error("This browser cannot encode audio.");
}

/** Encode frames [from, to); draw(i) paints frame i on the canvas. */
async function encodeFrames(canvas, vc, from, to, draw, progress) {
  const chunks = [];
  let failed = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => chunks.push({ chunk, meta }), error: (e) => { failed = e; } });
  enc.configure(vc.cfg);
  for (let i = from; i < to; i++) {
    if (failed) throw failed;
    draw(i);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(frame, { keyFrame: (i - from) % (FPS * 2) === 0 });
    frame.close();
    while (enc.encodeQueueSize > 6) await breathe();
    if (i % 10 === 0) { progress(i); await breathe(); }
  }
  await enc.flush();
  enc.close();
  if (failed) throw failed;
  return chunks;
}

async function encodeAudio(buf, ac) {
  const chunks = [];
  let failed = null;
  const enc = new AudioEncoder({ output: (chunk, meta) => chunks.push({ chunk, meta }), error: (e) => { failed = e; } });
  enc.configure(ac.cfg);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0);
  const block = 4800;
  for (let i = 0; i < buf.length; i += block) {
    const m = Math.min(block, buf.length - i);
    const data = new Float32Array(m * 2);
    data.set(L.subarray(i, i + m), 0);
    data.set(R.subarray(i, i + m), m);
    const ad = new AudioData({ format: "f32-planar", sampleRate: buf.sampleRate, numberOfFrames: m, numberOfChannels: 2, timestamp: Math.round((i * 1e6) / buf.sampleRate), data });
    enc.encode(ad);
    ad.close();
    if (enc.encodeQueueSize > 20) await breathe();
  }
  await enc.flush();
  enc.close();
  if (failed) throw failed;
  return chunks;
}

function mux(vc, ac, video, audio) {
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: vc.mux, width: vc.cfg.width, height: vc.cfg.height, frameRate: FPS },
    audio: { codec: ac.mux, numberOfChannels: 2, sampleRate: SAMPLE_RATE },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  for (const { chunk, meta } of video) muxer.addVideoChunk(chunk, meta);
  for (const { chunk, meta } of audio) muxer.addAudioChunk(chunk, meta);
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: "video/mp4" });
}

const sameBytes = (a, b) => {
  if (!a || !b) return a === b;
  const x = new Uint8Array(a.buffer ?? a, a.byteOffset ?? 0, a.byteLength);
  const y = new Uint8Array(b.buffer ?? b, b.byteOffset ?? 0, b.byteLength);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * Make one video per take.
 * takes: [{ name, setup(): Promise<{ total, splitT }>, drawAt(t), audio(): Promise<AudioBuffer> }]
 *   setup() readies the take and returns its length and the time where its frames stop differing from the
 *   other takes (the end of the introduction); every take must share the frames from splitT on.
 * onVideo(name, blob, audioCodec) for each finished take; progress(text) while working.
 */
export async function makeVideos(canvas, takes, { onVideo, progress }) {
  const vc = await videoCodec(canvas.width, canvas.height);
  const ac = await audioCodec();
  let shared = null; // { from, chunks } of the frames after the introduction
  for (const [n, take] of takes.entries()) {
    const label = takes.length > 1 ? `${take.name} (${n + 1} of ${takes.length})` : take.name;
    const { total, splitT } = await take.setup();
    const frames = Math.ceil(total * FPS);
    const split = Math.min(frames, Math.max(0, Math.round(splitT * FPS)));
    const say = (what) => (i) => progress(`Making the ${label} video: ${what} ${Math.round((100 * i) / frames)}%`);
    progress(`Making the ${label} video: the sound…`);
    const audio = await encodeAudio(await take.audio(), ac);
    const draw = (i) => take.drawAt(i / FPS);
    let video;
    const intro = split > 0 ? await encodeFrames(canvas, vc, 0, split, draw, say("pictures")) : [];
    if (!shared || shared.from !== split || shared.frames !== frames) {
      // the frames after the introduction follow on from the ones just drawn (the drawing keeps a little state)
      shared = { from: split, frames, chunks: await encodeFrames(canvas, vc, split, frames, draw, say("pictures")) };
    }
    const spliceable = !intro.length || sameBytes(intro[0].meta?.decoderConfig?.description, shared.chunks[0]?.meta?.decoderConfig?.description);
    if (spliceable) video = [...intro, ...shared.chunks];
    else video = await encodeFrames(canvas, vc, 0, frames, draw, say("pictures")); // encoders disagreed: this take whole
    progress(`Making the ${label} video: putting it together…`);
    await breathe();
    await onVideo(take.name, mux(vc, ac, video, audio), ac.mux);
  }
}
