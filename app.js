import {
  VOICES, ACCOMP_STYLES, INSTRUMENTAL, buildMusicXML, performance, locate, barSpan, passTime, chordIndexAt, prettyChord,
  trackKey, trackName, pianoVoices, barAt, barEnd, keyAfter, transposeChordName, syncopations, syncopate,
} from "./core.js";
import { Engine } from "./audio.js";
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
// ?remote=<url>: this copy is bundled in the app; hymn data and recordings come from that site
// (the live list and new hymns when online, the bundled copy when not)
const REMOTE = new URLSearchParams(location.search).get("remote") || "";
// where the recordings are: the published site sets <meta name="ah-audio"> to the audio store (Cloudflare R2);
// otherwise they come from the site itself (or the local copy)
const AUDIO = document.querySelector('meta[name="ah-audio"]')?.content || REMOTE;
// and the hymns themselves (the list and each hymn's file): the published site reads them from the same store,
// so a new hymn goes live by upload, with no rebuild of the site
const DATA = document.querySelector('meta[name="ah-data"]')?.content || REMOTE;
const NO_STORE = new URLSearchParams(location.search).has("test") || EMBED;
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
};
let hymnWritten = null; // the hymn as transcribed; `hymn` may be a rhythm variant of it
// key changes made while playing: from section k at score position q, move by delta semitones
let liveChanges = [];
let renderedShift = 0;
const save = (...keys) => keys.forEach((k) => store.set(k, state[k]));

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
    if (v && ["tracks", "page", "solfa", "words", "presenter"].includes(v)) state.view = v;
  }
  if (asked && !hymnList.some((x) => x.id === asked)) { notInStudio(asked); return; }
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
  setupPractice();
  solfa = new SolfaView($("altView"));
  words = new WordsView($("altView"));
  presenter = new Presenter($("stage"), $("measureHost"));
  studio = new Studio($("studio"));
  await document.fonts.ready;
  await loadHymn(hymnList.find((x) => x.id === picker.value));
  requestAnimationFrame(frame);
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
  try {
    hymn = await (await fetch(entry.path).then((r) => (r.ok ? r : Promise.reject(r))).catch(() => fetch(entry.fallback || entry.path))).json();
    hymnWritten = hymn;
  } catch {
    $("score").innerHTML = `<p class="status">This hymn's file is missing: ${entry.path}. Run <code>python3 build_web.py</code>, then reload.</p>`;
    return;
  }
  store.set("hymn", hymn.id);
  document.title = `${hymn.number} ${hymn.title}`;
  $("hymnNumber").textContent = hymn.number;
  $("hymnTitle").textContent = hymn.title;
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
    const r = await fetch(`${AUDIO}audio/${hymn.id}/manifest.json`, { cache: "no-cache" })
      .catch(() => fetch(`${AUDIO}audio/${hymn.id}/manifest.json`, { cache: "force-cache" }));
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
  const solfaWords = state.words === "solfa";
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
      const what = state.words === "solfa" ? "&words=solfa" : `&verses=${verses.join(",")}`;
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
  $("altView").hidden = isScoreView() || state.view === "presenter";
  buildHeaders();
  lastSystem = null;
  lastFollowEl = null;
  if (projectorOpen() && state.view !== "presenter") prepareStage();
  if (state.view === "presenter") {
    positionHeaders(null);
    await prepareStage();
  } else if (state.view === "solfa") {
    const voices = visibleVoices();
    solfa.render(hymn, { voices, words: state.words, verse: renderedVerse, chords: state.chords, wordsUnder: voices.includes("S") ? "S" : voices[0], chordName: (n) => chordLabel(n) });
    if (state.showSync) {
      const marked = new Set(syncopations(hymn).map((x) => `${x.voice}:${x.q}`));
      for (const c of solfa.cells) if (marked.has(`${c.voice}:${c.on}`)) c.el?.classList.add("sync");
    }
    positionHeaders(null);
  } else if (state.view === "words") {
    words.render(hymn, { words: state.words === "none" ? "all" : state.words, verse: renderedVerse, chords: state.chords, chordName: (n) => chordLabel(n) });
    positionHeaders(null);
  } else {
    const opts = withPiano(xmlOptions());
    view.render(buildMusicXML(scoreHymn(), opts), { mode: state.view, zoom: state.zoom, width: viewport.clientWidth - 8, tracks: opts.tracks, barOffset: hymn.pickup > 0 ? 1 : 0, transpose });
    buildLane();
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
  drag = { bar: view.barAt(e.clientX - r.left, e.clientY - r.top), x: e.clientX, moved: false, note: e.target.closest("g.note") };
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
  if (state.words === "current" && !unfolded() && loc && loc.verse !== renderedVerse && state.view !== "presenter") { renderAll(); return; }
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
    if (!loc) alt.clear();
    else {
      const el = state.view === "solfa" ? solfa.highlight(q, sung ? (q >= refrainQ ? (hymn.refrains?.[loc.verse - 1] ? 1000 + loc.verse : 0) : loc.verse) : -2) : words.highlight(q, sung ? loc.verse : -2, q >= refrainQ);
      alt.markChord(ci, hymn);
      const target = state.view === "solfa" ? el : el?.closest(".w-line");
      if (engine.playing && target && target !== lastFollowEl) {
        lastFollowEl = target;
        target.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
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
  if (ph.system.el !== lastSystem) {
    lastSystem = ph.system.el;
    positionHeaders(ph.system);
    if (engine.playing) {
      const top = viewport.getBoundingClientRect().top + window.scrollY + ph.top;
      window.scrollTo({ top: top - window.innerHeight * 0.2, behavior: reduceMotion ? "auto" : "smooth" });
    }
  }
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
    if (v === state.view) return;
    const b = document.querySelector(`.views .seg[data-view="${v}"]`);
    if (b) b.click(); else { state.view = v; save("view"); renderAll(); }
  },
  /** Switch to another hymn without reloading the page. False when the Studio doesn't have it. */
  async open(id, v) {
    const entry = hymnList.find((x) => x.id === id);
    if (!entry) return false;
    if (hymn?.id !== id) {
      stopPlayback();
      $("hymnPicker").value = id;
      history.replaceState(null, "", `${location.pathname}${location.search}#${id}`);
      await loadHymn(entry);
    }
    if (v) this.view(v);
    return true;
  },
  /** The hymns the Studio can play. */
  hymns() { return JSON.stringify(hymnList.map((x) => x.id)); },
  toggle() { return togglePlay(); },
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
    return JSON.stringify({
      ready: !!perf, hymn: hymn?.id ?? null, title: hymn?.title ?? "", view: state.view,
      playing: !!engine?.playing, tempo: state.tempo, key: $("keyLabel")?.textContent ?? "", voices,
    });
  },
};
