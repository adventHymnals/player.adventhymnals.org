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
// the piano accompaniment's two hands, shown as a grand staff under the voices
export const PIANO_HANDS = { R: { name: "Piano, right hand" }, L: { name: "Piano, left hand" } };
export const trackName = (voices) => voices.map((k) => (VOICES[k] || PIANO_HANDS[k]).name).join(" and ");

const DIV = 24; // divisions per quarter note (divisible by 3 for triplets)
const FLAT_ORDER = "BEADGCF";
const SHARP_ORDER = "FCGDAEB";
const ACC_NAME = { "-2": "flat-flat", "-1": "flat", 0: "natural", 1: "sharp", 2: "double-sharp" };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function noteType(d, dots) {
  const base = Math.round((d / (dots === 2 ? 1.75 : dots === 1 ? 1.5 : 1)) * 1000) / 1000;
  return { 4: "whole", 2: "half", 1: "quarter", 0.5: "eighth", 0.25: "16th", 0.125: "32nd" }[base] || "quarter";
}

// A silence of d quarter notes as rests that can be written (whole, half, ..., dotted), longest first;
// a part that only fits in triplets (thirds of a beat, beside triplet notes) becomes triplet rests.
const REST_KINDS = [[6, 1, 4], [4, 0, 4], [3, 1, 2], [2, 0, 2], [1.5, 1, 1], [1, 0, 1], [0.75, 1, 0.5], [0.5, 0, 0.5], [0.375, 1, 0.25], [0.25, 0, 0.25], [0.125, 0, 0.125]];
function greedyRests(d) {
  const out = [];
  let left = d;
  while (left > 1e-6) {
    const k = REST_KINDS.find(([len]) => len <= left + 1e-6);
    if (!k) break;
    out.push({ d: k[0], dots: k[1] });
    left -= k[0];
  }
  return { out, left };
}
function restChunks(d) {
  const plain = greedyRests(d);
  if (plain.left < 1e-4) return plain.out;
  // the plain part and the triplet part with the fewest rests (then the most plain)
  let best = null;
  for (let std = 0; std <= d + 1e-9; std += 0.125) {
    const a = greedyRests(std);
    const trip = greedyRests((d - std) * 1.5);
    if (a.left > 1e-4 || trip.left > 1e-4) continue;
    const n = a.out.length + trip.out.length;
    if (!best || n < best.n || (n === best.n && std > best.std)) {
      best = { n, std, out: [...a.out, ...trip.out.map((r) => ({ d: r.d / 1.5, dots: r.dots, written: r.d, trip: true }))] };
    }
  }
  return best ? best.out : plain.out;
}

function restXml(d, voice, wholeBar) {
  if (wholeBar) return `<note><rest measure="yes"/><duration>${Math.round(d * DIV)}</duration><voice>${voice}</voice></note>`;
  const rs = restChunks(d);
  const first = rs.findIndex((r) => r.trip);
  const last = rs.map((r) => !!r.trip).lastIndexOf(true);
  // triplet rests sit in a (hidden) tuplet of their own, or the renderer would count them at full length
  return rs.map((r, i) => `<note><rest/><duration>${Math.round(r.d * DIV)}</duration><voice>${voice}</voice>`
    + `<type>${noteType(r.written ?? r.d, r.dots)}</type>${"<dot/>".repeat(r.dots)}`
    + `${r.trip ? "<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>" : ""}`
    + `${i === first || i === last ? `<notations>${i === first ? '<tuplet type="start" bracket="no" show-number="none"/>' : ""}${i === last ? '<tuplet type="stop"/>' : ""}</notations>` : ""}</note>`).join("");
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

// Soprano/alto read treble; tenor and bass read bass, as in the hymnal (also the tenor on its own staff).
// the words on a hidden lyric voice (see buildMusicXML) show although their note is hidden
export const SVG_CSS = "g.verse{visibility:visible}";

export function clefFor(voices) {
  if (voices.some((k) => k === "S" || k === "A" || k === "R")) return ["G", 2, 0];
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

  // passVerse: when the verses are written out, each pass carries only its own verse.
  // k, idx: the voice and its note; a voice with words of its own (h.voiceWords) shows them,
  // and the lyric voice's words where its list says "*".
  const refrainQ = h.voices[h.lyricVoice][refrainAt]?.q ?? Infinity;
  const lyricsFor = (q, passVerse, k, idx) => {
    if (opts.words === "none" || opts.words === "solfa") return "";
    const own = h.voiceWords?.[k];
    const ownAt = (v) => { const e = own?.[v]?.[idx]; return e === undefined || e === "*" ? undefined : e; };
    const i = lyricIndex.get(q);
    if (i === undefined && !own) return "";
    const items = [];
    const one = passVerse ?? (opts.words === "current" ? opts.verse : null);
    if (q >= refrainQ - 1e-9) {
      // a verse with refrain words of its own (h.refrains) gets them; stacked, they follow as extra lines
      const alt = (v) => h.refrains?.[v - 1];
      const mine = ownAt(0);
      if (one !== null && alt(one)) {
        const s = i !== undefined ? alt(one)[i - refrainAt] : null;
        if (s) items.push([1, s]);
      } else {
        const s = mine !== undefined ? mine : i !== undefined ? h.refrain[i - refrainAt] : null;
        if (s) items.push([1, s]);
        if (one === null && i !== undefined) {
          let n = 1;
          // only from where its words part from verse 1's, labelled there
          h.refrains?.forEach((r, v) => {
            if (!r) return;
            const from = r.findIndex((x, j) => x?.t !== h.refrain[j]?.t);
            n++;
            if (from >= 0 && i - refrainAt >= from && r[i - refrainAt]) items.push([n, r[i - refrainAt], i - refrainAt === from ? v + 1 : null, true]);
          });
        }
      }
    } else if (one !== null) {
      const mine = ownAt(one - 1);
      const s = mine !== undefined ? mine : i !== undefined ? h.verses[one - 1]?.[i] : null;
      if (s) items.push([1, s, one]);
    } else {
      h.verses.forEach((v, n) => {
        const mine = ownAt(n);
        const s = mine !== undefined ? mine : i !== undefined ? v[i] : null;
        if (s) items.push([n + 1, s, n + 1]);
      });
    }
    return items
      .map(([n, s, label, alt]) => {
        // the verse number goes on a verse's first syllable, and where a verse's own refrain words begin
        const text = label && (i === 0 || alt) ? `${label}. ${s.t}` : s.t;
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
    // words under a staff without the lyric voice (e.g. under tenor/bass) ride on a hidden copy of the
    // lyric voice's rhythm, or a syllable sung while this staff holds a note would have nowhere to go
    const ghost = !!opts.trackWords?.[si] && opts.words !== "none" && opts.words !== "solfa"
      && !voices.includes(h.lyricVoice) && !voices.some((k) => h.voiceWords?.[k] || PIANO_HANDS[k]);
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
        // a syllable where the staff's upper voice has no note goes on the lower voice's note instead
        const upperOnsets = new Set(h.voices[voices[0]].filter((x) => x.m === m).map((x) => x.q));
        voices.forEach((k, vi) => {
          if (vi > 0) mx += `<backup><duration>${Math.round((barEnd(h, m) - barStart(h, m)) * DIV)}</duration></backup>`;
          // rests fill every silence, so each note sits at its own time (Verovio places notes one after another)
          const inBar = h.voices[k].filter((x) => x.m === m);
          let at = barStart(h, m);
          if (!inBar.length) mx += restXml(barEnd(h, m) - at, vi + 1, true);
          for (const n of inBar) {
            if (n.q > at + 1e-6) mx += restXml(n.q - at, vi + 1);
            at = n.q + n.d;
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
            const vn = h.voices[k];
            const prev = vn[vn.indexOf(n) - 1];
            const tieStop = !!prev?.tie && prev.p === n.p;
            const tieStart = !!n.tie && vn[vn.indexOf(n) + 1]?.p === n.p;
            const ties = (tieStop ? '<tie type="stop"/>' : "") + (tieStart ? '<tie type="start"/>' : "");
            const tied = (tieStop ? '<tied type="stop"/>' : "") + (tieStart ? '<tied type="start"/>' : "");
            // a triplet note: written value is d * actual/normal, with a bracket over its group
            const tm = n.tup ? `<time-modification><actual-notes>${n.tup[0]}</actual-notes><normal-notes>${n.tup[1]}</normal-notes></time-modification>` : "";
            const tPrev = vn[vn.indexOf(n) - 1], tNext = vn[vn.indexOf(n) + 1];
            const tupStart = n.tup && tPrev?.tup?.[2] !== n.tup[2], tupStop = n.tup && tNext?.tup?.[2] !== n.tup[2];
            const tupMark = (tupStart ? '<tuplet type="start" bracket="yes"/>' : "") + (tupStop ? '<tuplet type="stop"/>' : "");
            const written = n.tup ? (n.d * n.tup[0]) / n.tup[1] : n.d;
            // a syllable held over several notes of a voice (a melisma) is slurred, as printed: a note is held
            // when no syllable of the verses on show starts on it (its own words, or the lyric voice's at its onset)
            const slurMark = (() => {
              if (PIANO_HANDS[k]) return "";
              const one = passVerse ?? (opts.words === "current" ? opts.verse : null);
              const shown = one ? [one] : h.verses.map((_, v) => v + 1);
              const sylOf = (v) => [...(h.verses[v - 1] || []), ...(h.refrains?.[v - 1] || h.refrain || [])];
              const sets = shown.map(sylOf);
              const own = h.voiceWords?.[k];
              const startsIn = (j, v, si) => {
                const e = own?.[v - 1]?.[j] ?? own?.[0]?.[j];
                if (e !== undefined && e !== "*") return e !== null;
                const i = lyricIndex.get(vn[j].q);
                return i !== undefined && sets[si][i] != null;
              };
              const joined = (j) => j > 0 && j < vn.length && !vn[j - 1].tie && Math.abs(vn[j - 1].q + vn[j - 1].d - vn[j].q) < 1e-6;
              const held = (j) => joined(j) && shown.some((v, si) => !startsIn(j, v, si));
              const heldAll = (j) => joined(j) && shown.every((v, si) => !startsIn(j, v, si));
              const j = vn.indexOf(n);
              if (held(j + 1) && !held(j)) {
                // dashed where only some of the verses on show hold the syllable here
                let e = j + 1, all = true;
                while (held(e)) { all = all && heldAll(e); e++; }
                return `<slur type="start" placement="${twoVoices && vi === 1 ? "below" : "above"}"${all ? "" : ' line-type="dashed"'}/>`;
              }
              return held(j) && !held(j + 1) ? '<slur type="stop"/>' : "";
            })();
            const fermataMark = n.f ? `<fermata type="${twoVoices && vi === 1 ? "inverted" : "upright"}"/>` : "";
            const fermata = fermataMark || tied || tupMark || slurMark ? `<notations>${tied}${slurMark}${tupMark}${fermataMark}</notations>` : "";
            const stem = twoVoices ? `<stem>${vi === 0 ? "up" : "down"}</stem>` : "";
            const words = !opts.trackWords?.[si] ? ""
              : opts.words === "solfa" ? solfaFor(k, n, vi + 1)
              : ghost ? ""
              : vi === 0 || !upperOnsets.has(n.q) ? lyricsFor(n.q, passVerse, k, h.voices[k].indexOf(n)) : "";
            mx += `<note><pitch><step>${n.step}</step>${n.alter ? `<alter>${n.alter}</alter>` : ""}<octave>${n.oct}</octave></pitch>`
              + `<duration>${Math.round(n.d * DIV)}</duration>${ties}<voice>${vi + 1}</voice><type>${noteType(written, n.dots)}</type>`
              + `${"<dot/>".repeat(n.dots)}${acc}${tm}${stem}${fermata}${words}</note>`;
            // a chord (the piano hands): the other notes struck with this one
            for (const x of n.chord || []) {
              const kx = x.step + x.oct;
              const curx = kx in measureState ? measureState[kx] : accState[x.step] ?? 0;
              let accx = "";
              if (x.alter !== curx) { accx = `<accidental>${ACC_NAME[x.alter]}</accidental>`; measureState[kx] = x.alter; }
              mx += `<note><chord/><pitch><step>${x.step}</step>${x.alter ? `<alter>${x.alter}</alter>` : ""}<octave>${x.oct}</octave></pitch>`
                + `<duration>${Math.round(n.d * DIV)}</duration><voice>${vi + 1}</voice><type>${noteType(written, n.dots)}</type>`
                + `${"<dot/>".repeat(n.dots)}${accx}${tm}${stem}</note>`;
            }
          }
          if (inBar.length && at < barEnd(h, m) - 1e-6) mx += restXml(barEnd(h, m) - at, vi + 1);
        });
        if (ghost) {
          const gv = voices.length + 1;
          const hide = (x) => x.replaceAll("<note>", '<note print-object="no">');
          const lv = h.voices[h.lyricVoice];
          const pitch = clef[0] === "F" ? ["D", 3] : ["B", 4];
          mx += `<backup><duration>${Math.round((barEnd(h, m) - barStart(h, m)) * DIV)}</duration></backup>`;
          let at = barStart(h, m);
          for (const n of lv.filter((x) => x.m === m)) {
            if (n.q > at + 1e-6) mx += hide(restXml(n.q - at, gv));
            at = n.q + n.d;
            const written = n.tup ? (n.d * n.tup[0]) / n.tup[1] : n.d;
            const tm = n.tup ? `<time-modification><actual-notes>${n.tup[0]}</actual-notes><normal-notes>${n.tup[1]}</normal-notes></time-modification>` : "";
            mx += `<note print-object="no"><pitch><step>${pitch[0]}</step><octave>${pitch[1]}</octave></pitch>`
              + `<duration>${Math.round(n.d * DIV)}</duration><voice>${gv}</voice><type>${noteType(written, n.dots)}</type>`
              + `${"<dot/>".repeat(n.dots)}${tm}${lyricsFor(n.q, passVerse, h.lyricVoice, lv.indexOf(n))}</note>`;
          }
          if (at < barEnd(h, m) - 1e-6) mx += hide(restXml(barEnd(h, m) - at, gv, at === barStart(h, m)));
        }
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
    .map((p) => {
      // the piano's two staves are one instrument: braced together
      const sp = `<score-part id="${p.id}"><part-name>${esc(p.name)}</part-name></score-part>`;
      if (p.name === PIANO_HANDS.R.name) return `<part-group type="start" number="9"><group-symbol>brace</group-symbol><group-barline>yes</group-barline></part-group>${sp}`;
      if (p.name === PIANO_HANDS.L.name) return `${sp}<part-group type="stop" number="9"/>`;
      return sp;
    })
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
  church: "Church piano",
  gospel: "Gospel piano",
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

// The beat a hymn is felt in (a dotted quarter in 6/8, 9/8, 12/8) and how many fit in a bar.
const beatInfo = (h) => {
  const [num, den] = h.time;
  const beat = den === 8 && num % 3 === 0 ? 1.5 : 4 / den;
  return { beat, beats: Math.round(h.measureQ / beat) };
};

/** The notes of voice k sounding at q (or null). */
const soundingAt = (h, k, q) => (h.voices[k] || []).find((n) => n.q <= q + 1e-6 && q < n.q + n.d - 1e-6) || null;

/** Church piano, as church pianists play a hymn: soprano and alto in the right hand (the tune on top), tenor and
 *  bass in the left with the bass doubled an octave lower; on a long note the chord is struck again on the beat. */
function churchPiano(h) {
  const out = [];
  const { beat } = beatInfo(h);
  const add = (n, hand, v, q = n.q, d = n.d) => out.push({ q, d, p: n.p, v, hand });
  for (const k of ["S", "A"]) for (const n of h.voices[k] || []) add(n, "R", k === "S" ? 0.62 : 0.45);
  for (const k of ["T", "B"]) for (const n of h.voices[k] || []) add(n, "L", 0.45);
  for (const n of h.voices.B || []) if (n.p - 12 >= 28) add({ ...n, p: n.p - 12 }, "L", 0.5);
  // fills: on each beat inside a note held two beats or more, strike the chord again, softer
  const onsets = new Set(Object.values(h.voices).flat().map((n) => Math.round(n.q * 1000)));
  for (let q = 0; q < h.totalQ - 1e-6; q += beat) {
    if (onsets.has(Math.round(q * 1000))) continue;
    const s = soundingAt(h, "S", q);
    if (!s || s.d < 2 * beat - 1e-6) continue;
    const next = Math.min(q + beat, s.q + s.d);
    for (const k of ["A", "T"]) { const n = soundingAt(h, k, q); if (n) out.push({ q, d: next - q, p: n.p, v: 0.3, hand: k === "A" ? "R" : "L" }); }
  }
  return out;
}

/** Gospel piano: the tune in octaves with the alto between in the right hand; the left hand plays the bass in
 *  octaves on the strong beats (root, then the fifth) and the chord on the off-beats. */
function gospelPiano(h) {
  const out = [];
  const { beat, beats } = beatInfo(h);
  for (const n of h.voices.S || []) {
    out.push({ q: n.q, d: n.d, p: n.p, v: 0.62, hand: "R" });
    const a = soundingAt(h, "A", n.q);
    if (a && a.p < n.p) out.push({ q: n.q, d: n.d, p: a.p, v: 0.42, hand: "R" });
    if (n.p - 12 > (a ? a.p : 0) && n.p - 12 >= 55) out.push({ q: n.q, d: n.d, p: n.p - 12, v: 0.42, hand: "R" });
  }
  let prevBass = 43;
  for (let q = 0; q < h.totalQ - 1e-6; q += beat) {
    const c = chordAt(h, q);
    if (!c) continue;
    const inBar = Math.round((q - barStart(h, barAt(h, q))) / beat);
    const strong = inBar === 0 || (beats === 4 && inBar === 2);
    if (strong) {
      const root = nearest(c.bassPc ?? c.rootPc, prevBass);
      const p = beats === 4 && inBar === 2 ? nearest((c.rootPc + 7) % 12, root) : root;
      prevBass = Math.max(36, Math.min(50, p));
      out.push({ q, d: beat, p, v: 0.6, hand: "L" });
      if (p - 12 >= 28) out.push({ q, d: beat, p: p - 12, v: 0.5, hand: "L" });
    } else {
      // the off-beat chord, low in the left hand (between C3 and C4)
      const ints = KIND_INTERVALS[c.kind] || [0, 4, 7];
      const pcs = ints.map((i) => (c.rootPc + i) % 12);
      const notes = [];
      for (let p = 48; p <= 60 && notes.length < 3; p++) if (pcs.includes(p % 12)) notes.push(p);
      notes.forEach((p) => out.push({ q, d: beat * 0.6, p, v: 0.36, hand: "L" }));
    }
  }
  return out;
}

// spelling a MIDI pitch in the hymn's key: sharps in sharp keys, flats in flat keys
const SHARP_NAMES = [["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0], ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0]];
const FLAT_NAMES = [["C", 0], ["D", -1], ["D", 0], ["E", -1], ["E", 0], ["F", 0], ["G", -1], ["G", 0], ["A", -1], ["A", 0], ["B", -1], ["B", 0]];
function spell(p, fifths) {
  const [step, alter] = (fifths < 0 ? FLAT_NAMES : SHARP_NAMES)[((p % 12) + 12) % 12];
  return { step, alter, oct: Math.floor(p / 12) - 1, p };
}
const WRITABLE = [[4, 0], [3, 1], [2, 0], [1.5, 1], [1, 0], [0.75, 1], [0.5, 0], [0.375, 1], [0.25, 0]];

/** The accompaniment as two "voices" for the score: R (right hand, treble) and L (left hand, bass). Each note is a
 *  chord of everything that hand strikes at that moment, held until its next chord (or its own end, or the bar line),
 *  rounded to a length that can be written. */
export function pianoVoices(h, style) {
  const notes = accompaniment(h, style);
  const out = { R: [], L: [] };
  for (const hand of ["R", "L"]) {
    const mine = notes.filter((n) => n.hand === hand).sort((a, b) => a.q - b.q);
    const onsets = [...new Set(mine.map((n) => Math.round(n.q * 1e4) / 1e4))].sort((a, b) => a - b);
    let group = 0;
    let prevTripletEnd = -1;
    onsets.forEach((q, i) => {
      const at = mine.filter((n) => Math.abs(n.q - q) < 1e-3);
      const ps = [...new Set(at.map((n) => n.p))].sort((a, b) => b - a);
      const m = barAt(h, q);
      const room = Math.min(onsets[i + 1] ?? h.totalQ, barEnd(h, m)) - q;
      if (room < 0.16) return;
      const want = Math.min(room, Math.max(...at.map((n) => n.d)));
      const [top, ...rest] = ps.map((p) => spell(p, h.key.fifths));
      const exact = WRITABLE.find(([len]) => Math.abs(len - want) < 1e-3);
      const trip = !exact && WRITABLE.find(([len, dt]) => !dt && Math.abs(len - want * 1.5) < 1e-3);
      if (trip) {
        // a triplet note (three in the time of two), as in the voices it follows
        if (Math.abs(prevTripletEnd - q) > 1e-3) group++;
        prevTripletEnd = q + want;
        out[hand].push({ ...top, q, d: want, dots: 0, m, f: false, chord: rest, tup: [3, 2, `${hand}${group}`] });
        return;
      }
      const [d, dots] = exact || WRITABLE.find(([len]) => len <= want + 1e-6) || [0.25, 0];
      out[hand].push({ ...top, q, d, dots, m, f: false, chord: rest });
    });
  }
  return out;
}

/** Accompaniment notes for one pass, in score quarters: [{q, d, p, v, hand}] (v = velocity 0..1; hand "R" or "L",
 *  for showing it on a grand staff). */
export function accompaniment(h, style) {
  if (style === "off") return [];
  if (style === "church") return churchPiano(h);
  if (style === "gospel") return gospelPiano(h);
  if (style === "hymn") {
    return Object.entries(h.voices).flatMap(([k, notes]) => notes.map((n) => ({ q: n.q, d: n.d, p: n.p, v: 0.55, hand: k === "S" || k === "A" ? "R" : "L" })));
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
      if (inBar === 0 || changed) out.push({ q, d: beat, p: bass, v: 0.6, hand: "L" }, { q, d: beat, p: bass - 12 >= 28 ? bass - 12 : bass, v: 0.35, hand: "L" });
      rh.forEach((p) => out.push({ q, d: beat * 0.95, p, v: 0.42, hand: "R" }));
    } else if (style === "pulse") {
      const strong = inBar === 0 || (beats === 4 && inBar === 2);
      if (strong) out.push({ q, d: beat, p: beats === 4 && inBar === 2 ? fifth - 12 : bass, v: 0.62, hand: "L" });
      else rh.forEach((p) => out.push({ q, d: beat * 0.55, p, v: 0.4, hand: "R" }));
    } else if (style === "broken") {
      const pattern = [bass, rh[0], rh[1], rh[2] ?? rh[0] + 12, rh[1], rh[0]];
      for (let s = 0; s < 2; s++) {
        const idx = (inBar * 2 + s) % pattern.length;
        out.push({ q: q + (s * beat) / 2, d: beat / 2 + 0.4, p: pattern[idx], v: idx === 0 ? 0.6 : 0.4, hand: idx === 0 ? "L" : "R" });
      }
    } else if (style === "sustain") {
      if (changed || inBar === 0) {
        const end = Math.min(h.totalQ, h.chords.find((x) => x.q > q + 1e-6)?.q ?? h.totalQ);
        const len = Math.min(end - q, barEnd(h, barAt(h, q)) - q);
        out.push({ q, d: len, p: bass, v: 0.5, hand: "L" });
        rh.forEach((p) => out.push({ q, d: len, p, v: 0.33, hand: "R" }));
      }
    }
  }
  return out;
}

export const INSTRUMENTAL = {
  none: "None",
  first4: "First four bars",
  first8: "First eight bars",
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
  const n = /8$/.test(kind) ? 8 : 4;
  // The bars are only a guide: an introduction ends (or an ending begins) where a phrase of the words does,
  // the phrase boundary nearest to that many bars ("Awake, my soul! stretch every nerve," and not on into "And").
  const bounds = phraseBounds(h);
  // (a long phrase with no stop near there keeps the bar count, less the next phrase's pickup)
  const up = h.pickup > 0 && h.pickup < h.measureQ ? h.pickup : 0;
  const nearest = (q) => {
    const b = bounds.reduce((x, y) => (Math.abs(y - q) < Math.abs(x - q) ? y : x), bounds[0]);
    return Math.abs(b - q) <= h.measureQ * 1.5 ? b : null;
  };
  if (kind.startsWith("first")) {
    const bars = barEnd(h, Math.min(h.measures, n + (up ? 1 : 0)));
    const end = nearest(bars) ?? (bars < h.totalQ ? bars - up : bars);
    return [0, end > 0 ? end : h.totalQ];
  }
  const bars = barStart(h, Math.max(1, h.measures - n + 1));
  const start = nearest(bars) ?? Math.max(0, bars - up);
  return [start < h.totalQ ? start : 0, h.totalQ];
}

/** Where the phrases of the first verse (and refrain) begin: 0, every syllable after one that ends with
 *  punctuation, and the end. Falls back to the bar lines when the hymn has no words. */
export function phraseBounds(h) {
  const lv = h.voices[h.lyricVoice] || [];
  const syl = [...(h.verses[0] || []), ...(h.refrains?.[0] || h.refrain || [])];
  const out = new Set([0, h.totalQ]);
  let after = false;
  lv.forEach((n, i) => {
    const x = syl[i];
    if (!x) return;
    if (after) out.add(n.q);
    after = /[,;:.!?]["'’”)]*$/.test(x.t);
  });
  if (out.size === 2) for (let m = 1; m <= h.measures; m++) out.add(barStart(h, m));
  return [...out].sort((a, b) => a - b);
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
// countAt: the count-in bar comes at the very start ("start") or after the introduction, just before the singing ("verse").
// introVoice: a voice whose own line the introduction plays (over a soft accompaniment), for a one-voice practice video.
export function performance(h, { tempo, verses, accomp, countIn, countAt = "start", introVoice = null, stems = new Map(), intro = "none", interlude = "none", shiftAt = () => 0, metronome = false }) {
  const tm = timeMap(h, tempo);
  // sections follow straight on, in time: the last bar is already full (or short by the pickup that starts the next)
  const gap = 0;
  const countBar = countIn ? h.measureQ * tm.spq : 0;
  const events = [];
  const passes = [];
  const acc = accompaniment(h, accomp);
  // instrumental sections use the chosen accompaniment, or the hymn's own parts on piano
  const interR = instrumentalRange(h, interlude);
  const levels = Object.fromEntries(Object.keys(h.voices).map((k) => [k, dynamicLevels(h.voices[k])]));
  const accLevel = dynamicLevels(h.voices[h.lyricVoice]);
  const lv = h.voices[h.lyricVoice];
  const levelAt = (q) => { let v = accLevel[0] ?? 0.8; lv.forEach((n, i) => { if (n.q <= q + 1e-6) v = accLevel[i]; }); return v / DYNAMIC_LEVEL.mf; };
  const introR = instrumentalRange(h, intro);
  // with no introduction the count-in is at the start either way
  const countFirst = countIn && (countAt !== "verse" || !introR);
  const clickBeat = h.time[1] === 8 && h.time[0] % 3 === 0 ? 1.5 : 4 / h.time[1];
  let countT = -1; // when the count-in bar starts
  const countBarAt = (t0) => {
    countT = t0;
    for (let q = 0; q < h.measureQ - 1e-6; q += clickBeat) events.push({ t: t0 + q * tm.spq, dur: 0.05, p: q === 0 ? 96 : 89, ch: "click", v: 0.6, pass: -1, q });
  };
  if (countFirst) countBarAt(0);
  const lead = countFirst ? countBar : 0;
  let t = lead;
  const instrumental = (kind, [qFrom, qTo], verse) => {
    const k = passes.length;
    const t0 = t; // time of qFrom
    passes.push({ kind, verse, t0, qFrom, qTo });
    const at = (q) => t0 + tm.qToT(q) - tm.qToT(qFrom);
    const pass = passes[k];
    // Each voice's line is played on the piano in its OWN channel, so mute and solo act on an introduction or
    // interlude just as on a verse (solo the tenor: the introduction plays the tenor line). A chosen accompaniment
    // style plays under them on its own channel. In a one-voice video, that voice's line is on top.
    for (const key of Object.keys(h.voices)) {
      const lead = introVoice && kind === "intro" ? (key === introVoice ? 0.95 : 0.3) : null;
      h.voices[key].forEach((n, i) => {
        if (n.q < qFrom - 1e-6 || n.q >= qTo - 1e-6) return;
        events.push({ t: at(n.q), dur: at(Math.min(qTo, n.q + n.d)) - at(n.q), p: n.p + shiftAt(k, pass, n.q), ch: key, inst: true,
          v: lead ?? levels[key][i] * 0.85, pass: k, q: n.q, i });
      });
    }
    if (accomp !== "off") {
      for (const n of acc) {
        if (n.q < qFrom - 1e-6 || n.q >= qTo - 1e-6) continue;
        events.push({ t: at(n.q), dur: at(Math.min(qTo, n.q + n.d)) - at(n.q), p: n.p + shiftAt(k, pass, n.q), ch: "acc", v: n.v * levelAt(n.q) * (introVoice && kind === "intro" ? 0.35 : 1), pass: k, q: n.q });
      }
    }
    t = at(qTo) + gap;
  };
  if (introR) instrumental("intro", introR, verses[0]);
  if (countIn && !countFirst) { countBarAt(t); t += countBar; }
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
        events.push({ t: tn, dur: t0 + tm.qToT(n.q + n.d) - tn, p: n.p + shiftAt(k, pass, n.q), ch: key, v: levels[key][i], pass: k, q: n.q, i, silent: !!stem });
      });
    }
    for (const n of acc) {
      const tn = t0 + tm.qToT(n.q);
      events.push({ t: tn, dur: t0 + tm.qToT(Math.min(h.totalQ, n.q + n.d)) - tn, p: n.p + shiftAt(k, pass, n.q), ch: "acc", v: n.v * levelAt(n.q), pass: k, q: n.q });
    }
    t = t0 + tm.passT + gap;
    if (interR && vi < verses.length - 1) instrumental("interlude", interR, verse);
  });
  // the beats of every section, for the metronome and for "tap along"
  const beat = beatOf(h);
  const beatsInBar = (m) => Math.max(1, Math.round((barEnd(h, m) - barStart(h, m)) / beat));
  const fullBeats = Math.round(h.measureQ / beat);
  const beats = [];
  // the count-in bar counts too: 1, 2, 3 before the music starts
  if (countT >= 0) for (let b = 0; b < fullBeats; b++) beats.push({ t: countT + b * beat * tm.spq, bar: 0, beat: b, pass: -1 });
  passes.forEach((p, k) => {
    for (let m = 1; m <= h.measures; m++) {
      const nb = beatsInBar(m);
      for (let b = 0; b < nb; b++) {
        const q = barStart(h, m) + b * beat;
        if (q < p.qFrom - 1e-6 || q >= p.qTo - 1e-6) continue;
        // a short pickup bar holds the last beats of a full bar
        const inBar = nb < fullBeats ? fullBeats - nb + b : b;
        const tq = passTime({ passes, tm }, k, q);
        beats.push({ t: tq, bar: m, beat: inBar, pass: k });
        if (metronome) {
          const strong = inBar === 0;
          const half = fullBeats === 4 && inBar === 2;
          events.push({ t: tq, dur: 0.05, p: strong ? 96 : half ? 92 : 89, ch: "click", v: strong ? 0.75 : half ? 0.55 : 0.42, pass: k, q });
        }
      }
    }
  });
  events.sort((a, b) => a.t - b.t);
  beats.sort((a, b) => a.t - b.t);
  return { events, passes, total: t, tm, lead, beats };
}

/** Where are we at time t? -> { pass, kind, verse, t0, q } or null before the first section. */
export function locate(perf, t) {
  let cur = null;
  perf.passes.forEach((p, k) => { if (t >= p.t0 - 1e-6) cur = { pass: k, kind: p.kind, verse: p.verse, t0: p.t0, qFrom: p.qFrom, qTo: p.qTo }; });
  if (!cur) return null;
  const q = perf.tm.tToQ(t - cur.t0 + perf.tm.qToT(cur.qFrom));
  // done: an introduction or interlude has finished playing (a count-in may follow before the singing)
  return { ...cur, q: Math.min(q, cur.qTo), done: cur.kind !== "verse" && q >= cur.qTo - 1e-6 };
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
