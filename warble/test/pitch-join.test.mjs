// node web/warble/test/pitch-join.test.mjs
// Where a vowel follows the last one with no consonant between ("see I"), the pitch holds the old note to the
// boundary and then glides to the new one, never back: the hold into the coda used to land after the next
// vowel's start and pull the pitch back to the old note for 30 ms (a "scratch", SDAH 100 "shadow of", 18 Nov 2026).
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { passFrames, sungNotes } from "../frontend.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const web = path.resolve(here, "../..");
const lex = JSON.parse(fs.readFileSync(path.join(web, "warble/lexicon.json"), "utf8"));
const OLD = process.env.OLD_FRONTEND; // optional: the old front end must fail the same check
const fe = OLD ? await import(OLD) : { passFrames };
const FRAME = 512 / 44100;
const cents = (a, b) => 1200 * Math.log2(a / b);
const hz = (m) => 440 * 2 ** ((m - 69) / 12);

/** From 50 ms before the boundary t to 150 ms after it, the pitch only comes closer to the new note: its
 *  distance from it never grows by more than 50 cents (vibrato and drift stay well under that). */
function noReturn(f0, t, from, to) {
  if (from === to) return true;
  const i0 = Math.round((t - 0.05) / FRAME), i1 = Math.round((t + 0.15) / FRAME);
  let best = Infinity;
  for (let i = i0; i <= i1; i++) {
    if (!f0[i]) continue;
    const d = Math.abs(cents(f0[i], hz(to)));
    if (d > best + 50) return false;
    best = Math.min(best, d);
  }
  return true;
}

// a made-up hymn: syllables that end and begin on a vowel, on notes going up, down, the same, and across a rest
function hymn(pairs) {
  const S = [], verse = [];
  let q = 0;
  for (const [m1, m2, rest] of pairs) {
    S.push({ q, d: 2, p: m1, m: 1, f: false }); verse.push({ t: "see", s: "single" }); q += 2;
    if (rest) q += 1;
    S.push({ q, d: 2, p: m2, m: 1, f: false }); verse.push({ t: "I", s: "single" }); q += 2;
    q += 1; // a rest between the pairs
  }
  return { id: "TEST-1", lyricVoice: "S", voices: { S }, verses: [verse], refrain: [], totalQ: q, measureQ: 4, measures: Math.ceil(q / 4), tempo: 96 };
}
const cases = [["down", 62, 57, false], ["up", 57, 62, false], ["same", 60, 60, false], ["across a rest", 62, 57, true]];
const h = hymn(cases.map(([, a, b, r]) => [a, b, r]));
const f0 = fe.passFrames(h, ["S"], 1, 96, 0, lex).voices[0].f0;
const sung = sungNotes(h, "S", 1, 96, 0, lex).notes; // where each note sounds (the same in old and new)
const bad = [];
cases.forEach(([name, a, b], i) => { if (!noReturn(f0, sung[2 * i + 1].t, a, b)) bad.push(name); });
// the real places the voice peer measured: SDAH 100 verse 1, tempo 96
const h100 = JSON.parse(fs.readFileSync(path.join(web, "data/SDAH/100.json"), "utf8"));
const p100 = fe.passFrames(h100, ["S", "A", "T", "B"], 1, 96, 0, lex);
for (const [v, t, from, to] of [["S", 10.925, 66, 65], ["A", 10.925, 60, 61], ["B", 10.925, 51, 49], ["S", 26.55, 68, 65], ["A", 26.55, 65, 61], ["T", 26.55, 61, 56]]) {
  const f = p100.voices.find((x) => x.voice === v).f0;
  if (!noReturn(f, t, from, to)) bad.push(`SDAH-100 ${v} ${t}s ${from}->${to}`);
}
if (OLD) { console.log(`old front end: ${bad.length} places go back: ${bad.join(", ")}`); process.exit(0); }
assert.deepEqual(bad, [], "the pitch goes back to the old note");
console.log("ok: down, up, same note, across a rest, and SDAH 100's six places glide once, never back");
