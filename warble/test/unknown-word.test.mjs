// node web/warble/test/unknown-word.test.mjs
// A word with no pronunciation is sung on "aa" over its notes; the rest of the verse is sung as written
// (Brian, 18 Nov 2026: one unknown word never stops the verse). The made-up words are not in the lexicon.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { sungNotes, passFrames, unsung } from "../frontend.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const web = path.resolve(here, "../..");
const lex = JSON.parse(fs.readFileSync(path.join(web, "warble/lexicon.json"), "utf8"));
const h = JSON.parse(fs.readFileSync(path.join(web, "data/SDAH/108.json"), "utf8"));
const FAKE = ["zorblaxquin", "vrimtok"];
for (const w of FAKE) assert.ok(!(w in lex), `${w} must really be absent from the lexicon`);

const known = sungNotes(h, "S", 1, 96, 0, lex).notes;
// verse 1, its first word (three syllables) and a later one-syllable word made up
const v = h.verses[0].map((s) => (s ? { ...s } : s));
const multi = v.findIndex((s, i) => s?.s === "begin" && v[i + 1]?.s === "middle" && v[i + 2]?.s === "end");
const single = v.findIndex((s, i) => i > multi + 2 && s?.s === "single");
assert.ok(multi >= 0 && single > 0);
v[multi].t = "Zor"; v[multi + 1].t = "blax"; v[multi + 2].t = "quin"; v[single].t = "vrimtok,";
const fake = { ...h, verses: [v, ...h.verses.slice(1)] };

const got = sungNotes(fake, "S", 1, 96, 0, lex).notes; // must not throw
assert.equal(got.length, known.length, "every note still sung");
// which sung notes carry the made-up words: map notes back through the lyric voice by onset order
const lyric = h.voices[h.lyricVoice];
const start = (k) => lyric.findIndex((_, i) => i >= k);
const fakeNotes = new Set([start(multi), start(multi + 1), start(multi + 2), start(single)]);
let open = 0, same = 0;
got.forEach((n, i) => {
  if (fakeNotes.has(i)) {
    assert.ok(n.syllable, `note ${i} sung`);
    assert.equal(n.syllable.nucleus, "A"); assert.deepEqual(n.syllable.onset, []); assert.deepEqual(n.syllable.coda, []);
    open++;
  } else if (JSON.stringify(n.syllable) === JSON.stringify(known[i].syllable)) same++;
});
assert.equal(open, 4, "the made-up words' notes are sung on aa");
assert.ok(same >= got.length - 8, `the rest of the verse is sung as before (${same}/${got.length})`);
assert.deepEqual([...unsung].sort(), [...FAKE].sort());
// and the whole pass (all four voices) is made without an error
const pass = passFrames(fake, ["S", "A", "T", "B"], 1, 96, 0, lex);
assert.ok(pass.T > 0);
console.log(`ok: ${open} notes on aa, ${same}/${got.length} notes as before, unsung: ${[...unsung].length} words`);
