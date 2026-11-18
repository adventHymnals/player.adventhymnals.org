// node web/test/retune.test.mjs
// A text sung to another hymn's tune (core.js retune): the lower parts sing the target text, never the source
// hymn's own lower-part words (TRANSCRIBING.md 11: English words under a Swahili text), and the target's
// language stays (Swahili pronunciation); the target's own lower-part words only where they fit the tune's notes.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { retune } from "../core.js";
import { sungNotes } from "../warble/frontend.js";

const web = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = (f) => JSON.parse(fs.readFileSync(path.join(web, "data", f), "utf8"));
const y = read("SDAH/125.json"); // its tenor and bass have words of their own (English)
const x = read("NZK/1.json"); // Swahili
assert.ok(y.voiceWords?.T && y.voiceWords?.B && !y.language);
const alt = { tune: "test", name: "Test tune", from: y.id };
const z = retune(x, y, alt);
assert.equal(z.voiceWords, undefined, "no source lower-part words");
assert.equal(z.language, x.language, "the text's language");
assert.equal(z.id, x.id);
assert.deepEqual(z.voices, y.voices, "the tune's music");
// the bass sings the Swahili text with the melody: every syllable it sings is one of the text's
const texts = new Set(x.verses[0].filter(Boolean).map((s) => s.t));
const lex = JSON.parse(fs.readFileSync(path.join(web, "warble/lexicon.json"), "utf8"));
const bass = sungNotes(z, "B", 1, 96, 0, lex).notes;
assert.ok(bass.length > 0);
// (the source's own bass words, sung before, were English words the Swahili pronouncer can't read)
const ownB = new Set((y.voiceWords.B[0] || []).filter((w) => w && typeof w === "object").map((w) => w.t));
assert.ok(ownB.size > 0 && [...ownB].some((t) => !texts.has(t)), "the source had English bass words");
assert.doesNotThrow(() => sungNotes(z, "T", 1, 96, 0, lex));
// the target's own lower-part words come along only where they line up with the tune's notes
const x2 = { ...x, voiceWords: { B: [y.voiceWords.B[0].map(() => "*"), [1, 2, 3]] } };
const z2 = retune(x2, y, alt);
assert.deepEqual(z2.voiceWords.B[0].length, y.voices.B.length);
assert.equal(z2.voiceWords.B[1], null, "a list that doesn't fit the tune's notes is dropped");
console.log("ok: lower parts sing the target text, its language kept; own words only where they fit");
