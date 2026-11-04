import {
  VOICES, ACCOMP_STYLES, INSTRUMENTAL, buildMusicXML, performance, locate, barSpan, passTime, chordIndexAt, prettyChord,
  trackKey, trackName, pianoVoices, barAt, barEnd, keyAfter, transposeChordName, syncopations, syncopate, phraseBounds,
} from "./core.js";
import { Engine, singers } from "./audio.js";
import { ScoreView } from "./scoreview.js";
import { SolfaView, WordsView } from "./solfa.js";
import { Waterfall } from "./waterfall.js";
import { Presenter } from "./presenter.js";
import { Studio } from "./studio.js";
import { exportPdf } from "./pdfexport.js";
import { canMakeVideo, makeVideos } from "./videomaker.js";
import { Conductor, feel, mysteryTune, meterHint, PitchListener, centsOff, drawLane, noteName } from "./practice.js";

const $ = (id) => document.getElementById(id);
const workspace = $("workspace");
const viewport = $("viewport");
const sheet = $("sheet");
const ribbon = $("ribbon");
const headersEl = $("headers");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Per-viewer conveniences only; the page works the same without storage.
// ?test keeps a page's settings to itself (automated runs must not touch a person's tabs).
// ?embed is the compact player a hymn page on adventhymnals.org shows inline; it
// leaves the visitor's full-Studio settings alone.
const EMBED = new URLSearchParams(location.search).has("embed");
// ?app: inside the Android app, which draws its own controls and drives this page through window.AHStudio
const APP = new URLSearchParams(location.search).has("app");
singers.on = APP; // the app keeps the singers it has played (and lets them be cleared)
// ?remote=<url>: this copy is bundled in the app; hymn data and recordings come from that site
// (the live list and new hymns when online, the bundled copy when not)
const REMOTE = new URLSearchParams(location.search).get("remote") || "";
// where the recordings are: the published site sets <meta name="ah-audio"> to the audio store (Cloudflare R2);
// otherwise they come from the site itself (or the local copy)
const AUDIO = document.querySelector('meta[name="ah-audio"]')?.content || REMOTE;
// and the hymns themselves (the list and each hymn's file): the published site reads them from the same store,
// so a new hymn goes live by upload, with no rebuild of the site
const DATA = document.querySelector('meta[name="ah-data"]')?.content || REMOTE;
// search by idea (the site's API; online only). A local copy of the player asks a local backend.
const IDEA_API = document.querySelector('meta[name="ah-idea"]')?.content
  || (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://127.0.0.1:8000/api/plugins/adventhymnals/public/search/idea/" : "https://adventhymnals.org/api/search/idea");
// ?make=: the automatic social videos (see "automatic videos" below); the URL's settings are never saved
const MAKE = new URLSearchParams(location.search).get("make") ? new URLSearchParams(location.search) : null;
const NO_STORE = new URLSearchParams(location.search).has("test") || EMBED || !!MAKE;
const store = {
  get(k, d) { if (NO_STORE) return d; try { const v = localStorage.getItem(`hymn2:${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { if (NO_STORE) return; try { localStorage.setItem(`hymn2:${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

const CH = ["S", "A", "T", "B", "acc"];
const DEFAULT_MIX = { S: { level: 0.8, pan: -0.62 }, A: { level: 0.8, pan: -0.24 }, T: { level: 0.8, pan: 0.24 }, B: { level: 0.8, pan: 0.62 }, acc: { level: 0.55, pan: 0 } };
const state = {
  tracks: store.get("tracks", [["S"], ["A"], ["T"], ["B"]]),
  hidden: store.get("hidden", []),
  trackWords: store.get("trackWords", { S: true, A: true, T: true, B: true, SA: true, TB: true }),
  mute: store.get("mute", {}),
  solo: store.get("solo", {}),
  levels: store.get("levels", Object.fromEntries(CH.map((c) => [c, DEFAULT_MIX[c].level]))),
  pans: store.get("pans", Object.fromEntries(CH.map((c) => [c, DEFAULT_MIX[c].pan]))),
  view: store.get("view", "tracks"),
  words: store.get("words", "all"),
  nowbar: store.get("nowbar", true),
  chords: store.get("chords", false),
  piano: store.get("piano", false),
  accomp: store.get("accomp", "off"),
  accStaff: store.get("accStaff", false),
  intro: store.get("intro", "none"),
  interlude: store.get("interlude", "none"),
  countIn: store.get("countIn", true),
  countAt: store.get("countAt", "start"), // the count-in bar: at the very start, or after the introduction
  introVoice: null, // while making a one-voice video: the voice its introduction plays
  watermark: false, // while making a video: its watermark is drawn (always, on every video)
  format: "landscape", // while making an automatic video: "vertical" draws the tall stage of a Short
  // each voice's sound: "sung" (recorded singers), "choir" (synthesised aah) or "piano";
  // unset means singers when a recording exists, else the choir synth
  voiceSounds: store.get("voiceSounds", {}),
  zoom: store.get("zoom", 1),
  loop: { on: false, from: 1, to: 4 },
  tempo: 96,
  verses: [1],
  transpose: 0,       // semitones for the whole hymn (saved per hymn)
  lastVerseUp: store.get("lastVerseUp", 0), // modulate the last verse up 0, 1 or 2 semitones
  verseLayout: store.get("verseLayout", "stack"), // "stack": verses under one another; "unfold": written out
  presenterShows: store.get("presenterShows", "score"), // or "words" for projection
  showSync: store.get("showSync", false),
  headsCollapsed: store.get("headsCollapsed", false),
  practice: store.get("practice", false),
  practiceTab: store.get("practiceTab", "meter"),
  metronome: store.get("metronome", false),
  singVoice: store.get("singVoice", "S"),
  muteMine: store.get("muteMine", true),
  anyOctave: store.get("anyOctave", true),
  // ?app, the staff view: "line by line", one line at a time, the next line uncovered behind the
  // playhead (as the presenter does), instead of the whole page scrolling
  sweep: store.get("lineByLine", true), // the staff line by line, the next line peeled in behind the singer
  altZoom: store.get("altZoom", 1), // the sol-fa and words views, pinched larger or smaller
  solfaWordsAt: store.get("solfaWordsAt", "every"), // sol-fa: the words under every voice, or only the top one
  solfaSweep: store.get("solfaLineByLine", true), // sol-fa line by line, as the staff
  solfaZoom: store.get("solfaZoom", 1), // the sol-fa, pinched larger or smaller (the app opens it at the smallest)
  instrumental: store.get("instrumental", false), // every voice played on the piano, no singing
  singSolfa: store.get("singSolfa", false),
  staffScroll: store.get("staffScroll", false), // the app's staff as one long line moving under a still playhead
  beforeInstrumental: store.get("beforeInstrumental", null),
};
let hymnWritten = null; // the hymn as transcribed; `hymn` may be a rhythm variant of it
// key changes made while playing: from section k at score position q, move by delta semitones
let liveChanges = [];
let renderedShift = 0;
const save = (...keys) => keys.forEach((k) => store.set(k, state[k]));
// ?app: the hymn the app asked for last. Until it has loaded, the page reports it is not ready,
// so the app can never play (or show) the hymn it had before.
const appWant = { id: null, missing: false, loading: false };
let bootDone;
const bootReady = new Promise((r) => { bootDone = r; });

const engine = new Engine();
const waterfall = new Waterfall();
let tk = null;
let view = null;
let solfa = null;
let words = null;
let presenter = null;
let studio = null;
let hymn = null;
let perf = null;
let renderedVerse = 1;
let lastSystem = null;
let lastFollowEl = null;
let lastLineKey = "";
let recording = null;
let colors = null;
let manifest = null; // sung stems for this hymn, if rendered
let stemInfo = new Map(); // "S:1:0" (voice:verse:transpose) -> { offsetSec, duration } usable at the current tempo

const tracksOfHymn = () => state.tracks.map((t) => t.filter((k) => hymn?.voices[k])).filter((t) => t.length);
const visibleTracks = () => tracksOfHymn().filter((t) => !state.hidden.includes(trackKey(t)));
const visibleVoices = () => visibleTracks().flat();
const singing = () => state.practice && state.practiceTab === "sing" && listener?.on;
const heard = (ch) => !(state.mute[ch] || (CH.some((c) => state.solo[c]) && !state.solo[ch])
  || (singing() && state.muteMine && ch === state.singVoice)); // you sing your own part
const soundOf = (k) => state.voiceSounds[k] || (manifest ? "sung" : "choir");
const hymnVoices = () => "SATB".split("").filter((k) => hymn?.voices[k]);
const anySung = () => hymnVoices().some((k) => soundOf(k) === "sung");
const anyPiano = () => hymnVoices().some((k) => soundOf(k) === "piano");
const isScoreView = () => state.view === "tracks" || state.view === "page";
const unfolded = () => state.verseLayout === "unfold";

// ---- projection: the presenter full screen, filling the window, or in a window of its own ----

let projector = null; // the separate presenter window, while open
const projectorOpen = () => projector && !projector.closed;
const stageWanted = () => state.view === "presenter" || projectorOpen();

function openProjector() {
  if (projectorOpen()) { projector.focus(); return; }
  projector = window.open("", "hymn-projector", "popup=yes,resizable=yes,width=1280,height=720");
  if (!projector) { toast("The browser blocked the new window. Allow pop-ups for this page and try again."); return; }
  const d = projector.document;
  d.title = `${hymn.number} ${hymn.title}`;
  d.body.style.cssText = "margin:0;background:#000;height:100vh;display:grid;place-items:center;overflow:hidden";
  d.body.innerHTML = `<canvas style="max-width:100vw;max-height:100vh"></canvas>
    <div id="bar" style="position:fixed;top:12px;right:12px;display:flex;gap:8px;transition:opacity .25s">
      <button id="fill" aria-label="Fill the screen" title="Fill the screen" style="width:40px;height:38px;display:grid;place-items:center;padding:0;border-radius:7px;border:1px solid #888;background:#1e2a47;color:#fff;cursor:pointer"><svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7 12h10M7 12l2.5-2.5M7 12l2.5 2.5M17 12l-2.5-2.5M17 12l-2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      <button id="full" aria-label="Full screen" title="Full screen (or double-click)" style="width:40px;height:38px;display:grid;place-items:center;padding:0;border-radius:7px;border:1px solid #888;background:#1e2a47;color:#fff;cursor:pointer"><svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
    </div>
    <p id="hint" style="position:fixed;bottom:12px;left:0;right:0;text-align:center;font:15px sans-serif;color:#aaa;transition:opacity 1s">Drag this window to the projector, then use the buttons at the top right (or double-click for full screen).</p>`;
  const toggleFull = () => (d.fullscreenElement ? d.exitFullscreen() : d.documentElement.requestFullscreen().catch(() => {}));
  d.body.ondblclick = toggleFull;
  d.getElementById("full").onclick = toggleFull;
  // stretch the window over the whole screen it is on (the browser may keep its own frame)
  d.getElementById("fill").onclick = () => {
    const sc = projector.screen;
    projector.moveTo(sc.availLeft ?? 0, sc.availTop ?? 0);
    projector.resizeTo(sc.availWidth, sc.availHeight);
  };
  // the controls show while the mouse moves, then get out of the way
  const bar = d.getElementById("bar");
  let hideTimer;
  const showBar = () => { bar.style.opacity = 1; d.body.style.cursor = "default"; clearTimeout(hideTimer); hideTimer = setTimeout(() => { bar.style.opacity = 0; d.body.style.cursor = "none"; }, 2500); };
  d.addEventListener("mousemove", showBar);
  showBar();
  setTimeout(() => { const hint = d.getElementById("hint"); if (hint) hint.style.opacity = 0; }, 6000);
  projector.addEventListener("beforeunload", () => { projector = null; });
  prepareStage().then(() => paint(true));
}

// copy the stage into the projector window, scaled to fit
function mirrorProjector() {
  if (!projectorOpen()) return;
  const src = $("stage");
  const c = projector.document.querySelector("canvas");
  if (!c) return;
  const w = projector.innerWidth;
  const h = projector.innerHeight;
  const k = Math.min(w / src.width, h / src.height);
  const dpr = projector.devicePixelRatio || 1;
  const cw = Math.round(src.width * k * dpr);
  if (c.width !== cw) { c.width = cw; c.height = Math.round(src.height * k * dpr); c.style.width = `${src.width * k}px`; c.style.height = `${src.height * k}px`; }
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
}

function enterFullPage() {
  if (state.view !== "presenter") { state.view = "presenter"; save("view"); renderAll(); }
  document.body.classList.add("full-page");
  toast("Press Esc to leave full page.", 2500);
}
const leaveFullPage = () => document.body.classList.remove("full-page");

// Written out, the score runs every sung verse one after another, so a position inside verse
// pass k sits at (that verse's place among the sung verses) * totalQ + q in the score.
function verseOrdinal(loc) {
  if (!loc) return 0;
  const p = perf.passes[loc.pass];
  if (p.kind === "verse") return perf.passes.slice(0, loc.pass).filter((x) => x.kind === "verse").length;
  return null; // introductions and interludes have no copy of their own
}
function scoreQ(loc) {
  if (!loc) return null;
  if (!unfolded()) return loc.q;
  // an introduction or interlude lights up in the copy of the verse that comes next
  const j = verseOrdinal(loc) ?? Math.min(state.verses.length - 1, perf.passes.slice(0, loc.pass).filter((x) => x.kind === "verse").length);
  return j * hymn.totalQ + loc.q;
}
/** From a position in the score back to a performance time. */
function timeOfScoreQ(sq) {
  if (!unfolded()) {
    const loc = locate(perf, engine.now());
    const k = loc && loc.kind === "verse" ? loc.pass : perf.passes.findIndex((p) => p.kind === "verse");
    return passTime(perf, k, sq);
  }
  const j = Math.floor(sq / hymn.totalQ + 1e-9);
  const ks = perf.passes.map((p, i) => (p.kind === "verse" ? i : -1)).filter((i) => i >= 0);
  return passTime(perf, ks[Math.min(j, ks.length - 1)], sq - j * hymn.totalQ);
}

// ---- key ------------------------------------------------------------------

function shiftAt(k, pass, q) {
  let s = state.transpose;
  // the classic last-verse lift: only the final sung verse moves up
  if (state.lastVerseUp && state.verses.length > 1 && pass.kind === "verse" && pass.verse === state.verses[state.verses.length - 1]) s += state.lastVerseUp;
  for (const c of liveChanges) if (c.k < k || (c.k === k && c.q <= q + 1e-6)) s += c.delta;
  return s;
}
const currentShift = (loc) => (perf && loc ? shiftAt(loc.pass, perf.passes[loc.pass], loc.q) : perf ? shiftAt(0, perf.passes[0], 0) : state.transpose);
const keyFor = (shift) => keyAfter(hymn, shift);
// Verovio takes a key name for major hymns (so its spelling matches ours), semitones otherwise
const verovioTranspose = (shift) => (!shift ? "" : hymn.key.mode === "minor" ? String(shift) : keyFor(shift).name);
const chordLabel = (name, shift = renderedShift) => prettyChord(transposeChordName(name, keyFor(shift)));

function syncKeyLabel(shift = renderedShift) {
  const k = keyFor(shift);
  $("keyLabel").textContent = prettyChord(k.name) + (hymn.key.mode === "minor" ? "m" : "");
  $("keyLabel").title = shift ? `Transposed ${shift > 0 ? "up" : "down"} ${Math.abs(shift)} semitone${Math.abs(shift) === 1 ? "" : "s"} from ${prettyChord(keyFor(0).name)}. Click to go back to the written key.` : "The written key";
  $("keyLabel").classList.toggle("moved", !!shift);
}

/** Up or down a semitone: from the next bar while playing, for the whole hymn when stopped. */
function changeKey(delta) {
  if (!perf) return;
  const loc = engine.playing ? locate(perf, engine.now()) : null;
  if (loc) {
    let k = loc.pass;
    let q = barEnd(hymn, barAt(hymn, loc.q));
    if (q >= perf.passes[k].qTo - 1e-6 && perf.passes[k + 1]) { k += 1; q = perf.passes[k].qFrom; }
    liveChanges.push({ k, q, delta });
    rebuild();
    const to = prettyChord(keyFor(shiftAt(k, perf.passes[k], q)).name);
    toast(`Moving to ${to} at bar ${barAt(hymn, q)}.`, 3000);
  } else {
    state.transpose = Math.max(-11, Math.min(11, state.transpose + delta));
    store.set(`transpose:${hymn.id}`, state.transpose);
    if (anySung()) prepareStems(); else rebuild();
    renderAll();
  }
  noteStemsTransposed();
}

function resetKey() {
  liveChanges = [];
  state.transpose = 0;
  store.set(`transpose:${hymn.id}`, 0);
  if (anySung()) prepareStems(); else rebuild();
  renderAll();
}

function noteStemsTransposed() {
  if (anySung() && stemInfo.size && perf.events.some((e) => !e.silent && !e.inst && "SATB".includes(e.ch) && e.pass >= 0)) {
    if (!noteStemsTransposed.shown) toast("A key change inside a verse is sung by the synth until the next verse; recordings cover whole verses in one key.", 6000);
    noteStemsTransposed.shown = true;
  }
}

// ---- icons ----------------------------------------------------------------

const ICON = {
  mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 9.5l5 5m0-5l-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
  solo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 16 0v3" stroke="currentColor" stroke-width="2" fill="none"/><rect x="3" y="14" width="5" height="7" rx="1.5" fill="currentColor"/><rect x="16" y="14" width="5" height="7" rx="1.5" fill="currentColor"/></svg>',
  words: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h11M4 17h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  hide: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>',
  show: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" stroke="currentColor" stroke-width="2" fill="none"/><path d="M4 20L20 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  grip: '<svg viewBox="0 0 24 8" aria-hidden="true"><g fill="currentColor"><circle cx="6" cy="2" r="1.4"/><circle cx="12" cy="2" r="1.4"/><circle cx="18" cy="2" r="1.4"/><circle cx="6" cy="6" r="1.4"/><circle cx="12" cy="6" r="1.4"/><circle cx="18" cy="6" r="1.4"/></g></svg>',
};

function toast(text, ms = 4200, action = null) {
  const el = $("toast");
  el.innerHTML = "";
  el.append(document.createTextNode(text));
  if (action) {
    const b = document.createElement("button");
    b.className = "toast-act";
    b.textContent = action.label;
    b.onclick = () => { el.hidden = true; action.fn(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toast.timer);
  if (ms) toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(`--${n}`).trim();
  colors = {
    paper: v("paper"), paperClear: "rgba(252,251,247,0)", cloth: v("cloth"), ink: v("ink"), muted: v("muted"),
    rule: v("rule"), gilt: v("gilt"), loop: v("loop"), S: v("S"), A: v("A"), T: v("T"), B: v("B"), acc: v("acc"),
  };
  colors.lyric = colors.S;
  colors.stage = "#f4ecd9"; // the presenter and its videos: cream, softer than white
}

// ---- boot -----------------------------------------------------------------

function verovioReady() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const wait = () => {
      if (window.verovio?.module) {
        if (window.verovio.module.calledRun) resolve();
        else window.verovio.module.onRuntimeInitialized = resolve;
      } else if (Date.now() - started > 20000) reject(new Error("verovio"));
      else setTimeout(wait, 50);
    };
    wait();
  });
}

let hymnList = [];
async function loadList() {
  // fresh when online; the cached copy when not (the Android app plays offline what it played before)
  const local = () => fetch("data/index.json", { cache: "no-cache" }).catch(() => fetch("data/index.json", { cache: "force-cache" }));
  if (DATA) {
    try {
      const r = await fetch(`${DATA}data/index.json`, { cache: "no-cache" });
      if (!r.ok) throw new Error(String(r.status));
      hymnList = (await r.json()).map((x) => ({ ...x, path: new URL(x.path, DATA).href, fallback: x.path }));
      return fillPicker();
    } catch { /* offline: the bundled list */ }
  }
  hymnList = await (await local()).json();
  fillPicker();
}

function fillPicker() {
  $("hymnPicker").innerHTML = hymnList.map((x) => `<option value="${x.id}">${x.book} ${x.number}, ${x.title}</option>`).join("");
  setupFinder();
}

// ---- the hymn finder: search, and the dropdown of every hymn, filtered by hymnal and sound, sorted ----

// short names for the hymnals; a hymnal not listed here shows its code
const BOOK_NAMES = {
  SDAH: "Seventh-day Adventist Hymnal", NZK: "Nyimbo za Kristo", WN: "Wende Nyasaye", CH1941: "Church Hymnal 1941",
  CS1900: "Christ in Song 1900", CS1908: "Christ in Song 1908", RECORDED: "Recorded",
};
const BOOK_ORDER = ["SDAH", "NZK", "WN", "CH1941", "CS1908", "CS1900"]; // the hymnals in use first, then the older ones
const bookRank = (b) => (BOOK_ORDER.indexOf(b) + 1) || 99;
const bookCodes = () => [...new Set(hymnList.map((x) => x.book))].sort((a, b) => bookRank(a) - bookRank(b) || a.localeCompare(b));
const bookName = (b) => BOOK_NAMES[b] || b;
const SOUNDS = [["all", "All"], ["sung", "Singers ready"], ["midi", "MIDI only"]];
// "auto": by hymnal and number, or best match first while searching
const SORTS = [["auto", "Hymnal, number"], ["number", "Number 1→9"], ["number-desc", "Number 9→1"],
  ["title", "Title A→Z"], ["title-desc", "Title Z→A"], ["book", "Hymnal A→Z"]];
const finder = {
  q: "", books: store.get("finderBooks", []), sound: store.get("finderSound", "all"), sort: store.get("finderSort", "auto"),
  bookQ: "", shown: [], active: 0, ready: false,
};
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const normQ = (t) => String(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const numOf = (x) => parseInt(x.number, 10) || 0;
const byBookNum = (a, b) => bookRank(a.book) - bookRank(b.book) || a.book.localeCompare(b.book) || numOf(a) - numOf(b);
const titleKey = (x) => normQ(x.title).replace(/^(the|a|o) /, "");
const SORTERS = {
  number: (a, b) => numOf(a) - numOf(b) || byBookNum(a, b),
  "number-desc": (a, b) => numOf(b) - numOf(a) || byBookNum(a, b),
  title: (a, b) => titleKey(a).localeCompare(titleKey(b)) || byBookNum(a, b),
  "title-desc": (a, b) => titleKey(b).localeCompare(titleKey(a)) || byBookNum(a, b),
  book: (a, b) => bookName(a.book).localeCompare(bookName(b.book)) || numOf(a) - numOf(b),
};

// ---- full-text search: titles, every verse and the writers, forgiving typos (MiniSearch, in the page: works offline) ----

const search = { ms: null, words: null, loading: null, terms: new Map(), snips: new Map() };
// one term per word: lower case, no accents, apostrophes dropped ("o'er" -> "oer", "'tis" -> "tis")
const termOf = (t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
const tokenize = (text) => String(text).split(/[\s\-–—_/,.;:!?"“”‘’()[\]{}…]+/);
// short words that say little on their own, for deciding what a partial match must contain
const WEAK = new Set(["when", "am", "are", "was", "were", "will", "shall", "so", "as", "by", "from", "this", "that", "his", "her", "its", "your", "you", "who", "what", "how", "not", "no", "but", "or", "if", "then", "there", "here", "into", "up", "out", "day", "come", "let", "hymn", "song", "about"]);
const STOP = new Set(["the", "a", "an", "and", "of", "to", "in", "o", "is", "my", "me", "i", "we", "our", "thy", "thee", "thou", "for", "with", "be", "on", "at", "it", "us", "his", "he", "all"]);

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
}

/** Load the words and build the index, once, the first time someone searches with words. */
function ensureSearch() {
  search.loading ??= (async () => {
    const local = () => fetch("data/words.json", { cache: "no-cache" }).catch(() => fetch("data/words.json", { cache: "force-cache" }));
    let words = null;
    if (DATA) {
      try { const r = await fetch(`${DATA}data/words.json`, { cache: "no-cache" }); if (r.ok) words = await r.json(); } catch { /* offline: the bundled copy */ }
    }
    if (!words) words = await (await local()).json();
    if (!window.MiniSearch) await loadScript("vendor/minisearch-7.1.0.min.js");
    const ms = new window.MiniSearch({
      fields: ["title", "first", "words", "by"],
      tokenize,
      processTerm: (t) => termOf(t) || null,
      searchOptions: {
        boost: { title: 4, first: 2.5, by: 1.5 },
        // the word being typed may be unfinished; longer words may be mistyped
        prefix: (term, i, terms) => i === terms.length - 1 || term.length > 4,
        fuzzy: (term) => (term.length > 7 ? 0.25 : term.length > 3 ? 1 : false),
        weights: { fuzzy: 0.35, prefix: 0.6 },
      },
    });
    ms.addAll(hymnList.map((x) => {
      const w = words[x.id] || { v: [], by: "" };
      const first = (w.v[0] || "").split(/(?<=[,;:.!?])\s+/).slice(0, 2).join(" ");
      return { id: x.id, title: x.title, first, words: w.v.join(" \n "), by: w.by || "" };
    }));
    search.words = words;
    search.ms = ms;
  })().catch((e) => { search.loading = null; throw e; });
  return search.loading;
}

// ---- search by idea: hymns close in meaning, from the server (online only; offline the words still work) ----

const idea = { q: "", books: "", ids: [], lines: new Map(), timer: 0, ctrl: null };
const ideaWanted = (q) => (normQ(q).match(/[a-z]{2,}/g) || []).length >= 2 && !/^\s*[a-z]*\d*\s*\d+\s*$/i.test(q);

function askIdea(q) {
  clearTimeout(idea.timer);
  if (!ideaWanted(q) || !navigator.onLine) { idea.q = ""; idea.ids = []; return; }
  const books = finder.books.join(",");
  if (q === idea.q && books === idea.books) return;
  idea.timer = setTimeout(async () => {
    idea.ctrl?.abort();
    idea.ctrl = new AbortController();
    try {
      const u = new URL(IDEA_API, location.href);
      u.searchParams.set("q", q);
      u.searchParams.set("limit", "50");
      if (books) u.searchParams.set("books", books);
      const r = await fetch(u, { signal: idea.ctrl.signal });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      const have = new Set(hymnList.map((x) => x.id));
      const rows = data.results.filter((x) => have.has(x.hymn_id) && x.score >= 0.45); // only hymns this player can play
      Object.assign(idea, { q, books, ids: rows.map((x) => x.hymn_id), lines: new Map(rows.map((x) => [x.hymn_id, x.line])) });
      if (finder.q === q) renderFinder();
    } catch { /* offline or the server is busy: the words search stands alone */ }
  }, 350);
}

/** Hymns matching words: ids with a score, best first, and the terms each matched. */
function wordHits(q) {
  if (!search.ms) return null;
  const qTerms = tokenize(q).map(termOf).filter(Boolean);
  if (!qTerms.length) return [];
  // every word must be there (allowing typos); if nothing has them all, the hymns with most of them
  let res = search.ms.search(q, { combineWith: "AND" });
  let partial = false;
  if (!res.length) {
    // the hymns with at least half the words that carry meaning ("afraid", "alone"; not "when", "I", "am")
    const meaningful = [...new Set(qTerms.filter((t) => !STOP.has(t) && !WEAK.has(t)))];
    const need = Math.max(1, Math.ceil(meaningful.length / 2));
    res = search.ms.search(q, { combineWith: "OR" })
      .filter((r) => r.queryTerms.filter((t) => meaningful.includes(t)).length >= need)
      .slice(0, 20);
    partial = true;
  }
  search.partial = partial && res.length > 0;
  const phrase = qTerms.join(" ");
  const out = res.map((r) => {
    const w = search.words[r.id];
    const all = ` ${tokenize((w?.v || []).join(" ")).map(termOf).filter(Boolean).join(" ")} `;
    const title = ` ${tokenize(hymnList.find((x) => x.id === r.id)?.title || "").map(termOf).join(" ")} `;
    let s = r.score;
    if (qTerms.length > 1 && title.includes(` ${phrase} `)) s *= 4; // the exact words, in order
    else if (qTerms.length > 1 && all.includes(` ${phrase} `)) s *= 3;
    else if (title.startsWith(` ${phrase}`)) s *= 2;
    search.terms.set(r.id, new Set(r.terms));
    return { id: r.id, s, partial };
  });
  return out.sort((a, b) => b.s - a.s);
}

/** The line of the hymn the search matched, when the title doesn't show why it's there. */
function snippetFor(id, q) {
  const w = search.words?.[id];
  const terms = search.terms.get(id);
  if (!w || !terms) return "";
  const x = hymnList.find((h) => h.id === id);
  const titleTerms = new Set(tokenize(x?.title || "").map(termOf));
  const wanted = [...terms].filter((t) => !titleTerms.has(t));
  if (!wanted.length) return "";
  const phrase = tokenize(q).map(termOf).filter(Boolean).join(" ");
  let best = null;
  for (const verse of w.v) {
    const chunks = verse.split(/(?<=[,;:.!?])\s+/);
    for (let i = 0; i < chunks.length; i++) {
      for (const span of [1, 2]) { // a phrase may run over a comma
        const text = chunks.slice(i, i + span).join(" ");
        const ts = tokenize(text).map(termOf);
        const hits = wanted.filter((t) => ts.includes(t)).length + (phrase && ` ${ts.join(" ")} `.includes(` ${phrase} `) ? 10 : 0);
        const score = hits * 10 - span - text.length / 200;
        if (hits && (!best || score > best.score)) best = { score, text };
      }
    }
  }
  if (!best) return "";
  // mark the matched words
  return best.text.split(/(\s+)/).map((tok) => {
    const t = termOf(tok);
    return t && terms.has(t) && !STOP.has(t) ? `<mark>${escHtml(tok)}</mark>` : escHtml(tok);
  }).join("");
}

/** The hymns the finder shows: those in the chosen hymnals and sound, in the chosen order.
 *  A number ("240", "nzk 89") finds by number; words search the titles, verses and writers. */
function finderMatches(q, { books = finder.books, sound = finder.sound, sort = finder.sort } = {}) {
  const nq = normQ(q);
  const keep = (x) => !(books.length && !books.includes(x.book)) && !(sound === "sung" && !x.sung) && !(sound === "midi" && x.sung);
  if (!nq) return hymnList.filter(keep).sort(SORTERS[sort] || byBookNum);
  search.terms = new Map(); // which words each hymn matched, for its line under the title
  search.partial = false;
  const scored = new Map(); // id -> score
  const m = nq.match(/^([a-z]+\d*)?\s*(\d+)$/); // "240", or "nzk 89"
  if (m) {
    for (const x of hymnList) {
      if (m[1] && !x.book.toLowerCase().startsWith(m[1])) continue;
      if (x.number === m[2]) scored.set(x.id, 1e6 + (x.book === "SDAH" ? 1 : 0));
      else if (x.number.startsWith(m[2])) scored.set(x.id, 1e5 - x.number.length);
    }
  }
  const hits = /[a-z]/.test(nq) ? wordHits(q) : [];
  if (hits === null) {
    // the words are still loading: titles for now
    const words = nq.split(" ");
    for (const x of hymnList) {
      const t = normQ(x.title);
      if (t.startsWith(nq)) scored.set(x.id, Math.max(scored.get(x.id) || 0, 80));
      else if (words.every((w) => t.includes(w))) scored.set(x.id, Math.max(scored.get(x.id) || 0, 50));
    }
  } else {
    for (const h of hits) if (!scored.has(h.id)) scored.set(h.id, h.s);
  }
  const byId = new Map(hymnList.map((x) => [x.id, x]));
  const out = [...scored.keys()].map((id) => byId.get(id)).filter((x) => x && keep(x));
  if (SORTERS[sort]) return out.sort(SORTERS[sort]);
  return out.sort((a, b) => scored.get(b.id) - scored.get(a.id) || byBookNum(a, b));
}

function markMatch(title, q) {
  const words = normQ(q).split(" ").filter((w) => w.length > 1 && !/^\d+$/.test(w));
  let html = escHtml(title);
  for (const w of words) html = html.replace(new RegExp(`(${w})`, "i"), "<mark>$1</mark>");
  return html;
}

function setupFinder() {
  if (finder.ready) { renderFinder(); return; }
  finder.ready = true;
  const top = $("finderTop"), query = $("finderQuery"), panel = $("finderPanel"), btn = $("finderBtn"), list = $("finderList");
  const books = bookCodes();
  finder.books = finder.books.filter((b) => books.includes(b));
  if (!SOUNDS.some(([k]) => k === finder.sound)) finder.sound = "all";
  if (!SORTS.some(([k]) => k === finder.sort)) finder.sort = "auto";
  const open = (focusPanel) => {
    if (panel.hidden) {
      panel.hidden = false;
      showBooks(false);
      btn.setAttribute("aria-expanded", "true");
      top.setAttribute("aria-expanded", "true");
      renderFinder(true);
    }
    if (focusPanel && matchMedia("(pointer: fine)").matches) query.focus(); // no keyboard popping up on a phone
  };
  const close = () => {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    top.setAttribute("aria-expanded", "false");
  };
  finder.close = close;
  const setQ = (v, from) => {
    finder.q = v;
    askIdea(v.trim());
    if (/[a-z]/i.test(v) && !search.ms) ensureSearch().then(() => { if (finder.q) renderFinder(); }).catch(() => toast("The search could not load the words; titles and numbers still work.", 5000));
    if (from !== top) top.value = v;
    if (from !== query) query.value = v;
    finder.active = 0;
    renderFinder(!v);
  };
  btn.onclick = () => (panel.hidden ? open(true) : close());
  top.oninput = () => { open(false); showBooks(false); setQ(top.value, top); };
  top.onfocus = () => { if (top.value) open(false); };
  query.oninput = () => setQ(query.value, query);
  const keys = (e) => {
    const n = finder.shown.length;
    if (e.key === "ArrowDown") { e.preventDefault(); open(false); finder.active = Math.min(finder.active + 1, n - 1); highlight(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); finder.active = Math.max(finder.active - 1, 0); highlight(); }
    else if (e.key === "PageDown") { e.preventDefault(); finder.active = Math.min(finder.active + 10, n - 1); highlight(); }
    else if (e.key === "PageUp") { e.preventDefault(); finder.active = Math.max(finder.active - 10, 0); highlight(); }
    else if (e.key === "Enter") { e.preventDefault(); if (finder.shown[finder.active]) chooseHymn(finder.shown[finder.active].id); }
    else if (e.key === "Escape") { if (!panel.hidden) { e.stopPropagation(); close(); } else if (top.value) setQ("", null); }
  };
  top.onkeydown = keys;
  query.onkeydown = keys;
  list.onclick = (e) => { const li = e.target.closest("li[data-id]"); if (li) chooseHymn(li.dataset.id); };
  list.onmousemove = (e) => {
    const li = e.target.closest("li[data-id]");
    if (li && Number(li.dataset.i) !== finder.active) { finder.active = Number(li.dataset.i); highlight(false); }
  };
  const refilter = () => { finder.active = 0; renderFinder(!finder.q); };
  const setBooks = (b) => {
    finder.books = b.length === books.length ? [] : b;
    store.set("finderBooks", finder.books);
    askIdea(finder.q.trim());
    refilter();
    renderBookList();
  };
  $("finderSound").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    finder.sound = b.dataset.sound;
    store.set("finderSound", finder.sound);
    refilter();
  };
  $("finderSort").innerHTML = SORTS.map(([k, label]) => `<option value="${k}">${label}</option>`).join("");
  $("finderSort").onchange = (e) => { finder.sort = e.target.value; store.set("finderSort", finder.sort); refilter(); };
  // the chosen hymnals, each a chip that takes it off again
  $("finderPicked").onclick = (e) => {
    if (e.target.closest("button[data-more]")) { showBooks(true); return; }
    const b = e.target.closest("button[data-book]");
    if (b) setBooks(finder.books.filter((x) => x !== b.dataset.book));
  };

  // the hymnals: a searchable checklist of its own, so hundreds of hymnals still fit, phone or desktop
  const showBooks = (on) => {
    $("finderMain").hidden = on;
    $("finderBooksView").hidden = !on;
    if (on) {
      const all = bookCodes();
      finder.bookOrder = [...all.filter((b) => finder.books.includes(b)), ...all.filter((b) => !finder.books.includes(b))];
      finder.bookQ = "";
      $("finderBookQuery").value = "";
      renderBookList();
      if (matchMedia("(pointer: fine)").matches) $("finderBookQuery").focus();
    }
  };
  $("finderBooksBtn").onclick = () => showBooks(true);
  $("finderBack").onclick = $("finderBooksDone").onclick = () => { showBooks(false); renderFinder(!finder.q); };
  $("finderBooksAll").onclick = () => setBooks([]);
  $("finderBookQuery").oninput = (e) => { finder.bookQ = e.target.value; renderBookList(); };
  $("finderBookQuery").onkeydown = (e) => { if (e.key === "Escape") { e.stopPropagation(); showBooks(false); } };
  $("finderBookList").onchange = (e) => {
    const code = e.target.value;
    // starting from "all", the first tick narrows to that one hymnal
    setBooks(e.target.checked ? [...finder.books, code] : (finder.books.length ? finder.books : books).filter((x) => x !== code));
  };

  // outside the finder closes it
  document.addEventListener("pointerdown", (e) => { if (!panel.hidden && !e.target.closest("#finder")) close(); });
  // "/" jumps to the search box, as on most sites
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !e.target.closest("input, select, textarea, [contenteditable]")) { e.preventDefault(); top.focus(); top.select(); }
  });
  renderFinder();
}

function renderBookList() {
  const nq = normQ(finder.bookQ);
  const inSound = finderMatches("", { books: [], sound: finder.sound, sort: "auto" });
  const codes = (finder.bookOrder || bookCodes()).filter((b) => !nq || normQ(`${b} ${bookName(b)}`).includes(nq));
  $("finderBooksAll").setAttribute("aria-pressed", String(!finder.books.length));
  $("finderBookList").innerHTML = codes.length ? codes.map((b) => `<li><label>
      <input type="checkbox" value="${escHtml(b)}"${finder.books.includes(b) ? " checked" : ""}>
      <span class="b-name">${escHtml(bookName(b))}${bookName(b) !== b ? `<small>${escHtml(b)}</small>` : ""}</span>
      <span class="b-n">${inSound.filter((x) => x.book === b).length}</span>
    </label></li>`).join("") : `<li class="finder-empty">No hymnal matches “${escHtml(finder.bookQ.trim())}”.</li>`;
  $("finderBooksDone").textContent = `Show ${finderMatches(finder.q).length} hymns`;
}

function chooseHymn(id) {
  finder.close?.();
  $("finderTop").blur();
  const picker = $("hymnPicker");
  if (picker.value === id && !document.body.classList.contains("missing")) return;
  picker.value = id;
  picker.dispatchEvent(new Event("change"));
  syncFinderLabel();
}

function syncFinderLabel() {
  const x = hymnList.find((h) => h.id === $("hymnPicker").value);
  $("finderLabel").textContent = x ? `${x.book} ${x.number}` : "Hymns";
}

function renderFinder(scrollToCurrent = false) {
  if (!finder.ready) return;
  const n = finder.books.length;
  $("finderBooksVal").textContent = !n ? "All hymnals" : n === 1 ? bookName(finder.books[0]) : `${n} hymnals`;
  // each chosen hymnal as a chip whose × takes it off; past a few, "+N more" opens the checklist
  const PICKED_MAX = 3;
  $("finderPicked").innerHTML = finder.books.slice(0, PICKED_MAX)
    .map((b) => `<button type="button" data-book="${escHtml(b)}" title="${escHtml(bookName(b))}" aria-label="Stop showing ${escHtml(bookName(b))}">${escHtml(b)}</button>`).join("")
    + (n > PICKED_MAX ? `<button type="button" class="more" data-more aria-label="All ${n} chosen hymnals">+${n - PICKED_MAX} more</button>` : "");
  // the sound counts follow the chosen hymnals, so they say what clicking would show
  const inBooks = finderMatches("", { books: finder.books, sound: "all", sort: "auto" });
  $("finderSound").innerHTML = SOUNDS.map(([k, label]) => {
    const c = k === "all" ? inBooks.length : inBooks.filter((x) => (k === "sung" ? x.sung : !x.sung)).length;
    return `<button type="button" role="radio" data-sound="${k}" aria-checked="${finder.sound === k}">${label}<small>${c}</small></button>`;
  }).join("");
  const sortSel = $("finderSort");
  sortSel.value = finder.sort;
  sortSel.options[0].textContent = finder.q.trim() ? "Best match" : "Hymnal, number";
  let words = finderMatches(finder.q);
  // the hymns about the same idea (only those the filters keep). All the words found: the words
  // first, then the idea. Only some of them: the idea first, it reads the question better
  const keepIdea = new Set(finderMatches("").map((x) => x.id));
  let ideaRows = finder.q.trim() && idea.q === finder.q.trim()
    ? idea.ids.filter((id) => keepIdea.has(id)).map((id) => hymnList.find((x) => x.id === id)) : [];
  const ideaFirst = ideaRows.length && search.ms && search.partial;
  if (ideaFirst) {
    const inIdea = new Set(ideaRows.map((x) => x.id));
    words = words.filter((x) => !inIdea.has(x.id));
  } else {
    const inWords = new Set(words.map((x) => x.id));
    ideaRows = ideaRows.filter((x) => !inWords.has(x.id));
  }
  const shown = ideaFirst ? ideaRows.concat(words) : words.concat(ideaRows);
  const isIdea = new Set(ideaRows.map((x) => x.id));
  finder.shown = shown;
  const cur = $("hymnPicker").value;
  if (scrollToCurrent && !finder.q) { const i = shown.findIndex((x) => x.id === cur); finder.active = Math.max(0, i); }
  finder.active = Math.min(finder.active, Math.max(0, shown.length - 1));
  const filtered = n || finder.sound !== "all";
  const nW = words.length, q0 = finder.q.trim();
  const wordsSay = !q0 ? `${nW} hymn${nW === 1 ? "" : "s"}`
    : search.ms && search.partial && /[a-z]/i.test(q0) ? (nW ? `No hymn has all of “${q0}”; ${nW} have some of the words` : `No hymn has the words “${q0}”`)
    : nW ? `${nW} hymn${nW === 1 ? "" : "s"} ${nW === 1 ? "matches" : "match"} “${q0}”` : `No hymn has the words “${q0}”`;
  $("finderCount").textContent = !shown.length ? "" : `${wordsSay}${ideaRows.length ? `, ${ideaRows.length} more about this idea` : ""}${filtered ? " in the chosen filters" : ""}`;
  $("finderList").innerHTML = shown.length ? shown.map((x, i) => `${ideaFirst ? (i === 0 ? `<li class="finder-sep" role="presentation">About this idea</li>` : i === ideaRows.length && words.length ? `<li class="finder-sep" role="presentation">Some of the words</li>` : "")
      : i === words.length && ideaRows.length ? `<li class="finder-sep" role="presentation">About this idea</li>` : ""}<li role="option" id="fo-${i}" data-i="${i}" data-id="${escHtml(x.id)}" aria-selected="${i === finder.active}"${x.id === cur ? ' class="current"' : ""}>
      <span class="f-num"><small>${escHtml(x.book)}</small>${escHtml(x.number)}</span>
      <span class="f-title">${isIdea.has(x.id) ? `${escHtml(x.title)}<span class="f-snip">${escHtml(idea.lines.get(x.id) || "")}</span>`
        : `${markMatch(x.title, finder.q)}${finder.q && search.ms ? ((sn) => (sn ? `<span class="f-snip">${sn}</span>` : ""))(snippetFor(x.id, finder.q)) : ""}`}</span>
      <span class="f-sound ${x.sung ? "sung" : "midi"}" title="${x.sung ? "Recorded singers" : "Played on the synth (MIDI)"}">${x.sung ? "Singers" : "MIDI"}</span>
    </li>`).join("")
    : `<li class="finder-empty">No hymn matches${finder.q ? ` “${escHtml(finder.q.trim())}”` : ""}${filtered ? " in these filters. Try all hymnals or all sounds." : "."}</li>`;
  highlight(true, scrollToCurrent);
}

function highlight(scroll = true, center = false) {
  const list = $("finderList");
  list.querySelectorAll('li[aria-selected="true"]').forEach((li) => li.setAttribute("aria-selected", "false"));
  const li = list.querySelector(`#fo-${finder.active}`);
  if (!li) return;
  li.setAttribute("aria-selected", "true");
  $("finderTop").setAttribute("aria-activedescendant", li.id);
  $("finderQuery").setAttribute("aria-activedescendant", li.id);
  if (scroll) li.scrollIntoView({ block: center ? "center" : "nearest" });
}

async function boot() {
  readColors();
  try {
    await loadList();
  } catch {
    $("score").innerHTML = `<p class="status">The hymn list is missing. Run <code>python3 build_web.py</code> in the hymn-satb folder, then reload.</p>`;
    return;
  }
  const picker = $("hymnPicker");
  const asked = decodeURIComponent(location.hash.slice(1));
  const wanted = asked || store.get("hymn", hymnList[0].id);
  picker.value = hymnList.some((x) => x.id === wanted) ? wanted : hymnList[0].id;
  if (EMBED) setupEmbed();
  if (APP) {
    document.body.classList.add("app");
    const v = new URLSearchParams(location.search).get("view");
    if (v && ["tracks", "page", "solfa", "words", "presenter"].includes(v)) state.view = v === "page" && state.staffScroll ? "tracks" : v;
  }
  if (APP && asked && !hymnList.some((x) => x.id === asked)) {
    appWant.id = asked; appWant.missing = true;
    picker.value = hymnList.some((x) => x.id === store.get("hymn")) ? store.get("hymn") : hymnList[0].id;
  } else if (asked && !hymnList.some((x) => x.id === asked)) { if (MAKE) makeFailed(asked, "the Studio has no such hymn"); notInStudio(asked); return; }
  picker.onchange = () => { location.hash = picker.value; loadHymn(hymnList.find((x) => x.id === picker.value)); };
  bindControls();
  try {
    await verovioReady();
    tk = new window.verovio.toolkit();
  } catch {
    $("score").innerHTML = `<p class="status">The score viewer could not load. Check the internet connection and reload the page.</p>`;
    return;
  }
  view = new ScoreView(tk, $("score"));
  if (APP) { state.zoom = APP_ZOOM; state.solfaZoom = APP_ZOOM; state.altZoom = 1; setupPinch(); }
  setupPractice();
  solfa = new SolfaView($("altView"));
  words = new WordsView($("altView"));
  presenter = new Presenter($("stage"), $("measureHost"));
  studio = new Studio($("studio"));
  await document.fonts.ready;
  await loadHymn(hymnList.find((x) => x.id === picker.value));
  bootDone();
  requestAnimationFrame(frame);
  if (MAKE) runMake();
}

/** A hymn the site linked to that the Studio has no score for yet. */
function notInStudio(id) {
  const [book, num] = id.split("-");
  document.title = `${book} ${num || ""} · not in the Studio yet`;
  $("hymnNumber").textContent = num || "";
  $("hymnTitle").textContent = "Not in the Studio yet";
  $("hymnCredits").textContent = `${book} ${num || ""}`;
  document.body.classList.add("missing");
  const ready = hymnList.filter((x) => x.book !== "RECORDED");
  $("workspace").insertAdjacentHTML("beforebegin", `<div class="missing-note">
    <h2>This hymn's music is still being prepared</h2>
    <p>Each hymn is checked note by note before it goes in the Studio, so they are being added one at a time.
    ${EMBED ? "" : "You can still read all the words on the hymn's page."}</p>
    ${ready.length ? `<p>Ready to play now:</p><ul>${ready.map((x) => `<li><a href="${EMBED ? "?embed=1" : "./"}#${x.id}">${x.book} ${x.number}, ${x.title}</a></li>`).join("")}</ul>` : ""}
  </div>`);
  const picker = $("hymnPicker");
  picker.value = "";
  syncFinderLabel();
  picker.onchange = () => { location.hash = picker.value; };
  window.addEventListener("hashchange", () => location.reload(), { once: true });
}

/** The compact player: the score, play, tempo, key and the voices, plus the way out to the full Studio. */
function setupEmbed() {
  document.body.classList.add("embed");
  // inside a hymn page, whose own bar already names the hymn and links out
  // or inside the Android app (?app), which has its own Words / Play / Studio switch
  if (window.self !== window.top || new URLSearchParams(location.search).has("app")) { document.body.classList.add("framed"); return; }
  const out = document.createElement("a");
  out.className = "embed-out";
  out.target = "_blank";
  out.rel = "noopener";
  out.textContent = "Full Studio ↗";
  const sync = () => { out.href = `./${location.hash}`; };
  sync();
  window.addEventListener("hashchange", sync);
  document.querySelector(".toolbar").append(out);
}

async function loadHymn(entry) {
  stopPlayback();
  if (hymn && hymn.id !== entry.id) engine.dropStems(); // the last hymn's singers leave memory
  try {
    hymn = await (await fetch(entry.path).then((r) => (r.ok ? r : Promise.reject(r))).catch(() => fetch(entry.fallback || entry.path))).json();
    hymnWritten = hymn;
  } catch {
    $("score").innerHTML = `<p class="status">This hymn's file is missing: ${entry.path}. Run <code>python3 build_web.py</code>, then reload.</p>`;
    return;
  }
  store.set("hymn", hymn.id);
  syncFinderLabel();
  document.title = `${hymn.number} ${hymn.title}`;
  $("hymnNumber").textContent = hymn.number;
  $("hymnTitle").textContent = hymn.title;
  $("hymnEnglish").textContent = hymn.english || entry.english || "";  // NZK/WN: the English hymn it translates
  $("hymnCredits").textContent = [hymn.poet && `Words by ${hymn.poet}`, hymn.composer && `music by ${hymn.composer}`].filter(Boolean).join(", ");
  $("copyright").textContent = hymn.copyright;
  state.tempo = store.get(`tempo:${hymn.id}`, hymn.tempo);
  state.transpose = store.get(`transpose:${hymn.id}`, 0);
  liveChanges = [];
  $("tempo").value = state.tempo;
  $("tempoLabel").textContent = `${state.tempo} a minute`;
  const saved = store.get(`verses:${hymn.id}`, null);
  state.verses = saved && saved.every((v) => v <= hymn.verses.length) ? saved : hymn.verses.map((_, i) => i + 1);
  state.loop = { on: false, from: 1, to: Math.min(4, hymn.measures) };
  $("loopFrom").max = $("loopTo").max = hymn.measures;
  syncLoopInputs();
  buildVerseChips();
  syncPracticeForHymn();
  await loadManifest();
  rebuild(false);
  await renderAll();
  prepareStems();
}

async function loadManifest() {
  manifest = null;
  stemInfo = new Map();
  try {
    const r = await singers.manifest(`${AUDIO}audio/${hymn.id}/manifest.json`);
    if (r.ok) manifest = await r.json();
    // recordings live in the audio store, whichever copy of the player this is
    if (manifest && AUDIO) manifest.stems.forEach((st) => { st.url = new URL(st.url, AUDIO).href; });
  } catch { /* no sung stems for this hymn */ }
  syncSungControls();
}

const stemTempos = () => [...new Set((manifest?.stems || []).map((s) => s.tempo))].sort((a, b) => a - b);

function syncSungControls() {
  $("sungRow").hidden = !manifest && !anySung();
  const tempos = stemTempos();
  $("sungStatus").textContent = !manifest ? "No sung recording yet."
    : tempos.length ? `Recorded at ${tempos.join(", ")} a minute.` : "No sung recording yet.";
}

// the key each chosen verse is sung in, before any live changes
const verseShift = (v) => state.transpose + (state.lastVerseUp && state.verses.length > 1 && v === state.verses[state.verses.length - 1] ? state.lastVerseUp : 0);

/** Load the sung stems for the chosen verses at the current tempo and keys; other voices use the synth. */
async function prepareStems() {
  stemInfo = new Map();
  $("credit").textContent = "";
  if (!anySung() || !manifest) { rebuild(); return; }
  if (hymn.variant) { // the recordings follow the written rhythm
    toast("The singers are recorded in the written rhythm, so the synth sings the changed rhythm.", 6000);
    engine.setStemBuffers(new Map());
    rebuild();
    return;
  }
  // the recording nearest the slider's tempo; it is stretched to the slider's tempo below
  const tempos = stemTempos();
  const recTempo = tempos.reduce((a, b) => (Math.abs(b - state.tempo) < Math.abs(a - state.tempo) ? b : a), tempos[0]);
  // In sol-fa mode each voice has one recording singing its note names, reused for every verse.
  const solfaWords = state.words === "solfa" || state.singSolfa; // the singers sing their note names
  const wanted = [];
  const missing = [];
  for (const v of state.verses) {
    for (const k of hymnVoices()) {
      if (soundOf(k) !== "sung") continue; // this voice is set to the choir synth or piano
      const shift = verseShift(v);
      const st = manifest.stems.find((x) => x.voice === k && x.tempo === recTempo && (x.transpose ?? 0) === shift && x.verse === (solfaWords ? "solfa" : v));
      if (st) wanted.push({ key: `${k}:${v}:${shift}`, url: st.url, offsetSec: st.offsetSec });
      else if (!solfaWords || v === state.verses[0]) missing.push(solfaWords ? VOICES[k].name : `${VOICES[k].name} ${v}`);
    }
  }
  toast("Loading the singers…", 0);
  try {
    const bufs = await engine.loadStems(wanted, (done, total) => {
      if (total) toast(`Loading the singers… ${done} of ${total}. You can press play now; the synth sings until they arrive.`, 0);
    });
    if (bufs.stale) return; // a newer request (another hymn) has taken over
    // recorded at another tempo: stretch to the slider's tempo, keeping the pitch (everything scales by one ratio)
    const ratio = recTempo / state.tempo;
    if (Math.abs(ratio - 1) > 1e-3) {
      const keys = [...bufs.keys()];
      for (let i = 0; i < keys.length; i++) {
        toast(`Fitting the singers to ${state.tempo} a minute… ${i + 1} of ${keys.length}`, 0);
        await new Promise((r) => setTimeout(r, 0));
        bufs.set(keys[i], engine.stretched(bufs.get(keys[i]), ratio));
      }
    }
    engine.setStemBuffers(bufs);
    for (const w of wanted) if (bufs.has(w.key)) stemInfo.set(w.key, { offsetSec: w.offsetSec * ratio, duration: bufs.get(w.key).duration });
    if (bufs.failed.length) toast(`${bufs.failed.length} recording${bufs.failed.length === 1 ? "" : "s"} did not arrive (slow connection?), so the synth sings ${bufs.failed.length === 1 ? "that part" : "those parts"}. Reload to try again.`, 8000);
    const what = solfaWords ? "singing sol-fa" : "in this key and tempo";
    const far = Math.abs(recTempo / state.tempo - 1) > 0.25 ? ` Recorded at ${recTempo}; this far from it the voices can sound smeared.` : "";
    toast((missing.length ? `Singers ready. Synth until recorded ${what}: ${missing.join(", ")}.` : "Singers ready.") + far, far ? 9000 : 7000, missing.length ? { label: "Record them", fn: renderSingers } : null);
    // the singers' voices must be credited (their licence); the code credit stays with the code
    $("credit").textContent = (manifest.credit || "").replace(/;\s*synthesis code.*$/i, "");
  } catch (err) {
    toast(`The singers could not load: ${err.message}`, 7000);
  }
  rebuild();
}

function setTempo(t) {
  state.tempo = t;
  $("tempo").value = t;
  $("tempoLabel").textContent = `${t} a minute`;
  store.set(`tempo:${hymn.id}`, t);
  if (anySung()) prepareStems(); else rebuild();
}

async function renderSingers() {
  // one recording run per key the chosen verses are sung in (e.g. a raised last verse)
  const byShift = new Map();
  for (const v of state.verses) byShift.set(verseShift(v), [...(byShift.get(verseShift(v)) || []), v]);
  if ([...byShift.keys()].some((s) => Math.abs(s) > 6)) { toast("The singers can be recorded up to six semitones from the written key."); return; }
  for (const [shift, verses] of byShift) {
    toast("Asking the server to record the singers…", 0);
    let res;
    try {
      const what = state.words === "solfa" || state.singSolfa ? "&words=solfa" : `&verses=${verses.join(",")}`;
      res = await fetch(`api/sing?hymn=${hymn.id}&tempo=${state.tempo}${what}&transpose=${shift}`, { method: "POST" });
    } catch {
      toast("Recording the singers needs the hymn server. Start it with python3 server.py in the hymn-satb folder.");
      return;
    }
    const job = await res.json().catch(() => ({}));
    if (!res.ok) { toast(job.error || "The singers could not start."); return; }
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await (await fetch(`api/sing/${job.id}`)).json();
      if (s.status === "done") break;
      if (s.status === "error") { toast(`Recording failed: ${s.error}`, 9000); return; }
      toast(`${s.message || "Recording the singers…"}${shift ? ` (in ${prettyChord(keyFor(shift).name)})` : ""}`, 0);
    }
  }
  await loadManifest();
  await prepareStems();
}

// ---- rendering ------------------------------------------------------------

function xmlOptions(extra = {}) {
  const tracks = visibleTracks();
  return {
    tracks,
    trackWords: tracks.map((t) => state.trackWords[trackKey(t)] !== false),
    words: state.words,
    verse: renderedVerse,
    chords: state.chords,
    unfold: unfolded() ? state.verses : null,
    ...extra,
  };
}

// the accompaniment on a grand staff (right hand, left hand) under the voices, to practise it from
const pianoShown = () => state.accStaff && state.accomp !== "off" && state.view !== "presenter";
let pianoCache = null;
function scoreHymn() {
  if (!pianoShown()) return hymn;
  if (pianoCache?.hymn !== hymn || pianoCache.style !== state.accomp) {
    pianoCache = { hymn, style: state.accomp, h: { ...hymn, voices: { ...hymn.voices, ...pianoVoices(hymn, state.accomp) } } };
  }
  return pianoCache.h;
}
function withPiano(opts) {
  if (!pianoShown()) return opts;
  return { ...opts, tracks: [...opts.tracks, ["R"], ["L"]], trackWords: [...opts.trackWords, false, false] };
}

function wordsVerse() {
  const loc = perf && locate(perf, engine.now());
  return loc ? loc.verse : state.verses[0];
}

async function renderAll() {
  if (!tk || !hymn) return;
  renderedVerse = wordsVerse();
  renderedShift = currentShift(perf && locate(perf, engine.now()));
  syncKeyLabel();
  const transpose = verovioTranspose(renderedShift);
  workspace.dataset.view = state.view;
  document.querySelectorAll(".views .seg").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === state.view)));
  $("stageWrap").hidden = state.view !== "presenter";
  $("pianoPanel").hidden = !state.piano || state.view === "presenter";
  $("nowbar").hidden = !state.nowbar || state.view === "presenter";
  // the docked practice panel sits just above the words bar (or at the bottom when it is hidden)
  document.documentElement.style.setProperty("--nowbar-h", `${$("nowbar").hidden ? 0 : $("nowbar").offsetHeight}px`);
  sheet.hidden = !isScoreView();
  clearSweep();
  $("altView").classList.remove("sf-sweeping");
  $("altView").style.height = "";
  $("altView").hidden = isScoreView() || state.view === "presenter";
  $("altView").style.zoom = String(state.view === "solfa" ? state.solfaZoom : state.altZoom);
  buildHeaders();
  lastSystem = null;
  lastFollowEl = null;
  if (projectorOpen() && state.view !== "presenter") prepareStage();
  if (state.view === "presenter") {
    positionHeaders(null);
    await prepareStage();
  } else if (state.view === "solfa") {
    const voices = visibleVoices();
    solfa.render(hymn, { voices, words: state.words, widthScale: appWide(state.solfaZoom), verse: renderedVerse, chords: state.chords, wordsUnder: state.solfaWordsAt === "top" ? voices[0] : state.solfaWordsAt === "bottom" ? voices[voices.length - 1] : "every", chordName: (n) => chordLabel(n) });
    if (state.showSync) {
      const marked = new Set(syncopations(hymn).map((x) => `${x.voice}:${x.q}`));
      for (const c of solfa.cells) if (marked.has(`${c.voice}:${c.on}`)) c.el?.classList.add("sync");
    }
    setupSolfaSweep();
    positionHeaders(null);
  } else if (state.view === "words") {
    words.render(hymn, { fit: APP, words: state.words === "none" ? "all" : state.words, verse: renderedVerse, chords: state.chords, chordName: (n) => chordLabel(n) });
    positionHeaders(null);
  } else {
    const opts = withPiano(xmlOptions());
    // pinched bigger in the app: the sheet itself is wider than the screen, and scrolls sideways
    sheet.style.width = state.view === "page" && appWide(state.zoom) > 1 ? `${Math.floor((viewport.clientWidth - 8) * appWide(state.zoom))}px` : "";
    view.render(buildMusicXML(scoreHymn(), opts), { mode: state.view, zoom: state.zoom, width: (viewport.clientWidth - 8) * appWide(state.zoom), tracks: opts.tracks, barOffset: hymn.pickup > 0 ? 1 : 0, transpose });
    buildLane();
    setupSweep();
    positionHeaders(view.systems[0]);
    drawLoopBoxes();
    drawSyncMarks();
  }
  lastLineKey = "";
  paint(true);
}

async function prepareStage() {
  const opts = xmlOptions();
  const key = JSON.stringify([hymn.id, opts, state.words === "current" ? renderedVerse : 0, renderedShift]);
  await presenter.prepare(tk, buildMusicXML(hymn, opts), key, hymn.pickup > 0 ? 1 : 0, verovioTranspose(renderedShift));
}

// ---- track headers ---------------------------------------------------------

const iconBtn = (act, ch, pressed, label) =>
  `<button class="ib" data-act="${act}" ${ch ? `data-ch="${ch}"` : ""} aria-pressed="${pressed}" aria-label="${label}" title="${label}">${ICON[act]}</button>`;

function voiceRow(k, single) {
  const name = k === "acc" ? "Accompaniment" : VOICES[k].name;
  // on a shared staff each voice is one compact row, led by its coloured letter
  return `<div class="track-voice${single ? "" : " compact"}" style="--vc: var(--${k})">
      ${single ? "" : `<span class="vname" title="${name}">${k === "acc" ? "Acc" : k}</span>`}
      ${iconBtn("mute", k, !!state.mute[k], `Mute ${name}`)}
      ${iconBtn("solo", k, !!state.solo[k], `Hear only soloed voices: ${name}`)}
      <input type="range" min="0" max="1" step="0.01" value="${state.levels[k]}" data-ch="${k}" aria-label="${name} volume">
      ${k === "acc" ? "" : `<select class="vsound" data-sound="${k}" aria-label="${name} sounds like" title="How ${name} sounds">
        <option value="sung" ${soundOf(k) === "sung" ? "selected" : ""}>Singer</option>
        <option value="choir" ${soundOf(k) === "choir" ? "selected" : ""}>Choir aah</option>
        <option value="piano" ${soundOf(k) === "piano" ? "selected" : ""}>Piano</option>
      </select>`}
    </div>`;
}

function buildHeaders() {
  headersEl.innerHTML = "";
  // fold the sidebar into a slim rail of voice colours, or open it again
  workspace.classList.toggle("heads-collapsed", state.headsCollapsed);
  const fold = document.createElement("button");
  fold.className = "heads-toggle";
  fold.setAttribute("aria-label", state.headsCollapsed ? "Show the track controls" : "Hide the track controls");
  fold.title = fold.getAttribute("aria-label");
  fold.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${state.headsCollapsed ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6"}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  fold.onclick = () => { state.headsCollapsed = !state.headsCollapsed; save("headsCollapsed"); renderAll(); };
  headersEl.append(fold);
  if (state.headsCollapsed) {
    const rail = document.createElement("div");
    rail.className = "heads-rail";
    rail.innerHTML = visibleTracks().flat().map((k) => `<span style="--c: var(--${k})" title="${VOICES[k].name}">${k}</span>`).join("");
    headersEl.append(rail);
    return;
  }
  const tracks = visibleTracks();
  tracks.forEach((t, i) => {
    const key = trackKey(t);
    const el = document.createElement("div");
    el.className = `track${t.length > 1 ? " joined" : ""}`;
    el.dataset.key = key;
    el.style.setProperty("--c", `var(--${t[0]})`);
    if (t.length > 1) el.style.setProperty("--c2", `var(--${t[1]})`);
    const rows = t.map((k) => voiceRow(k, t.length === 1));
    el.innerHTML = `
      <div class="track-title"><span class="name">${trackName(t)}</span>
        ${iconBtn("words", "", state.trackWords[key] !== false, `Words under the ${trackName(t)} staff`)}
        ${iconBtn("hide", "", false, `Hide the ${trackName(t)} staff`)}
      </div>
      ${rows[0]}
      ${rows[1] || ""}`;
    headersEl.append(el);
  });
  // hidden staves stay in the list, so they can be brought back
  for (const t of tracksOfHymn().filter((x) => state.hidden.includes(trackKey(x)))) {
    const el = document.createElement("div");
    el.className = "track is-hidden";
    el.dataset.key = trackKey(t);
    el.style.setProperty("--c", `var(--${t[0]})`);
    el.innerHTML = `<div class="track-title"><span class="name">${trackName(t)}</span>${iconBtn("show", "", false, `Show the ${trackName(t)} staff`)}</div>`;
    headersEl.append(el);
  }
  const acc = document.createElement("div");
  acc.className = "track acc";
  acc.dataset.key = "acc";
  acc.style.setProperty("--c", "var(--acc)");
  acc.innerHTML = `
    <div class="track-title"><span class="name">Accompaniment</span></div>
    <select data-act="style" aria-label="Accompaniment style">${Object.entries(ACCOMP_STYLES).map(([v, l]) => `<option value="${v}" ${v === state.accomp ? "selected" : ""}>${l}</option>`).join("")}</select>
    ${voiceRow("acc", true)}`;
  headersEl.append(acc);

  headersEl.querySelectorAll("button[data-act], select[data-act], input[type=range]").forEach((c) => {
    const key = c.closest(".track")?.dataset.key;
    if (c.type === "range") {
      c.oninput = () => { state.levels[c.dataset.ch] = Number(c.value); save("levels"); applyMix(); };
      return;
    }
    const act = c.dataset.act;
    if (act === "mute" || act === "solo") {
      c.onclick = () => {
        const m = state[act];
        m[c.dataset.ch] = !m[c.dataset.ch];
        c.setAttribute("aria-pressed", String(m[c.dataset.ch]));
        save(act);
        applyMix();
      };
    } else if (act === "words") {
      c.onclick = () => { state.trackWords[key] = state.trackWords[key] === false; save("trackWords"); renderAll(); };
    } else if (act === "hide") {
      c.onclick = () => {
        if (visibleTracks().length === 1) return toast("At least one staff stays on the page.");
        state.hidden.push(key);
        save("hidden");
        renderAll();
      };
    } else if (act === "show") {
      c.onclick = () => { state.hidden = state.hidden.filter((k) => k !== key); save("hidden"); renderAll(); };
    } else if (act === "style") {
      c.onchange = () => { state.accomp = c.value; save("accomp"); if (c.value !== "off") engine.loadPiano(); rebuild(); if (state.accStaff) renderAll(); };
    }
  });
  headersEl.querySelectorAll("select[data-sound]").forEach((sel) => {
    sel.onchange = () => {
      state.voiceSounds[sel.dataset.sound] = sel.value;
      save("voiceSounds");
      if (sel.value === "piano") engine.loadPiano();
      applyMix();
      syncSungControls();
      prepareStems();
    };
  });
  syncStavesMenu();
}

// ---- staves: the layout of the voices, chosen in the toolbar ------------------------------------------
function setStaves(layout) {
  state.tracks = layout.split("|").map((t) => t.split(""));
  for (const t of state.tracks) {
    const k = trackKey(t);
    if (t.length > 1 && state.trackWords[k] === undefined) state.trackWords[k] = state.trackWords[t[0]] !== false;
  }
  // a voice hidden on its own stays hidden; a joined staff starts shown
  state.hidden = state.hidden.filter((k) => state.tracks.some((t) => trackKey(t) === k));
  save("tracks", "trackWords", "hidden");
  renderAll();
  window.scrollTo({ top: 0 });
}

// where the words go: under the top staff only, below the bottom staff only, or under every staff
function wordsAt() {
  const keys = visibleTracks().map(trackKey);
  const on = keys.map((k) => state.trackWords[k] !== false);
  if (on.every(Boolean)) return "every";
  if (on.filter(Boolean).length === 1 && on[0]) return "top";
  if (on.filter(Boolean).length === 1 && on[on.length - 1]) return "bottom";
  return "";
}

function setWordsAt(where) {
  // in the sol-fa view the same menu places its words: under every voice, or the top one only
  if (state.view === "solfa") { state.solfaWordsAt = where; save("solfaWordsAt"); renderAll(); return; }
  const keys = visibleTracks().map(trackKey);
  keys.forEach((k, i) => { state.trackWords[k] = where === "every" || (where === "top" ? i === 0 : i === keys.length - 1); });
  save("trackWords");
  renderAll();
}

function syncStavesMenu() {
  const at = wordsAt();
  document.querySelectorAll("#stavesMenu [data-words-at]").forEach((b) => {
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(b.dataset.wordsAt === at));
  });
  const cur = state.tracks.map(trackKey).join("|");
  const voices = Object.keys(hymn?.voices || {});
  document.querySelectorAll("#stavesMenu [data-layout]").forEach((b) => {
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(b.dataset.layout === cur));
    // a melody-only song has nothing to lay out
    b.hidden = voices.length < 4;
  });
  const ps = document.querySelector("#stavesMenu [data-acc-staff]");
  ps.setAttribute("role", "menuitemcheckbox");
  ps.setAttribute("aria-checked", String(pianoShown()));
  $("stavesMenu").hidden = voices.length < 4;
}

/** Line the headers up with the staves of a system (tracks: the only one; page: the one playing). */
function positionHeaders(system) {
  const items = [...headersEl.children].filter((el) => !el.classList.contains("heads-toggle"));
  if (state.headsCollapsed) return;
  const aligned = isScoreView() && system;
  headersEl.classList.toggle("stacked", !aligned);
  if (!aligned) {
    headersEl.style.height = "";
    items.forEach((el) => { el.style.top = ""; el.style.height = ""; });
    return;
  }
  const offset = sheet.offsetTop;
  const staffEls = items.filter((el) => el.classList.contains("track") && !el.classList.contains("acc") && !el.classList.contains("is-hidden"));
  const acc = items.find((el) => el.classList.contains("acc"));
  const rest = items.filter((el) => el.classList.contains("is-hidden") || (el === acc && !pianoShown()));
  const staves = system.staves;
  const sysBottom = system.box.y + system.box.h + offset;
  let bottom = 0;
  staffEls.forEach((el, i) => {
    const st = staves[i];
    if (!st) return;
    const top = (i === 0 ? system.box.y : st.top - 26) + offset;
    const nextTop = staves[i + 1] ? staves[i + 1].top - 26 + offset : sysBottom;
    el.style.top = `${top}px`;
    el.style.height = `${Math.max(58, nextTop - top)}px`;
    bottom = Math.max(bottom, top + Math.max(58, nextTop - top));
  });
  // the accompaniment's controls sit beside its two staves
  const pianoTop = staves[staffEls.length];
  if (acc && pianoShown() && pianoTop) {
    const top = pianoTop.top - 26 + offset;
    acc.style.top = `${top}px`;
    acc.style.height = `${Math.max(58, sysBottom - top)}px`;
    bottom = Math.max(bottom, top + Math.max(58, sysBottom - top));
  }
  // a box too short for its controls (staves close together) puts each voice on one row
  staffEls.forEach((el) => {
    el.classList.remove("tight");
    if (el.scrollHeight > el.clientHeight + 1) el.classList.add("tight");
  });
  let y = Math.max(bottom, state.view === "tracks" ? $("lane").offsetTop : sysBottom);
  for (const el of rest) {
    el.style.top = `${y}px`;
    el.style.height = "auto";
    y += el.offsetHeight;
  }
  headersEl.style.height = `${y + 8}px`;
}

// chord lane under the staves in tracks view
function buildLane() {
  const lane = $("lane");
  lane.innerHTML = "";
  if (state.view !== "tracks") return;
  lane.style.width = `${sheet.offsetWidth}px`;
  const copies = unfolded() ? state.verses.length : 1;
  const all = Array.from({ length: copies }, (_, j) => hymn.chords.map((c) => ({ ...c, q: c.q + j * hymn.totalQ }))).flat();
  all.forEach((c, i) => {
    const x0 = view.xAt(c.q);
    const x1 = all[i + 1] ? view.xAt(all[i + 1].q) : sheet.offsetWidth - 40;
    const b = document.createElement("div");
    b.className = "blk";
    b.style.left = `${x0 - 6}px`;
    b.style.width = `${Math.max(24, x1 - x0)}px`;
    b.textContent = chordLabel(c.name);
    lane.append(b);
  });
}

// ---- playback ------------------------------------------------------------

function applyMix() {
  for (const ch of CH) {
    engine.setLevel(ch, state.levels[ch] ?? 0.8);
    engine.setMuted(ch, !heard(ch));
    engine.setPan(ch, state.pans[ch] ?? 0);
  }
  engine.voiceSounds = Object.fromEntries("SATB".split("").map((k) => [k, soundOf(k) === "piano" ? "piano" : "choir"]));
}

function rebuild(keep = true) {
  if (!hymn) return;
  const wasPlaying = engine.playing;
  const loc = keep && perf ? locate(perf, engine.now()) : null;
  const stems = anySung() ? stemInfo : new Map();
  perf = performance(hymn, { tempo: state.tempo, verses: state.verses, accomp: state.accomp, countIn: state.countIn, countAt: state.countAt, introVoice: state.introVoice, stems, intro: state.intro, interlude: state.interlude, shiftAt, metronome: state.metronome });
  engine.load(perf.events);
  waterfall.setPerformance(perf);
  applyLoop();
  let t = 0;
  if (loc) {
    const k = perf.passes.findIndex((p) => p.kind === loc.kind && p.verse === loc.verse);
    if (k >= 0) t = passTime(perf, k, loc.q);
  }
  if (wasPlaying) engine.play(t);
  else engine.pausedAt = t;
  paint(true);
}

function seek(t) {
  if (engine.playing) engine.play(t);
  else engine.pausedAt = t;
  paint(true);
}

function setPlaying(on) {
  $("playIcon").setAttribute("d", on ? "M6 4h4v16H6zM14 4h4v16h-4z" : "M7 4.5v15l13-7.5z");
  $("playBtn").setAttribute("aria-label", on ? "Pause" : "Play");
}

async function togglePlay() {
  if (!perf) return;
  if (engine.playing) { engine.pause(); setPlaying(false); return; }
  engine.ensure();
  applyMix();
  if (state.accomp !== "off" || anyPiano() || state.intro !== "none" || state.interlude !== "none") engine.loadPiano();
  let from = engine.pausedAt ?? 0;
  if (from >= perf.total - 0.05) from = 0;
  await engine.play(from);
  setPlaying(true);
}

function stopPlayback() {
  engine.stop();
  if (liveChanges.length) { liveChanges = []; if (perf) rebuild(false); } // live key changes last one run
  setPlaying(false);
  if (recording) finishRecording();
  view?.clear();
  solfa?.clear();
  words?.clear();
  lastSystem = null;
  lastFollowEl = null;
  paint(true);
  viewport.scrollLeft = 0;
  window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
}

// ---- syncopation -----------------------------------------------------------

/** Mark each syncopated note in the score (every written-out copy of it). */
function drawSyncMarks() {
  const layer = $("syncLayer");
  layer.innerHTML = "";
  if (!state.showSync || !view) return;
  const copies = unfolded() ? state.verses.length : 1;
  for (const x of syncopations(hymn)) {
    for (let j = 0; j < copies; j++) {
      const n = view.notes.find((v) => v.voice === x.voice && Math.abs(v.on - (x.q + j * hymn.totalQ)) < 1e-6);
      if (!n?.box) continue;
      const m = document.createElement("span");
      m.className = "sync-mark";
      m.style.setProperty("--c", `var(--${x.voice})`);
      m.style.left = `${n.box.x + n.box.w / 2}px`;
      m.style.top = `${n.box.y - 4}px`;
      m.title = `Syncopation: ${VOICES[x.voice].name}, bar ${x.m}. The note starts off the beat and is held through a stronger beat.`;
      layer.append(m);
    }
  }
}

function syncSummary() {
  const found = syncopations(hymn);
  if (!found.length) return "No syncopation here: every note starts on the beat, or ends before the next stronger beat.";
  const bars = [...new Set(found.map((x) => x.m))].sort((a, b) => a - b);
  return `${found.length} syncopated note${found.length === 1 ? "" : "s"}, in bar${bars.length === 1 ? "" : "s"} ${bars.join(", ")}.`;
}

function syncRhythmButtons() {
  $("addSync").textContent = `Add syncopation to bars ${state.loop.from} to ${state.loop.to}`;
  $("restoreRhythm").hidden = !hymn?.variant;
}

function addSyncopation() {
  const before = hymn;
  hymn = syncopate(hymn, state.loop.from, state.loop.to);
  if (!hymn.variant.bars) {
    hymn = before;
    toast(`Bars ${state.loop.from} to ${state.loop.to} have no note on beat 2 that can come half a beat early in every voice. Try other bars.`, 7000);
    return;
  }
  state.showSync = true;
  $("showSync").checked = true;
  save("showSync");
  syncRhythmButtons();
  if (anySung()) prepareStems(); else rebuild();
  renderAll();
  toast(`Syncopation added in ${hymn.variant.bars} bar${hymn.variant.bars === 1 ? "" : "s"}. ${syncSummary()}`, 7000);
}

function restoreRhythm() {
  hymn = hymnWritten;
  syncRhythmButtons();
  if (anySung()) prepareStems(); else rebuild();
  renderAll();
  toast("Back to the written rhythm.", 3000);
}

// ---- loop ------------------------------------------------------------------

function syncLoopInputs() {
  $("loopBtn").setAttribute("aria-pressed", String(state.loop.on));
  $("loopFrom").value = state.loop.from;
  $("loopTo").value = state.loop.to;
  syncRhythmButtons();
}

function applyLoop() {
  if (!perf || !hymn) return;
  if (!state.loop.on) { engine.setLoop(null); drawLoopBoxes(); return; }
  const loc = locate(perf, engine.now());
  const [a, b] = barSpan(hymn, perf, loc ? loc.pass : 0, state.loop.from, state.loop.to);
  engine.setLoop(a, b);
  if (!engine.playing && (engine.pausedAt < a || engine.pausedAt >= b)) engine.pausedAt = a;
  drawLoopBoxes();
}

function clearLoop() {
  setLoop(state.loop.from, state.loop.to, false);
  toast("Selection cleared.", 2000);
}

function setLoop(from, to, on = true) {
  const lo = Math.max(1, Math.min(from, to));
  const hi = Math.min(hymn.measures, Math.max(from, to));
  state.loop = { on, from: lo, to: hi };
  syncLoopInputs();
  applyLoop();
}

function drawLoopBoxes(pending) {
  const layer = $("loopLayer");
  layer.innerHTML = "";
  if (!view || !isScoreView()) return;
  const range = pending || (state.loop.on ? state.loop : null);
  if (!range) return;
  const off = unfolded() && !pending ? (verseOrdinal(perf && locate(perf, engine.now())) ?? 0) * hymn.measures : 0;
  const boxes = view.barBoxes(range.from + off, range.to + off);
  boxes.forEach((b, i) => {
    const d = document.createElement("div");
    d.className = `loopbox${pending ? " pending" : ""}${i === 0 ? " first" : ""}${i === boxes.length - 1 ? " last" : ""}`;
    Object.assign(d.style, { left: `${b.x}px`, top: `${b.y - 10}px`, width: `${b.w}px`, height: `${b.h + 20}px` });
    layer.append(d);
    if (pending) return;
    if (i === boxes.length - 1) {
      const x = document.createElement("button");
      x.className = "loop-clear";
      x.textContent = "×";
      x.title = "Clear the selection (Esc)";
      x.setAttribute("aria-label", "Clear the selection");
      x.style.left = `${b.x + b.w - 11}px`;
      x.style.top = `${b.y - 22}px`;
      x.addEventListener("pointerdown", (e) => e.stopPropagation());
      x.onclick = clearLoop;
      layer.append(x);
    }
    // grab either edge to widen or narrow the loop
    for (const edge of [i === 0 ? "from" : null, i === boxes.length - 1 ? "to" : null].filter(Boolean)) {
      const hnd = document.createElement("div");
      hnd.className = `loop-edge ${edge}`;
      hnd.title = edge === "from" ? "Drag to move the start of the loop" : "Drag to move the end of the loop";
      hnd.style.top = `${b.y - 10}px`;
      hnd.style.height = `${b.h + 20}px`;
      hnd.style.left = `${edge === "from" ? b.x - 7 : b.x + b.w - 7}px`;
      hnd.addEventListener("pointerdown", (e) => startEdgeDrag(e, edge));
      layer.append(hnd);
    }
  });
}

function startEdgeDrag(e, edge) {
  e.stopPropagation();
  e.preventDefault();
  const r = () => $("score").getBoundingClientRect();
  const y = e.clientY;
  const onMove = (ev) => {
    const raw = view.barAt(ev.clientX - r().left, y - r().top) ?? view.barAt(ev.clientX - r().left, ev.clientY - r().top);
    if (!raw) return;
    const bar = ((raw - 1) % hymn.measures) + 1; // written out: the same bar in any verse
    const from = edge === "from" ? Math.min(bar, state.loop.to) : state.loop.from;
    const to = edge === "to" ? Math.max(bar, state.loop.from) : state.loop.to;
    if (from !== state.loop.from || to !== state.loop.to) setLoop(from, to, true);
  };
  const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); toast(`Looping bars ${state.loop.from} to ${state.loop.to}`); };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

// drag across bars to choose a loop; a plain click on a note jumps there
let drag = null;
sheet.addEventListener("pointerdown", (e) => {
  if (!view || e.button !== 0 || e.target.closest(".loop-edge")) return;
  const r = $("score").getBoundingClientRect();
  // in the app a finger scrolls and pinches; tapping a note still plays from there
  const bar = APP && e.pointerType === "touch" ? null : view.barAt(e.clientX - r.left, e.clientY - r.top);
  drag = { bar, x: e.clientX, moved: false, note: e.target.closest("g.note") };
});
window.addEventListener("pointermove", (e) => {
  if (!drag || drag.bar === null) return;
  if (!drag.moved && Math.abs(e.clientX - drag.x) < 8) return;
  drag.moved = true;
  sheet.classList.add("selecting");
  const r = $("score").getBoundingClientRect();
  const bar = view.barAt(e.clientX - r.left, e.clientY - r.top) ?? drag.last ?? drag.bar;
  drag.last = bar;
  drawLoopBoxes({ from: Math.min(drag.bar, bar), to: Math.max(drag.bar, bar) });
});
window.addEventListener("pointerup", () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  sheet.classList.remove("selecting");
  const inVerse = (b) => ((b - 1) % hymn.measures) + 1;
  if (d.moved && d.bar !== null) { setLoop(inVerse(d.bar), inVerse(d.last ?? d.bar)); toast(`Looping bars ${state.loop.from} to ${state.loop.to}. Drag its edges to change it.`); return; }
  if (d.note && perf) {
    const n = view.notes.find((x) => x.el === d.note);
    if (n) seek(timeOfScoreQ(n.on));
  }
});
// in sol-fa and words views, click a note or word to jump there
$("altView").addEventListener("click", (e) => {
  const t = e.target.closest("[data-q], [data-c]");
  if (!t || !perf) return;
  const q = t.dataset.q !== undefined ? Number(t.dataset.q) : solfa.cells[Number(t.dataset.c)]?.on;
  if (q === undefined) return;
  const loc = locate(perf, engine.now());
  const k = loc && loc.kind === "verse" ? loc.pass : perf.passes.findIndex((p) => p.kind === "verse");
  seek(passTime(perf, k, q));
});

// ---- the moving place ----------------------------------------------------

let lastT = -1;
let making = false; // a video is being made: its frames are drawn by the maker, not by the clock
function frame() {
  requestAnimationFrame(frame);
  if (making) return;
  paint(false);
  if (state.practice) drawPractice();
}

// ---- practice: feel the meter, sing in tune -----------------------------------

let conductor = null;
let listener = null;
let quiz = null;          // { tune, engine, answered, t0 }
let quizScore = { right: 0, asked: 0 };
let trace = [];           // your recent pitch: [{t, p, target, off}]
let tuneTally = { inTune: 0, sung: 0, pass: -1 };
let taps = [];

function setupPractice() {
  conductor = new Conductor($("conductor"));
  const panel = $("practicePanel");
  const showTab = (tab) => {
    state.practiceTab = tab;
    save("practiceTab");
    $("tabMeter").setAttribute("aria-selected", String(tab === "meter"));
    $("tabSing").setAttribute("aria-selected", String(tab === "sing"));
    $("prMeter").hidden = tab !== "meter";
    $("prSing").hidden = tab !== "sing";
    applyMix();
  };
  $("tabMeter").onclick = () => showTab("meter");
  $("tabSing").onclick = () => showTab("sing");
  const b = $("practiceBtn");
  const sync = () => { panel.hidden = !state.practice; b.setAttribute("aria-pressed", String(state.practice)); };
  b.onclick = () => { state.practice = !state.practice; save("practice"); sync(); if (!state.practice) stopListening(); applyMix(); };
  $("practiceClose").onclick = () => { state.practice = false; save("practice"); sync(); stopListening(); applyMix(); };
  sync();
  showTab(state.practiceTab);
  $("metronome").checked = state.metronome;
  $("metronome").onchange = (e) => { state.metronome = e.target.checked; save("metronome"); rebuild(); };
  $("tapPad").onclick = () => tap();
  document.addEventListener("keydown", (e) => {
    if ((e.key === "t" || e.key === "T") && state.practice && state.practiceTab === "meter" && !e.target.closest("input, select, textarea")) { e.preventDefault(); tap(); }
  });
  $("quizPlay").onclick = playQuiz;
  $("quizChoices").querySelectorAll("button").forEach((btn) => { btn.onclick = () => answerQuiz(btn); });
  $("micBtn").onclick = () => (listener?.on ? stopListening() : startListening());
  for (const id of ["muteMine", "anyOctave"]) {
    $(id).checked = state[id];
    $(id).onchange = (e) => { state[id] = e.target.checked; save(id); applyMix(); };
  }
  $("singVoice").onchange = (e) => { state.singVoice = e.target.value; save("singVoice"); trace = []; applyMix(); };
}

function syncPracticeForHymn() {
  const f = feel(hymn.time);
  conductor.setBeats(f.beats);
  $("meterLabel").textContent = f.label;
  const voices = hymnVoices();
  if (!voices.includes(state.singVoice)) state.singVoice = voices[0];
  $("singVoice").innerHTML = voices.map((k) => `<option value="${k}" ${k === state.singVoice ? "selected" : ""}>${VOICES[k].name}</option>`).join("");
}

/** The beat being played now, from the performance's beat grid. */
function beatNow(t) {
  if (!perf?.beats?.length) return null;
  let i = -1;
  for (let k = 0; k < perf.beats.length; k++) { if (perf.beats[k].t <= t + 1e-6) i = k; else break; }
  if (i < 0) return null;
  const b = perf.beats[i];
  const next = perf.beats[i + 1];
  const len = next ? next.t - b.t : 60 / state.tempo;
  return { ...b, f: Math.min(0.999, (t - b.t) / len) };
}

function drawPractice() {
  if (state.practiceTab === "meter") {
    if (quiz && !quiz.answered) { $("beatNum").textContent = "?"; return; } // no clues while guessing
    const b = engine.playing || engine.pausedAt ? beatNow(engine.now()) : null;
    const beat = b ? b.beat : 0;
    conductor.show(beat, b ? b.f : 0);
    $("beatNum").textContent = beat + 1;
    $("beatNum").classList.toggle("one", beat === 0);
    return;
  }
  // sing in tune: your pitch against the note your part has now
  const c = $("pitchLane");
  const w = c.clientWidth;
  const h = c.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const voice = state.singVoice;
  const notes = (perf?.events || []).filter((e) => e.ch === voice && !e.stem && e.p > 0)
    .map((e) => ({ t: e.t, dur: e.dur, p: e.p, label: hymn.solfa?.[voice]?.[e.i] || "" }));
  // what you sing reaches the microphone a little after the sound left the speakers
  // (engine.now() is already what the speakers are playing)
  const lag = engine.ctx ? 0.03 : 0;
  // while the music plays, your voice is drawn against its clock; stopped, the lane is a tuner
  const tuner = !engine.playing;
  if (tuner !== drawPractice.tuner) { trace = []; drawPractice.tuner = tuner; }
  const now = tuner ? window.performance.now() / 1000 : engine.now(); // window.: core.js exports its own performance()
  if (listener?.on && (frame.tick = (frame.tick || 0) + 1) % 2 === 0) {
    const sung = listener.read();
    const t = tuner ? now : now - lag;
    const target = tuner ? null : notes.find((n) => n.t <= t && t < n.t + n.dur) || null;
    const off = sung !== null && target ? centsOff(sung, target.p, state.anyOctave) : null;
    trace.push({ t, p: sung, target: target ? target.p : null, off });
    while (trace.length && trace[0].t < now - 8) trace.shift();
    const loc = engine.playing ? locate(perf, t) : null;
    if (loc && loc.pass !== tuneTally.pass) tuneTally = { inTune: 0, sung: 0, pass: loc.pass };
    if (engine.playing && target && sung !== null) { tuneTally.sung++; if (Math.abs(off) <= 50) tuneTally.inTune++; }
    $("pitchReadout").textContent = sung === null ? (tuner ? "Sing a note, or press play and sing your part" : "Listening…")
      : tuner ? `You're singing ${noteName(sung)}` : !target ? `Rest (you're singing ${noteName(sung)})` : describeCents(off);
    $("tuneScore").textContent = tuneTally.sung > 20 ? `In tune ${Math.round((100 * tuneTally.inTune) / tuneTally.sung)}% of this verse` : "";
  }
  drawLane(g, w, h, now, tuner ? [] : notes, trace, colors, colors[voice], state.anyOctave);
}

function describeCents(off) {
  const a = Math.abs(off);
  if (a <= 25) return "In tune";
  if (a <= 50) return `${off > 0 ? "A little sharp" : "A little flat"} (${off > 0 ? "+" : "−"}${Math.round(a)} cents)`;
  const semis = Math.round(a / 100);
  return `${off > 0 ? "Too high" : "Too low"} by ${semis === 1 ? "a semitone" : `${semis} semitones`}`;
}

async function startListening() {
  engine.ensure();
  listener = listener || new PitchListener();
  try {
    await engine.ctx.resume(); // the audio engine sleeps until something wakes it
    await listener.start(engine.ctx);
  } catch {
    toast("The microphone is not available. Allow it for this page and try again.", 6000);
    return;
  }
  $("micBtn").textContent = "Stop listening";
  trace = [];
  applyMix();
  toast(state.muteMine ? `Listening. Your part (${VOICES[state.singVoice].name}) is muted so you can sing it.` : "Listening.", 4000);
}

function stopListening() {
  if (!listener?.on) return;
  listener.stop();
  $("micBtn").textContent = "Start listening";
  $("pitchReadout").textContent = "Not listening";
  applyMix();
}

function tap() {
  const pad = $("tapPad");
  pad.classList.add("hit");
  setTimeout(() => pad.classList.remove("hit"), 120);
  let grid = null;
  let t = null;
  if (quiz && quiz.engine.playing) {
    t = quiz.engine.now();
    grid = quiz.beats;
  } else if (engine.playing) {
    t = engine.now();
    grid = perf.beats;
  }
  if (!grid) { $("tapFeedback").textContent = "Press play first, then tap on every beat."; return; }
  const near = grid.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  const ms = Math.round((t - near.t) * 1000);
  taps = [...taps.slice(-7), Math.abs(ms)];
  const avg = Math.round(taps.reduce((a, b) => a + b, 0) / taps.length);
  const when = Math.abs(ms) <= 40 ? "Right on the beat" : ms > 0 ? `${ms} ms late` : `${-ms} ms early`;
  const which = quiz && quiz.engine.playing && !quiz.answered ? "" : near.beat === 0 ? " That was beat 1, the strong beat." : ` That was beat ${near.beat + 1}.`;
  $("tapFeedback").textContent = `${when}.${which} Average over your last ${taps.length}: ${avg} ms.`;
}

async function playQuiz() {
  if (engine.playing) { engine.pause(); setPlaying(false); }
  // until it is answered, the button plays the same tune again
  if (quiz && !quiz.answered) { quiz.engine.stop(); quiz.engine.play(0); return; }
  quiz?.engine.stop();
  const tune = mysteryTune();
  const qe = new Engine();
  qe.ensure();
  await qe.loadPiano();
  qe.load(tune.events);
  quiz = { tune, engine: qe, answered: false, beats: Array.from({ length: Math.round(tune.length / tune.beatSec) }, (_, i) => ({ t: i * tune.beatSec, beat: i % tune.beats })) };
  $("quizChoices").querySelectorAll("button").forEach((b) => b.classList.remove("right", "wrong"));
  $("quizFeedback").textContent = "Listen for the strong beat, then choose. You can tap along to help.";
  workspace.classList.add("quiz-hidden"); // no peeking at the score
  $("quizPlay").textContent = "Play it again";
  qe.play(0);
}

function answerQuiz(btn) {
  if (!quiz || quiz.answered) return;
  quiz.answered = true;
  workspace.classList.remove("quiz-hidden");
  const right = `${quiz.tune.time[0]}/${quiz.tune.time[1]}`;
  quizScore.asked++;
  if (btn.dataset.time === right) quizScore.right++;
  $("quizChoices").querySelectorAll("button").forEach((b) => {
    if (b.dataset.time === right) b.classList.add("right");
    else if (b === btn) b.classList.add("wrong");
  });
  $("quizFeedback").textContent = `${btn.dataset.time === right ? "Yes!" : `It was ${right}.`} ${meterHint(quiz.tune.time)} Score: ${quizScore.right} of ${quizScore.asked}.`;
  $("quizPlay").textContent = "New tune";
}

// tAt: draw the moment at that performance time instead of the playing one (frames of a video made offline)
function paint(force, tAt) {
  if (!perf || !hymn) return;
  const t = tAt ?? engine.now();
  if (tAt === undefined && engine.playing && t >= perf.total && !engine.loop) {
    engine.stop();
    setPlaying(false);
    if (recording) setTimeout(finishRecording, 1200);
  }
  const moving = engine.playing || force || Math.abs(t - lastT) > 1e-3;
  if (!moving && !stageWanted()) return;
  lastT = t;
  // once the introduction has played, nothing is lit until the singing starts (the count-in, if any, runs then):
  // a lit note would look like the place to start singing
  const at = locate(perf, t);
  const loc = at?.done ? null : at;
  if (state.words === "current" && !unfolded() && loc && loc.verse !== renderedVerse) {
    if (state.view !== "presenter") { renderAll(); return; }
    // the presenter only needs its score again, with this verse's words
    renderedVerse = loc.verse;
    prepareStage().then(() => paint(true));
  }
  if (currentShift(loc) !== renderedShift) { renderAll(); return; } // the key changed here
  const refrainQ = hymn.marks.find((m) => /refrain|chorus/i.test(m.text))?.q ?? Infinity;
  const q = loc ? loc.q : null;
  const sung = loc && loc.kind === "verse";
  const verseN = !sung ? -1 : state.words === "solfa" ? 0 : q >= refrainQ || state.words === "current" || unfolded() ? 1 : loc.verse;
  const sq = scoreQ(loc); // the position in the score as drawn (written out or stacked)
  const copy = unfolded() && loc ? verseOrdinal(loc) ?? 0 : 0;
  const ci = loc ? chordIndexAt(hymn, q) : -1;

  if (!loc) $("where").textContent = engine.playing ? "Counting in" : "Ready";
  else {
    const part = loc.kind === "intro" ? "Introduction" : loc.kind === "interlude" ? "Interlude" : q >= refrainQ ? "Refrain" : `Verse ${loc.verse}`;
    $("where").textContent = `${part}, bar ${barAt(hymn, q)} of ${hymn.measures}`;
  }
  const lines = currentLines(loc);
  updateNowbar(loc, ci, lines);

  if (stageWanted()) {
    presenter.draw({
      hymn, q: sq, verseN, tracks: visibleTracks(), colors, t, heard, mode: state.presenterShows, watermark: state.watermark,
      format: state.format, badge: state.format === "vertical" ? hymnBadge() : null,
      only: loc?.kind === "intro" && state.introVoice ? [state.introVoice] : null,
      verseLabel: !loc ? `Verse ${state.verses[0]}` : loc.kind === "intro" ? "Introduction" : loc.kind === "interlude" ? "Interlude" : q >= refrainQ ? `Refrain, verse ${loc.verse}` : `Verse ${loc.verse}`,
      chord: state.chords && ci >= 0 ? chordLabel(hymn.chords[ci].name) : null,
      nextChord: state.chords && hymn.chords[ci + 1] ? chordLabel(hymn.chords[ci + 1].name) : null,
      line: lines.now, nextLine: lines.nextText, stanza: lines.stanza, stanzaAt: lines.at, piano: state.piano ? waterfall : null,
      loop: state.loop.on ? { from: state.loop.from + copy * hymn.measures, to: state.loop.to + copy * hymn.measures } : null,
    });
    mirrorProjector();
    if (state.view === "presenter") return;
  }
  if (state.view === "solfa" || state.view === "words") {
    const alt = state.view === "solfa" ? solfa : words;
    if (!loc) {
      alt.clear();
      // nothing sounding (stopped, counting in, or between the introduction and verse 1): show the line
      // where the singing starts, whole, not the half-peeled line the introduction ended on
      if (solfaSweeping()) { const at = comingUp(t); const k = at ? sfLineAt(at.q) : 0; if (k >= 0 && k !== sfSweep.i) solfaSweepTo(k, null); }
    }
    else {
      const el = state.view === "solfa" ? solfa.highlight(q, sung ? (q >= refrainQ ? (hymn.refrains?.[loc.verse - 1] ? 1000 + loc.verse : 0) : loc.verse) : -2) : words.highlight(q, sung ? loc.verse : -2, q >= refrainQ);
      alt.markChord(ci, hymn);
      const target = state.view === "solfa" ? el : el?.closest(".w-line");
      if (solfaSweeping()) {
        const cell = [...solfa.active][0]?.el;
        const li = cell ? solfa.lines.findIndex((l) => l.el.contains(cell)) : -1;
        const brief = li !== sfSweep.i && sfSweep.i >= 0 && engine.playing && loc.kind !== "verse" && briefVisit(t, li, (a) => sfLineAt(a.q));
        if (li >= 0 && !brief) solfaSweepTo(li, cell);
      } else if (engine.playing && target && target !== lastFollowEl) {
        lastFollowEl = target;
        target.scrollIntoView({ block: "center", inline: "center", behavior: reduceMotion ? "auto" : "smooth" });
      }
    }
    if (state.piano) drawPianoPanel(t);
    return;
  }

  if (!loc || sq === null) {
    view.clear();
    // stopped (or counting in): keep the playhead at the start, so it can be dragged
    const start = !engine.playing && !loc ? view.playhead(0) : null;
    if (start) placeRibbon(start);
    else ribbon.hidden = true;
    if (sweeping()) {
      // as the sol-fa: the line where the singing starts, whole
      const at = start ? null : comingUp(t);
      const p0 = start || (at && view.playhead(scoreQ(at))) || view.playhead(0);
      if (p0 && view.systems.indexOf(p0.system) !== sweep.i) sweepTo(p0, false);
    }
  } else {
    view.highlight(sq, verseN);
    const cj = ci + copy * hymn.chords.length;
    view.markChord(cj);
    $("lane").querySelectorAll(".blk").forEach((b, i) => b.classList.toggle("sounding", i === cj));
    const ph = view.playhead(sq);
    if (ph) {
      placeRibbon(ph);
      follow(ph);
    }
  }
  if (state.piano) drawPianoPanel(t);
}

function placeRibbon(ph) {
  ribbon.hidden = false;
  ribbon.style.left = `${ph.x}px`;
  ribbon.style.top = `${ph.top - 8}px`;
  ribbon.style.height = `${ph.height + 16}px`;
}

// Drag the playhead to where playing should continue. While playing, it pauses during the
// drag and carries on from the new place when released.
let ribbonDrag = null;
ribbon.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation(); // not a loop selection
  ribbon.setPointerCapture(e.pointerId);
  ribbonDrag = { wasPlaying: engine.playing };
  if (engine.playing) { engine.pause(); setPlaying(false); }
  ribbon.classList.add("dragging");
});
ribbon.addEventListener("pointermove", (e) => {
  if (!ribbonDrag) return;
  const r = $("score").getBoundingClientRect();
  engine.pausedAt = timeOfScoreQ(view.qAt(e.clientX - r.left, e.clientY - r.top));
  paint(true);
});
ribbon.addEventListener("pointerup", () => {
  if (!ribbonDrag) return;
  const resume = ribbonDrag.wasPlaying;
  ribbonDrag = null;
  ribbon.classList.remove("dragging");
  if (resume) togglePlay();
  else toast(`Playing will start from ${$("where").textContent.toLowerCase()}.`, 2500);
});

// page view: when not playing, the headers stay beside the line at the top of the window as the page scrolls
window.addEventListener("scroll", () => {
  if (engine.playing || state.view !== "page" || !view.systems?.length) return;
  const toolbar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--toolbar-h")) || 52;
  const y = window.scrollY + toolbar - (sheet.getBoundingClientRect().top + window.scrollY);
  const sys = view.systems.filter((s) => s.box.y + s.box.h * 0.5 > y)[0] || view.systems.at(-1);
  if (sys.el === lastSystem) return;
  lastSystem = sys.el;
  positionHeaders(sys);
}, { passive: true });

function follow(ph) {
  if (state.view === "tracks") {
    if (engine.playing) viewport.scrollLeft = ph.x - viewport.clientWidth * 0.33;
    return;
  }
  if (sweeping()) {
    const k = view.systems.indexOf(ph.system);
    const t = engine.now();
    const at = locate(perf, t);
    // an introduction or interlude touching a line for a moment does not turn the page
    if (k !== sweep.i && sweep.i >= 0 && engine.playing && at?.kind !== "verse" && briefVisit(t, k, systemOf)) return;
    sweepTo(ph);
    if (engine.playing) keepInSight(viewport, ph.x);
    return;
  }
  if (engine.playing) keepInSight(viewport, ph.x);
  if (ph.system.el !== lastSystem) {
    lastSystem = ph.system.el;
    positionHeaders(ph.system);
    if (engine.playing) {
      const top = viewport.getBoundingClientRect().top + window.scrollY + ph.top;
      window.scrollTo({ top: top - window.innerHeight * 0.2, behavior: reduceMotion ? "auto" : "smooth" });
    }
  }
}

// ---- line by line (?app, the staff view) ----------------------------------------------------------
// One line of the score at a time, as the presenter shows it: once three quarters of the line is
// sung, the next line is uncovered behind the playhead, from barline to barline, so when the eye
// goes back to the left the next line is already there.
const SWEEP_PAD = 14;
const SWEEP_TOP = 2; // above a line: nothing of the line before it (its last words) shows
const APP_ZOOM = 0.5; // the app's staff: the smallest the pinch allows, so the whole page width shows
// In the app the lines are always those of the smallest size; pinched bigger, the page is wider than
// the screen and scrolls sideways (it is not laid out again into shorter lines).
const appWide = (z) => (APP ? Math.max(1, z / APP_ZOOM) : 1);
/** Keep x (content px of a sideways-scrolling box) in sight: from the left third onwards. */
function keepInSight(box, x) {
  if (box.scrollWidth <= box.clientWidth + 4) return;
  if (x < box.scrollLeft + 16 || x > box.scrollLeft + box.clientWidth * 0.8) box.scrollLeft = Math.max(0, x - box.clientWidth * 0.33);
}
const sweep = { el: null, inner: null, i: -1, x: 0, next: undefined };
const sweeping = () => state.sweep && state.view === "page" && !!view?.systems?.length;

function clearSweep() {
  viewport.classList.remove("sweeping");
  viewport.style.height = "";
  sheet.style.transform = "";
  if (sweep.el) sweep.el.hidden = true;
  sweep.i = -1;
  sweep.next = undefined;
}

function setupSweep() {
  if (!sweeping()) return;
  if (!sweep.el) {
    sweep.el = document.createElement("div");
    sweep.el.className = "sweep-next";
    sweep.el.setAttribute("aria-hidden", "true");
    viewport.append(sweep.el);
  }
  // a copy of the score, unlit, from which the next line is shown
  sweep.el.innerHTML = `<div class="score">${$("score").innerHTML}</div>`;
  sweep.inner = sweep.el.firstChild;
  sweep.el.hidden = true;
  sweep.next = undefined;
  const h = Math.max(...view.systems.map((s) => s.box.h)) + 2 * SWEEP_PAD;
  viewport.classList.add("sweeping");
  viewport.style.height = `${Math.ceil(h)}px`;
  sweep.el.style.left = `${sheet.offsetLeft}px`;
  sweep.el.style.width = `${sheet.offsetWidth}px`;
  sweep.el.style.height = `${Math.ceil(h)}px`;
  sweep.i = -1;
}

// The line that will really be sung after line i: not always the one below it (verse 2 goes back to
// the top, a refrain or a repeat jumps). Found by looking ahead in the performance from now.
const systemOf = (at) => { const p = view.playhead(scoreQ(at)); return p ? view.systems.indexOf(p.system) : -1; };
function upcomingSystem(i) { return lineAfter(engine.now(), i, systemOf); }

function sweepTo(ph, wipe = true) {
  const sys = ph.system;
  const i = view.systems.indexOf(sys);
  if (i !== sweep.i) {
    sweep.i = i;
    sweep.x = 0;
    sweep.next = undefined;
    lastSystem = sys.el;
    sheet.style.transform = `translateY(${SWEEP_TOP - sys.box.y}px)`;
    if (engine.playing) viewport.scrollLeft = 0;
    sweep.el.hidden = true;
    // as tall as this line and the next, so nothing of the line after peeks in below
    const tall = (k) => { // a line, and below it only the clear space before the line after it
      const s = view.systems[k];
      if (!s) return 0;
      const after = view.systems[k + 1];
      return s.box.h + (after ? Math.max(0, Math.min(SWEEP_PAD, after.box.y - s.box.y - s.box.h - 4)) : SWEEP_PAD);
    };
    sweep.tall = tall;
    const h = `${Math.floor(SWEEP_TOP + Math.max(tall(i), tall(i + 1)))}px`;
    viewport.style.height = h;
    sweep.el.style.height = h;
  }
  const a = sys.anchors;
  if (!a.length || !wipe || !engine.playing) { sweep.el.hidden = true; return; }
  // peeled in two steps, not continuously: at three quarters of the line, its first half; at nine
  // tenths, up to three quarters; the rest when the singing goes back to the left. Each edge is the
  // barline at or before that point.
  if (ph.x < (sweep.lastX ?? 0) - 30) { sweep.x = 0; sweep.next = undefined; sweep.el.hidden = true; } // went back on this line
  sweep.lastX = ph.x;
  const end = a[a.length - 1].x;
  const at = (ph.x - a[0].x) / Math.max(1, end - a[0].x);
  if (at < 0.75) return;
  if (sweep.next === undefined) {
    // decided once per line, at three quarters: it then never changes its mind
    sweep.next = upcomingSystem(i);
    if (sweep.next >= 0) {
      const h = `${Math.floor(SWEEP_TOP + Math.max(sweep.tall(i), sweep.tall(sweep.next)))}px`;
      viewport.style.height = h;
      sweep.el.style.height = h;
    }
  }
  const next = view.systems[sweep.next];
  if (!next) { sweep.el.hidden = true; return; }
  const upTo = sys.box.x + sys.box.w * (at >= 0.9 ? 0.75 : 0.5);
  const bars = view.measures.filter((m) => m.system === sys.el).map((m) => m.box.x + m.box.w).filter((x) => x <= upTo + 1);
  peel(sweep, bars.length ? Math.max(...bars) : upTo);
  sweep.inner.style.transform = `translateY(${SWEEP_TOP - next.box.y}px)`;
}

/** The line being sung lies on top of the next one; behind the singer it is peeled away in steps.
 *  The edge only ever moves right. */
function peel(sw, edge) {
  sw.x = Math.max(sw.x, edge);
  if (sw.x < 2) { sw.el.hidden = true; return; }
  sw.el.hidden = false;
  sw.el.style.setProperty("--edge", `${sw.x}px`);
  sw.el.style.clipPath = `inset(0 calc(100% - ${sw.x}px) 0 0)`;
  sw.el.style.maskImage = "";
  sw.el.style.webkitMaskImage = "";
}

/** The line the music goes to after line `from`, from time t: lineOf(at) gives a position's line. A line
 *  only touched for a moment (an introduction running a few notes over into it) is passed over. */
const BRIEF = 1.5; // seconds
function lineAfter(t, from, lineOf) {
  let cand = -1, since = 0, away = false;
  for (let dt = 0.1; t + dt < perf.total && dt < 60; dt += 0.1) {
    const at = locate(perf, t + dt);
    const k = at && !at.done ? lineOf(at) : -1;
    if (k === -1) away = true;
    // back on this same line after a break (the introduction done, verse 1 starts here): the page
    // starts over, there is no other line to uncover
    if (k === from && away) return -1;
    if (cand >= 0) {
      if (k === cand) { if (dt - since >= BRIEF) return cand; continue; }
      if (k === -1 && dt - since < BRIEF) continue; // silence: decide by what follows
      cand = -1;
      away = true;
    }
    if (k >= 0 && k !== from) { cand = k; since = dt; }
  }
  return cand;
}

/** True when the music is in line k only for a moment from time t (and is not singing there). */
function briefVisit(t, k, lineOf) {
  for (let dt = 0; dt < BRIEF; dt += 0.1) {
    const at = locate(perf, t + dt);
    if (!at || at.done || lineOf(at) !== k) return true;
  }
  return false;
}

/** Where the music next sounds after time t (within ten seconds), or null. */
function comingUp(t) {
  if (!perf) return null;
  for (let dt = 0.1; dt < 10 && t + dt < perf.total; dt += 0.1) {
    const at = locate(perf, t + dt);
    if (at && !at.done) return at;
  }
  return null;
}

// ---- sol-fa line by line (?app) -----------------------------------------------------------------
// As the staff: one line of sol-fa at a time; once most of it is sung, the line that really comes next
// (looked up in the performance) is uncovered behind the singer, bar by bar, from the left.
const sfSweep = { el: null, inner: null, i: -1, x: 0, next: undefined };
const solfaSweeping = () => state.solfaSweep && state.view === "solfa" && !!solfa?.lines?.length;
const SF_PAD = 10;

function setupSolfaSweep() {
  const alt = $("altView");
  alt.classList.remove("sf-sweeping");
  alt.style.height = "";
  sfSweep.i = -1;
  sfSweep.next = undefined;
  sfSweep.el = null;
  if (!solfaSweeping()) return;
  const flow = alt.querySelector(".sf-flow");
  alt.classList.add("sf-sweeping");
  sfSweep.el = document.createElement("div");
  sfSweep.el.className = "sf-next";
  sfSweep.el.setAttribute("aria-hidden", "true");
  sfSweep.el.hidden = true;
  sfSweep.inner = flow.cloneNode(true);
  sfSweep.el.append(sfSweep.inner);
  sfSweep.el.style.left = `${flow.offsetLeft}px`;
  sfSweep.el.style.width = `${flow.offsetWidth}px`;
  alt.append(sfSweep.el);
}

function sfLineAt(q) {
  const bar = solfa.bars?.find((b) => Number(b.dataset.bar) === barAt(hymn, q));
  return bar ? solfa.lines.findIndex((l) => l.el.contains(bar)) : -1;
}

function solfaSweepTo(li, cell) {
  const alt = $("altView");
  const flow = alt.querySelector(".sf-flow");
  const lines = solfa.lines;
  const line = lines[li];
  if (!flow || !line || !sfSweep.el) return;
  const top = (k) => lines[k].el.offsetTop - lines[0].el.offsetTop; // the flow may or may not be the offset parent
  const tall = (k) => (lines[k] ? lines[k].el.offsetHeight : 0);
  const fit = (k) => { alt.style.height = `${Math.ceil(flow.offsetTop + SF_PAD * 2 + Math.max(tall(li), tall(k)))}px`; };
  if (li !== sfSweep.i) {
    sfSweep.i = li;
    sfSweep.x = 0;
    sfSweep.next = undefined;
    sfSweep.el.hidden = true;
    flow.style.transform = `translateY(${SF_PAD - top(li)}px)`;
    alt.scrollLeft = 0;
    fit(li);
  }
  if (!cell || !engine.playing) { sfSweep.el.hidden = true; return; }
  // the column of the note being sung (its words start there too): the peel stops at its left edge
  const beat = cell.closest(".sf-beat") || cell;
  const bar = cell.closest(".sf-bar");
  const x = bar.offsetLeft + beat.offsetLeft;
  if (engine.playing) {
    const r = cell.getBoundingClientRect(), A = alt.getBoundingClientRect();
    if (alt.scrollWidth > alt.clientWidth + 4 && (r.right > A.right - 24 || r.left < A.left)) cell.scrollIntoView({ inline: "center", block: "nearest" });
  }
  const W = line.el.offsetWidth;
  if (x < (sfSweep.lastX ?? 0) - 30) { sfSweep.x = 0; sfSweep.next = undefined; sfSweep.el.hidden = true; } // went back on this line
  sfSweep.lastX = x;
  if (x < W * 0.75) return; // peeled in two steps, as the staff
  if (sfSweep.next === undefined) {
    // decided once per line, at three quarters, and never changed: the line the performance goes to next
    sfSweep.next = lineAfter(engine.now(), li, (a) => sfLineAt(a.q));
    if (sfSweep.next >= 0) fit(sfSweep.next);
  }
  const next = lines[sfSweep.next];
  if (!next) { sfSweep.el.hidden = true; return; }
  sfSweep.el.style.top = `${flow.offsetTop}px`;
  sfSweep.el.style.height = alt.style.height;
  sfSweep.inner.style.transform = `translateY(${SF_PAD - top(sfSweep.next)}px)`;
  const upTo = W * (x >= W * 0.9 ? 0.75 : 0.5);
  const edges = line.bars.map((b) => b.offsetLeft + b.offsetWidth).filter((e) => e <= upTo + 1);
  peel(sfSweep, edges.length ? Math.max(...edges) : upTo);
}

// ---- pinch to zoom (?app) ------------------------------------------------------------------------
// Two fingers make the score (staff), or the sol-fa and words, larger or smaller. While pinching the
// view is only stretched; on letting go it is laid out again at the new size.
function setupPinch() {
  let p = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const target = () => (isScoreView() ? sheet : state.view === "solfa" || state.view === "words" ? $("altView") : null);
  workspace.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 2) return;
    drag = null; // two fingers: neither a loop nor a tap on a note
    const el = target();
    if (!el) return;
    const r = el.getBoundingClientRect();
    const altKey = state.view === "solfa" ? "solfaZoom" : "altZoom";
    const z = el === sheet ? 1 : state[altKey]; // CSS zoom scales the box, not the transform origin
    const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    p = { el, d: dist(e.touches), k: 1, base: el.style.transform || "" };
    el.style.transition = "none";
    el.style.transformOrigin = `${(mx - r.left) / z}px ${(my - r.top) / z}px`;
  }, { passive: true });
  workspace.addEventListener("touchmove", (e) => {
    if (!p || e.touches.length !== 2) return;
    e.preventDefault();
    const now = p.el === sheet ? state.zoom : state[state.view === "solfa" ? "solfaZoom" : "altZoom"];
    p.k = Math.max(0.5 / now, Math.min(2.5 / now, dist(e.touches) / p.d));
    p.el.style.transform = `${p.base} scale(${p.k})`;
  }, { passive: false });
  const end = (e) => {
    if (!p || e.touches.length >= 2) return;
    const { el, k, base } = p;
    p = null;
    el.style.transform = base;
    el.style.transformOrigin = "";
    el.style.transition = "";
    if (Math.abs(k - 1) < 0.04) return;
    if (el === sheet) { state.zoom = Math.max(0.5, Math.min(2.5, state.zoom * k)); save("zoom"); renderAll(); }
    else {
      const key = state.view === "solfa" ? "solfaZoom" : "altZoom";
      state[key] = Math.max(0.5, Math.min(2.5, state[key] * k)); save(key); el.style.zoom = String(state[key]);
      if (state.view === "solfa") renderAll(); // the lines are laid out again for the new size
    }
  };
  workspace.addEventListener("touchend", end);
  workspace.addEventListener("touchcancel", end);
}

// ---- piano roll sheet ----------------------------------------------------------------------------
// Docked above the words bar. Its handle opens and closes it (click, Enter or Space) and resizes it (drag).
function setPianoOpen(open) {
  const p = $("pianoPanel");
  p.classList.toggle("open", open);
  $("pianoHandle").setAttribute("aria-expanded", String(open));
  store.set("pianoOpen", open);
  paint(true);
}

function setupPianoSheet() {
  const p = $("pianoPanel");
  p.classList.toggle("open", store.get("pianoOpen", false)); // starts as just its bar
  const h = $("pianoHandle");
  h.setAttribute("aria-expanded", String(p.classList.contains("open")));
  // a plain button: click opens or closes it; it gives focus back so Space stays play/pause
  h.onclick = () => { setPianoOpen(!p.classList.contains("open")); h.blur(); };
}

// ---- tooltips ------------------------------------------------------------------------------------
// One tooltip for every button with data-tip or title: shown straight away, kept inside the window.
function setupTooltips() {
  const tip = $("tip");
  let cur = null;
  const hide = () => { tip.hidden = true; cur = null; };
  const show = (el) => {
    if (el.title) { el.dataset.tip = el.title; el.removeAttribute("title"); } // no second, slow native tooltip
    const text = el.dataset.tip;
    if (!text) return hide();
    cur = el;
    tip.textContent = text;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    x = Math.max(6, Math.min(window.innerWidth - tw - 6, x));
    let y = r.bottom + 7;
    if (y + th > window.innerHeight - 6) y = r.top - th - 7; // no room below: show it above
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const el = e.target.closest?.("[data-tip], [title]");
    if (el && el !== cur && !el.closest(".score")) show(el);
    else if (!el) hide();
  });
  document.addEventListener("focusin", (e) => { const el = e.target.closest?.("[data-tip], [title]"); if (el && e.target.matches(":focus-visible")) show(el); });
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", hide);
  window.addEventListener("scroll", hide, true);
}

function drawPianoPanel(t) {
  const c = $("pianoCanvas");
  const w = c.clientWidth;
  const h = c.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (!w || !h) return; // closed: nothing to draw
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  waterfall.draw(g, 0, 0, w, h, t, colors, heard);
}

// words of one pass: the verse, then the refrain, split into sung lines
function passSyllables(verse) { return [...(hymn.verses[verse - 1] || []), ...(hymn.refrains?.[verse - 1] || hymn.refrain || [])]; }

function splitLines(syl) {
  const out = [[]];
  syl.forEach((s, i) => {
    out[out.length - 1].push(i);
    if (s && (s.s === "single" || s.s === "end") && /[,;:.!?]$/.test(s.t)) out.push([]);
  });
  return out.filter((l) => l.length);
}

function lineParts(syl, idxs, current) {
  return idxs.map((i) => {
    const s = syl[i];
    if (!s) return { text: "", sung: false }; // a melisma note
    const join = s.s === "begin" || s.s === "middle" ? "" : " ";
    return { text: s.t + join, sung: i === current };
  });
}

function currentLines(loc) {
  if (loc && loc.kind !== "verse") {
    const label = loc.kind === "intro" ? "Introduction" : "Interlude";
    const next = loc.kind === "intro" ? loc.verse : state.verses[state.verses.indexOf(loc.verse) + 1];
    const syl = passSyllables(next ?? loc.verse);
    const first = splitLines(syl)[0] || [];
    const nextText = lineParts(syl, first, -1).map((p) => p.text).join("");
    const stanza = splitLines(syl).map((l) => lineParts(syl, l, -1)); // the stanza to come, none of it lit yet
    return { now: [{ text: label, sung: false }], next: [], nextText: `Next: ${nextText}`, key: `${loc.pass}:inst`, stanza, at: -1 };
  }
  const verse = loc ? loc.verse : state.verses[0];
  const syl = passSyllables(verse);
  const ls = splitLines(syl);
  let si = -1;
  if (loc) {
    const lv = hymn.voices[hymn.lyricVoice];
    si = lv.findIndex((n) => n.q <= loc.q + 1e-6 && loc.q < n.q + n.d - 1e-6);
    while (si > 0 && !syl[si]) si--; // a melisma keeps its syllable lit
  }
  const li = Math.max(0, ls.findIndex((l) => l.includes(si)));
  const now = ls[li] ? lineParts(syl, ls[li], si) : [];
  const next = ls[li + 1] ? lineParts(syl, ls[li + 1], -1) : [];
  const stanza = ls.map((l, i) => lineParts(syl, l, i === li ? si : -1));
  return { now, next, nextText: next.map((p) => p.text).join(""), key: `${loc?.pass}:${si}:${verse}`, stanza, at: loc ? li : -1 };
}

function updateNowbar(loc, ci, lines) {
  $("chordNow").textContent = state.chords ? chordLabel(hymn.chords[Math.max(0, ci)]?.name || "") : "";
  $("chordNext").textContent = state.chords && hymn.chords[ci + 1] ? `Next: ${chordLabel(hymn.chords[ci + 1].name)}` : "";
  if (lines.key === lastLineKey) return;
  lastLineKey = lines.key;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  document.documentElement.style.setProperty("--hl", `var(--${hymn.lyricVoice})`);
  $("lineNow").innerHTML = lines.now.map((p) => (p.sung ? `<span class="sung">${esc(p.text.trimEnd())}</span>${p.text.endsWith(" ") ? " " : ""}` : esc(p.text))).join("");
  $("lineNext").textContent = lines.nextText;
}

// ---- studio, recording, export, import ---------------------------------------

function openStudio() {
  const members = [...visibleVoices().map((k) => ({ ch: k, name: VOICES[k].name, color: `var(--${k})`, kind: "singer" })),
    { ch: "acc", name: "Accompaniment", color: "var(--acc)", kind: "piano" }];
  const defaults = Object.fromEntries(CH.map((c) => [c, DEFAULT_MIX[c]]));
  studio.open(members, { level: state.levels, pan: state.pans }, (ch, level, pan) => {
    state.levels[ch] = level;
    state.pans[ch] = pan;
    save("levels", "pans");
    applyMix();
    const r = headersEl.querySelector(`input[type=range][data-ch="${ch}"]`);
    if (r) r.value = level;
  }, defaults);
}

// Record button: a dialog first, so the video's content is chosen, then recording starts
function openRecordDialog() {
  if (recording) { finishRecording(); return; }
  const d = $("recDialog");
  const chips = (box, items, isOn) => {
    $(box).innerHTML = items.map(([v, l]) => `<label><input type="checkbox" value="${v}" ${isOn(v) ? "checked" : ""}>${l}</label>`).join("");
  };
  chips("recVerses", hymn.verses.map((_, i) => [i + 1, String(i + 1)]), (v) => state.verses.includes(Number(v)));
  chips("recVoices", hymnVoices().map((k) => [k, VOICES[k].name]), (k) => !state.mute[k]);
  $("recShows").value = state.presenterShows;
  $("recAccomp").innerHTML = Object.entries(ACCOMP_STYLES).map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  $("recAccomp").value = state.accomp;
  for (const [id, key] of [["recIntro", "intro"], ["recInterlude", "interlude"]]) {
    $(id).innerHTML = Object.entries(INSTRUMENTAL).map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    $(id).value = state[key];
  }
  $("recCountIn").value = state.countIn ? state.countAt : "off";
  // one video of the choir, and/or one per voice (each voice alone, its introduction playing its own line)
  chips("recTakes", [["choir", "Choir"], ...hymnVoices().map((k) => [k, VOICES[k].name])], (v) => v === "choir");
  const summary = () => {
    const vs = [...$("recVerses").querySelectorAll("input:checked")].map((x) => x.value);
    const voices = [...$("recVoices").querySelectorAll("input:checked")].map((x) => VOICES[x.value].name);
    const takes = [...$("recTakes").querySelectorAll("input:checked")].length;
    $("recSummary").textContent = `${hymn.number} ${hymn.title}: verse${vs.length === 1 ? "" : "s"} ${vs.join(", ") || "none"}; `
      + `${voices.length ? voices.join(", ") : "no voices"}; at ${state.tempo} a minute; `
      + `${takes === 1 ? "one mp4" : `${takes} mp4s`}.`;
  };
  d.querySelectorAll("input, select").forEach((el) => { el.onchange = summary; });
  summary();
  $("recCancel").onclick = () => d.close();
  $("recStart").onclick = async () => {
    const vs = [...$("recVerses").querySelectorAll("input:checked")].map((x) => Number(x.value));
    if (!vs.length) return toast("Choose at least one verse.");
    const on = new Set([...$("recVoices").querySelectorAll("input:checked")].map((x) => x.value));
    state.verses = vs; store.set(`verses:${hymn.id}`, vs);
    for (const k of hymnVoices()) state.mute[k] = !on.has(k);
    state.presenterShows = $("recShows").value;
    state.accomp = $("recAccomp").value;
    state.intro = $("recIntro").value;
    state.interlude = $("recInterlude").value;
    state.countIn = $("recCountIn").value !== "off";
    if (state.countIn) state.countAt = $("recCountIn").value;
    const takes = [...$("recTakes").querySelectorAll("input:checked")].map((x) => x.value);
    if (!takes.length) return toast("Choose at least one video.");
    save("mute", "presenterShows", "accomp", "intro", "interlude", "countIn", "countAt");
    // keep the rest of the page in step with what was chosen
    $("presenterShows").value = state.presenterShows; $("intro").value = state.intro; $("interlude").value = state.interlude;
    $("countIn").checked = state.countIn; $("countAt").value = state.countAt; buildVerseChips();
    d.close();
    if (state.accomp !== "off" || state.intro !== "none" || state.interlude !== "none") await engine.loadPiano();
    if (anySung()) await prepareStems(); else rebuild();
    buildHeaders();
    applyMix();
    if (canMakeVideo()) await makeTakeVideos(takes);
    else await startRecording(); // an older browser: film the stage live
  };
  d.showModal();
}

// Every video is made ahead of time (see videomaker.js): smooth whatever the browser is doing, and the
// takes after the first reuse the frames after the introduction.
async function makeTakeVideos(takeKeys) {
  if (state.view !== "presenter") { state.view = "presenter"; save("view"); await renderAll(); }
  stopPlayback();
  engine.ensure();
  await engine.loadPiano();
  const loopWas = state.loop.on;
  if (loopWas) setLoop(state.loop.from, state.loop.to, false);
  const choir = hymnVoices().filter((k) => !state.mute[k]);
  making = true;
  state.watermark = true;
  const takes = takeKeys.map((key) => ({
    name: key === "choir" ? "Choir" : VOICES[key].name,
    setup: async () => {
      state.introVoice = key === "choir" ? null : key;
      rebuild(false);
      await prepareStage();
      const voices = key === "choir" ? choir : [key];
      for (const k of hymnVoices()) engine.setMuted(k, !voices.includes(k));
      // the takes differ only up to the first verse (the count-in after an introduction is the same in all)
      const intro = perf.passes[0]?.kind === "intro";
      const firstVerse = perf.passes.find((p) => p.kind === "verse");
      const splitT = !intro ? 0 : firstVerse.t0 - (state.countIn && state.countAt === "verse" ? hymn.measureQ * perf.tm.spq : 0);
      return { total: perf.total + 1, splitT };
    },
    drawAt: (t) => paint(true, t),
    audio: () => engine.renderOffline(perf.events, perf.total + 1.5),
  }));
  const made = [];
  try {
    await makeVideos($("stage"), takes, {
      progress: (text) => toast(text, 0),
      onVideo: async (name, blob, audioCodec) => {
        // Opus sound in an mp4 does not play everywhere: the server makes it AAC when it can
        if (audioCodec !== "aac") {
          try {
            const r = await fetch("api/to-mp4", { method: "POST", body: blob });
            if (r.ok) blob = new Blob([await r.arrayBuffer()], { type: "video/mp4" });
          } catch { /* no server: keep it as it is */ }
        }
        made.push({ file: `${hymn.id}-${name}.mp4`, blob });
      },
    });
    $("toast").hidden = true;
    showMadeVideos(made);
  } catch (err) {
    toast(`The video could not be made: ${err.message}`, 8000);
  } finally {
    making = false;
    state.introVoice = null;
    state.watermark = false;
    rebuild(false);
    applyMix();
    if (loopWas) setLoop(state.loop.from, state.loop.to, true);
    paint(true);
  }
}

// Finished videos are kept until the user saves them: nothing says "saved" before a file is really written.
function showMadeVideos(made) {
  const d = $("vidDialog");
  const picker = "showSaveFilePicker" in window;
  $("vidTitle").textContent = made.length === 1 ? "Your video is ready" : `Your ${made.length} videos are ready`;
  $("vidNote").textContent = made.length === 1 ? "It is not saved yet. Choose where to keep it." : "They are not saved yet. Choose where to keep each one.";
  const mb = (b) => `${(b.size / 1e6).toFixed(1)} MB`;
  $("vidList").innerHTML = made.map((v, i) => `<li><span class="vname">${v.file}</span><span class="vsize">${mb(v.blob)}</span>`
    + `<button class="ghost" data-save="${i}">Save…</button></li>`).join("");
  const done = (i, where) => {
    const li = $("vidList").children[i];
    li.querySelector("[data-save]").replaceWith(Object.assign(document.createElement("span"), { className: "saved", textContent: where }));
  };
  const saveOne = async (i) => {
    const v = made[i];
    if (picker) {
      try {
        const fh = await window.showSaveFilePicker({ suggestedName: v.file, types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }] });
        const w = await fh.createWritable();
        await w.write(v.blob);
        await w.close();
        done(i, `Saved as ${fh.name}`);
      } catch (err) { if (err.name !== "AbortError") toast(`Could not save it: ${err.message}`, 6000); }
      return;
    }
    // no save picker in this browser: it downloads, and the browser decides where (usually Downloads)
    const a = document.createElement("a");
    a.href = URL.createObjectURL(v.blob);
    a.download = v.file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    done(i, "Sent to your browser's downloads");
  };
  $("vidList").querySelectorAll("[data-save]").forEach((b) => { b.onclick = () => saveOne(Number(b.dataset.save)); });
  $("vidSaveAll").hidden = made.length < 2 || !("showDirectoryPicker" in window);
  $("vidSaveAll").onclick = async () => {
    try {
      const dir = await window.showDirectoryPicker({ mode: "readwrite" });
      for (const [i, v] of made.entries()) {
        const w = await (await dir.getFileHandle(v.file, { create: true })).createWritable();
        await w.write(v.blob);
        await w.close();
        if ($("vidList").children[i].querySelector("[data-save]")) done(i, `Saved in ${dir.name}`);
      }
    } catch (err) { if (err.name !== "AbortError") toast(`Could not save them: ${err.message}`, 6000); }
  };
  $("vidClose").onclick = () => {
    const unsaved = $("vidList").querySelectorAll("[data-save]").length;
    if (unsaved && !confirm(`${unsaved === 1 ? "A video is" : `${unsaved} videos are`} not saved and will be lost. Close anyway?`)) return;
    d.close();
  };
  d.oncancel = (e) => { e.preventDefault(); $("vidClose").onclick(); }; // Escape asks too
  d.showModal();
}

async function startRecording() {
  if (recording) { finishRecording(); return; }
  if (state.view !== "presenter") { state.view = "presenter"; save("view"); await renderAll(); }
  engine.ensure();
  applyMix();
  await engine.loadPiano();
  stopPlayback();
  const loopWas = state.loop.on;
  if (loopWas) setLoop(state.loop.from, state.loop.to, false);
  state.watermark = true;
  const rec = presenter.record(engine.recordStream(), async (blob) => {
    // a webm recording is turned into a standard mp4 by the server when it can (players, phones, social sites)
    if (!blob.type.includes("avc1") && !blob.type.includes("mp4")) {
      toast("Making the video into an mp4…", 0);
      try {
        const r = await fetch("api/to-mp4", { method: "POST", body: blob });
        if (r.ok) blob = new Blob([await r.arrayBuffer()], { type: "video/mp4" });
      } catch { /* no server: keep the webm */ }
    }
    const ext = blob.type.includes("mp4") ? "mp4" : "webm";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${hymn.id}-${visibleTracks().map(trackKey).join("-")}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast(`Video saved as ${a.download}`);
  });
  recording = { rec, loopWas };
  $("recordBtn").classList.add("recording");
  $("recordBtn").setAttribute("aria-label", "Stop recording");
  $("recordBtn").querySelector("span").textContent = "Stop recording and save the video";
  document.querySelector("#moreMenu > summary").classList.add("recording");
  toast("Recording. It stops by itself at the end of the last verse.", 3000);
  await engine.play(0);
  setPlaying(true);
}

function finishRecording() {
  if (!recording) return;
  const r = recording;
  recording = null;
  state.watermark = false;
  r.rec.stop();
  $("recordBtn").classList.remove("recording");
  $("recordBtn").setAttribute("aria-label", "Record a video");
  $("recordBtn").querySelector("span").textContent = "Record the presenter to a video";
  document.querySelector("#moreMenu > summary").classList.remove("recording");
  if (r.loopWas) setLoop(state.loop.from, state.loop.to, true);
}

async function doExport() {
  if (!tk || !hymn) return;
  const tracks = visibleTracks();
  const name = `${hymn.id}-${tracks.map(trackKey).join("-")}.pdf`;
  toast("Making the PDF…", 0);
  try {
    const opts = withPiano(xmlOptions({ header: true, words: state.words === "current" ? "all" : state.words }));
    const pages = await exportPdf(tk, buildMusicXML(scoreHymn(), opts), hymn, name, $("measureHost"), verovioTranspose(currentShift(null)));
    toast(`Saved ${name} (${pages} ${pages === 1 ? "page" : "pages"})`);
  } catch (err) {
    toast(`The PDF could not be made: ${err.message}`);
  }
  presenter.key = ""; // the toolkit now holds the PDF layout
}

async function doImport(file) {
  toast(`Reading ${file.name}…`, 0);
  let res;
  try {
    res = await fetch(`api/import?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file, headers: { "Content-Type": file.type || "application/pdf" } });
  } catch {
    toast("Import needs the hymn server. Start it with python3 server.py in the hymn-satb folder.");
    return;
  }
  if (res.status === 404 || res.status === 501) { toast("Import needs the hymn server. Start it with python3 server.py in the hymn-satb folder."); return; }
  const job = await res.json().catch(() => ({}));
  if (!res.ok) { toast(job.error || "The import could not start.", 9000); return; }
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await (await fetch(`api/import/${job.id}`)).json();
    if (s.status === "done") {
      await loadList();
      $("hymnPicker").value = s.hymn;
      location.hash = s.hymn;
      await loadHymn(hymnList.find((x) => x.id === s.hymn));
      toast(`Imported ${s.title}. Check it against the scan before relying on it.`, 8000);
      return;
    }
    if (s.status === "error") { toast(`Import failed: ${s.error}`, 9000); return; }
    toast(s.message || "Transcribing…", 0);
  }
}

/** Turn a recording (audio or video) into a hymn, on the local server. */
async function doImportAudio(file) {
  toast(`Sending ${file.name}…`, 0);
  let res;
  try {
    res = await fetch(`api/import-audio?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
  } catch {
    toast("Importing a recording needs the hymn server on this computer (python3 server.py).", 7000);
    return;
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) { toast("Importing a recording needs the hymn server on this computer (python3 server.py).", 7000); return; }
  const job = await res.json().catch(() => ({}));
  if (!res.ok) { toast(job.error || "The recording could not be sent.", 8000); return; }
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    let s;
    try { s = await (await fetch(`api/import-audio/${job.id}`)).json(); } catch { continue; }
    if (s.status === "done") {
      await loadList();
      $("hymnPicker").value = s.hymn;
      location.hash = s.hymn;
      await loadHymn(hymnList.find((x) => x.id === s.hymn));
      toast("Transcribed. Listen and compare with the recording; expect to correct some notes and words.", 9000);
      return;
    }
    if (s.status === "error") { toast(`The recording could not be transcribed: ${s.error}`, 10000); return; }
    toast(s.message || "Transcribing the recording…", 0);
  }
}

// ---- automatic videos (?make=) -------------------------------------------------------------------
// The social pipeline (social/post.py) loads e.g. ?make=choir,alto,rehearsal&format=landscape#SDAH-610 in a
// headless browser. The page makes those videos with no dialog and POSTs each one, with a sidecar JSON (and
// thumbnails, with thumb=1), to server.py, which keeps them in out/videos/<id>/. window.AH_MAKE and a console
// line ("AH-MAKE DONE <id>" or "AH-MAKE ERROR <id> <message>") say how it went. The URL's settings are used for
// this page only and never saved, so the same URL always makes the same videos. The spec is
// social/SPEC-player.md.

const HYMNAL_NAMES = { SDAH: "SDA Hymnal", CS1900: "Christ in Song", CS1908: "Christ in Song", CH1941: "Church Hymnal 1941", NZK: "Nyimbo za Kristo", WN: "Wende Nyasaye" };
const hymnBadge = () => `${HYMNAL_NAMES[hymn.book] || hymn.book} ${hymn.number}`;
const LOGO = "brand/logo.svg"; // the one place the logo comes from
const END_VOICE = "audio/endcard/cta.wav"; // spoken: "Which hymn should we sing next? Tell us in the comments."
const END_CARD = {
  landscape: { secs: 10, voiceAt: 0.8, lines: ["Which hymn should we sing next?", "Tell us in the comments", "Learn your part · player.adventhymnals.org"] },
  vertical: { secs: 4, voiceAt: 0.4, lines: ["Full hymn ▶ on our channel", "Which hymn next? Comment below"] },
};
const SHORT_MAX = 58; // seconds: one file fits YouTube Shorts, Reels and TikTok
const MAKE_TAKES = ["choir", "soprano", "alto", "tenor", "bass", "rehearsal", "short"];
const voiceOfTake = (take) => Object.keys(VOICES).find((k) => VOICES[k].name.toLowerCase() === take);
const takeLabel = (take) => (take === "choir" ? "SATB Choir" : take === "rehearsal" ? "All Parts Rehearsal" : `${VOICES[voiceOfTake(take)]?.name} Part`);
const refrainAt = () => hymn.marks.find((m) => /refrain|chorus/i.test(m.text))?.q ?? null;

function makeFailed(id, message) {
  window.AH_MAKE = { ...(window.AH_MAKE || { files: [] }), state: "error", error: message };
  console.log(`AH-MAKE ERROR ${id} ${message}`);
}

/** A performance like rebuild()'s, for one section of an automatic video. */
const perfFor = (verses, introVoice, extra = {}) => performance(hymn, {
  tempo: state.tempo, verses, accomp: state.accomp, countIn: state.countIn, countAt: state.countAt, introVoice,
  stems: anySung() ? stemInfo : new Map(), intro: state.intro, interlude: state.interlude, shiftAt, metronome: false, ...extra,
});

// A take is a timeline of parts, each { kind: "music" | "card" | "end", t0, dur }. A music part plays a
// performance from its time `from` with some `voices`, and its sound rings `ring` seconds into the next part.
function useMusic(it) {
  perf = it.perf;
  state.verses = it.verses;
  state.introVoice = it.introVoice;
}

function drawTimeline(tl, t) {
  const it = tl.items.findLast((x) => t >= x.t0 - 1e-9) ?? tl.items[0];
  const k = t - it.t0;
  const mark = (dark, cornerOnly = false) => (state.format === "vertical" ? presenter.drawVerticalMark(dark ? "#ffffff" : colors.cloth, cornerOnly)
    : presenter.drawMark({ watermark: true, colors, mode: dark ? "words" : "score" }, cornerOnly));
  if (it.kind === "music") { useMusic(it); paint(true, it.from + k); return; }
  if (it.kind === "card") {
    presenter.drawTitleCard({ hymn, colors, title: it.title, voice: it.voice, badge: hymnBadge() });
    mark(false);
    return;
  }
  if (!tl.last) { // the end card fades in over the last picture of the music
    const m = tl.items.findLast((x) => x.kind === "music");
    useMusic(m);
    paint(true, m.from + m.dur);
    tl.last = Object.assign(document.createElement("canvas"), { width: $("stage").width, height: $("stage").height });
    tl.last.getContext("2d").drawImage($("stage"), 0, 0);
  }
  presenter.drawEndCard({ k, last: tl.last, logo: makeAssets.logo, lines: END_CARD[state.format].lines });
  mark(true, true); // the card is all brand already: no diagonal across the call to action
}

/** The sound of a take: each music part rendered offline and laid in place, then the spoken end card,
 *  matched to the singing's loudness. */
async function timelineAudio(tl) {
  const rate = 48000;
  const out = new AudioBuffer({ numberOfChannels: 2, length: Math.ceil(tl.total * rate), sampleRate: rate });
  for (const it of tl.items.filter((x) => x.kind === "music")) {
    for (const k of hymnVoices()) engine.setMuted(k, !it.voices.includes(k));
    const len = Math.min(it.dur + it.ring, tl.total - it.t0);
    const buf = await engine.renderOffline(it.perf.events, it.from + len + 0.05, rate);
    const fadeIn = it.from > 0 ? 0.08 * rate : 0; // a clip from the middle of a hymn starts softly
    const fadeOut = (it.ring > 0.5 ? 0.6 : 0.25) * rate;
    const n = Math.round(len * rate);
    const at = Math.round(it.t0 * rate);
    const from = Math.round(it.from * rate);
    for (let c = 0; c < 2; c++) {
      const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
      const dst = out.getChannelData(c);
      for (let i = 0; i < n && at + i < dst.length && from + i < src.length; i++) {
        const gain = Math.min(1, fadeIn ? i / fadeIn : 1, (n - i) / fadeOut);
        dst[at + i] += src[from + i] * gain;
      }
    }
  }
  const end = tl.items.find((x) => x.kind === "end");
  const voice = makeAssets.voice;
  if (end && voice) {
    // as loud as the singing: the RMS of the sounding samples of each
    const rms = (chs, a, b) => {
      let sum = 0;
      let count = 0;
      for (const d of chs) for (let i = a; i < b; i++) if (Math.abs(d[i]) > 0.003) { sum += d[i] * d[i]; count++; }
      return count ? Math.sqrt(sum / count) : 0;
    };
    const outCh = [out.getChannelData(0), out.getChannelData(1)];
    const vCh = [voice.getChannelData(0), voice.getChannelData(voice.numberOfChannels > 1 ? 1 : 0)];
    const music = rms(outCh, 0, Math.round(end.t0 * rate));
    const spoken = rms(vCh, 0, voice.length);
    let peak = 0;
    for (const d of vCh) for (const x of d) peak = Math.max(peak, Math.abs(x));
    const gain = Math.min(music && spoken ? music / spoken : 1, peak ? 0.89 / peak : 1);
    const at = Math.round((end.t0 + END_CARD[state.format].voiceAt) * rate);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < voice.length && at + i < out.length; i++) outCh[c][at + i] += vCh[c][i] * gain;
    }
  }
  return out;
}

/** YouTube chapters: the first at 0, each at least 10 s long, at least 3 of them (else none). */
function tidyChapters(list, total) {
  const out = [];
  for (const c of [...list].sort((a, b) => a.t - b.t)) {
    const ch = { ...c };
    while (out.length && ch.t - out.at(-1).t < 10) out.pop(); // the short one before joins the one before it
    if (!out.length) ch.t = 0;
    out.push(ch);
  }
  while (out.length > 1 && total - out.at(-1).t < 10) out.pop();
  return out.length >= 3 ? out.map((c) => ({ t: Math.round(c.t * 10) / 10, label: c.label })) : [];
}

/** One chapter per verse and refrain of a performance that starts at `offset` in the video. */
function chaptersOf(p, offset = 0) {
  const rq = refrainAt();
  const out = [];
  p.passes.forEach((pass, k) => {
    if (pass.kind === "intro") out.push({ t: offset + pass.t0, label: "Introduction" });
    if (pass.kind !== "verse") return;
    out.push({ t: offset + pass.t0, label: `Verse ${pass.verse}` });
    if (rq !== null) out.push({ t: offset + passTime(p, k, rq), label: "Refrain" });
  });
  return out;
}

/** The whole hymn sung by `voices` (the choir, or one voice), then the end card. */
function songTimeline(verses, voices, introVoice, endcard) {
  const p = perfFor(verses, introVoice);
  const items = [{ kind: "music", t0: 0, dur: endcard ? p.total : p.total + 1, from: 0, perf: p, verses, voices, introVoice, ring: endcard ? 1.2 : 0 }];
  let total = items[0].dur;
  if (endcard) { items.push({ kind: "end", t0: total, dur: END_CARD[state.format].secs }); total += END_CARD[state.format].secs; }
  // every take shares the frames after its introduction (see videomaker.js)
  const intro = p.passes[0]?.kind === "intro";
  const firstVerse = p.passes.find((x) => x.kind === "verse");
  const splitT = !intro ? 0 : firstVerse.t0 - (state.countIn && state.countAt === "verse" ? hymn.measureQ * p.tm.spq : 0);
  return { items, total, splitT, chapters: tidyChapters(chaptersOf(p), total), verses };
}

/** Soprano, alto, tenor and bass each alone (partVerses), then the choir (verses), each after a 2 s card. */
function rehearsalTimeline(verses, partVerses, choir, endcard) {
  const sections = [
    ...hymnVoices().map((k) => ({ title: `${VOICES[k].name} part`, chapter: VOICES[k].name, voices: [k], introVoice: k, verses: partVerses, voice: k })),
    { title: "Choir", chapter: "Choir", voices: choir, introVoice: null, verses, voice: null },
  ];
  const items = [];
  const chapters = [];
  let t = 0;
  sections.forEach((s, i) => {
    chapters.push({ t, label: s.chapter });
    items.push({ kind: "card", t0: t, dur: 2, title: s.title, voice: s.voice });
    t += 2;
    const p = perfFor(s.verses, s.introVoice);
    const last = i === sections.length - 1;
    const dur = last && endcard ? p.total : p.total + 1;
    items.push({ kind: "music", t0: t, dur, from: 0, perf: p, verses: s.verses, voices: s.voices, introVoice: s.introVoice, ring: last && endcard ? 1.2 : 0 });
    t += dur;
  });
  if (endcard) { items.push({ kind: "end", t0: t, dur: END_CARD[state.format].secs }); t += END_CARD[state.format].secs; }
  return { items, total: t, splitT: t, chapters: tidyChapters(chapters, t), verses };
}

/** What clip=fit (the default) means for this hymn: the last verse with its refrain when the whole short
 *  stays within 58 s, else the refrain alone, or verse 1 when there is no refrain. */
function resolveClip(clip, endcard) {
  if (clip && clip !== "fit") return clip;
  const last = hymn.verses.length;
  const p = perfFor([last], null, { countIn: false, intro: "none", interlude: "none" });
  const card = endcard ? END_CARD.vertical.secs : 0;
  if (p.total + card + 0.5 <= SHORT_MAX) return `whole:${last}`;
  return refrainAt() !== null ? "refrain" : "verse:1";
}

/** The short: one refrain, verse or stretch (clip=refrain | verse:N | whole:N, a verse with its refrain |
 *  q:FROM-TO), singing from the first moment, then the 4 s end card; at most 58 s, cut at the end of a
 *  phrase when it would be longer. */
function shortTimeline(spec, choir, endcard) {
  const rq = refrainAt();
  let verse = 1;
  let qFrom = 0;
  let qTo = hymn.totalQ;
  let label;
  if (spec === "refrain") {
    if (rq === null) throw new Error("this hymn has no refrain; use clip=verse:N");
    [qFrom, label] = [rq, "Refrain"];
  } else if (/^verse:\d+$/.test(spec)) {
    verse = Number(spec.split(":")[1]);
    if (!hymn.verses[verse - 1]) throw new Error(`there is no verse ${verse}`);
    if (rq !== null) qTo = rq;
    label = `Verse ${verse}`;
  } else if (/^whole:\d+$/.test(spec)) {
    verse = Number(spec.split(":")[1]);
    if (!hymn.verses[verse - 1]) throw new Error(`there is no verse ${verse}`);
    label = rq !== null ? `Verse ${verse} and refrain` : `Verse ${verse}`;
  } else if (/^q:[\d.]+-[\d.]+$/.test(spec)) {
    [qFrom, qTo] = spec.slice(2).split("-").map(Number);
    if (!(qFrom < qTo && qTo <= hymn.totalQ)) throw new Error(`clip ${spec} is not inside the hymn`);
    label = "Excerpt";
  } else throw new Error(`clip ${spec} is not fit, refrain, verse:N or q:FROM-TO`);
  const p = perfFor([verse], null, { countIn: false, intro: "none", interlude: "none" });
  const card = endcard ? END_CARD.vertical.secs : 0;
  const fromS = Math.max(0, passTime(p, 0, qFrom) - 0.1);
  let toS = passTime(p, 0, qTo);
  const room = SHORT_MAX - card - 0.5;
  if (toS - fromS > room) { // too long: end where a phrase does, the latest that fits
    const ends = phraseBounds(hymn).filter((q) => q > qFrom && passTime(p, 0, q) - fromS <= room);
    qTo = ends.at(-1) ?? qFrom;
    toS = qTo > qFrom ? passTime(p, 0, qTo) : fromS + room;
  }
  const ends = qTo >= hymn.totalQ - 1e-6; // the hymn's own last chord may ring; elsewhere the next words must not
  const items = [{ kind: "music", t0: 0, dur: toS - fromS + (card ? 0 : 1), from: fromS, perf: p, verses: [verse], voices: choir, introVoice: null, ring: card ? (ends ? 1.2 : 0.25) : 0 }];
  let total = items[0].dur;
  if (card) { items.push({ kind: "end", t0: total, dur: card }); total += card; }
  return { items, total, splitT: total, chapters: [], verses: [verse], clip: { label, fromS: Math.round(fromS * 1000) / 1000, toS: Math.round(toS * 1000) / 1000 } };
}

const makeAssets = { logo: null, voice: null };

async function loadMakeAssets() {
  // the logo, rasterised large so it stays sharp at any size it is drawn
  try {
    const svg = (await (await fetch(LOGO)).text()).replace("<svg ", '<svg width="800" height="800" ');
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    await img.decode();
    makeAssets.logo = img;
  } catch { /* no logo: the cards are drawn without it */ }
  try {
    const r = await fetch(`${AUDIO}${END_VOICE}`, { cache: "no-cache" });
    if (r.ok) makeAssets.voice = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(await r.arrayBuffer());
  } catch { /* no voice yet: the end card is silent */ }
  for (const f of ["800 54px Alegreya", "700 46px Alegreya", "600 34px Alegreya", "500 52px Alegreya", "400 34px Alegreya",
    "italic 400 30px Alegreya", "600 30px 'Alegreya Sans'", "700 40px 'Alegreya Sans'", "500 36px 'Alegreya Sans'", "800 58px 'Alegreya Sans'"]) {
    await document.fonts.load(f).catch(() => {});
  }
}

/** The hymn's first line as people know it: the first phrases of verse 1, up to four words at least. */
function firstLine() {
  const syl = passSyllables(1);
  let text = "";
  for (const line of splitLines(syl)) {
    text += lineParts(syl, line, -1).map((x) => x.text).join("");
    if (text.trim().split(/\s+/).length >= 4) break;
  }
  return text.trim().replace(/[,;:.!?]+$/, "");
}

function stemsVersion() {
  if (!manifest) return null;
  if (manifest.version) return String(manifest.version);
  let h = 0x811c9dc5; // FNV-1a of the manifest: any new recording changes it
  for (const ch of JSON.stringify(manifest)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

async function postFile(name, blob, reencode = false) {
  const r = await fetch(`api/video?id=${encodeURIComponent(hymn.id)}&name=${encodeURIComponent(name)}${reencode ? "&reencode=1" : ""}`, { method: "POST", body: blob });
  if (!r.ok) throw new Error(`server.py did not keep ${name}: ${(await r.json().catch(() => ({}))).error || r.status}`);
  window.AH_MAKE.files.push(name);
}

async function runMake() {
  const id = hymn?.id || decodeURIComponent(location.hash.slice(1));
  window.AH_MAKE = { state: "working", files: [], error: null, progress: "" };
  const p = MAKE;
  const stage = $("stage");
  try {
    if (!hymn) throw new Error("the hymn did not load");
    if (!canMakeVideo()) throw new Error("this browser cannot encode video (WebCodecs)");
    const format = p.get("format") || "landscape";
    if (!["landscape", "vertical"].includes(format)) throw new Error(`format ${format} is not landscape or vertical`);
    const wanted = p.get("make").split(",").map((x) => x.trim()).filter(Boolean);
    const bad = wanted.filter((x) => !MAKE_TAKES.includes(x));
    if (bad.length) throw new Error(`unknown take ${bad.join(", ")}`);
    if (wanted.includes("short") && format !== "vertical") throw new Error("short needs format=vertical");
    const missingVoice = wanted.filter((x) => voiceOfTake(x) && !hymnVoices().includes(voiceOfTake(x)));
    if (missingVoice.length) throw new Error(`this hymn has no ${missingVoice.join(", ")} part`);
    const all = hymn.verses.map((_, i) => i + 1);
    const verseList = (v, name) => {
      if (!v || v === "all") return all;
      const list = v.split(",").map(Number);
      if (!list.length || list.some((n) => !all.includes(n))) throw new Error(`${name}=${v}: the hymn has verses ${all.join(", ")}`);
      return list;
    };
    const verses = verseList(p.get("verses"), "verses");
    const partVerses = verseList(p.get("partVerses") || "1", "partVerses");
    const endcard = p.get("endcard") !== "off";
    const short = wanted.includes("short");
    let clip = null;

    // the settings: the URL's, else the hymn's own, else the defaults of a fresh profile
    const pick = (name, ok, fallback) => {
      const v = p.get(name);
      if (v === null) return fallback;
      if (!ok(v)) throw new Error(`${name}=${v} is not allowed`);
      return v;
    };
    state.format = format;
    state.tempo = Number(pick("tempo", (v) => Number(v) >= 30 && Number(v) <= 240, hymn.tempo));
    state.accomp = pick("accomp", (v) => v in ACCOMP_STYLES, state.accomp);
    state.intro = short ? "none" : pick("intro", (v) => v in INSTRUMENTAL, "none");
    state.interlude = pick("interlude", (v) => v in INSTRUMENTAL, state.interlude);
    const countIn = short ? "off" : pick("countIn", (v) => ["start", "verse", "off"].includes(v), "start");
    state.countIn = countIn !== "off";
    if (state.countIn) state.countAt = countIn;
    state.presenterShows = pick("shows", (v) => ["score", "words", "stanza"].includes(v), format === "vertical" ? "words" : "score");
    state.mute = {};
    state.solo = {};
    state.transpose = 0;
    state.lastVerseUp = 0;
    state.view = "presenter";

    window.AH_MAKE.progress = "Loading the singers";
    await loadMakeAssets();
    engine.ensure();
    await engine.loadPiano();
    if (short) clip = resolveClip(p.get("clip"), endcard);
    const sungVerses = short ? [shortVerse(clip)] : [...new Set([...verses, ...(wanted.includes("rehearsal") ? partVerses : [])])].sort((a, b) => a - b);
    state.verses = sungVerses;
    if (!manifest) throw new Error("this hymn has no sung recording yet");
    await prepareStems();
    const missing = sungVerses.flatMap((v) => hymnVoices().filter((k) => !stemInfo.has(`${k}:${v}:0`)).map((k) => `${k}${v}`));
    if (missing.length) throw new Error(`sung stems missing at ${state.tempo} a minute: ${missing.join(" ")}`);
    if (format === "vertical") { stage.width = 1080; stage.height = 1920; }
    await renderAll();
    await prepareStage();
    applyMix();

    const choir = hymnVoices();
    const plan = [];
    for (const take of wanted) {
      if (take === "choir") plan.push({ take, tl: songTimeline(verses, choir, null, endcard) });
      else if (take === "rehearsal") plan.push({ take, tl: rehearsalTimeline(verses, partVerses, choir, endcard) });
      else if (take === "short") plan.push({ take, tl: shortTimeline(clip, choir, endcard) });
      else { const k = voiceOfTake(take); plan.push({ take, tl: songTimeline(verses, [k], k, endcard) }); }
    }
    // the takes that share frames first, the rest after (each of those is drawn whole)
    plan.sort((a, b) => (a.tl.splitT >= a.tl.total) - (b.tl.splitT >= b.tl.total));
    making = true;
    state.watermark = true;
    let said = 0;
    await makeVideos(stage, plan.map(({ take, tl }) => ({
      name: take,
      setup: async () => { useMusic(tl.items.find((x) => x.kind === "music")); return { total: tl.total, splitT: tl.splitT }; },
      drawAt: (t) => drawTimeline(tl, t),
      audio: () => timelineAudio(tl),
    })), {
      progress: (text) => {
        window.AH_MAKE.progress = text;
        if (Date.now() - said > 15000) { said = Date.now(); console.log(`AH-MAKE PROGRESS ${id} ${text}`); }
      },
      onVideo: async (take, blob, audioCodec, videoCodec) => {
        const { tl } = plan.find((x) => x.take === take);
        const name = `${hymn.id}-${take}-${format}`;
        // VP9 or Opus inside (a browser without H.264/AAC encoders): the server makes it H.264/AAC
        await postFile(`${name}.mp4`, blob, audioCodec !== "aac" || videoCodec !== "avc");
        const end = tl.items.find((x) => x.kind === "end");
        const meta = {
          hymnId: hymn.id, book: hymn.book, number: hymn.number, title: hymn.title, firstLine: firstLine(),
          poet: hymn.poet || "", composer: hymn.composer || "", copyright: hymn.copyright || "",
          take, format, verses: tl.verses, durationS: Math.round(tl.total * 100) / 100, chapters: tl.chapters,
          clip: tl.clip || null, endcard: end ? { startS: Math.round(end.t0 * 100) / 100 } : null,
          player: null, stems: stemsVersion(), // server.py fills in the player's git commit
          tempo: state.tempo, accomp: state.accomp, intro: state.intro, countIn,
          ...(take === "rehearsal" ? { partVerses } : {}),
        };
        await postFile(`${name}.json`, new Blob([JSON.stringify(meta)], { type: "application/json" }));
        console.log(`AH-MAKE FILE ${id} ${name}.mp4`);
      },
    });
    if (p.get("thumb") === "1") {
      for (const take of wanted.filter((x) => x !== "short")) {
        const c = document.createElement("canvas");
        const k = voiceOfTake(take) || null;
        presenter.drawThumb(c, { hymn, colors, badge: hymnBadge(), label: takeLabel(take), voice: k, logo: makeAssets.logo });
        await postFile(`${hymn.id}-${take}-thumb.png`, await new Promise((r) => c.toBlob(r, "image/png")));
      }
    }
    window.AH_MAKE.state = "done";
    window.AH_MAKE.progress = "";
    console.log(`AH-MAKE DONE ${id}`);
  } catch (err) {
    makeFailed(id, err?.message || String(err));
  } finally {
    making = false;
    state.watermark = false;
  }
}

/** The verse a short's clip comes from. */
function shortVerse(clip) {
  return /^(verse|whole):\d+$/.test(clip) ? Number(clip.split(":")[1]) : 1;
}

// ---- controls ------------------------------------------------------------

function bindControls() {
  $("playBtn").onclick = togglePlay;
  $("stopBtn").onclick = stopPlayback;
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.target.closest("input, select, textarea, button, summary, dialog")) return;
    e.preventDefault();
    togglePlay();
  });
  $("tempo").oninput = (e) => { $("tempoLabel").textContent = `${e.target.value} a minute`; };
  $("tempo").onchange = (e) => setTempo(Number(e.target.value));

  $("loopBtn").onclick = () => setLoop(state.loop.from, state.loop.to, !state.loop.on);
  $("keyDown").onclick = () => changeKey(-1);
  $("keyUp").onclick = () => changeKey(1);
  $("keyLabel").onclick = resetKey;
  $("lastVerseUp").value = String(state.lastVerseUp);
  $("lastVerseUp").onchange = (e) => { state.lastVerseUp = Number(e.target.value); save("lastVerseUp"); if (anySung()) prepareStems(); else rebuild(); };
  const loopInput = () => setLoop(Number($("loopFrom").value) || 1, Number($("loopTo").value) || 1, state.loop.on);
  $("loopFrom").onchange = loopInput;
  $("loopTo").onchange = loopInput;

  document.querySelectorAll(".views .seg").forEach((b) => {
    b.onclick = () => { if (state.view === b.dataset.view) return; state.view = b.dataset.view; save("view"); renderAll(); };
  });
  const toggle = (id, key, after) => {
    const b = $(id);
    b.setAttribute("aria-pressed", String(state[key]));
    b.onclick = () => { state[key] = !state[key]; b.setAttribute("aria-pressed", String(state[key])); save(key); after(); };
  };
  toggle("chordsBtn", "chords", () => renderAll());
  toggle("pianoBtn", "piano", () => { $("pianoPanel").hidden = !state.piano || state.view === "presenter"; paint(true); });
  setupPianoSheet();
  const stavesMenu = $("stavesMenu");
  stavesMenu.querySelectorAll("[data-layout]").forEach((b) => b.addEventListener("click", () => { stavesMenu.open = false; setStaves(b.dataset.layout); }));
  stavesMenu.querySelector("[data-acc-staff]").addEventListener("click", () => {
    stavesMenu.open = false;
    state.accStaff = !state.accStaff;
    // a piano staff needs something to show: start the accompaniment if it is off
    if (state.accStaff && state.accomp === "off") { state.accomp = "church"; engine.loadPiano(); rebuild(); }
    save("accStaff", "accomp");
    renderAll();
  });
  stavesMenu.querySelectorAll("[data-words-at]").forEach((b) => b.addEventListener("click", () => { stavesMenu.open = false; setWordsAt(b.dataset.wordsAt); }));
  document.addEventListener("click", (e) => { if (stavesMenu.open && !stavesMenu.contains(e.target)) stavesMenu.open = false; });
  const setToolbarH = () => document.documentElement.style.setProperty("--toolbar-h", `${document.querySelector(".toolbar").offsetHeight}px`);
  setToolbarH();
  window.addEventListener("resize", setToolbarH);
  setupTooltips();
  // the More menu closes after a choice, and when clicking elsewhere
  const more = $("moreMenu");
  more.querySelectorAll(".menu-item").forEach((b) => b.addEventListener("click", () => { more.open = false; }));
  document.addEventListener("click", (e) => { if (more.open && !more.contains(e.target)) more.open = false; });
  $("studioBtn").onclick = openStudio;
  $("studioClose").onclick = () => $("studio").close();
  $("studioReset").onclick = () => studio.reset();

  const WORDS_HINT = {
    all: "Every verse under the music, as in the hymnal.",
    current: "Only the verse being sung; it changes as you go.",
    solfa: "Each voice's own note names (doh, re, mi) in the key being sung, for sight-singing.",
    none: "Plain staves. The line being sung still shows in the bar below.",
  };
  $("wordsHint").textContent = WORDS_HINT[state.words];
  document.querySelectorAll('input[name="wordsMode"]').forEach((r) => {
    r.checked = r.value === state.words;
    r.onchange = () => { state.words = r.value; save("words"); $("wordsHint").textContent = WORDS_HINT[r.value]; renderAll(); if (anySung()) prepareStems(); };
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("optionsMenu").open = false; });
  // the options panel opens just under the toolbar, wherever the page is scrolled
  $("optionsMenu").addEventListener("toggle", () => {
    const bottom = document.querySelector(".toolbar").getBoundingClientRect().bottom;
    document.documentElement.style.setProperty("--toolbar-bottom", `${Math.max(0, bottom)}px`);
  });
  $("verseUnfold").checked = unfolded();
  $("verseUnfold").onchange = (e) => { state.verseLayout = e.target.checked ? "unfold" : "stack"; save("verseLayout"); renderAll(); };
  $("presenterShows").value = state.presenterShows;
  $("presenterShows").onchange = (e) => { state.presenterShows = e.target.value; save("presenterShows"); paint(true); };
  $("fullBtn").onclick = async () => {
    if (state.view !== "presenter") { state.view = "presenter"; save("view"); await renderAll(); }
    $("stageWrap").requestFullscreen?.().catch(() => toast("This browser would not go full screen."));
  };
  $("pageBtn").onclick = enterFullPage;
  $("pageExit").onclick = leaveFullPage;
  $("windowBtn").onclick = openProjector;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (document.body.classList.contains("full-page")) leaveFullPage();
    else if (state.loop.on && !$("optionsMenu").open && !$("studio").open) clearLoop();
  });
  $("lineByLine").checked = state.sweep && state.solfaSweep;
  $("lineByLine").onchange = (e) => {
    state.sweep = state.solfaSweep = e.target.checked;
    store.set("lineByLine", state.sweep); store.set("solfaLineByLine", state.solfaSweep);
    renderAll();
  };
  $("nowbarToggle").checked = state.nowbar;
  $("nowbarToggle").onchange = (e) => { state.nowbar = e.target.checked; save("nowbar"); $("nowbar").hidden = !state.nowbar || state.view === "presenter"; };
  for (const id of ["intro", "interlude"]) {
    const sel = $(id);
    sel.innerHTML = Object.entries(INSTRUMENTAL).map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    sel.value = state[id];
    sel.onchange = () => { state[id] = sel.value; save(id); if (sel.value !== "none") engine.loadPiano(); rebuild(); };
  }
  $("renderSingers").onclick = renderSingers;
  $("showSync").checked = state.showSync;
  $("showSync").onchange = (e) => { state.showSync = e.target.checked; save("showSync"); renderAll(); if (state.showSync) toast(syncSummary(), 6000); };
  $("addSync").onclick = addSyncopation;
  $("restoreRhythm").onclick = restoreRhythm;
  $("countIn").checked = state.countIn;
  $("countIn").onchange = (e) => { state.countIn = e.target.checked; save("countIn"); rebuild(); };
  $("countAt").value = state.countAt;
  $("countAt").onchange = (e) => { state.countAt = e.target.value; save("countAt"); rebuild(); };
  $("zoomIn").onclick = () => { state.zoom = Math.min(2, state.zoom * 1.15); save("zoom"); renderAll(); };
  $("zoomOut").onclick = () => { state.zoom = Math.max(0.6, state.zoom / 1.15); save("zoom"); renderAll(); };
  document.addEventListener("click", (e) => { const m = $("optionsMenu"); if (m.open && !m.contains(e.target)) m.open = false; });

  $("importBtn").onclick = () => $("importFile").click();
  $("importAudioBtn").onclick = () => $("importAudioFile").click();
  $("importAudioFile").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) doImportAudio(f); };
  $("importFile").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) doImport(f); };
  $("exportBtn").onclick = doExport;
  $("recordBtn").onclick = openRecordDialog;

  let w = window.innerWidth;
  let timer;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (Math.abs(window.innerWidth - w) > 40) { w = window.innerWidth; renderAll(); } }, 200);
  });
}

function buildVerseChips() {
  const box = $("verses");
  box.innerHTML = hymn.verses.map((_, i) => `<label><input type="checkbox" value="${i + 1}" ${state.verses.includes(i + 1) ? "checked" : ""}> ${i + 1}</label>`).join("");
  box.querySelectorAll("input").forEach((inp) => {
    inp.onchange = () => {
      const chosen = [...box.querySelectorAll("input:checked")].map((x) => Number(x.value));
      if (!chosen.length) { inp.checked = true; return; } // always at least one verse
      state.verses = chosen;
      store.set(`verses:${hymn.id}`, chosen);
      if (anySung()) prepareStems(); else rebuild();
    };
  });
}

boot();


// ─────────────────────────────────────────────── the Android app's handle
// The app draws its own controls (the player sheet, the views, the voices
// panel) and drives this page through these few calls; it reads state() to
// redraw them. Everything goes through the page's own handlers, so the app
// and the page can never disagree about what is playing or muted.
window.AHStudio = {
  /** "words" | "solfa" | "page" | "tracks" | "presenter" */
  view(v) {
    if (v === "page" && state.staffScroll) v = "tracks"; // the staff moving under a still playhead
    if (v === state.view) return;
    const b = document.querySelector(`.views .seg[data-view="${v}"]`);
    if (b) b.click(); else { state.view = v; save("view"); renderAll(); }
  },
  /** Switch to another hymn without reloading the page. False when the Studio doesn't have it.
   *  Whatever was playing stops at once; until the new hymn has loaded, state() says it is not
   *  ready, so the app's play button can't start the old one. A later open() wins over this one. */
  async open(id, v) {
    appWant.id = id;
    appWant.missing = false;
    if (engine.playing && id !== hymn?.id) stopPlayback(); // the same hymn in another view plays on
    await bootReady;
    if (appWant.id !== id) return false;
    const entry = hymnList.find((x) => x.id === id);
    if (!entry) { appWant.missing = true; if (engine.playing) stopPlayback(); return false; }
    if (hymn?.id !== id) {
      appWant.loading = true;
      try {
        stopPlayback();
        state.zoom = APP_ZOOM; save("zoom"); // each hymn opens at the smallest size: the whole page on the screen
        state.solfaZoom = APP_ZOOM; save("solfaZoom"); // the sol-fa too
        state.altZoom = 1; save("altZoom"); // the words fit themselves to the screen
        $("hymnPicker").value = id;
        history.replaceState(null, "", `${location.pathname}${location.search}#${id}`);
        await loadHymn(entry);
      } finally { if (appWant.id === id) appWant.loading = false; }
      if (appWant.id !== id) return false;
    }
    if (v) this.view(v);
    return true;
  },
  /** The app's view options: words ("all" | "current" | "solfa" | "none": every verse, only the one
   *  being sung, sol-fa names, none), sweep (the staff line by line), staves ("S|A|T|B", "SA|TB", …). */
  set(name, value) {
    if (name === "words" && ["all", "current", "solfa", "none"].includes(value)) {
      const r = document.querySelector(`input[name="wordsMode"][value="${value}"]`);
      if (r) { r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); }
    } else if (name === "sweep") {
      state.sweep = !!value; store.set("lineByLine", state.sweep); renderAll();
    } else if (name === "staves" && /^[SATB|]+$/.test(value)) {
      setStaves(value);
    } else if (name === "accStaff") {
      const want = !!value;
      if (want === !!state.accStaff) return;
      document.querySelector("#stavesMenu [data-acc-staff]")?.click();
    } else if (name === "wordsAt" && ["top", "bottom", "every"].includes(value)) {
      setWordsAt(value);
    } else if (name === "accomp" && value in ACCOMP_STYLES) {
      state.accomp = value; save("accomp");
      if (value !== "off") engine.loadPiano();
      else if (state.accStaff) { state.accStaff = false; save("accStaff"); }
      rebuild(); renderAll();
    } else if ((name === "intro" || name === "interlude") && value in INSTRUMENTAL) {
      const sel = $(name);
      sel.value = value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (name === "countIn") {
      $("countIn").checked = !!value;
      $("countIn").dispatchEvent(new Event("change", { bubbles: true }));
    } else if (name === "fit") {
      if (state.view === "solfa") { state.solfaZoom = APP_ZOOM; save("solfaZoom"); } else { state.zoom = APP_ZOOM; save("zoom"); }
      renderAll();
    } else if (name === "solfaSweep") {
      state.solfaSweep = !!value; store.set("solfaLineByLine", state.solfaSweep); renderAll();
    } else if (name === "zoom" && Number(value) > 0) {
      // the size, as a pinch sets it: the staff's or the sol-fa's, by the view
      const z = Math.max(0.5, Math.min(2.5, Number(value)));
      if (state.view === "solfa") { state.solfaZoom = z; save("solfaZoom"); } else { state.zoom = z; save("zoom"); }
      renderAll();
    } else if (name === "staffScroll") {
      state.staffScroll = !!value; save("staffScroll");
      if (state.view === "page" || state.view === "tracks") this.view(state.staffScroll ? "tracks" : "page");
    } else if (name === "presenterShows" && ["score", "words", "stanza"].includes(value)) {
      const sel = $("presenterShows");
      sel.value = value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (name === "singSolfa") {
      state.singSolfa = !!value; save("singSolfa"); prepareStems();
    } else if (name === "solfaWordsAt" && ["every", "top", "bottom"].includes(value)) {
      state.solfaWordsAt = value; save("solfaWordsAt"); renderAll();
    } else if (name === "instrumental") {
      // instruments only: every voice on the piano instead of singing; off brings the voices back as they were
      const on = !!value;
      if (on === !!state.instrumental) return;
      const chs = ["S", "A", "T", "B"].filter((ch) => hymn?.voices?.[ch]?.length);
      if (on) {
        state.beforeInstrumental = Object.fromEntries(chs.map((ch) => [ch, document.querySelector(`select.vsound[data-sound="${ch}"]`)?.value || "sung"]));
        save("beforeInstrumental");
      }
      state.instrumental = on; save("instrumental");
      for (const ch of chs) this.setSound(ch, on ? "piano" : state.beforeInstrumental?.[ch] || "sung");
    }
  },
  /** Saved singers, for the app's Settings: starts the count; savedList holds the answer (JSON) when done. */
  saved() { this.savedList = null; singers.list().then((l) => { this.savedList = JSON.stringify(l); }, () => { this.savedList = "[]"; }); },
  savedList: null,
  /** Clear saved singers: the given hymn ids, or all of them when none are given. Then recounts. */
  clearSaved(ids) { this.savedList = null; singers.clear(ids && ids.length ? ids : null).finally(() => this.saved()); },
  /** The hymns the Studio can play. */
  hymns() { return JSON.stringify(hymnList.map((x) => x.id)); },
  toggle() { if (appWant.id && (appWant.id !== hymn?.id || appWant.loading)) return; return togglePlay(); },
  stop() { stopPlayback(); },
  setMute(ch, on) { state.mute[ch] = !!on; save("mute"); applyMix(); buildHeaders(); },
  setSolo(ch, on) { state.solo[ch] = !!on; save("solo"); applyMix(); buildHeaders(); },
  setLevel(ch, x) { state.levels[ch] = Math.max(0, Math.min(1, Number(x))); save("levels"); applyMix(); },
  setSound(ch, value) {
    const sel = document.querySelector(`select.vsound[data-sound="${ch}"]`);
    if (!sel) return;
    sel.value = value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  },
  setTempo(bpm) {
    const t = $("tempo");
    t.value = String(Math.round(bpm));
    t.dispatchEvent(new Event("input", { bubbles: true }));
    t.dispatchEvent(new Event("change", { bubbles: true }));
  },
  key(step) { $(step > 0 ? "keyUp" : "keyDown").click(); },
  state() {
    const voices = ["S", "A", "T", "B"].filter((ch) => hymn?.voices?.[ch]?.length).map((ch) => {
      const sel = document.querySelector(`select.vsound[data-sound="${ch}"]`);
      return {
        ch, name: VOICES[ch]?.name ?? ch, mute: !!state.mute[ch], solo: !!state.solo[ch], level: state.levels[ch] ?? 0.8,
        sound: sel?.value ?? "", sounds: sel ? [...sel.options].map((o) => ({ value: o.value, label: o.textContent })) : [],
      };
    });
    // the piano (accompaniment, introduction, interlude): its own loudness, mute and solo
    if (hymn && (state.accomp !== "off" || state.intro !== "none" || state.interlude !== "none")) {
      voices.push({ ch: "acc", name: "Piano", mute: !!state.mute.acc, solo: !!state.solo.acc, level: state.levels.acc ?? 0.55, sound: "", sounds: [] });
    }
    const want = appWant.id ?? hymn?.id ?? null;
    return JSON.stringify({
      ready: !!perf && !appWant.loading && hymn?.id === want, hymn: hymn?.id ?? null, want, missing: appWant.missing,
      title: hymn?.title ?? "", english: hymn?.english ?? "", view: state.view, words: state.words, sweep: !!state.sweep,
      staves: state.tracks.map((t) => t.join("")).join("|"), wordsAt: wordsAt(), accStaff: !!state.accStaff,
      accomp: state.accomp, intro: state.intro, interlude: state.interlude, countIn: !!state.countIn, zoom: state.zoom,
      solfaSweep: !!state.solfaSweep, solfaWordsAt: state.solfaWordsAt, instrumental: !!state.instrumental, singSolfa: !!state.singSolfa, staffScroll: !!state.staffScroll, presenterShows: state.presenterShows,
      accomps: Object.entries(ACCOMP_STYLES).map(([value, label]) => ({ value, label })),
      intros: Object.entries(INSTRUMENTAL).map(([value, label]) => ({ value, label })),
      playing: !!engine?.playing, tempo: state.tempo, key: $("keyLabel")?.textContent ?? "", voices,
    });
  },
};
