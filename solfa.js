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
   * opts: { voices: ["S","A","T","B"], words: "all"|"current"|"none", verse, chords: bool,
   *         wordsUnder: "S" | "every" | null (the words under one voice, or under every voice) }
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
    // every bar has the same rows, so the bars on a line line up: verse bars and refrain bars alike
    const alts = (h.refrains || []).filter(Boolean).length;
    this.wordRows = opts.words === "none" ? 0 : opts.words === "current" ? 1 : Math.max(h.verses.length, 1 + alts);
    const under = (k) => opts.words !== "none" && (opts.wordsUnder === "every" || k === opts.wordsUnder);
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
      html += `<div class="sf-bar" data-bar="${m}" style="--nb: ${nb}">${mark ? `<div class="sf-mark">${esc(mark.text)}</div>` : `<div class="sf-mark"></div>`}`;
      if (opts.chords) {
        html += `<div class="sf-row sf-chords"><span class="sf-bl"></span>`;
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
        if (under(k)) html += this.wordsRows(h, a, b, beat, nb, sylAt, refrainAt, opts);
      }
      html += `</div>`;
    }
    html += `</div>`;
    this.content.innerHTML = html;
    this.voices = opts.voices;
    this.bars = [...this.content.querySelectorAll(".sf-bar")];
    this.bars.at(-1)?.classList.add("sf-final");
    this.widthScale = opts.widthScale || 1;
    this.layout();
    const els = this.content.querySelectorAll("[data-c]");
    els.forEach((el) => { this.cells[Number(el.dataset.c)].el = el; });
    this.syls = withEnds([...this.content.querySelectorAll(".sf-syl")].map((el) => ({ el, on: Number(el.dataset.q), verse: Number(el.dataset.v) })));
    this.chordEls = [...this.content.querySelectorAll(".sf-chord")];
    this.active = new Set();
  }

  /** Bars into lines that fill the width, as a printed sol-fa page: each line starts with the voices'
   *  letters, its bars stretched so every line ends at the right edge. Again after a resize or zoom. */
  layout() {
    const flow = this.content.querySelector(".sf-flow");
    if (!flow || !this.bars?.length) return;
    // pinched bigger: the lines of the smallest size, wider than the screen (it scrolls sideways)
    flow.style.width = "";
    if (this.widthScale > 1) flow.style.width = `${Math.floor(flow.offsetWidth * this.widthScale)}px`;
    // natural widths first, all on one unwrapped row, each with the voices' letters as a line's first bar has
    flow.classList.add("measuring");
    for (const b of this.bars) { this.label(b, true); flow.append(b); }
    flow.querySelectorAll(".sf-line").forEach((l) => l.remove());
    const withLabel = this.bars.map((b) => b.getBoundingClientRect().width);
    for (const b of this.bars) this.label(b, false);
    const widths = this.bars.map((b) => b.getBoundingClientRect().width);
    flow.classList.remove("measuring");
    const avail = flow.getBoundingClientRect().width - 2;
    const lines = [];
    let cur = [], w = 0;
    this.bars.forEach((b, i) => {
      const add = cur.length ? widths[i] : withLabel[i];
      if (cur.length && w + add > avail) { lines.push(cur); cur = []; w = 0; }
      cur.push(i); w += cur.length === 1 ? withLabel[i] : widths[i];
    });
    if (cur.length) lines.push(cur);
    this.lines = lines.map((idx, n) => {
      const line = document.createElement("div");
      line.className = "sf-line";
      this.label(this.bars[idx[0]], true);
      for (const i of idx) line.append(this.bars[i]);
      const used = withLabel[idx[0]] + idx.slice(1).reduce((t, i) => t + widths[i], 0);
      // the last line stretches only when it is nearly full; a bar wider than the screen is shrunk
      if (n === lines.length - 1 && used < avail * 0.7) line.classList.add("sf-short");
      if (used > avail) line.style.zoom = String(Math.max(0.5, avail / used));
      flow.append(line);
      return { el: line, bars: idx.map((i) => this.bars[i]) };
    });
  }

  /** The voices' letters at the start of a bar's rows (the first bar on a line), or none. */
  label(bar, on) {
    bar.querySelectorAll(".sf-lab").forEach((x) => x.remove());
    bar.classList.toggle("sf-first", on);
    if (!on) return;
    let k = 0;
    for (const row of bar.children) {
      if (!row.classList.contains("sf-row")) continue;
      const lab = document.createElement("span");
      lab.className = "sf-lab";
      lab.setAttribute("aria-hidden", "true");
      if (row.classList.contains("sf-voice")) lab.textContent = this.voices[k++];
      row.prepend(lab);
    }
  }

  wordsRows(h, a, b, beat, nb, sylAt, refrainAt, opts) {
    const lv = h.voices[h.lyricVoice];
    const inBar = lv.filter((n) => n.q >= a - 1e-6 && n.q < b - 1e-6);
    const isRefrain = inBar.length && sylAt.get(inBar[0].q) >= refrainAt;
    // refrain rows: verse 1's (0), then each verse's own refrain words (1000 + verse)
    const alts = (h.refrains || []).map((r, i) => (r ? 1000 + i + 1 : 0)).filter(Boolean);
    const verses = isRefrain
      ? (opts.words === "current" ? [h.refrains?.[opts.verse - 1] ? 1000 + opts.verse : 0] : [0, ...alts])
      : opts.words === "current" ? [opts.verse] : h.verses.map((_, i) => i + 1);
    let out = "";
    for (const v of verses) {
      out += `<div class="sf-row sf-words"><span class="sf-bl"></span>`;
      for (let i = 0; i < nb; i++) {
        const ba = a + i * beat;
        const ns = inBar.filter((n) => n.q >= ba - 1e-6 && n.q < ba + beat - 1e-6);
        const parts = ns.map((n) => {
          const idx = sylAt.get(n.q);
          let s, dv = v;
          if (isRefrain) s = v > 1000 ? h.refrains[v - 1001]?.[idx - refrainAt] : h.refrain[idx - refrainAt];
          else if (idx < refrainAt) s = h.verses[v - 1]?.[idx];
          // the refrain starting inside a verse bar (its pickup, e.g. "Mwam-ba"): the verse's own refrain
          // words on its row, or the refrain once, on the first row
          else if (h.refrains?.[v - 1]) { s = h.refrains[v - 1][idx - refrainAt]; dv = 1000 + v; }
          else if (v === verses[0]) { s = h.refrain?.[idx - refrainAt]; dv = 0; }
          if (!s) return "";
          const label = idx === 0 && !isRefrain ? `${v}. ` : idx === refrainAt && v > 1000 ? `${v - 1000}. ` : "";
          const dash = s.s === "begin" || s.s === "middle" ? "-" : "";
          return `<span class="sf-syl" data-q="${n.q}" data-v="${dv}">${esc(label + s.t + dash)}</span>`;
        });
        out += `<span class="sf-beat">${parts.join(" ")}</span>`;
      }
      out += `</div>`;
    }
    for (let k = verses.length; k < this.wordRows; k++) out += `<div class="sf-row sf-words"><span class="sf-bl"></span>${`<span class="sf-beat">&nbsp;</span>`.repeat(nb)}</div>`;
    return out;
  }

  highlight(q, verseN) {
    const now = new Set(this.cells.filter((c) => c.on <= q + 1e-6 && q < c.off - 1e-6));
    for (const c of this.active) if (!now.has(c)) c.el?.classList.remove("on");
    for (const c of now) c.el?.classList.add("on");
    this.active = now;
    for (const s of this.syls) s.el.classList.toggle("sung", (s.verse === verseN || (s.verse === 0 && verseN < 1000)) && s.on <= q + 1e-6 && q < s.end - 1e-6);
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
    list.forEach((s, i) => { let j = i + 1; while (list[j] && list[j].on <= s.on + 1e-6) j++; s.end = list[j] ? list[j].on : Infinity; });
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
        if (!n || !s) return; // no note, or a melisma note
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
      const label = h.marks.find((m) => m.text)?.text || "Refrain";
      if (h.refrains?.[v - 1]) html += block(h.refrains[v - 1], refrainAt, `${label} (verse ${v})`, 1000 + v);
      else if (h.refrain?.length && (v === verses[0] || opts.refrainEach)) html += block(h.refrain, refrainAt, label, 0);
    }
    this.content.innerHTML = `<div class="w-sheet${opts.chords ? " with-chords" : ""}">${html}</div>`;
    if (opts.fit) this.fit();
    this.alt = new Set((h.refrains || []).map((r, i) => (r ? i + 1 : 0)).filter(Boolean));
    this.syls = withEnds([...this.content.querySelectorAll(".w-syl")].map((el) => ({ el, on: Number(el.dataset.q), verse: Number(el.dataset.v) })));
    this.chordEls = [...this.content.querySelectorAll(".w-chord")];
  }

  /** As large as the screen allows: the longest line just fills the width. */
  fit() {
    const sheet = this.content.querySelector(".w-sheet");
    if (!sheet) return;
    sheet.classList.add("w-fit");
    sheet.style.fontSize = "20px";
    const room = sheet.clientWidth;
    const widest = Math.max(1, ...[...sheet.querySelectorAll(".w-line")].map((l) => l.scrollWidth));
    sheet.style.fontSize = `${Math.max(12, Math.min(64, Math.floor(20 * (room / widest) * 0.97)))}px`;
  }

  /** Returns the element being sung, for scrolling. */
  highlight(q, verseN, inRefrain) {
    let cur = null;
    for (const s of this.syls) {
      const mine = inRefrain ? s.verse === (this.alt?.has(verseN) ? 1000 + verseN : 0) : s.verse === verseN;
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
