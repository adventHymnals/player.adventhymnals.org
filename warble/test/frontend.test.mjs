// node web/warble/test/frontend.test.mjs [testvec dir]
// Checks the JS front end against the Python test vectors (RUNTIME.md section 2):
// ph identical, prog within 1e-5, f0 within 0.05 Hz.
import fs from "node:fs";
import path from "node:path";
import { passFrames } from "../frontend.js";
import { readBin, writeBin } from "../bin.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const web = path.resolve(here, "../..");
const dir = process.argv[2] || "/home/i/big/AH/hymn-satb/sing/tiny-work/testvec";
const lex = JSON.parse(fs.readFileSync(path.join(web, "warble/lexicon.json"), "utf8"));
const CASES = [["sdah108-v1-t96", "SDAH/108", 1, 96, 0], ["sdah108-v3-t72-k-2", "SDAH/108", 3, 72, -2],
  ["sdah73-v1-t96", "SDAH/73", 1, 96, 0], ["nzk1-v1-t96", "NZK/1", 1, 96, 0], ["wn15-v1-t96", "WN/15", 1, 96, 0]];


let bad = 0;
for (const [name, file, verse, tempo, k] of CASES) {
  const ref = readBin(fs.readFileSync(path.join(dir, `${name}.bin`)));
  const h = JSON.parse(fs.readFileSync(path.join(web, "data", `${file}.json`), "utf8"));
  const t0 = performance.now();
  const got = passFrames(h, "SATB".split("").filter((x) => h.voices[x]), verse, tempo, k, lex);
  const ms = performance.now() - t0;
  const bytes = writeBin(got), refBytes = fs.readFileSync(path.join(dir, `${name}.bin`));
  const sameBytes = bytes.length === refBytes.length && bytes.every((b, i) => b === refBytes[i]);
  const msgs = [], stats = [];
  if (got.T !== ref.T) msgs.push(`T ${got.T} != ${ref.T}`);
  got.voices.forEach((g, v) => {
    const r = ref.voices[v];
    if (g.speaker !== r.speaker) msgs.push(`${g.voice} speaker`);
    let phd = 0, pr = 0, fd = 0, first = -1;
    for (let t = 0; t < Math.min(got.T, ref.T); t++) {
      if (g.ph[t] !== r.ph[t]) { phd++; if (first < 0) first = t; }
      pr = Math.max(pr, Math.abs(g.prog[t] - r.prog[t]));
      fd = Math.max(fd, Math.abs(g.f0[t] - r.f0[t]));
    }
    stats.push(`${g.voice} f0Δ ${fd.toFixed(4)} progΔ ${pr.toExponential(1)} voiced ${g.f0.filter((x) => x > 0).length}`);
    if (phd || pr > 1e-5 || fd > 0.05) msgs.push(`${g.voice}: ph differs ${phd} (first ${first}), prog ${pr.toExponential(1)}, f0 ${fd.toFixed(3)} Hz`);
  });
  if (!sameBytes) msgs.push("bin bytes differ");
  bad += msgs.length > 0;
  console.log(`${msgs.length ? "FAIL" : "ok  "} ${name} (${got.T} frames, ${ms.toFixed(0)} ms) ${msgs.join("; ")}\n      ${stats.join(" | ")}`);
}
process.exit(bad ? 1 : 0);
