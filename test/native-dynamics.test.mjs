// node web/test/native-dynamics.test.mjs
// The app's own live singer (AHNative.warble) sings each voice at one gain: the page moves those gains with
// the score's dynamics as the singing goes (audio.js nativeLevels / nativeGains), in steps of about 3 dB
// (core.js singGain), the loudest mark of the hymn at the level used before (the phone has no limiter).
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { performance, timeMap, DYNAMIC_LEVEL, singGain, phoneDb } from "../core.js";
import { Engine } from "../audio.js";

const web = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const h = JSON.parse(fs.readFileSync(path.join(web, "data/CS1908/1.json"), "utf8")); // p, mp, mf, ff, f, ff
// every voice sung by the app (a "native" pass), as on the phone
const stems = new Map(["S", "A", "T", "B"].map((k) => [`${k}:1:0`, { offsetSec: 0, duration: 200, native: "pass-1" }]));
const perf = performance(h, { tempo: 96, verses: [1], accomp: "off", countIn: false, stems });
const events = perf.events || perf.evs || perf;
const e = new Engine();
e.stemEvents = (Array.isArray(events) ? events : []).filter((x) => x.stem);
assert.ok(e.stemEvents.length >= 4 && e.stemEvents.every((x) => x.native && x.env?.length), "every voice a native pass with its envelope");

const sent = [];
let pos = 0;
e.native = { play() {}, stop() {}, pos: () => pos, gains: (g) => sent.push(JSON.parse(g)) };
e.playing = true;
e.nativePlay(0);
clearInterval(e.nativeDynTimer); // the test moves the clock by hand
const t0 = e.stemEvents[0].t;
const tm = timeMap(h, 96);
const marks = h.voices.S.filter((n) => n.dyn).map((n) => ({ dyn: n.dyn, t: t0 + tm.qToT(n.q) + 0.1 }));
const top = Math.max(...marks.map((m) => phoneDb(DYNAMIC_LEVEL[m.dyn])));
const heard = [];
for (const m of marks) {
  pos = m.t;
  e.nativeLevels(pos); e.nativeGains();
  const g = sent.at(-1);
  for (const k of ["S", "A", "T", "B"]) assert.equal(g[k], Math.round(0.8 * Math.round(10 ** ((phoneDb(DYNAMIC_LEVEL[m.dyn]) - top) / 20) * 1000) / 1000 * 1000) / 1000, `${k} at ${m.dyn}`);
  heard.push(`${m.dyn} ${(20 * Math.log10(g.S / 0.8)).toFixed(1)} dB`);
}
assert.ok(Math.max(...sent.map((g) => g.S)) <= 0.8 + 1e-9, "never louder than the level used before");
// p is 3 dB under mp, mp 3 dB under mf
const db = (k) => 20 * Math.log10(singGain(DYNAMIC_LEVEL[k]));
assert.ok(Math.abs(db("mp") - db("p") - 3) < 0.1 && Math.abs(db("mf") - db("mp") - 3) < 0.1);
// gains are sent only where a level changes: a handful per verse, timed from the timeline (no polling)
const changes = e.nativeChanges();
assert.ok(changes.length > 0 && changes.length <= 8 * e.stemEvents.filter((x) => x.ch === "S").length, `few changes (${changes.length})`);
// the phone's steps: about 5 dB a mark (p 5 dB under mp, mp 5 under mf)
assert.ok(Math.abs(phoneDb(DYNAMIC_LEVEL.mp) - phoneDb(DYNAMIC_LEVEL.p) - 5) < 0.1 && Math.abs(phoneDb(DYNAMIC_LEVEL.mf) - phoneDb(DYNAMIC_LEVEL.mp) - 5) < 0.1);
e.nativeStop();
// a hymn with one mark only sings at the level used before
const one = JSON.parse(JSON.stringify(h));
for (const k of Object.keys(one.voices)) one.voices[k].forEach((n, i) => { if (n.dyn) n.dyn = i === 0 ? "p" : undefined; });
const e1 = new Engine();
e1.stemEvents = (performance(one, { tempo: 96, verses: [1], accomp: "off", countIn: false, stems }).events).filter((x) => x.stem);
const sent1 = [];
e1.native = { play() {}, stop() {}, pos: () => pos, gains: (g) => sent1.push(JSON.parse(g)) };
e1.playing = true; e1.nativePlay(0); clearInterval(e1.nativeDynTimer);
pos = marks[2].t; e1.nativeLevels(pos); e1.nativeGains(true);
assert.equal(sent1.at(-1).S, 0.8, "one mark: the normal level");
e1.nativeStop();
console.log("ok:", heard.join(", "), "; one mark only: normal level");
