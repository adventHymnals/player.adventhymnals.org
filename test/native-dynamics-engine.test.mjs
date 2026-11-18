// node web/test/native-dynamics-engine.test.mjs
// An app whose engine applies loudness marks itself (AHNative.warble available().dyn, dynamics(key, json)):
// the page sends each pass's schedule once at play (pass-relative seconds, linear between points, a step as
// two points 20 ms apart) and runs no timer; the gains it sends are the mixer's only.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { performance, timeMap, DYNAMIC_LEVEL, phoneDb } from "../core.js";
import { Engine } from "../audio.js";

const web = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const h = JSON.parse(fs.readFileSync(path.join(web, "data/CS1908/1.json"), "utf8")); // p, mp, mf, ff, f, ff
const stems = new Map(["S", "A", "T", "B"].map((k) => [`${k}:1:0`, { offsetSec: -0.3, duration: 200, native: "pass-1" }]));
const perf = performance(h, { tempo: 96, verses: [1], accomp: "off", countIn: false, stems });
const e = new Engine();
e.stemEvents = perf.events.filter((x) => x.stem);
const sched = [], gains = [];
e.native = { available: () => JSON.stringify({ dyn: true }), dynamics: (k, j) => { sched.push([k, JSON.parse(j)]); return "{\"ok\":true}"; },
  play() {}, stop() {}, pos: () => 0, gains: (g) => gains.push(JSON.parse(g)) };
e.playing = true;
e.nativePlay(0);
assert.equal(e.nativeDynTimer, undefined, "no timer: the engine applies the marks");
assert.equal(sched.length, 1);
const [key, s] = sched[0];
assert.equal(key, "pass-1");
assert.equal(s.letters, "SATB");
for (const g of gains) for (const k of "SATB") assert.equal(g[k], 0.8, "gains: the mixer's level only");
// at each mark (a moment after it), the schedule gives that mark's level against the hymn's loudest
const ev = e.stemEvents.find((x) => x.ch === "S");
const passStart = ev.t - (ev.off || 0);
const tm = timeMap(h, 96);
const top = Math.max(...h.voices.S.filter((n) => n.dyn).map((n) => phoneDb(DYNAMIC_LEVEL[n.dyn])));
const at = (pts, t) => { let i = pts.findIndex((p) => p[0] > t); if (i < 0) return pts.at(-1)[1]; if (i === 0) return pts[0][1]; const [a, ga] = pts[i - 1], [b, gb] = pts[i]; return ga + ((gb - ga) * (t - a)) / (b - a); };
const pts = s.points.S;
for (let i = 1; i < pts.length; i++) assert.ok(pts[i][0] >= pts[i - 1][0], "sorted");
// the verse's notes start where the stem's audio is offset from the pass (offsetSec): marks are at the
// timeline time of their note, relative to the pass's first sample
const firstNoteT = e.stemEvents.length && perf.events.filter((x) => x.ch === "S" && !x.stem)[0].t;
const heard = [];
for (const n of h.voices.S.filter((n) => n.dyn)) {
  const tl = firstNoteT + tm.qToT(n.q) - tm.qToT(h.voices.S[0].q);
  const g = at(pts, tl - passStart + 0.05);
  const want = Math.round(10 ** ((phoneDb(DYNAMIC_LEVEL[n.dyn]) - top) / 20) * 1000) / 1000;
  assert.ok(Math.abs(g - want) < 0.002, `${n.dyn}: ${g} (want ${want})`);
  heard.push(`${n.dyn} ${(20 * Math.log10(g)).toFixed(1)} dB`);
}
// an app without the capability: level 1 (the timer), no dynamics() call
const e2 = new Engine();
e2.stemEvents = e.stemEvents;
const s2 = [];
e2.native = { available: () => JSON.stringify({}), dynamics: () => s2.push(1), play() {}, stop() {}, pos: () => 0, gains() {} };
e2.playing = true; e2.nativePlay(0);
assert.equal(s2.length, 0); assert.notEqual(e2.nativeDynTimer, undefined);
e2.nativeStop();
console.log(`ok: one schedule per pass (${pts.length} points for S), ${heard.join(", ")}; older apps: level 1`);
