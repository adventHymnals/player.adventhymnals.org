// node web/test/parts.test.mjs
// Parts beyond S/A/T/B (Messiah No. 33's Soprano II; later a second choir): hymnjson.py reads a sopranoTwo block
// into voices.S2 with parts.S2 = {base, name}; the player orders the parts (S, S2, A, T, B), puts S2 on the
// sopranos' staff and clef, names and colours it as a soprano; the live singer sings it with the soprano
// singer on a noise part of its own (S A T B 0-3, others 4+, as the app's engine), letter "s" for the app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { partsOf, partLetters, noiseParts, registerParts, VOICES, baseOf, clefFor, trackName, buildMusicXML } from "../core.js";
import { passFrames } from "../warble/frontend.js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const ly = fs.readFileSync(path.join(root, "hymns/SDAH/108.ly"), "utf8");
const sop = /^soprano\s*=\s*\{[\s\S]*?^\}/m.exec(ly)[0];
const fixture = ly.replace(sop, `${sop}\n${sop.replace(/^soprano/, "sopranoTwo")}\nsopranoTwoName = "Soprano II"\n`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parts-"));
const f = path.join(dir, "108.ly");
fs.writeFileSync(f, fixture);
const out = execFileSync("python3", [path.join(root, "hymnjson.py"), f], { encoding: "utf8" });
const h = JSON.parse(out.split("\n").find((l) => l.startsWith("{\"id\"")));
fs.rmSync(dir, { recursive: true });

assert.deepEqual(h.parts, { S2: { base: "S", name: "Soprano II" } });
assert.equal(h.voices.S2.length, h.voices.S.length);
assert.deepEqual(partsOf(h), ["S", "S2", "A", "T", "B"]);
assert.deepEqual(partLetters(partsOf(h), h), ["S", "s", "A", "T", "B"]);
assert.deepEqual(noiseParts("SsATB"), [0, 4, 1, 2, 3]);
registerParts(h);
assert.equal(VOICES.S2.name, "Soprano II");
assert.equal(baseOf("S2"), "S");
assert.deepEqual(clefFor(["S2"]), ["G", 2, 0]);
assert.equal(trackName(["S", "S2"]), "Soprano and Soprano II");
// on the sopranos' staff: the MusicXML has both voices in that part
const xml = buildMusicXML(h, { tracks: [["S", "S2"], ["A"], ["T"], ["B"]], trackWords: [true, true, true, true], words: "all", verse: 1 });
assert.match(xml, /Soprano and Soprano II/);
// the live singer: five voices, S2 with the soprano singer, noise part 4
const lex = JSON.parse(fs.readFileSync(path.join(root, "web/warble/lexicon.json"), "utf8"));
const pass = passFrames(h, partsOf(h), 1, 96, 0, lex);
assert.deepEqual(pass.voices.map((v) => [v.voice, v.part]), [["S", 0], ["S2", 4], ["A", 1], ["T", 2], ["B", 3]]);
assert.equal(pass.voices[1].speaker, pass.voices[0].speaker);
// a hymn without parts: as before
const plain = JSON.parse(fs.readFileSync(path.join(root, "web/data/SDAH/108.json"), "utf8"));
registerParts(plain);
assert.deepEqual(partsOf(plain), ["S", "A", "T", "B"]);
assert.equal(VOICES.S2, undefined);
console.log("ok: S2 read, ordered S S2 A T B, on the soprano staff and clef, sung as a soprano on part 4 (letter s)");
