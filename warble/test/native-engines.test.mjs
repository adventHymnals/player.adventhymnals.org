// node web/warble/test/native-engines.test.mjs
// The app's second live engine (the new voice, "leap"; web/warble/NATIVE-ENGINES.md), page side: offered only in
// an app that announces it; never in the browser; Warble stays the first ("warble"); the new voice's passes are
// the same front end's, keyed by its own id; its readiness and download size come from the app.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const web = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const singing = {
  default: "warble",
  voices: [
    { id: "", label: "Live singers", model: "m/warble.onnx", sha256: "a".repeat(64) },
    { id: "leap", engine: "leap", label: "New voice", files: [{ url: "m/nhv_convs.onnx", sha256: "d".repeat(64), size: 1916539 }], tiers: [{ tier: "int8", url: "m/leap-int8.bin", sha256: "b".repeat(64), size: 28.8e6 }, { tier: "mixed", url: "m/leap-mixed.bin", sha256: "c".repeat(64), size: 40.5e6 }] },
  ],
};
globalThis.location = { href: "https://player.test/index.html" };
globalThis.fetch = async (url, o) => (String(url).endsWith("singing.json") ? { ok: true, json: async () => singing } : { ok: true });
globalThis.indexedDB = undefined;
const { loadSinging, Warble, canSing } = await import("../warble.js");
const avail = (engines) => { globalThis.window = { AHNative: { warble: { available: () => JSON.stringify({ v: 1, windows: true, cs: true, parts: true, dyn: true, ...(engines ? { engines } : {}) }), cached: () => true } } }; };

// the browser: Warble only
globalThis.window = {};
let c = await loadSinging(["https://player.test/data/singing.json"]);
assert.deepEqual(c.voices.map((w) => w.engine), ["warble"]);
// an app without engines (older): Warble only, as today
avail(null);
c = await loadSinging(["https://player.test/data/singing.json"]);
assert.deepEqual(c.voices.map((w) => w.engine), ["warble"]);
// an app with both: Warble first and plain "warble", then the new voice as "leap"
avail({ warble: { label: "Live singers", ready: true }, leap: { label: "New voice", ready: false, size: 40.5e6 } });
c = await loadSinging(["https://player.test/data/singing.json"]);
assert.deepEqual(c.voices.map((w) => w.engine), ["warble", "leap"]);
const leap = c.voices[1];
assert.equal(leap.nativeEngine, "leap");
// the name on screen is the page's ("Singers v6"), whatever label singing.json or the app gives
assert.equal(leap.label, "Singers v6");
assert.deepEqual(leap.tiers.map((t) => t.url), ["https://player.test/data/m/leap-int8.bin", "https://player.test/data/m/leap-mixed.bin"]);
assert.deepEqual(leap.files.map((t) => t.url), ["https://player.test/data/m/nhv_convs.onnx"]);
assert.equal(await leap.saved(), false, "not ready until the app says so");
avail({ warble: { ready: true }, leap: { ready: true, tier: "mixed" } });
assert.equal(await leap.saved(), true);
// its passes: the same front end, keyed by its id (never mixed up with Warble's)
const h = JSON.parse(fs.readFileSync(path.join(web, "data/SDAH/108.json"), "utf8"));
const lex = JSON.parse(fs.readFileSync(path.join(web, "warble/lexicon.json"), "utf8"));
leap.lex = Promise.resolve(lex); c.voices[0].lex = Promise.resolve(lex);
assert.match(leap.passKey(h, 1, 96, 0), /^leap\/SDAH-108:/);
assert.match(c.voices[0].passKey(h, 1, 96, 0), /^SDAH-108:/);
const a = await c.voices[0].features(h, 1, 96, 0), b = await leap.features(h, 1, 96, 0);
assert.deepEqual(Buffer.from(Warble.bin(b)), Buffer.from(Warble.bin(a)), "the same pass bytes for either engine");
assert.equal(b.letters, a.letters);
assert.equal(canSing({ engine: "leap" }), true);
globalThis.window = {};
assert.equal(canSing({ engine: "leap" }), false, "never in the browser");
// a test build's own entry (AHNative.warble.voices()), with the hosted one disabled (as live): offered, no files to fetch
singing.voices[1].enabled = false;
const own = { id: "leap", engine: "leap", label: "New voice (test)", files: [], tiers: [] };
globalThis.window = { AHNative: { warble: { available: () => JSON.stringify({ v: 1, cs: true, dyn: true, parts: true, engines: { warble: { ready: true }, leap: { ready: true, tier: "mixed2" } } }), cached: () => true, voices: () => JSON.stringify([own]) } } };
c = await loadSinging(["https://player.test/data/singing.json"]);
assert.deepEqual(c.voices.map((w) => `${w.engine}:${w.label}`), ["warble:Live singers", "leap:Singers v6"]);
assert.deepEqual([...c.voices[1].files, ...c.voices[1].tiers], []);
// the same hosted-but-disabled list in an app without voices(): nothing new
avail({ warble: { ready: true }, leap: { ready: true } });
c = await loadSinging(["https://player.test/data/singing.json"]);
assert.deepEqual(c.voices.map((w) => w.engine), ["warble"]);
// a test build that only announces the engine as local (its files in the APK): offered by its label, nothing fetched
avail({ warble: { ready: true }, leap: { label: "New voice", ready: true, tier: "mixed2", tiers: ["mixed2", "int8"], local: true } });
c = await loadSinging(["https://player.test/data/singing.json"]);
assert.deepEqual(c.voices.map((w) => `${w.engine}:${w.label}`), ["warble:Live singers", "leap:Singers v6"]);
assert.deepEqual([...c.voices[1].files, ...c.voices[1].tiers], []);
console.log("ok: offered only where the app has it; Warble first; same pass bytes, keyed leap/…; readiness from the app; a test build's own entry; a local engine");
