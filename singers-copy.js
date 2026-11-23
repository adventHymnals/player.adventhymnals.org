// The singing choices' names and the messages about them, in one place. Brian, 19 Nov 2026: three sections, in
// this order: Warble (the Warble voices, live on the phone), Weaver (the live voice that is not Warble) and Recorded,
// each numbered from v1. Old -> new: v1 = Recorded v1, v2 = Warble v1, v3 = Warble v2, v4 = Recorded v2,
// v5 = Warble v3, v6 = Weaver v1 (v6 at full quality, the app's, = Weaver v1f), v7 = Warble v4. The ids never change.
// chip: the name inside its section ("v3"); short: the name everywhere else, never cut ("Warble v3"); label: for
// sentences and screen readers (the same); group: the section; n: the order in the pickers (section, then number);
// line: the one detail line under the picker.
// Keyed by singing.json voice id (the phone models) or the recorded engine. The page's own table wins over a
// singing.json label, so the names are the same whatever copy of singing.json a device holds.
// Wording: ChatGPT, Round 5 (19 Nov) and Round 7 (20 Nov: Weaver downloads once, Warble v3/v4 inside the app, Recorded
// is computer-made singing; the app's copy-proposal.md).
const entry = (group, name, k, n, line) => ({ group, chip: `v${k}`, short: `${name} v${k}`, label: `${name} v${k}`, n, line });
export const SECTIONS = [
  { group: "warble", name: "Warble", live: true,
    // in the app (v3 and v4 inside it); a browser fetches the voice once, so only the first two sentences hold there
    info: "Warble sings live on your phone as the hymn plays. It can sing any hymn, in any key or at any speed. v3 and v4 are ready to use, even without internet. Earlier versions download once when first chosen. v4 has clearer, steadier high notes.", webInfo: "Warble sings live on your phone as the hymn plays. It can sing any hymn, in any key or at any speed." },
  { group: "weaver", name: "Weaver", live: true, info: "Weaver sings live on your phone, with fuller, more natural voices. It can sing any hymn, in any key or at any speed. It needs a stronger phone and may not work on some phones. Weaver v1 downloads once (64 MB), then takes a few minutes to get ready. Weaver v1f gives the best sound and is an optional extra download (60 MB)." },
  { group: "recorded", name: "Recorded", live: false, info: "These are computer-made singing voices, recorded in advance for some hymns. Recorded v2 uses the same recordings, made to sound like different singers. Each hymn's recording downloads the first time you play it and stays on your phone for listening without internet. Downloads average 6 MB per hymn (usually 3–9 MB). The key and tune cannot be changed." },
];
export const SINGERS = {
  v1: entry("warble", "Warble", 1, 11, "Earlier version; sings any hymn"),
  v2: entry("warble", "Warble", 2, 12, "Earlier version; sings any hymn"),
  v3: entry("warble", "Warble", 3, 13, "Usual choice; any hymn, key or speed"),
  // a test build's own voice (the app's voices(), 19 Nov): Warble's network with the app's own singing of it
  v7: entry("warble", "Warble", 4, 14, "Newest; clearer, steadier high notes"),
  // the main live voice (23 Nov 2026; line: ChatGPT with the copy rules, 23 Nov)
  v5: entry("warble", "Warble", 5, 15, "Main voice; more natural, distinct voices"),
  leap: entry("weaver", "Weaver", 1, 21, "Fuller voices; needs a stronger phone"),
  stems: entry("recorded", "Recorded", 1, 31, "Computer-made singing; available for some hymns"),
  "stems-v2": entry("recorded", "Recorded", 2, 32, "Same recordings, sounding like other singers; fewer hymns"),
};
// the credit line under the score, one per singer group (final, approved 18 Nov from the voice peer's facts; the
// app's Settings carry the same lines; no LUNAI link exists, so none is given)
// ONE switch for every voice credit the page shows (the line under the score, in a made video's details). Off during
// closed testing (Brian, 23 Nov 2026): after the hymn's own copyright notice the line shows the voice's NAME only
// ("Warble v5", "Weaver v1", "Recorded v1"), no dataset, licence, paper or source for any voice. true brings the
// full credit lines back. The hymn's copyright notice (#copyright) is not a voice credit and always shows.
export const SHOW_VOICE_CREDITS = false;
const CREDIT_V23 = "Warble v1 and v2: singers from GTSinger (Zhang et al., NeurIPS 2024), CC BY-NC-SA 4.0.";
export const CREDITS = {
  v1: CREDIT_V23, v2: CREDIT_V23,
  v3: "Warble v3: singers from GTSinger (Zhang et al., NeurIPS 2024), CC BY-NC-SA 4.0; hymn lines after the LUNAI singing voices, used with permission.",
  leap: "Weaver v1: LeapSinger and NHVSing by wavtechyukky (NHVSing weights: non-commercial use only); singers from GTSinger (Zhang et al., NeurIPS 2024, CC BY-NC-SA 4.0); hymn lines after the LUNAI singing voices, used with permission. Runs on ONNX Runtime (MIT).",
  // TEST build wording (the coordinator, 19 Nov; not final: facts from the voice peer, then ChatGPT)
  v7: "Warble v4: singers from GTSinger (Zhang et al., NeurIPS 2024), CC BY-NC-SA 4.0; taught by Weaver v1 (LeapSinger by wavtechyukky); hymn lines after the LUNAI singing voices, used with permission; sung through NHVSing by wavtechyukky (NHVSing weights: non-commercial use only). Runs on ONNX Runtime (MIT).",
};
export const COPY = {
  firstUse: (mb) => (mb ? `Downloads ${mb} MB the first time only` : ""),
  heading: "Singers", recorded: "Recorded", phone: "Live", live: "Live", done: "Done", infoAria: (name) => `About ${name}`, infoClose: "OK",
  // the picker's states (ChatGPT, agreed with the app, 18 Nov)
  noRecordingChip: "No recording for this hymn", gettingReady: (pct) => `Getting ready on your phone (${pct}%)`,
  needsStronger: "This version needs a stronger phone", chipAria: (name, what) => `${name}. ${what}`,
  instruments: "Instruments", instrumentsLine: "No singing; every part played on the piano", ask: "Ask me", askLine: "Ask when I press Play", singers: "Singers",
  credit: (id, label) => CREDITS[id] || `${label}: singers from GTSinger (Zhang et al., NeurIPS 2024), CC BY-NC-SA 4.0.`,
  preparing: (pct) => `Getting the singers ready… ${pct}%. You can press play now. Instruments will play each verse until the singers are ready.`,
  newKey: (pct) => `Getting the singers ready in the new key… ${pct}%. Instruments will play until they're ready.`,
  ready: "The singers are ready.",
  noStart: "The singers couldn't start, so instruments play instead.",
  noModel: "The singers couldn't start because their voices didn't download. Check your connection and try again.",
  stopped: "The singers stopped. Press play to continue.",
  verseFailed: (vs) => (vs.length === 1 ? `The singers couldn't sing verse ${vs[0]}, so instruments play it.`
    : `The singers couldn't sing verses ${vs.slice(0, -1).join(", ")} and ${vs.at(-1)}, so instruments play them.`),
  notReadyYet: (label, instead) => `${label} isn't ready on this phone yet, so ${instead} will sing for now.`, // B11 (Round 5)
  notReadyNow: (label, instead) => `${label} isn't ready on this phone right now, so ${instead} will sing for now.`, // B12 (as B11, Round 5)
  noLoad: "The singers couldn't load. Try again in a moment.",
  keyRecorded: "Recorded singers stay in their original key. If you change the key, the instruments take over. Warble and Weaver can sing in any key.",
  tuneRecorded: (tune) => `Sung to ${tune}. Recorded singers only sing the printed tune, so the singers on your phone or instruments play this one.`,
  noRecording: (label) => `This hymn has no recording yet. ${label} can sing it.`,
  // Round 4 (ChatGPT, 18 Nov): Singers v6 on the phone
  v6Preparing: (label, instead, pct) => `${label} is getting ready on your phone… ${pct}%. ${instead} will sing for now.`,
  v6Ready: (label) => `${label} is ready.`,
  v6Headstart: (label, pct) => `${label} is getting ready to sing… ${pct}%`,
  v6Catchup: (label) => `${label} is catching up. Singing will continue shortly.`,
  videoSingers: (i, n) => `Adding the singers to the video… ${i} of ${n}`,
  // Round 5 (ChatGPT, 19 Nov): a sound-only recording from the record dialog
  recKind: "Make", recKindVideo: "A video", recKindAudio: "Sound only", recTitleVideo: "Record a video", recTitleAudio: "Record the singing",
  recStartVideo: "Make the video", recStartAudio: "Make the recording",
  audioProgress: (name, pct) => `Making the ${name} recording… ${pct}%`, audioSingers: (i, n) => `Adding the singers… ${i} of ${n}`,
  audioReady: (count) => (count === 1 ? "Your recording is ready" : `Your ${count} recordings are ready`), audioSaving: "Saving the recording to your phone\u2026", audioFailed: "The recording couldn't be made. Try again, or choose fewer parts.",
  audioSummary: (count) => (count === 1 ? "one sound file" : `${count} sound files`),
};
/** A choice's entry: by singing.json id, or recorded engine; null when unknown (the caller's own label). */
export const singerCopy = (id) => SINGERS[id] || null;
