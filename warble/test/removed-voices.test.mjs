// node web/warble/test/removed-voices.test.mjs
// Weaver v1/v1f ("leap") and Warble v4 ("v7") were removed on 27 Nov 2026 (Brian: every voice must be ours; they
// used LeapSinger and NHVSing). Whatever an older singing.json or an older app (Weaver in it) announces, the page
// never offers them: not from singing.json, not from the app's own voices(), not from its engines.
import path from "node:path";
import assert from "node:assert/strict";

const singing = {
  default: "warble",
  voices: [
    { id: "v3", label: "Live singers", model: "m/warble.onnx", sha256: "a".repeat(64) },
    { id: "v2", label: "Live singers v2", model: "m/warble2.onnx", sha256: "e".repeat(64) },
    // as the live singing.json still lists it until a new one is published
    { id: "leap", engine: "leap", label: "New voice", files: [{ url: "m/nhv_convs.onnx", sha256: "d".repeat(64), size: 1916539 }], tiers: [{ tier: "int8", url: "m/ac_int8.onnx", sha256: "b".repeat(64), size: 28.8e6 }], enabled: true },
  ],
};
globalThis.location = { href: "https://player.test/index.html" };
globalThis.fetch = async (url) => (String(url).endsWith("singing.json") ? { ok: true, json: async () => singing } : { ok: true });
globalThis.indexedDB = undefined;
const { loadSinging, canSing } = await import("../warble.js");
const { REMOVED, SINGERS, CREDITS, SECTIONS } = await import("../../singers-copy.js");
const url = ["https://player.test/data/singing.json"];

// the browser
globalThis.window = {};
let c = await loadSinging(url);
assert.deepEqual(c.voices.map((w) => w.engine), ["warble", "warble-v2"]);
// an older app with Weaver: its engines and its own entries (Weaver, Warble v4 "app:v7") are ignored
globalThis.window = { AHNative: { warble: {
  available: () => JSON.stringify({ v: 1, windows: true, cs: true, parts: true, dyn: true, engines: { warble: { ready: true }, leap: { ready: true, local: true, tier: "mixed2" } } }),
  voices: () => JSON.stringify([{ id: "leap", engine: "leap", label: "Weaver v1", files: [], tiers: [] }, { id: "v7", engine: "warble", model: "app:v7", sha256: "f".repeat(64), requires: "cs" }]),
  cached: () => true,
} } };
c = await loadSinging(url);
assert.deepEqual(c.voices.map((w) => w.engine), ["warble", "warble-v2"]);
assert.equal(canSing({ engine: "leap" }), false);
assert.equal(canSing({ id: "v7", engine: "warble", model: "app:v7" }), false);
// the names, sections and credits: nothing of them left
assert.ok(!("leap" in SINGERS) && !("v7" in SINGERS));
assert.ok(!("leap" in CREDITS) && !("v7" in CREDITS));
assert.deepEqual(SECTIONS.map((s) => s.group), ["warble", "recorded"]);
assert.ok(["leap", "leap-full", "warble-v7"].every((e) => REMOVED.engines.has(e)));
const words = JSON.stringify({ SINGERS, CREDITS, SECTIONS });
assert.ok(!/LeapSinger|NHVSing|wavtechyukky|Weaver/.test(words), "no credit or name of them");
console.log("ok: Weaver and Warble v4 never offered (singing.json, an older app's engines and own voices); no name or credit left");
