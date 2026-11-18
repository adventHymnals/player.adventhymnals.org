// The singing choices' names and the messages about them, in one place (Brian, 18 Nov 2026: the choices are
// "Singers v1" … "Singers v6", numbered in the order they came into being; never an internal name on screen).
// short: the name in every chip, button and row ("v5", never cut); label: for sentences and screen readers;
// group: "recorded" or "phone" (the picker's two headings); line: the one detail line under the picker.
// Keyed by singing.json voice id (the phone models) or the recorded engine. The page's own table wins over a
// singing.json label, so the names are the same whatever copy of singing.json a device holds.
// Wording: ChatGPT pass, Round 3 (review/ROUND3-PAGE-STRINGS.md).
export const SINGERS = {
  stems: { n: 1, short: "v1", group: "recorded", label: "Singers v1", line: "Recorded singers; downloads for hymns that have them" },
  v1: { n: 2, short: "v2", group: "phone", label: "Singers v2", line: "An earlier version of singing on your phone; any hymn" },
  v2: { n: 3, short: "v3", group: "phone", label: "Singers v3", line: "An earlier version of singing on your phone; any hymn" },
  "stems-v2": { n: 4, short: "v4", group: "recorded", label: "Singers v4", line: "Recordings that sound like real singers; downloads for some hymns" },
  v3: { n: 5, short: "v5", group: "phone", label: "Singers v5", line: "Sung on your phone; any hymn, key or speed" },
  leap: { n: 6, short: "v6", group: "phone", label: "Singers v6", line: "Fuller singing on your phone; needs a stronger phone" },
  // a test build's own voice (the app's voices(), 19 Nov): the line is v5's until its own passes ChatGPT
  v7: { n: 7, short: "v7", group: "phone", label: "Singers v7", line: "Sung on your phone; any hymn, key or speed" },
};
// the credit line under the score, one per singer group (final, approved 18 Nov from the voice peer's facts; the
// app's Settings carry the same lines; no LUNAI link exists, so none is given)
const CREDIT_V23 = "Singers v2 and v3: singers from GTSinger (Zhang et al., NeurIPS 2024), CC BY-NC-SA 4.0.";
export const CREDITS = {
  v1: CREDIT_V23, v2: CREDIT_V23,
  v3: "Singers v5: singers from GTSinger (Zhang et al., NeurIPS 2024), CC BY-NC-SA 4.0; hymn lines after the LUNAI singing voices, used with permission.",
  leap: "Singers v6: LeapSinger and NHVSing by wavtechyukky (NHVSing weights: non-commercial use only); singers from GTSinger (Zhang et al., NeurIPS 2024, CC BY-NC-SA 4.0); hymn lines after the LUNAI singing voices, used with permission. Runs on ONNX Runtime (MIT).",
  // TEST build wording (the coordinator, 19 Nov; not final: facts from the voice peer, then ChatGPT)
  v7: "Singers v7: singers from GTSinger (Zhang et al., NeurIPS 2024), CC BY-NC-SA 4.0; taught by Singers v6 (LeapSinger by wavtechyukky); hymn lines after the LUNAI singing voices, used with permission; sung through NHVSing by wavtechyukky (NHVSing weights: non-commercial use only). Runs on ONNX Runtime (MIT).",
};
export const COPY = {
  firstUse: (mb) => (mb ? `Downloads ${mb} MB the first time only` : ""),
  heading: "Singers", recorded: "Recorded", phone: "On your phone", done: "Done",
  // the picker's states (ChatGPT, agreed with the app, 18 Nov)
  noRecordingChip: "No recording for this hymn", gettingReady: (pct) => `Getting ready on your phone (${pct}%)`,
  needsStronger: "This version needs a stronger phone", chipAria: (n, what) => `Version ${n}. ${what}`,
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
  notReadyYet: (label, instead) => `${label} isn't ready on this phone yet, so ${instead} sing instead.`, // B11
  notReadyNow: (label, instead) => `${label} isn't ready on this phone right now, so ${instead} sing instead.`, // B12
  noLoad: "The singers couldn't load. Try again in a moment.",
  keyRecorded: "Singers v1 and Singers v4 stay in the key they were recorded in. If you change the key, instruments take over. Singers v2, Singers v3, Singers v5 and Singers v6 can sing in any key.",
  tuneRecorded: (tune) => `Sung to ${tune}. Recorded singers only sing the printed tune, so the singers on your phone or instruments play this one.`,
  noRecording: (label) => `This hymn has no recording yet. ${label} can sing it.`,
  // Round 4 (ChatGPT, 18 Nov): Singers v6 on the phone
  v6Preparing: (label, instead, pct) => `${label} is getting ready on your phone… ${pct}%. ${instead} will sing for now.`,
  v6Ready: (label) => `${label} is ready.`,
  v6Headstart: (label, pct) => `${label} is getting ready to sing… ${pct}%`,
  v6Catchup: (label) => `${label} is catching up. Singing will continue shortly.`,
  videoSingers: (i, n) => `Adding the singers to the video… ${i} of ${n}`,
};
/** A choice's entry: by singing.json id, or recorded engine; null when unknown (the caller's own label). */
export const singerCopy = (id) => SINGERS[id] || null;
