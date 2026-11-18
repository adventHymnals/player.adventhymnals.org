// node web/warble/test/lexicon-refresh.test.mjs
// A hymn newer than the Studio's lexicon (a word added with the hymn): the singer fetches the published
// lexicon once and sings the word as written; a word missing there too is sung on "aa"; one fetch per 10 min.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { Warble } from "../warble.js";
import { unsung } from "../frontend.js";

const web = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const full = JSON.parse(fs.readFileSync(path.join(web, "warble/lexicon.json"), "utf8"));
const h = JSON.parse(fs.readFileSync(path.join(web, "data/SDAH/108.json"), "utf8"));
// the first one-syllable word of verse 1 that the lexicon has: left out of the "bundled" copy
const s = h.verses[0].find((x) => x?.s === "single" && full[x.t.toLowerCase().replace(/[^a-z']/g, "")]);
const word = s.t.toLowerCase().replace(/[^a-z']/g, "");
const old = { ...full }; delete old[word];

let fetches = 0;
globalThis.fetch = async (url) => { fetches++; assert.match(String(url), /^https:\/\/example\.test\/warble\/lexicon\.json\?t=\d+$/); return { ok: true, json: async () => full }; };
Warble.lexiconUrl = "https://example.test/warble/lexicon.json";
const w = new Warble({ model: "m.onnx" }, "https://example.test/");
w.lex = Promise.resolve(old);

const pass = await w.features(h, 1, 96, 0);
assert.equal(fetches, 1, "the published lexicon fetched once");
assert.equal(unsung.size, 0, "the word was found there and sung as written");
const ref = Object.assign(new Warble({ model: "m.onnx" }, "https://example.test/"), { lex: Promise.resolve(full) });
const want = await ref.features(h, 1, 96, 0);
const flat = (x) => JSON.stringify(x, (_, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
assert.equal(flat(pass), flat(want), "the same pass as with the full lexicon");

// a word missing everywhere: no second fetch within 10 minutes, sung on "aa"
const v = h.verses[0].map((x) => (x ? { ...x } : x));
v[v.indexOf(v.find((x) => x?.s === "single"))].t = "zorvex";
await w.features({ ...h, verses: [v, ...h.verses.slice(1)] }, 1, 96, 0);
assert.equal(fetches, 1, "at most one fetch every 10 minutes");
assert.deepEqual([...unsung], ["zorvex"]);
console.log(`ok: one fetch, the missing word sung as written; a word missing everywhere on "aa"`);
