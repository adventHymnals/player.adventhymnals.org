// Tonic sol-fa (Curwen) and words-only views, as HTML. Both expose the same small interface
// as ScoreView for the app: render(...), highlight(q, verseN), clear(), playhead-free.

import { VOICES, barStart, barEnd, prettyChord } from "./core.js";

const STEPS = "CDEFGAB";
const NAMES = ["d", "r", "m", "f", "s", "l", "t"];
const RAISED = { d: "de", r: "ri", f: "fe", s: "se", l: "le", m: "f", t: "d" };
const LOWERED = { r: "ra", m: "ma", s: "sa", l: "lo", t: "ta", d: "t", f: "m" };
const FLAT_ORDER = "BEADGCF";
const SHARP_ORDER = "FCGDAEB";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function keyAlter(fifths, step) {
  const order = fifths < 0 ? FLAT_ORDER : SHARP_ORDER;
  return order.slice(0, Math.abs(fifths)).includes(step) ? Math.sign(fifths) : 0;
}

/** The doh of the key: letter, and the letter-octave that sounds unmarked for each voice. */
function dohOf(h) {
  const t = h.key.tonic; // LilyPond name, e.g. "des", "fis", "a"
  let step = STEPS.indexOf(t[0].toUpperCase());
  if (h.key.mode === "minor") step = (step + 2) % 7; // lah-minor: doh is the relative major
  return step;
}

function solfaName(h, n, dohStep, refOct) {
  const deg = (STEPS.indexOf(n.step) - dohStep + 7) % 7;
  let name = NAMES[deg];
  const chroma = n.alter - keyAlter(h.key.fifths, n.step);
  if (chroma > 0) name = RAISED[name] || name;
  else if (chroma < 0) name = LOWERED[name] || name;
  // octave by letter position, so chromatic notes keep their octave mark
  const abs = n.oct * 7 + STEPS.indexOf(n.step);
  const dohAbs = refOct * 7 + dohStep;
  const oct = Math.floor((abs - dohAbs) / 7);
  return { name, oct };
}

const beatLen = (h) => (h.time[1] === 8 && h.time[0] % 3 === 0 ? 1.5 : 4 / h.time[1]);
const PREFIX = (f) => (Math.abs(f - 0.5) < 0.01 ? "." : Math.abs(f - 0.25) < 0.01 ? "," : Math.abs(f - 0.75) < 0.01 ? ".," : Math.abs(f - 1 / 3) < 0.02 || Math.abs(f - 2 / 3) < 0.02 ? "," : "");

/** Separator before beat i of a bar: strong ":" normally, "!" for the half-bar in 4 beats. */
const SEP = (i, beats) => (i === 0 ? "" : beats === 4 && i === 2 ? "!" : ":");

function marks(oct) {
  if (oct > 0) return `<sup class="om">${"ʹ".repeat(oct)}</sup>`;
  if (oct < 0) return `<sub class="om">${"ˏ".repeat(-oct)}</sub>`;
  return "";
}

export class SolfaView {
  constructor(content) {
    this.content = content;
    this.cells = [];
    this.syls = [];
    this.chordEls = [];
    this.active = new Set();
  }

  /**
   * opts: { voices: ["S","A","T","B"], words: "all"|"current"|"none", verse, chords: bool, wordsUnder: "S"|null }
   */
  render(h, opts) {
    const dohStep = dohOf(h);
    const beat = beatLen(h);
    // unmarked octave: from the doh in octave 4 for soprano and alto, octave 3 for tenor and bass
    const REF = { S: 4, A: 4, T: 3, B: 3 };
    const refOct = (k) => REF[k];
    const lv = h.voices[h.lyricVoice];
    const refrainAt = h.refrainNote ?? Infinity;
    const sylAt = new Map(lv.map((n, i) => [n.q, i]));
    const name = opts.chordName || ((n) => prettyChord(n));
    const keyName = name(spellTonic(h, dohStep));
    let html = `<div class="sf-key">Doh is ${esc(keyName)} <span class="sf-time">${h.time[0]}/${h.time[1]}</span></div>`;
    this.cells = [];
    const bars = h.measures;
    html += `<div class="sf-flow">`;
    for (let m = 1; m <= bars; m++) {
      const a = barStart(h, m);
      const b = barEnd(h, m);
      const nb = Math.max(1, Math.round((b - a) / beat));
      const mark = h.marks.find((x) => x.m === m);
      html += `<div class="sf-bar" data-bar="${m}">${mark ? `<div class="sf-mark">${esc(mark.text)}</div>` : `<div class="sf-mark"></div>`}`;
      if (opts.chords) {
        html += `<div class="sf-row sf-chords">`;
        for (let i = 0; i < nb; i++) {
          const ba = a + i * beat;
          const cs = h.chords.filter((c) => c.q >= ba - 1e-6 && c.q < ba + beat - 1e-6);
          html += `<span class="sf-beat">${cs.map((c) => `<span class="sf-chord" data-q="${c.q}">${esc(name(c.name))}</span>`).join(" ")}</span>`;
        }
        html += `</div>`;
      }
      for (const k of opts.voices) {
        html += `<div class="sf-row sf-voice" style="--vc: var(--${k})"><span class="sf-bl">|</span>`;
        for (let i = 0; i < nb; i++) {
          const ba = a + i * beat;
          const be = ba + beat;
          let cell = SEP(i, nb) ? `<span class="sf-sep">${SEP(i, nb)}</span>` : "";
          const inBeat = h.voices[k].filter((n) => n.q >= ba - 1e-6 && n.q < be - 1e-6);
          const held = h.voices[k].find((n) => n.q < ba - 1e-6 && n.q + n.d > ba + 1e-6);
          if (held && !inBeat.some((n) => Math.abs(n.q - ba) < 1e-6)) cell += `<span class="sf-hold">-</span>`;
          for (const n of inBeat) {
            const { name, oct } = solfaName(h, n, dohStep, refOct(k));
            const pre = PREFIX((n.q - ba) / beat);
            const id = this.cells.length;
            this.cells.push({ voice: k, on: n.q, off: n.q + n.d, id });
            cell += `${pre ? `<span class="sf-pre">${pre}</span>` : ""}<span class="sf-n" data-c="${id}">${name}${marks(oct)}${n.f ? `<span class="sf-ferm">𝄐</span>` : ""}</span>`;
          }
          html += `<span class="sf-beat">${cell}</span>`;
        }
        html += `</div>`;
        if (k === opts.wordsUnder && opts.words !== "none") html += this.wordsRows(h, a, b, beat, nb, sylAt, refrainAt, opts);
      }
      html += `</div>`;
    }
    html += `<span class="sf-bl sf-end">‖</span></div>`;
    this.content.innerHTML = html;
    const els = this.content.querySelectorAll("[data-c]");
    els.forEach((el) => { this.cells[Number(el.dataset.c)].el = el; });
    this.syls = withEnds([...this.content.querySelectorAll(".sf-syl")].map((el) => ({ el, on: Number(el.dataset.q), verse: Number(el.dataset.v) })));
    this.chordEls = [...this.content.querySelectorAll(".sf-chord")];
    this.bars = [...this.content.querySelectorAll(".sf-bar")];
    this.active = new Set();
  }

  wordsRows(h, a, b, beat, nb, sylAt, refrainAt, opts) {
    const lv = h.voices[h.lyricVoice];
    const inBar = lv.filter((n) => n.q >= a - 1e-6 && n.q < b - 1e-6);
    const isRefrain = inBar.length && sylAt.get(inBar[0].q) >= refrainAt;
    const verses = isRefrain ? [0] : opts.words === "current" ? [opts.verse] : h.verses.map((_, i) => i + 1);
    let out = "";
    for (const v of verses) {
      out += `<div class="sf-row sf-words"><span class="sf-bl"></span>`;
      for (let i = 0; i < nb; i++) {
        const ba = a + i * beat;
        const ns = inBar.filter((n) => n.q >= ba - 1e-6 && n.q < ba + beat - 1e-6);
        const parts = ns.map((n) => {
          const idx = sylAt.get(n.q);
          const s = isRefrain ? h.refrain[idx - refrainAt] : h.verses[v - 1]?.[idx];
          if (!s) return "";
          const label = idx === 0 && !isRefrain ? `${v}. ` : "";
          const dash = s.s === "begin" || s.s === "middle" ? "-" : "";
          return `<span class="sf-syl" data-q="${n.q}" data-v="${isRefrain ? 0 : v}">${esc(label + s.t + dash)}</span>`;
        });
        out += `<span class="sf-beat">${parts.join(" ")}</span>`;
      }
      out += `</div>`;
    }
    return out;
  }

  highlight(q, verseN) {
    const now = new Set(this.cells.filter((c) => c.on <= q + 1e-6 && q < c.off - 1e-6));
    for (const c of this.active) if (!now.has(c)) c.el?.classList.remove("on");
    for (const c of now) c.el?.classList.add("on");
    this.active = now;
    for (const s of this.syls) s.el.classList.toggle("sung", (s.verse === 0 || s.verse === verseN) && s.on <= q + 1e-6 && q < s.end - 1e-6);
    const cur = [...now][0]?.el?.closest(".sf-bar");
    if (cur && cur !== this.curBar) { this.curBar?.classList.remove("cur"); cur.classList.add("cur"); this.curBar = cur; }
    return cur;
  }

  markChord(i, h) {
    const q = h.chords[i]?.q;
    this.chordEls.forEach((el) => el.classList.toggle("sounding", Number(el.dataset.q) === q));
  }

  clear() { this.highlight(-1, 0); this.curBar?.classList.remove("cur"); this.curBar = null; }

  barAtEl(el) { const b = el.closest(".sf-bar"); return b ? Number(b.dataset.bar) : null; }
}

// each syllable lasts until the next one in the same verse row
function withEnds(syls) {
  const byVerse = new Map();
  for (const s of syls) { if (!byVerse.has(s.verse)) byVerse.set(s.verse, []); byVerse.get(s.verse).push(s); }
  for (const list of byVerse.values()) {
    list.sort((a, b) => a.on - b.on);
    list.forEach((s, i) => { s.end = list[i + 1] ? list[i + 1].on : Infinity; });
  }
  return syls;
}

function spellTonic(h, dohStep) {
  const step = STEPS[dohStep];
  const a = keyAlter(h.key.fifths, step);
  return step + (a < 0 ? "b" : a > 0 ? "#" : "");
}

/** Words only, verse by verse; with chords, a chord-over-lyrics chart. */
export class WordsView {
  constructor(content) {
    this.content = content;
    this.syls = [];
    this.chordEls = [];
  }

  render(h, opts) {
    const lv = h.voices[h.lyricVoice];
    const refrainAt = h.refrainNote ?? Infinity;
    const chordAt = (q0, q1) => h.chords.filter((c) => c.q >= q0 - 1e-6 && c.q < q1 - 1e-6);
    const block = (syl, offset, label, verseN) => {
      let html = "";
      let line = "";
      let word = "";
      let chars = 0; // letters on the line so far, to decide whether a comma ends it
      syl.forEach((s, j) => {
        const i = j + offset;
        const n = lv[i];
        if (!n) return;
        const cs = opts.chords ? chordAt(n.q, lv[i + 1]?.q ?? h.totalQ) : [];
        const joinNext = s.s === "begin" || s.s === "middle";
        // chord-over-lyrics: each syllable is a small column, its chord(s) on top
        const chord = cs.map((c) => `<span class="w-chord" data-q="${c.q}">${esc((opts.chordName || prettyChord)(c.name))}</span>`).join("");
        word += `<span class="w-syl${joinNext ? "" : " w-end"}" data-q="${n.q}" data-v="${verseN}"><span class="w-c">${chord}</span><span class="w-t">${esc(s.t)}${joinNext ? "" : "&nbsp;"}</span></span>`;
        chars += s.t.length;
        if (joinNext) return;
        // a word's syllables stay together when the line wraps
        line += `<span class="w-word">${word}</span>`;
        word = "";
        // a line ends where the sense does: a full stop or semicolon, or a comma once the line is long enough
        if (/[;:.!?]$/.test(s.t) || (/,$/.test(s.t) && chars >= 24)) { html += `<p class="w-line">${line}</p>`; line = ""; chars = 0; }
      });
      if (word) line += `<span class="w-word">${word}</span>`;
      if (line) html += `<p class="w-line">${line}</p>`;
      return `<section class="w-block" data-v="${verseN}"><h3>${esc(label)}</h3>${html}</section>`;
    };
    let html = "";
    const verses = opts.words === "current" ? [opts.verse] : h.verses.map((_, i) => i + 1);
    for (const v of verses) {
      html += block(h.verses[v - 1] || [], 0, `Verse ${v}`, v);
      if (h.refrain?.length && (v === verses[0] || opts.refrainEach)) html += block(h.refrain, refrainAt, h.marks.find((m) => m.text)?.text || "Refrain", 0);
    }
    this.content.innerHTML = `<div class="w-sheet${opts.chords ? " with-chords" : ""}">${html}</div>`;
    this.syls = withEnds([...this.content.querySelectorAll(".w-syl")].map((el) => ({ el, on: Number(el.dataset.q), verse: Number(el.dataset.v) })));
    this.chordEls = [...this.content.querySelectorAll(".w-chord")];
  }

  /** Returns the element being sung, for scrolling. */
  highlight(q, verseN, inRefrain) {
    let cur = null;
    for (const s of this.syls) {
      const mine = inRefrain ? s.verse === 0 : s.verse === verseN;
      const on = mine && s.on <= q + 1e-6 && q < s.end - 1e-6;
      s.el.classList.toggle("sung", on);
      if (on) cur = s.el;
    }
    return cur;
  }

  markChord(i, h) {
    const q = h.chords[i]?.q;
    this.chordEls.forEach((el) => el.classList.toggle("sounding", Number(el.dataset.q) === q));
  }

  clear() { this.syls.forEach((s) => s.el.classList.remove("sung")); }
}

export { VOICES };
