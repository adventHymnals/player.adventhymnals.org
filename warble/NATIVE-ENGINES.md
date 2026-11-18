# The app's live singing engines: the page ↔ app bridge (agreed 18 Nov 2026)

Status: agreed by the app peer (weaverbird-mvp-monorepo-78) on 18 Nov 2026; the page side is built
(web/warble/warble.js, web/app.js, test web/warble/test/native-engines.test.mjs). The voice peer confirms the
conversion (byte-identical against leap_hymn.py FEEDS) when it builds the engine's C code.
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
- phrases: cut in the middle of pauses of 0.25 s or more (each phrase longer than 1 s). Two layouts inside the
  engine (voice peer, 18 Nov 18:05: cutting a phrase into chunks dulls the tone, the network looks far to each
  side): short chunks only for the phrase where playback starts or lands after a seek (sound within ~1.5 s),
  whole phrases for everything rendered ahead (a 22.7 s phrase, four voices, ~8 s on the G99); the first
  phrase after a start may sound slightly duller than the rest. Nothing of this reaches the page;
- ids 0-2 (`<pad>`, `<SP>`, `<AP>`) become the pause token, every other id `id - 2` (the model's table is
  `pau` then PHONES_V2 without the three specials); the model gets a continuous pitch (log-linear through
  unvoiced gaps, made inside), the vocoder the voicing (f0 > 1 Hz); `prog` is not used; the front end keeps
  splitting long diphthongs (DIPH_SPLIT) for both engines;
- output: 44.1 kHz mono float per voice, on the pass's time base (frames of 512 samples);
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
                "leap":   {"label": "New voice", "ready": true, "tier": "mixed2", "tiers": ["int8", "mixed2", "full"]}}}
   ```
   `ready`: the engine's model file is on the phone and its first-use benchmark passed; before that
   `"ready": false` with `"size"` (bytes to download), which the page shows. An app without `engines` has
   Warble only (the page behaves exactly as today).
   Model files: singing.json's new-voice entry is `{"id": "leap", "engine": "leap", "label": "New voice",
   "files": [{"url", "sha256", "size"}, …], "tiers": [{"tier", "url", "sha256", "size"}, …]}`; after
   `use("leap")` the page calls `model(url, sha256)` once per file (the shared ones, then the tiers) and the app
   fetches the shared files and the tier it picks (the existing model() path). The label is the page's
   (singing.json), not the app's. Files (voice peer, tiers.json in its handoff): shared `nhv_convs.onnx`
   (1,916,539 bytes) and `leap_aux.bin` (545,296); tiers `ac_mixed2.onnx` (34,970,130: the live tier Brian
   chose), `ac_int8.onnx` (28,820,742: slower phones), `ac_full.onnx` (60,174,660: on demand, video).
2. `use(engine)`: `"warble"` or `"leap"`; the engine that the following `load`/`play` go to. Returns
   `{"ok":true}` or `{"ok":false,"error":"…"}` (not ready). Pages that never call it get Warble (as today).
   ONE engine at a time (agreed): `use(x)` stops play, unloads the other engine's passes and model and loads
   x's model (the first use may take a few seconds); both resident is too much memory for a G99. Call it while
   stopped (if playing, the app stops first). The page calls it before loading passes, only when it changes,
   and forgets the passes it had loaded.
3. `engine()` (the phone's saved choice, as today) may also return `"leap"`.
4. Cast: `cast(json)` optional (by name or id), default `{"S":"de_soprano_1","A":"en_alto_2","T":"en_alto_1","B":"it_bass_1"}`
   (ids 0, 3, 2, 9: indexes in the model's 20 sorted singer names; the cast Brian judged on 18 Nov). Not offered
   in the page's settings yet (other singers are untested on hymns);
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

## Test path (no hosted files: 18 Nov 2026, until Brian approves publishing the weights)

The model files are NOT on R2 and the live singing.json has no enabled new-voice entry (the repo copy carries
it disabled). For Brian's comparison on his phone, the app's TEST build puts the files on the phone itself
(adb or bundled) and supplies the voice entry through the bridge:

- `AHNative.warble.voices()` → a JSON list of singing.json voice entries, e.g.
  `[{"id": "leap", "engine": "leap", "label": "New voice (test)", "files": [], "tiers": []}]`.
  The page adds them to the voices it offers (replacing a listed entry with the same id); only entries with
  `"engine": "leap"` are taken. Empty `files`/`tiers`: the page calls no `model()` (the app has the files).
- Or, simpler (the app peer's test build): `available().engines.leap` with `"local": true` (the files carried in
  the APK, copied into the app's files and sha256-checked; `"ready"` once the benchmark picked a tier). The page
  then offers the voice from that alone, by its `label`, with no singing.json entry and no `model()` calls.
- Offered only in a build that has `voices()` or a local `engines.leap`; every other app and the browser
  see nothing new (test: `web/warble/test/native-engines.test.mjs`).
- When Brian approves hosting: the files go to R2 and the entry is enabled with `tools/publish/flip_leap.py`;
  release builds then drop `voices()`.

## Also agreed

- `AHStudio.set('next', id)`: the app sends the playlist's or queue's next hymn whenever it changes (null when
  none); the page engraves that hymn in the background (while idle and stopped) instead of the next in the list.

## Confirmed by the voice peer (18 Nov)

The conversion is in its C library (review/voice/phone/lib/leapvoc.c) and checked on SDAH 100 v1 t96 from a
pass written by the published frontend.js + bin.js: 12 phrases, tokens, durations, phrase starts and voicing
identical to leap_hymn.py, pitch within 0.0007 Hz. Audio is checked by level and spectrum against a
reference (8-bit tiers round differently across devices), not by bytes.

## Earlier open questions (all answered)

1. Voice peer: is the conversion above exactly what the shipping model wants (diphthong rule, pause ids,
   phrase cut, chunk size, context), and the default cast after today's bass runs?
2. (answered: one engine at a time; id "leap"; the label from singing.json.)
