# The app's live singing engines: the page ↔ app bridge (DRAFT, 18 Nov 2026)

Status: draft by the player peer, for the app peer and the voice peer to agree before either builds.
Scope: the Android app gains a second live engine, the new voice (LeapSinger acoustic model + NHVSing
vocoder, native C, by the voice peer), beside Warble. The browser keeps Warble only (no WASM port now).

## Principle: one pass format, each engine converts

The page builds ONE pass per (hymn, tune, verse, tempo, key) with its front end (web/warble/frontend.js:
lexicon, "aa" for an unknown word, the pitch rule, dynamics), exactly as for Warble today, and hands the
same binary to whichever engine sings. The new engine converts it itself, as the voice peer's
`review/voice/leap/leap_hymn.py` does today from the same frames:

- frames: hop 512 at 44.1 kHz (the pass) → hop 256 (each frame repeated twice);
- phonemes: Warble's ids (PHONES_V2) → the new model's tokens (`dict/gts.phonemes`); a split diphthong
  (AA+Y, EH+Y, AO+Y, AA+W, AO+W with the glide part at most 15 frames) is merged back into one (AY, EY, OY,
  AW, OW); ids below 3 are pauses (`pau`);
- pitch: the pass's f0 per frame (Hz, 0 = unvoiced) is used as given (the rule pitch, which Brian
  prefers for the choir); voicing as the pass has it;
- phrases: cut in the middle of pauses of 0.25 s or more; long phrases chunked (about 6 s, with 0.5 s
  context each side, joins cross-faded in phase, `phone/hymnbin.py` / `sing4.c`);
- the cast (which singer sings which part) is the engine's (below); the pass's per-voice speaker field is
  Warble's and is ignored by the new engine.

So nothing about the new voice's internals (tokens, hop, tiers, excitation) reaches the page, and the page
does not change when the model does.

## What `AHNative.warble` gives the page

Existing methods keep their meaning: `available()`, `engine()`, `model(url, sha)`, `cached(sha)`,
`load(key, b64, letters)`, `unload(key)`, `play(json)`, `stop()`, `pos()`, `gains(json)`,
`dynamics(key, json)`, `stats()`, `renderWav(...)`, events through `window.AHWarble.onEvent`.

New:

1. `available()` adds `"engines"`:
   ```json
   {"v":1, "windows":true, "cs":true, "parts":true, "dyn":true,
    "engines": {"warble": {"label": "Live singers", "ready": true},
                "leap":   {"label": "New voice", "ready": true, "tier": "mixed", "tiers": ["int8", "mixed", "full"]}}}
   ```
   `ready`: the engine's files are on the phone and it passed its benchmark. An app without `engines` has
   Warble only (the page behaves exactly as today).
2. `use(engine)`: `"warble"` or `"leap"`; the engine that the following `load`/`play` go to. Returns
   `{"ok":true}` or `{"ok":false,"error":"…"}` (not ready). Pages that never call it get Warble (as today).
   Passes loaded for one engine are its own; switching engines unloads the other's.
3. `engine()` (the phone's saved choice, as today) may also return `"leap"`.
4. Cast: `cast(json)` optional, `{"S":"de_soprano_1","A":"en_alto_2","T":"en_alto_1","B":"it_bass_1"}`;
   an extra part's letter (lower case of its base: `s` Soprano II) takes its base voice's singer with a
   noise/seed of its own (as Warble's parts). Without a call, the engine's own default cast.
5. Tiers are the app's business (benchmark at first use, drop a tier on underrun or heat); `stats()`
   reports the tier in use. Video recording (`renderWav`) always uses the full tier.

## Timing, loudness, mixer: unchanged

- `play({from, segs})`, `pos()`: the page's timeline, as for Warble; each engine starts the audio of a
  pass at its `at`. The new engine's lookahead (chunks rendered ahead, ~3 s lead) is inside it: `play`
  returns at once and the engine reports `started` when sound begins (latency reported in the event).
- `gains(json)`: per letter level and pan (the mixer), eased over ~10 ms, for either engine.
- `dynamics(key, json)` (level 2): the same schedule (pass-relative seconds, linear gain points per
  letter) applied after synthesis, per 64-sample block, for either engine. The new engine needs nothing
  else for loudness.

## The page side (player)

- Settings → Singers / the app's Who sings: the page offers "New voice" when `available().engines.leap.ready`;
  the choice is saved by the app (`engine()`), the page calls `use()` before loading passes.
- Pass keys carry the engine (`leap/…`, `warble/…`), so a switch never reuses the other engine's pass.
- Everything else (front end, lexicon refresh, "aa", dynamics schedules, extra parts, gains) unchanged.
- The browser (no AHNative): Warble only, as today.

## Tests

- Page, stub engine (`web/warble/test/native-engines.test.mjs`): with `engines.leap.ready`, choosing the
  new voice calls `use("leap")` before `load`, with the same pass bytes and letters as for Warble, and
  keys prefixed by the engine; an app without `engines` never calls `use`.
- Engine (voice peer / app peer): for SDAH 100 verse 1 at tempo 96, the page's pass bytes (written by
  `frontend.js` → `bin.js`) converted by the engine's C code give the same tokens, durations and f0 as
  `leap_hymn.py` FEEDS for the same dump (byte-identical), before any audio is compared.

## Open questions

1. Voice peer: is the conversion above exactly what the shipping model wants (diphthong rule, pause ids,
   phrase cut, chunk size, context), and the default cast after today's bass runs?
2. App peer: one AudioTrack mixing whichever engine sings (one engine at a time), or both loaded? Memory:
   Warble's model (~17 MB) and the new voice's tier (29-60 MB) both resident, or unload the other on `use`?
3. Both: the engine id (`leap`?) and the label the page shows ("New voice"?).
