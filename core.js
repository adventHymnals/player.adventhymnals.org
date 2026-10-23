// Hymn player core: MusicXML for any track layout, playback timeline, dynamics, accompaniment.
// No DOM here, so it runs in the browser and in Node tests.

export const VOICES = {
  S: { name: "Soprano" },
  A: { name: "Alto" },
  T: { name: "Tenor" },
  B: { name: "Bass" },
};

export const KIND_INTERVALS = {
  "": [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], dim: [0, 3, 6], "+": [0, 4, 8],
  maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9],
  6: [0, 4, 7, 9], m6: [0, 3, 7, 9], sus4: [0, 5, 7], "7sus4": [0, 5, 7, 10], 5: [0, 7],
};

const KIND_XML = {
  "": "major", m: "minor", 7: "dominant", dim: "diminished", "+": "augmented",
  maj7: "major-seventh", m7: "minor-seventh", m7b5: "half-diminished", dim7: "diminished-seventh",
  6: "major-sixth", m6: "minor-sixth", sus4: "suspended-fourth", "7sus4": "suspended-fourth", 5: "power",
};

// loudness of each printed dynamic, as a gain multiplier
export const DYNAMIC_LEVEL = { ppp: 0.3, pp: 0.4, p: 0.52, mp: 0.66, mf: 0.8, f: 0.95, ff: 1.08, fff: 1.18, sf: 1.0, sfz: 1.0, fp: 0.6 };

export const prettyChord = (name) => name.replace(/b/g, "♭").replace(/#/g, "♯");

// ---- transposition ---------------------------------------------------------

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const LETTERS = "CDEFGAB";
const MAJOR_NAME = { 0: "C", 1: "Db", 2: "D", 3: "Eb", 4: "E", 5: "F", 7: "G", 8: "Ab", 9: "A", 10: "Bb", 11: "B" };
const ACC_TEXT = { "-2": "bb", "-1": "b", 0: "", 1: "#", 2: "##" };

/** The key after moving the hymn by `shift` semitones: {name, shift, letter, fromLetter}. */
export function keyAfter(h, shift) {
  const t = h.key.tonic; // LilyPond name: "des", "ees", "fis", "a"
  const letter = t[0].toUpperCase();
  const rest = t.slice(1);
  const alter = (rest.match(/is/g) || []).length - (rest.match(/es|^s/g) || []).length;
  const pc = (((PC[letter] + alter + shift) % 12) + 12) % 12;
  let name;
  if (h.key.mode === "minor") {
    name = { 0: "C", 1: "C#", 2: "D", 3: "Eb", 4: "E", 5: "F", 6: "F#", 7: "G", 8: "G#", 9: "A", 10: "Bb", 11: "B" }[pc];
  } else {
    // F#/Gb: stay on the side of the circle the hymn was written on
    name = MAJOR_NAME[pc] ?? (h.key.fifths < 0 ? "Gb" : "F#");
  }
  return { name, shift, letter: name[0], fromLetter: letter, mode: h.key.mode };
}

/** Respell a chord symbol for a transposed key, keeping its function (IV stays IV). */
export function transposeChordName(name, key) {
  if (!key || !key.shift) return name;
  const letterShift = (LETTERS.indexOf(key.letter) - LETTERS.indexOf(key.fromLetter) + 7) % 7;
  return name.replace(/[A-G](bb|b|##|#)?/g, (m) => {
    const a = { bb: -2, b: -1, "": 0, "#": 1, "##": 2 }[m.slice(1)];
    const L = LETTERS[(LETTERS.indexOf(m[0]) + letterShift) % 7];
    const na = ((((PC[m[0]] + a + key.shift - PC[L]) % 12) + 18) % 12) - 6;
    return L + (ACC_TEXT[na] ?? "");
  });
}

// Bars may differ in length (a pickup bar is short), so bar maths goes through measureStarts.
const starts = (h) => h.measureStarts || Array.from({ length: h.measures }, (_, i) => i * h.measureQ);
export const barStart = (h, m) => starts(h)[Math.max(0, Math.min(h.measures, m) - 1)] ?? h.totalQ;
export const barEnd = (h, m) => (m >= h.measures ? h.totalQ : starts(h)[m]);
export function barAt(h, q) {
  const s = starts(h);
  let m = 1;
  for (let i = 0; i < s.length; i++) if (s[i] <= q + 1e-6) m = i + 1;
  return m;
}
export const trackKey = (voices) => voices.join("");
export const trackName = (voices) => voices.map((k) => VOICES[k].name).join(" and ");

const DIV = 8; // divisions per quarter note
const FLAT_ORDER = "BEADGCF";
const SHARP_ORDER = "FCGDAEB";
const ACC_NAME = { "-2": "flat-flat", "-1": "flat", 0: "natural", 1: "sharp", 2: "double-sharp" };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function noteType(d, dots) {
  const base = d / (dots === 2 ? 1.75 : dots === 1 ? 1.5 : 1);
  return { 4: "whole", 2: "half", 1: "quarter", 0.5: "eighth", 0.25: "16th", 0.125: "32nd" }[base] || "quarter";
}

function keyState(fifths) {
  const st = {};
  const order = fifths < 0 ? FLAT_ORDER : SHARP_ORDER;
  for (let i = 0; i < Math.abs(fifths); i++) st[order[i]] = fifths < 0 ? -1 : 1;
  return st;
}

function rootXml(tag, spelled) {
  const step = spelled[0];
  const alter = -(spelled.match(/b/g) || []).length + (spelled.match(/#/g) || []).length;
  return `<${tag}><${tag}-step>${step}</${tag}-step>${alter ? `<${tag}-alter>${alter}</${tag}-alter>` : ""}</${tag}>`;
}

// Soprano/alto read treble, tenor alone reads octave treble, anything with bass reads bass.
export function clefFor(voices) {
  if (voices.some((k) => k === "S" || k === "A")) return ["G", 2, 0];
  if (voices.every((k) => k === "T")) return ["G", 2, -1];
  return ["F", 4, 0];
}

// Only soprano+alto and tenor+bass may share a staff, as in a hymnal.
export const canJoin = (a, b) => a.length === 1 && b.length === 1 && ["SA", "TB"].includes(a[0] + b[0]);

/**
 * h: hymn JSON. opts:
 *   tracks:  visible staves, top to bottom, each a list of voices, e.g. [["S","A"],["T"],["B"]]
 *   trackWords: booleans, one per track: print lyrics under that staff
 *   words:   "all" | "current" | "solfa" | "none"   (all verses, the verse being sung, each voice's sol-fa, or none)
 *   unfold:  verse numbers to write out one after another as one long score (one line of words each)
 *   verse:   verse number for "current"
 *   chords:  print chord symbols above the top staff
 *   header:  include title and credits (for PDF export)
 */
export function buildMusicXML(h, opts) {
  const tracks = opts.tracks;
  const refrainAt = h.refrainNote ?? Infinity;
  const lyricIndex = new Map(); // onset -> index of the note in the lyric voice
  h.voices[h.lyricVoice].forEach((n, i) => lyricIndex.set(n.q, i));

  // passVerse: when the verses are written out, each pass carries only its own verse
  const lyricsFor = (q, passVerse) => {
    if (opts.words === "none" || opts.words === "solfa" || !lyricIndex.has(q)) return "";
    const i = lyricIndex.get(q);
    const items = [];
    const one = passVerse ?? (opts.words === "current" ? opts.verse : null);
    if (i >= refrainAt) {
      const s = h.refrain[i - refrainAt];
      if (s) items.push([1, s]);
    } else if (one !== null) {
      const s = h.verses[one - 1]?.[i];
      if (s) items.push([1, s, one]);
    } else {
      h.verses.forEach((v, k) => v[i] && items.push([k + 1, v[i], k + 1]));
    }
    return items
      .map(([n, s, label]) => {
        const text = i === 0 && label ? `${label}. ${s.t}` : s.t;
        return `<lyric number="${n}"><syllabic>${s.s}</syllabic><text>${esc(text)}</text></lyric>`;
      })
      .join("");
  };

  // sol-fa words: every voice sings its own note names (a shared staff gets two lines)
  const noteIndex = new Map(Object.values(h.voices).flatMap((ns) => ns.map((n, i) => [n, i])));
  const solfaFor = (k, n, line) => {
    const name = h.solfa?.[k]?.[noteIndex.get(n)];
    return name ? `<lyric number="${line}"><syllabic>single</syllabic><text>${esc(name)}</text></lyric>` : "";
  };
  const passes = opts.unfold?.length ? opts.unfold : [null];

  const parts = tracks.map((voices, si) => {
    const id = `P${si + 1}`;
    const clef = clefFor(voices);
    const twoVoices = voices.length > 1;
    let wedgeOpen = false; // LilyPond ends a hairpin at the next dynamic; MusicXML needs an explicit stop
    let xml = "";
    passes.forEach((passVerse, j) => {
      for (let m = 1; m <= h.measures; m++) {
        const accState = keyState(h.key.fifths);
        const measureState = {};
        const pickupBar = m === 1 && j === 0 && h.pickup > 0;
        // written out: bars run on continuously, pass after pass
        const number = passVerse !== null ? j * h.measures + m : pickupBar ? 0 : h.pickup > 0 ? m - 1 : m;
        let mx = `<measure number="${number}"${pickupBar ? ' implicit="yes"' : ""}>`;
        if (m === 1 && j === 0) {
          mx += `<attributes><divisions>${DIV}</divisions><key><fifths>${h.key.fifths}</fifths><mode>${h.key.mode}</mode></key>`
            + `<time><beats>${h.time[0]}</beats><beat-type>${h.time[1]}</beat-type></time>`
            + `<clef><sign>${clef[0]}</sign><line>${clef[1]}</line>${clef[2] ? `<clef-octave-change>${clef[2]}</clef-octave-change>` : ""}</clef></attributes>`;
          // tempo is set by the player, so no printed metronome mark
          if (si === 0) mx += `<sound tempo="${h.tempo}"/>`;
        }
        if (si === 0) {
          for (const mk of h.marks) {
            if (mk.m === m) mx += `<direction placement="above"><direction-type><words font-style="italic">${esc(mk.text)}</words></direction-type></direction>`;
          }
        }
        const printedDyn = new Set(); // one dynamic per onset per staff
        voices.forEach((k, vi) => {
          if (vi > 0) mx += `<backup><duration>${Math.round((barEnd(h, m) - barStart(h, m)) * DIV)}</duration></backup>`;
          for (const n of h.voices[k].filter((x) => x.m === m)) {
            if (opts.chords && si === 0 && vi === 0) {
              for (const c of h.chords) {
                if (c.q >= n.q && c.q < n.q + n.d) {
                  const off = Math.round((c.q - n.q) * DIV);
                  mx += `<harmony placement="above">${rootXml("root", c.root)}<kind text="${esc(c.kind)}">${KIND_XML[c.kind] || "major"}</kind>${c.bass ? rootXml("bass", c.bass) : ""}${off ? `<offset>${off}</offset>` : ""}</harmony>`;
                }
              }
            }
            const place = twoVoices && vi === 0 ? "above" : "below";
            const direction = (inner) => `<direction placement="${place}"><direction-type>${inner}</direction-type><voice>${vi + 1}</voice></direction>`;
            if (!printedDyn.has(n.q)) {
              if (wedgeOpen && (n.dyn || n.hp)) { mx += direction(`<wedge type="stop"/>`); wedgeOpen = false; }
              if (n.dyn) mx += direction(`<dynamics><${n.dyn}/></dynamics>`);
              if (n.hp === "<" || n.hp === ">") { mx += direction(`<wedge type="${n.hp === "<" ? "crescendo" : "diminuendo"}"/>`); wedgeOpen = true; }
              if (n.dyn || n.hp) printedDyn.add(n.q);
            }
            const k2 = n.step + n.oct;
            const current = k2 in measureState ? measureState[k2] : accState[n.step] ?? 0;
            let acc = "";
            if (n.alter !== current) {
              acc = `<accidental>${ACC_NAME[n.alter]}</accidental>`;
              measureState[k2] = n.alter;
            }
            const fermata = n.f ? `<notations><fermata type="${twoVoices && vi === 1 ? "inverted" : "upright"}"/></notations>` : "";
            const stem = twoVoices ? `<stem>${vi === 0 ? "up" : "down"}</stem>` : "";
            const words = !opts.trackWords?.[si] ? ""
              : opts.words === "solfa" ? solfaFor(k, n, vi + 1)
              : vi === 0 ? lyricsFor(n.q, passVerse) : "";
            mx += `<note><pitch><step>${n.step}</step>${n.alter ? `<alter>${n.alter}</alter>` : ""}<octave>${n.oct}</octave></pitch>`
              + `<duration>${Math.round(n.d * DIV)}</duration><voice>${vi + 1}</voice><type>${noteType(n.d, n.dots)}</type>`
              + `${"<dot/>".repeat(n.dots)}${acc}${stem}${fermata}${words}</note>`;
          }
        });
        const lastPass = j === passes.length - 1;
        if (m === h.measures) mx += `<barline location="right"><bar-style>${lastPass ? "light-heavy" : "light-light"}</bar-style></barline>`;
        else if (h.marks.some((mk) => mk.m === m + 1)) mx += `<barline location="right"><bar-style>light-light</bar-style></barline>`;
        mx += `</measure>`;
        xml += mx;
      }
    });
    return { id, name: trackName(voices), xml };
  });

  const head = opts.header
    ? `<work><work-title>${esc(`${h.number} ${h.title}`)}</work-title></work><identification>${h.composer ? `<creator type="composer">${esc(h.composer)}</creator>` : ""}${h.poet ? `<creator type="lyricist">${esc(h.poet)}</creator>` : ""}</identification>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">${head}<part-list>${parts
    .map((p) => `<score-part id="${p.id}"><part-name>${esc(p.name)}</part-name></score-part>`)
    .join("")}</part-list>${parts.map((p) => `<part id="${p.id}">${p.xml}</part>`).join("")}</score-partwise>`;
}

// ---- syncopation -------------------------------------------------------------

const beatOf = (h) => (h.time[1] === 8 && h.time[0] % 3 === 0 ? 1.5 : 4 / h.time[1]);

/** How strong a position is in its bar: 4 bar start, 3 half-bar (4 beats), 2 beat, 1 half-beat, 0 quarter-beat. */
export function metricWeight(h, q) {
  const beat = beatOf(h);
  const pos = q - barStart(h, barAt(h, q));
  const near = (x) => Math.abs(x - Math.round(x)) < 1e-6;
  if (pos < 1e-6) return 4;
  if (near(pos / beat)) {
    const nb = Math.round(h.measureQ / beat);
    return (nb === 4 || nb === 2) && Math.round(pos / beat) === nb / 2 ? 3 : 2;
  }
  if (near((pos * 2) / beat)) return 1;
  if (near((pos * 4) / beat)) return 0;
  return -1;
}

/**
 * Syncopated notes: a note that starts on a weaker position and is held through a stronger one.
 * Returns [{ voice, i, q, m, over }] where `over` is the strong position it is held through.
 */
export function syncopations(h) {
  const out = [];
  const step = beatOf(h) / 4;
  for (const [voice, notes] of Object.entries(h.voices)) {
    notes.forEach((n, i) => {
      const w = metricWeight(h, n.q);
      let best = null;
      for (let x = n.q + step; x < n.q + n.d - 1e-6; x += step) {
        const wx = metricWeight(h, x);
        if (wx > w && (!best || wx > best.w)) best = { w: wx, q: x };
      }
      if (best) out.push({ voice, i, q: n.q, m: n.m, over: best.q });
    });
  }
  return out;
}

const NOTE_LENGTHS = [0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6];
const dotsFor = (d) => ([0.375, 0.75, 1.5, 3, 6].some((x) => Math.abs(x - d) < 1e-6) ? 1 : 0);

/**
 * Add syncopation to bars from..to by anticipation: the note on beat 2 comes half a beat early,
 * taking the time from the note before it, and is held across the beat. All four voices move
 * together so the words and the harmony stay aligned. Returns a new hymn; the input is unchanged.
 */
export function syncopate(h, from, to) {
  const c = structuredClone(h);
  const beat = beatOf(h);
  const half = beat / 2;
  const fits = (d) => NOTE_LENGTHS.some((x) => Math.abs(x - d) < 1e-6);
  let changed = 0;
  for (let m = from; m <= to; m++) {
    const target = barStart(h, m) + beat; // beat 2
    if (target >= barEnd(h, m) - 1e-6) continue;
    // every voice must have a note starting on beat 2 whose previous note (same bar) can lend half a beat
    const plan = Object.entries(c.voices).map(([k, ns]) => {
      const i = ns.findIndex((n) => Math.abs(n.q - target) < 1e-6);
      const prev = ns[i - 1];
      const ok = i > 0 && prev.m === m && Math.abs(prev.q + prev.d - target) < 1e-6 && prev.d >= beat - 1e-6
        && fits(prev.d - half) && fits(ns[i].d + half);
      return ok ? { ns, i, prev } : null;
    });
    if (plan.some((p) => !p)) continue;
    for (const { ns, i, prev } of plan) {
      prev.d -= half;
      prev.dots = dotsFor(prev.d);
      ns[i].q -= half;
      ns[i].d += half;
      ns[i].dots = dotsFor(ns[i].d);
    }
    changed++;
  }
  c.variant = { kind: "syncopated", from, to, bars: changed };
  return c;
}

// ---- dynamics --------------------------------------------------------------

/** Loudness multiplier for every note of a voice, following marks and hairpins. */
export function dynamicLevels(notes) {
  const levels = new Array(notes.length);
  let level = DYNAMIC_LEVEL.mf;
  let ramp = null; // { from, startQ, dir }
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.dyn && DYNAMIC_LEVEL[n.dyn] !== undefined) { level = DYNAMIC_LEVEL[n.dyn]; ramp = null; }
    if (n.hp === "<" || n.hp === ">") {
      // ramp to the next printed dynamic, or by a step if none follows before the hairpin stops
      let j = i + 1;
      while (j < notes.length && !notes[j].dyn && notes[j].hp !== "!") j++;
      const target = notes[j]?.dyn ? DYNAMIC_LEVEL[notes[j].dyn] : level + (n.hp === "<" ? 0.15 : -0.15);
      ramp = { from: level, to: target, a: n.q, b: notes[j] ? notes[j].q : n.q + n.d };
    }
    let v = level;
    if (ramp) {
      const f = ramp.b > ramp.a ? Math.min(1, (n.q - ramp.a) / (ramp.b - ramp.a)) : 1;
      v = ramp.from + (ramp.to - ramp.from) * f;
      if (n.hp === "!" || f >= 1) { level = ramp.to; ramp = n.hp === "!" ? null : ramp; }
    }
    levels[i] = v;
  }
  return levels;
}

// ---- time ------------------------------------------------------------------

// Score position (quarters) <-> seconds within one pass; fermata notes are held twice as long.
export function timeMap(h, tempo) {
  const spq = 60 / tempo;
  const holds = [];
  for (const n of h.voices[h.lyricVoice]) if (n.f) holds.push([n.q, n.q + n.d]);
  const qToT = (q) => {
    let t = q * spq;
    for (const [a, b] of holds) t += spq * Math.max(0, Math.min(q, b) - a);
    return t;
  };
  const tToQ = (t) => {
    let q = 0;
    let lastT = 0;
    for (const [a, b] of holds) {
      const ta = qToT(a);
      if (t < ta) return q + (t - lastT) / spq;
      const tb = qToT(b);
      if (t < tb) return a + (t - ta) / (2 * spq);
      q = b;
      lastT = tb;
    }
    return q + (t - lastT) / spq;
  };
  return { spq, qToT, tToQ, passT: qToT(h.totalQ) };
}

// ---- accompaniment ---------------------------------------------------------

export const ACCOMP_STYLES = {
  off: "Off",
  hymn: "Hymn on piano",
  block: "Block chords",
  pulse: "Bass and chords",
  broken: "Broken chords",
  sustain: "Sustained chords",
};

function chordAt(h, q) {
  let c = null;
  for (const x of h.chords) if (x.q <= q + 1e-6) c = x; else break;
  return c;
}

function nearest(pc, target) {
  let best = target;
  let bd = 99;
  for (let p = target - 12; p <= target + 12; p++) {
    if (((p % 12) + 12) % 12 === pc && Math.abs(p - target) < bd) { best = p; bd = Math.abs(p - target); }
  }
  return best;
}

function rhVoicing(c, prev) {
  const ints = KIND_INTERVALS[c.kind] || [0, 4, 7];
  const pcs = ints.map((i) => (c.rootPc + i) % 12);
  const candidates = [];
  // every inversion with the lowest note between G3 and F#4
  for (let low = 55; low <= 66; low++) {
    if (!pcs.includes(low % 12)) continue;
    const notes = [low];
    let p = low;
    while (notes.length < pcs.length) {
      p++;
      if (pcs.includes(p % 12) && !notes.some((x) => x % 12 === p % 12)) notes.push(p);
    }
    candidates.push(notes);
  }
  if (!prev) return candidates.reduce((a, b) => (Math.abs(a[0] - 60) <= Math.abs(b[0] - 60) ? a : b));
  const cost = (v) => v.reduce((s, x, i) => s + Math.abs(x - (prev[i] ?? prev[prev.length - 1])), 0);
  return candidates.reduce((a, b) => (cost(a) <= cost(b) ? a : b));
}

/** Accompaniment notes for one pass, in score quarters: [{q, d, p, v}] (v = velocity 0..1). */
export function accompaniment(h, style) {
  if (style === "off") return [];
  if (style === "hymn") {
    return Object.values(h.voices).flat().map((n) => ({ q: n.q, d: n.d, p: n.p, v: 0.55 }));
  }
  const out = [];
  const [num, den] = h.time;
  const beat = den === 8 && num % 3 === 0 ? 1.5 : 4 / den;
  const beats = Math.round(h.measureQ / beat);
  let prevRH = null;
  let prevBass = 43;
  let lastChord = null;
  for (let q = 0; q < h.totalQ - 1e-6; q += beat) {
    const c = chordAt(h, q);
    if (!c) continue;
    const rh = rhVoicing(c, prevRH);
    prevRH = rh;
    const bass = nearest(c.bassPc ?? c.rootPc, prevBass);
    prevBass = Math.max(36, Math.min(50, bass));
    const inBar = Math.round((q - barStart(h, barAt(h, q))) / beat);
    const changed = c !== lastChord;
    lastChord = c;
    const fifth = nearest((c.rootPc + 7) % 12, bass + 4);
    if (style === "block") {
      if (inBar === 0 || changed) out.push({ q, d: beat, p: bass, v: 0.6 }, { q, d: beat, p: bass - 12 >= 28 ? bass - 12 : bass, v: 0.35 });
      rh.forEach((p) => out.push({ q, d: beat * 0.95, p, v: 0.42 }));
    } else if (style === "pulse") {
      const strong = inBar === 0 || (beats === 4 && inBar === 2);
      if (strong) out.push({ q, d: beat, p: beats === 4 && inBar === 2 ? fifth - 12 : bass, v: 0.62 });
      else rh.forEach((p) => out.push({ q, d: beat * 0.55, p, v: 0.4 }));
    } else if (style === "broken") {
      const pattern = [bass, rh[0], rh[1], rh[2] ?? rh[0] + 12, rh[1], rh[0]];
      for (let s = 0; s < 2; s++) {
        const idx = (inBar * 2 + s) % pattern.length;
        out.push({ q: q + (s * beat) / 2, d: beat / 2 + 0.4, p: pattern[idx], v: idx === 0 ? 0.6 : 0.4 });
      }
    } else if (style === "sustain") {
      if (changed || inBar === 0) {
        const end = Math.min(h.totalQ, h.chords.find((x) => x.q > q + 1e-6)?.q ?? h.totalQ);
        const len = Math.min(end - q, barEnd(h, barAt(h, q)) - q);
        out.push({ q, d: len, p: bass, v: 0.5 });
        rh.forEach((p) => out.push({ q, d: len, p, v: 0.33 }));
      }
    }
  }
  return out;
}

export const INSTRUMENTAL = {
  none: "None",
  last4: "Last four bars",
  last8: "Last eight bars",
  refrain: "The refrain",
  all: "The whole hymn",
};

/** Score range [qFrom, qTo) played by an introduction or interlude choice, or null. */
export function instrumentalRange(h, kind) {
  if (!kind || kind === "none") return null;
  if (kind === "all") return [0, h.totalQ];
  if (kind === "refrain") {
    const r = h.marks.find((m) => /refrain|chorus/i.test(m.text));
    return r ? [r.q, h.totalQ] : [barStart(h, Math.max(1, h.measures - 3)), h.totalQ];
  }
  const n = kind === "last8" ? 8 : 4;
  return [barStart(h, Math.max(1, h.measures - n + 1)), h.totalQ];
}

/** Performance time of score position q inside segment k. */
export const passTime = (perf, k, q) => {
  const p = perf.passes[k] ?? perf.passes[0];
  return p.t0 + perf.tm.qToT(q) - perf.tm.qToT(p.qFrom);
};

/**
 * Full performance: an optional count-in bar and introduction, one pass per chosen verse, and
 * optional instrumental interludes between verses.
 * stems: Map "S:1:0" (voice:verse:transpose) -> { offsetSec, duration } of sung recordings at this tempo; their voice's
 * notes stay in the timeline (for highlighting and the waterfall) but are marked silent.
 * Returns { events: [{t, dur, p, ch, v, pass, q, silent?, stem?}],
 *           passes: [{kind: "intro"|"verse"|"interlude", verse, t0, qFrom, qTo}], total, tm, lead }
 */
export function performance(h, { tempo, verses, accomp, countIn, stems = new Map(), intro = "none", interlude = "none", shiftAt = () => 0 }) {
  const tm = timeMap(h, tempo);
  const gap = tm.spq; // one beat of breath between sections
  const lead = countIn ? h.measureQ * tm.spq : 0;
  const events = [];
  const passes = [];
  const acc = accompaniment(h, accomp);
  // instrumental sections use the chosen accompaniment, or the hymn's own parts on piano
  const instAcc = accomp === "off" ? accompaniment(h, "hymn") : acc;
  const introR = instrumentalRange(h, intro);
  const interR = instrumentalRange(h, interlude);
  const levels = Object.fromEntries(Object.keys(h.voices).map((k) => [k, dynamicLevels(h.voices[k])]));
  const accLevel = dynamicLevels(h.voices[h.lyricVoice]);
  const lv = h.voices[h.lyricVoice];
  const levelAt = (q) => { let v = accLevel[0] ?? 0.8; lv.forEach((n, i) => { if (n.q <= q + 1e-6) v = accLevel[i]; }); return v / DYNAMIC_LEVEL.mf; };
  if (countIn) {
    const beat = h.time[1] === 8 && h.time[0] % 3 === 0 ? 1.5 : 4 / h.time[1];
    for (let q = 0; q < h.measureQ - 1e-6; q += beat) events.push({ t: q * tm.spq, dur: 0.05, p: q === 0 ? 96 : 89, ch: "click", v: 0.6, pass: -1, q });
  }
  let t = lead;
  const instrumental = (kind, [qFrom, qTo], verse) => {
    const k = passes.length;
    const t0 = t; // time of qFrom
    passes.push({ kind, verse, t0, qFrom, qTo });
    const at = (q) => t0 + tm.qToT(q) - tm.qToT(qFrom);
    const pass = passes[k];
    for (const n of instAcc) {
      if (n.q < qFrom - 1e-6 || n.q >= qTo - 1e-6) continue;
      events.push({ t: at(n.q), dur: at(Math.min(qTo, n.q + n.d)) - at(n.q), p: n.p + shiftAt(k, pass, n.q), ch: "acc", v: n.v * levelAt(n.q), pass: k, q: n.q });
    }
    t = at(qTo) + gap;
  };
  if (introR) instrumental("intro", introR, verses[0]);
  verses.forEach((verse, vi) => {
    const k = passes.length;
    const t0 = t;
    const pass = { kind: "verse", verse, t0, qFrom: 0, qTo: h.totalQ };
    passes.push(pass);
    // a recording fits a verse sung wholly in one key; a key change inside the verse uses the synth
    const shifts = new Set(lv.map((n) => shiftAt(k, pass, n.q)));
    const verseShift = shifts.size === 1 ? [...shifts][0] : null;
    for (const key of Object.keys(h.voices)) { // a melody-only song has just the soprano
      const stem = verseShift === null ? null : stems.get(`${key}:${verse}:${verseShift}`);
      if (stem) events.push({ t: t0 + stem.offsetSec, dur: stem.duration, ch: key, stem: `${key}:${verse}:${verseShift}`, v: 1, pass: k, q: 0, p: 0 });
      h.voices[key].forEach((n, i) => {
        const tn = t0 + tm.qToT(n.q);
        events.push({ t: tn, dur: t0 + tm.qToT(n.q + n.d) - tn, p: n.p + shiftAt(k, pass, n.q), ch: key, v: levels[key][i], pass: k, q: n.q, silent: !!stem });
      });
    }
    for (const n of acc) {
      const tn = t0 + tm.qToT(n.q);
      events.push({ t: tn, dur: t0 + tm.qToT(Math.min(h.totalQ, n.q + n.d)) - tn, p: n.p + shiftAt(k, pass, n.q), ch: "acc", v: n.v * levelAt(n.q), pass: k, q: n.q });
    }
    t = t0 + tm.passT + gap;
    if (interR && vi < verses.length - 1) instrumental("interlude", interR, verse);
  });
  events.sort((a, b) => a.t - b.t);
  return { events, passes, total: t, tm, lead };
}

/** Where are we at time t? -> { pass, kind, verse, t0, q } or null before the first section. */
export function locate(perf, t) {
  let cur = null;
  perf.passes.forEach((p, k) => { if (t >= p.t0 - 1e-6) cur = { pass: k, kind: p.kind, verse: p.verse, t0: p.t0, qFrom: p.qFrom, qTo: p.qTo }; });
  if (!cur) return null;
  const q = perf.tm.tToQ(t - cur.t0 + perf.tm.qToT(cur.qFrom));
  return { ...cur, q: Math.min(q, cur.qTo) };
}

/** Seconds of a bar range [from, to] (1-based, inclusive) inside a given section. */
export function barSpan(h, perf, pass, from, to) {
  const k = perf.passes[pass]?.kind === "verse" ? pass : Math.max(0, perf.passes.findIndex((p) => p.kind === "verse"));
  return [passTime(perf, k, barStart(h, from)), passTime(perf, k, barEnd(h, to))];
}

export function chordIndexAt(h, q) {
  let i = -1;
  h.chords.forEach((c, k) => { if (c.q <= q + 1e-6) i = k; });
  return i;
}
