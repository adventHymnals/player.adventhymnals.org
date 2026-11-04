// Warble front end: hymn score -> per-voice frame features (phoneme id, position in phoneme, f0).
// A line-by-line port of sing/tiny/warble/frontend.py and the score logic it reuses
// (sing/render.py sung_notes, sing/singer/phonemes.py, sing/singer/dsinger.py with fixed
// consonant lengths). No ML here; it is cheap. Spec: sing/tiny/RUNTIME.md section 2.
// English words come from lexicon.json (built by sing/warble_lexicon.py from CMUdict).
import { Rng } from "./rng.js";

export const SR = 44100, HOP = 512, FRAME = HOP / SR, LEAD = 0.3;
export const SPEAKER = { S: 2, A: 1, T: 3, B: 3 };
const ARPA = ("AA AE AH AO AW AY B CH D DH EH ER EY F G HH IH IY JH K L M N NG OW OY P R S SH T TH "
  + "UH UW V W Y Z ZH").split(" ");
export const PHONES = ["<pad>", "<SP>", "<AP>", ...ARPA];
const ID = Object.fromEntries(PHONES.map((p, i) => [p, i]));
const UNVOICED = new Set(["P", "T", "K", "F", "TH", "S", "SH", "HH", "CH", "<SP>", "<AP>"]);
const UNVOICED_ID = new Set([...UNVOICED].map((p) => ID[p]));
const ALIAS = { AX: "AH", DX: "D" };

// ---------------------------------------------------------------- small numpy/python helpers

/** Python round(): halves to even. */
function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
/** np.interp(x, xp, fp) for one x (xp sorted). */
function interp(x, xp, fp) {
  const n = xp.length;
  if (x < xp[0]) return fp[0];
  if (x > xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1; // largest j with xp[j] <= x
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (xp[m] <= x) lo = m; else hi = m - 1; }
  const j = lo;
  if (j === n - 1 || xp[j] === x) return fp[j];
  const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
  return slope * (x - xp[j]) + fp[j];
}
const hz = (midi) => 440.0 * 2 ** ((midi - 69) / 12);
const clip = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const sum = (a) => a.reduce((s, x) => s + x, 0);

// ---------------------------------------------------------------- phonemes.py

const SCAT = {
  la: "l A", da: "d A", dah: "d A", ja: "j A", ba: "b A", na: "n A", ta: "t A",
  dam: "d A m", bam: "b A m", dum: "d U m", bum: "b U m", dm: "d I m", dn: "d I n",
  doo: "d u", du: "d u", dun: "d V n", doon: "d u n", dap: "d A p", bap: "b A p",
  ah: "A", aah: "A", oh: "@U", ooh: "u", oo: "u", uh: "V", mm: "m", hm: "h m",
  hmm: "h m", m: "m", n: "n", hah: "h A", ha: "h A", ho: "h @U", dee: "d i",
  di: "d i", ding: "d I N", dong: "d A N", dang: "d { N", "ding-dong": "d I N d A N",
  shoo: "S u", wah: "w A", wa: "w A", bop: "b A p", "ba-da": "b A d A", pa: "p A",
  dom: "d O m", bom: "b O m", bim: "b I m", dim: "d I m", tu: "t u", tm: "t m",
  o: "@U", a: "A", ahh: "A", nah: "n A", yeah: "j E", "oh-oh": "@U @U",
};
const inScat = (w) => Object.prototype.hasOwnProperty.call(SCAT, w);
const VOWELS = new Set(["i", "I", "E", "{", "A", "V", "O", "U", "u", "@", "r=", "EI", "AI", "OI", "@U", "aU"]);
const SONORANTS = new Set(["m", "n", "N", "l"]);
const SW_MAP = [
  ["ng'", "N"], ["ch", "tS"], ["sh", "S"], ["th", "T"], ["dh", "D"], ["gh", "g"], ["kh", "h"],
  ["ny", "n j"], ["ng", "N g"], ["a", "A"], ["e", "E"], ["i", "i"], ["o", "O"], ["u", "u"],
  ["j", "dZ"], ["y", "j"], ["c", "k"], ["q", "k"], ["x", "k s"],
];
const syllabic = (lang) => lang.startsWith("sw") || lang.startsWith("luo");
const syl = (onset = [], nucleus = "A", coda = []) => ({ onset, nucleus, coda, extra: [] });

function pyStrip(s, chars) {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}
export function cleanWord(text) {
  const t = text.toLowerCase().replaceAll("’", "'").replaceAll("ﬂ", "fl").replaceAll("ﬁ", "fi");
  return pyStrip(t.replace(/[^a-zäöüß'\- ]/g, ""), "-' ");
}
function swahiliSampa(word) {
  const w = word.toLowerCase().replaceAll("’", "'"), out = [];
  let i = 0;
  while (i < w.length) {
    const hit = SW_MAP.find(([k]) => w.startsWith(k, i));
    if (hit) { out.push(...hit[1].split(" ")); i += hit[0].length; } else { if (/\p{L}/u.test(w[i])) out.push(w[i]); i += 1; }
  }
  return out;
}
export class MissingWord extends Error {}

function wordPhonemes(word, lang, lex) {
  const w = cleanWord(word);
  if (!w) return [];
  if (syllabic(lang)) return swahiliSampa(w);
  if (inScat(w)) return SCAT[w].split(" ");
  const ws = w.split(/\s+/).filter(Boolean);
  if (ws.every(inScat)) return ws.map((p) => SCAT[p]).join(" ").split(" ");
  if (lang.startsWith("en") && lex && Object.prototype.hasOwnProperty.call(lex, w)) return lex[w].split(" ");
  throw new MissingWord(`no pronunciation for "${w}"`);
}

function splitSyllables(phones, n, parts) {
  const nucleiOf = (ph) => ph.map((p, i) => (VOWELS.has(p) ? i : -1)).filter((i) => i >= 0);
  let nuclei = nucleiOf(phones);
  if (!nuclei.length) {
    const son = phones.map((p, i) => (SONORANTS.has(p) ? i : -1)).filter((i) => i >= 0);
    if (son.length) nuclei = [son[son.length - 1]];
    else if (phones.length) return [syl(phones, "@"), ...Array.from({ length: n - 1 }, () => syl([], "@"))];
    else return Array.from({ length: n }, () => syl([], "@"));
  }
  while (nuclei.length > n) {
    const glide = [];
    for (let k = 1; k < nuclei.length - 1; k++) if ((phones[nuclei[k]] === "i" || phones[nuclei[k]] === "I") && nuclei[k + 1] === nuclei[k] + 1) glide.push(k);
    if (glide.length) {
      const j = nuclei[glide[0]];
      phones = [...phones.slice(0, j), "j", ...phones.slice(j + 1)];
      nuclei = nucleiOf(phones);
      continue;
    }
    let weak = [];
    for (let k = 1; k < nuclei.length - 1; k++) if (["@", "r=", "I"].includes(phones[nuclei[k]])) weak.push(k);
    if (!weak.length) {
      const last = nuclei[nuclei.length - 1];
      weak = nuclei.length > 1 && (phones[last] === "r=" || (phones[last] === "@" && phones.length > last + 1)) ? [nuclei.length - 1] : [];
    }
    if (!weak.length) break;
    const j = nuclei[weak[0]];
    phones = [...phones.slice(0, j), ...(phones[j] === "r=" ? ["r"] : []), ...phones.slice(j + 1)];
    nuclei = nucleiOf(phones);
  }
  while (nuclei.length > n) {
    const cand = [];
    for (let k = 1; k < nuclei.length; k++) if (phones[nuclei[k]] === "@") cand.push(k);
    nuclei.splice(cand.length ? cand[0] : nuclei.length - 1, 1);
  }
  const sylls = [];
  let prevEnd = 0;
  nuclei.forEach((ni, k) => {
    const nxt = k + 1 < nuclei.length ? nuclei[k + 1] : null;
    const onset = phones.slice(prevEnd, ni);
    let coda;
    if (nxt === null) { coda = phones.slice(ni + 1); prevEnd = phones.length; } else {
      const between = phones.slice(ni + 1, nxt);
      const nextPart = k + 1 < parts.length ? parts[k + 1] : "";
      const cw = cleanWord(nextPart);
      const startsConsonant = /^[^aeiouyäöü']/.test(cw || "a");
      let split;
      if (!between.length) split = 0;
      else if (!startsConsonant) split = between.length >= 2 && ["r", "l", "j"].includes(between[between.length - 1]) ? between.length - 1 : between.length;
      else if (between.length >= 2 && (/^[^aeiouyäöü]*/.exec(cw)[0].length >= 2
        || (["r", "l"].includes(between[between.length - 1]) && !(SONORANTS.has(between[between.length - 2]) || ["r", "l"].includes(between[between.length - 2]))
          && !["r", "l"].includes(cw.slice(0, 1))))) split = between.length - 2;
      else split = between.length - 1;
      coda = between.slice(0, split);
      prevEnd = ni + 1 + split;
    }
    sylls.push(syl(onset, phones[ni], coda));
  });
  while (sylls.length < n) sylls.push(syl([], sylls[sylls.length - 1].nucleus));
  return sylls;
}

function phonemizeWords(words, lang, lex) {
  const out = [];
  for (const parts of words) {
    if (parts.length === 1 && parts[0].trim().includes(" ")) {
      let subs = [];
      for (const w of parts[0].trim().split(/\s+/)) {
        const ph = wordPhonemes(w, lang, lex);
        if (ph.length) subs = subs.concat(splitSyllables(ph, Math.max(1, ph.filter((p) => VOWELS.has(p)).length), [w]));
      }
      const first = subs.length ? subs[0] : syl([], "@");
      first.extra = subs.slice(1);
      out.push([first]);
      continue;
    }
    if (syllabic(lang)) { out.push(parts.map((p) => splitSyllables(wordPhonemes(p, lang, lex), 1, [p])[0])); continue; }
    const whole = parts.map(cleanWord).join("");
    const phones = parts.length > 1 ? wordPhonemes(whole, lang, lex) : wordPhonemes(parts[0], lang, lex);
    if (parts.length > 1 && parts.every((p) => inScat(cleanWord(p)))) {
      out.push(parts.map((p) => splitSyllables(SCAT[cleanWord(p)].split(" "), 1, [p])[0]));
      continue;
    }
    out.push(splitSyllables(phones, parts.length, parts));
  }
  if (lang.startsWith("en")) {
    for (let i = 0; i < out.length - 1; i++) {
      if (words[i].length === 1 && cleanWord(words[i][0]) === "the" && out[i].length && out[i + 1].length
        && !out[i + 1][0].onset.length && VOWELS.has(out[i + 1][0].nucleus)) out[i][0].nucleus = "i";
    }
  }
  return out;
}

// ---------------------------------------------------------------- render.py

const SOLFA_SAMPA = {
  doh: ["d", "@U"], re: ["r", "EI"], mi: ["m", "i"], fa: ["f", "A"], soh: ["s", "@U"],
  la: ["l", "A"], ti: ["t", "i"],
  di: ["d", "i"], ri: ["r", "i"], fi: ["f", "i"], si: ["s", "i"], li: ["l", "i"],
  ra: ["r", "A"], me: ["m", "EI"], se: ["s", "EI"], le: ["l", "EI"], te: ["t", "EI"],
};
const BREATH_MAX = 0.25, BREATH_FRAC = 0.25;

export function timeMap(h, tempo) {
  const spq = 60 / tempo;
  const holds = h.voices[h.lyricVoice].filter((n) => n.f).map((n) => [n.q, n.q + n.d]);
  return (q) => q * spq + sum(holds.map(([a, b]) => spq * Math.max(0.0, Math.min(q, b) - a)));
}
function refrainOf(h, verse) {
  const rs = h.refrains || [];
  const own = typeof verse === "number" && verse <= rs.length ? rs[verse - 1] : null;
  return own && own.length ? own : h.refrain || [];
}
function wordsOf(syllables) {
  const words = [];
  let cur = [];
  syllables.forEach((s, i) => {
    if (s === null || s === undefined) return;
    cur.push(i);
    if (s.s === "single" || s.s === "end") { words.push(cur); cur = []; }
  });
  return cur.length ? [...words, cur] : words;
}
function syllablesOf(notes, lyric, sy) {
  const out = [];
  let j = 0, prev = null;
  notes.forEach((n, i) => {
    while (j + 1 < lyric.length && lyric[j + 1].q <= n.q + 1e-9) j++;
    let k = 0;
    for (let x = j; x >= 0; x--) if (sy[x]) { k = x; break; }
    if (i && notes[i - 1].tie) k = prev;
    out.push([k === prev ? null : k, k]);
    prev = k;
  });
  return out;
}
function splitHeld(notes, lyric, sy, where) {
  const starts = lyric.filter((n, i) => sy[i]).map((n) => n.q);
  const out = [];
  notes.forEach((n, i) => {
    const cuts = !where || where[i] ? starts.filter((q) => n.q + 1e-9 < q && q < n.q + n.d - 1e-9) : [];
    const edges = [n.q, ...cuts, n.q + n.d];
    for (let k = 0; k < edges.length - 1; k++) {
      const part = { ...n, q: edges[k], d: edges[k + 1] - edges[k], src: i };
      if (k + 1 < edges.length - 1) { delete part.tie; part.f = false; }
      out.push(part);
    }
  });
  return out;
}
function phonemesOf(syls, lang, lex) {
  const groups = wordsOf(syls);
  const sung = phonemizeWords(groups.map((g) => g.map((i) => syls[i].t)), lang, lex);
  const out = new Array(syls.length).fill(null);
  groups.forEach((g, gi) => g.forEach((i, x) => { if (x < sung[gi].length) out[i] = sung[gi][x]; }));
  return out;
}

const SKIP = [null, true, ""];
/** render.sung_notes: -> { notes: [{t, dur, midi, syllable}], total } */
export function sungNotes(h, voice, verse, tempo, transpose, lex) {
  const notes = h.voices[voice];
  const lyric = h.voices[h.lyricVoice];
  const full = h.verses.filter((v) => v.length === lyric.length);
  const SOL = verse === "solfa";
  let sy;
  if (SOL && h.verses[0].length !== lyric.length && full.length && !refrainOf(h, 1).length) sy = [...full[0]];
  else sy = [...h.verses[SOL ? 0 : verse - 1], ...refrainOf(h, verse)];
  let tailQ = null;
  if (!SOL && sy.length < lyric.length && full.length && !refrainOf(h, verse).length) {
    tailQ = lyric[sy.length].q - 1e-9;
    sy = sy.concat(new Array(lyric.length - sy.length).fill(null));
  }
  if (sy.length !== lyric.length) throw new Error(`${sy.length} syllables for ${lyric.length} notes in the lyric voice`);
  const vw = SOL ? null : ((h.voiceWords || {})[voice] || new Array(verse).fill(null))[verse - 1] ?? null;
  const follows = notes.map((_, i) => vw === null || vw[i] === "*");
  const parts = SOL ? notes.map((n, i) => ({ ...n, src: i })) : splitHeld(notes, lyric, sy, follows);
  const lv = syllablesOf(parts, lyric, sy);
  const qToT = timeMap(h, tempo);
  const sung = [];
  if (SOL) {
    const names = (h.solfa || {})[voice];
    if (!names || names.length !== notes.length) throw new Error(`no sol-fa names for voice ${voice}`);
    lv.forEach(([nw, k], x) => {
      const nm = names[x].toLowerCase();
      if (!SOLFA_SAMPA[nm]) throw new Error(`unknown sol-fa name ${nm}`);
      const i = sung.length;
      const text = (sy[k] || {}).t || "";
      if (i && notes[i - 1].tie && notes[i - 1].p === notes[i].p) sung.push([null, false, text]);
      else sung.push([syl([SOLFA_SAMPA[nm][0]], SOLFA_SAMPA[nm][1]), nw !== null, text]);
    });
  } else {
    const lang = h.language || "en-us";
    const bySyl = phonemesOf(sy, lang, lex);
    const ownPh = vw ? phonemesOf(vw.map((x) => (x && typeof x === "object" ? x : null)), lang, lex) : [];
    parts.forEach((part, x) => {
      const [nw, k] = lv[x];
      const i = part.src;
      if ((tailQ !== null && part.q >= tailQ) || (follows[i] && !sy[k])) sung.push(SKIP);
      else if (follows[i]) sung.push([nw !== null ? bySyl[k] : null, nw !== null, sy[k].t]);
      else {
        let last = { t: "" };
        for (let y = i; y >= 0; y--) if (vw[y] && typeof vw[y] === "object") { last = vw[y]; break; }
        sung.push([ownPh[i], !!(vw[i] && typeof vw[i] === "object"), last.t]);
      }
    });
  }
  const out = [];
  parts.forEach((n, j) => {
    if (sung[j] === SKIP) return;
    const [s, , text] = sung[j];
    const t = qToT(n.q);
    let end = qToT(n.q + n.d);
    const lastOfSyl = j + 1 === parts.length || sung[j + 1][1];
    if (j + 1 < parts.length && lastOfSyl && /[,;:.!?]['"’”]*$/.test(text)) end -= Math.min(BREATH_MAX, (end - t) * BREATH_FRAC);
    out.push({ t: t + LEAD, dur: end - t, midi: n.p + transpose, syllable: s });
  });
  return { notes: out, total: qToT(h.totalQ) };
}

// ---------------------------------------------------------------- dsinger.py (no bank: fixed consonant lengths)

const TO_ARPA = {
  i: "iy", I: "ih", E: "eh", "{": "ae", A: "aa", V: "ah", O: "ao", U: "uh",
  u: "uw", "@": "ax", "r=": "er", EI: "ey", AI: "ay", OI: "oy", "@U": "ow", aU: "aw",
  p: "p", b: "b", t: "t", d: "d", k: "k", g: "g", 4: "dx", f: "f", v: "v",
  s: "s", z: "z", S: "sh", Z: "zh", T: "th", D: "dh", h: "hh", m: "m", n: "n",
  N: "ng", l: "l", r: "r", w: "w", j: "y", tS: "ch", dZ: "jh",
};
const CLIP = {
  b: [0.03, 0.065], d: [0.03, 0.065], g: [0.03, 0.065], dx: [0.02, 0.05],
  m: [0.06, 0.15], n: [0.06, 0.15], ng: [0.07, 0.2],
  p: [0.04, 0.13], t: [0.04, 0.13], k: [0.04, 0.13], ch: [0.08, 0.17], jh: [0.08, 0.15],
  f: [0.055, 0.18], th: [0.055, 0.18], s: [0.055, 0.18], sh: [0.055, 0.18], hh: [0.055, 0.18],
  v: [0.05, 0.15], z: [0.05, 0.15], zh: [0.05, 0.15], dh: [0.05, 0.15],
  r: [0.04, 0.13], w: [0.04, 0.13], y: [0.04, 0.13], l: [0.04, 0.15],
};
const clipOf = (p) => CLIP[p] || [0.04, 0.15];
const CLOSURE = { b: 0.055, d: 0.055, g: 0.055, jh: 0.035, p: 0.02, t: 0.02, k: 0.02, ch: 0.02 };
const ONSET_SUBS = { b: "de/b", d: "de/d", g: "de/g", p: "de/p", t: "de/t", k: "de/k", l: "de/l" };
const CODA_SUBS = { l: "de/l" };
const CODA_L_MIN = 0.09;
const DIPH_SPLIT = { ay: ["aa", "y"], ey: ["eh", "y"], oy: ["ao", "y"], aw: ["aa", "w"], ow: ["ao", "w"] };
const arpaOf = (sampa) => sampa.filter((p) => TO_ARPA[p] !== undefined).map((p) => TO_ARPA[p]);

function groupsOf(notes) {
  const groups = [];
  for (const n of notes) {
    const g = groups[groups.length - 1];
    if (n.syllable === null && g && Math.abs(g[1][g[1].length - 1].t + g[1][g[1].length - 1].dur - n.t) < 0.02) g[1].push(n);
    else groups.push([n.syllable || syl([], "A"), [n]]);
  }
  return groups;
}
function unitsOf(groups) {
  const units = [];
  for (const [s0, gnotes] of groups) {
    const subs = [s0, ...s0.extra];
    const start = gnotes[0].t, end = gnotes[gnotes.length - 1].t + gnotes[gnotes.length - 1].dur;
    const span = (end - start) / subs.length;
    subs.forEach((s, k) => {
      const a = start + k * span, b = start + (k + 1) * span;
      let ns = gnotes.filter((n) => n.t < b - 1e-6 && n.t + n.dur > a + 1e-6);
      if (!ns.length) ns = gnotes.slice(-1);
      let vowel = TO_ARPA[s.nucleus] ?? "ah";
      if (!VOWELS.has(s.nucleus)) vowel = TO_ARPA[s.nucleus] ?? "m";
      units.push({ onset: arpaOf(s.onset), vowel, coda: arpaOf(s.coda), t: a, end: b, notes: ns, midi: ns[0].midi });
    });
  }
  return units;
}
function phrasesOf(units, gap) {
  const out = [];
  let cur = [];
  for (const u of units) {
    if (cur.length && u.t - cur[cur.length - 1].end > gap) { out.push(cur); cur = []; }
    cur.push(u);
  }
  return cur.length ? [...out, cur] : out;
}
function choralR(units) {
  units.forEach((u, i) => {
    const nxt = i + 1 < units.length ? units[i + 1] : null;
    if (u.coda.length && u.coda[u.coda.length - 1] === "r" && (nxt === null || nxt.onset.length)) u.coda = u.coda.slice(0, -1);
  });
}
function plan(units) {
  const c = (p, v) => clip(v, ...clipOf(p));
  for (const u of units) {
    u.on_d = u.onset.map((p) => c(p, 0.07));
    u.co_d = u.coda.map((p) => c(p, 0.07));
    u.co_d = u.coda.map((p, i) => (p === "l" ? Math.max(u.co_d[i], CODA_L_MIN) : u.co_d[i]));
    if (u.coda.length && ["m", "n", "ng"].includes(u.coda[u.coda.length - 1])) {
      const k = u.co_d.length - 1;
      u.co_d[k] = Math.max(u.co_d[k], Math.min(0.18, (u.end - u.t) * 0.25));
    }
  }
  units.forEach((u, i) => {
    const length = u.end - u.t;
    const nxtOn = i + 1 < units.length && units[i + 1].t - u.end < 0.02 ? sum(units[i + 1].on_d) : 0.0;
    const last = u.notes[u.notes.length - 1];
    const budget = Math.min(length * 0.5, (u.end - Math.max(u.t, last.t)) * 0.6);
    let used = sum(u.co_d) + nxtOn;
    if (used > budget) {
      let k = budget / used;
      const nxt = i + 1 < units.length && nxtOn ? units[i + 1] : null;
      const floor = (ph, d) => Math.max(d * k, clipOf(ph)[0]);
      u.co_d = u.coda.map((p, x) => floor(p, u.co_d[x]));
      if (nxt) nxt.on_d = nxt.onset.map((p, x) => floor(p, nxt.on_d[x]));
      const room = (u.end - Math.max(u.t, last.t)) - 0.03;
      used = sum(u.co_d) + (nxt ? sum(nxt.on_d) : 0.0);
      if (used > room && room > 0) {
        k = room / used;
        u.co_d = u.co_d.map((d) => d * k);
        if (nxt) nxt.on_d = nxt.on_d.map((d) => d * k);
      }
    }
  });
}
function segmentsOf(units, t0) {
  const segs = [];
  const push = (ph, s, e) => {
    if (e - s < 0.005) return;
    if (segs.length && segs[segs.length - 1][2] > s) {
      segs[segs.length - 1][2] = s;
      if (segs[segs.length - 1][2] - segs[segs.length - 1][1] < 0.005) segs.pop();
    }
    if (segs.length && s > segs[segs.length - 1][2] + 1e-6) segs.push(["SP", segs[segs.length - 1][2], s]);
    segs.push([ph, s, e]);
  };
  const firstOn = sum(units[0].on_d);
  const start = units[0].t - firstOn;
  push("SP", t0, start - t0 > 0.3 ? start - 0.2 : start);
  if (start - t0 > 0.3) push("AP", start - 0.2, start);
  units.forEach((u, i) => {
    const nxt = i + 1 < units.length ? units[i + 1] : null;
    let t = u.t - sum(u.on_d);
    u.onset.forEach((p, j) => {
      const d = u.on_d[j];
      if (j === 0 && CLOSURE[p] !== undefined && segs.length && !["SP", "AP"].includes(segs[segs.length - 1][0])) {
        const w = Math.min(CLOSURE[p], (segs[segs.length - 1][2] - segs[segs.length - 1][1]) * 0.4);
        push("SP", t - w, t);
      }
      push(ONSET_SUBS[p] || p, t, t + d);
      t += d;
    });
    let vEnd;
    if (nxt !== null && nxt.t - u.end < 0.02) vEnd = nxt.t - sum(nxt.on_d) - sum(u.co_d);
    else vEnd = u.end - sum(u.co_d) - Math.min(0.04, (u.end - u.t) * 0.1);
    vEnd = Math.max(vEnd, u.t + 0.03);
    u.v = [u.t, vEnd];
    if (DIPH_SPLIT[u.vowel] && vEnd - u.t > 0.5) {
      const [nuc, glide] = DIPH_SPLIT[u.vowel];
      const g = Math.min(u.coda.length ? 0.11 : 0.16, Math.max(0.08, (vEnd - u.t) * 0.15));
      push(nuc, u.t, vEnd - g);
      push(glide, vEnd - g, vEnd);
    } else push(u.vowel, u.t, vEnd);
    t = vEnd;
    u.coda.forEach((p, x) => { push(CODA_SUBS[p] || p, t, t + u.co_d[x]); t += u.co_d[x]; });
  });
  return segs.map(([p, s, e]) => [p, s - t0, e - t0]);
}

/** synth._pitch_curve */
function pitchCurve(notes, start, end, vibrato, seed, scoop) {
  const rng = new Rng(seed);
  const pts = [];
  notes.forEach((n, i) => {
    const a = Math.max(start, n.t), b = Math.min(end, n.t + n.dur);
    if (b <= a) return;
    const f = hz(n.midi);
    const glide = Math.min(0.045, (b - a) / 3);
    if (i > 0) { pts.push([a, hz(notes[i - 1].midi)]); pts.push([a + glide, f]); } else {
      pts.push([a, f * 2 ** ((scoop ? -0.35 : 0) / 12)]);
      pts.push([a + glide, f]);
    }
    const span = b - a;
    let drift = 0.0;
    let t = a + glide + 0.12;
    while (t < b - 0.05 && !(vibrato && span > 0.5)) {
      drift = 0.7 * drift + rng.normal(0, 0.035);
      pts.push([t, f * 2 ** (drift / 12)]);
      t += 0.12;
    }
    if (vibrato && span > 0.5) {
      const rate = 5.0 + rng.uniform(-0.35, 0.35);
      const depthMax = 0.16 + rng.uniform(0, 0.06);
      const onset = a + Math.min(0.3, span * 0.3);
      t = onset;
      let phase = 0.0;
      const step = 1 / rate / 8;
      while (t < b - 0.04) {
        const depth = Math.min(1.0, (t - onset) / 0.35) * depthMax;
        drift = 0.9 * drift + rng.normal(0, 0.01);
        pts.push([t, f * 2 ** ((depth * Math.sin(phase) + drift) / 12)]);
        phase += 2 * Math.PI * rate * step * (1 + rng.normal(0, 0.03));
        t += step;
      }
    }
    pts.push([b, f]);
  });
  return pts;
}

// ---------------------------------------------------------------- frontend.py

const warblePhone = (p) => {
  p = p.split("/").pop();
  if (p === "SP" || p === "AP") return `<${p}>`;
  const q0 = p.split("_")[0].toUpperCase().replace(/[012]+$/, "");
  const q = ALIAS[q0] || q0;
  if (ID[q] === undefined) throw new Error(`phoneme ${p} has no Warble equivalent`);
  return q;
};

/**
 * One voice's frames. -> { ph: Int16Array, prog: Float32Array, f0: Float32Array, T }
 * T: the frame count of the pass (from the first voice), or null to compute it.
 */
export function voiceFrames(h, voice, verse, tempo, T, transpose, lex) {
  const { notes, total } = sungNotes(h, voice, verse, tempo, transpose, lex);
  const n = T || Math.trunc((total + LEAD + 1.0) / FRAME);
  const ph = new Int16Array(n).fill(ID["<SP>"]), prog = new Float32Array(n), f0 = new Float32Array(n);
  if (!notes.length) return { ph, prog, f0, T: n };
  const units = unitsOf(groupsOf(notes));
  let segs = [];
  const all = [];
  // Each phrase's leading silence starts where the phrase before it ended. (frontend.py gives every
  // phrase t0 = 0, so each phrase's leading silence overwrote all the phrases before it: a hymn sung in
  // many short phrases kept only its last. Same result wherever a pass is one phrase, as in the test vectors.)
  let t0 = 0.0;
  for (const phrase of phrasesOf(units, 0.3)) {
    choralR(phrase);
    plan(phrase);
    const ps = segmentsOf(phrase, t0).map(([p, s, e]) => [p, s + t0, e + t0]);
    segs = segs.concat(ps);
    if (ps.length) t0 = ps[ps.length - 1][2];
    all.push(...phrase);
  }
  for (const [p, s, e] of segs) {
    const a = pyRound(s / FRAME), b = Math.min(n, pyRound(e / FRAME));
    if (b > a) {
      const id = ID[warblePhone(p)];
      for (let i = a; i < b; i++) { ph[i] = id; prog[i] = (i - a + 0.5) / (b - a); }
    }
  }
  let pts = [];
  all.forEach((u, k) => {
    const ns = u.notes;
    const [a, b] = u.v;
    pts = pts.concat(pitchCurve(ns, a, b, true, 7 + k, k === 0));
    pts.push([b + 0.03, hz(ns[ns.length - 1].midi)]);
  });
  pts.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const ts = pts.map((p) => p[0]), fs = pts.map((p) => p[1]);
  for (let i = 0; i < n; i++) f0[i] = UNVOICED_ID.has(ph[i]) ? 0 : interp(0.0 + i * FRAME, ts, fs);
  return { ph, prog, f0, T: n };
}

/** Every voice of one pass (verse k + refrain, or "solfa"): [{ voice, speaker, ph, prog, f0 }], T. */
export function passFrames(h, voices, verse, tempo, transpose, lex) {
  let T = null;
  const out = [];
  for (const v of voices) {
    const r = voiceFrames(h, v, verse, tempo, T, transpose, lex);
    T = r.T;
    out.push({ voice: v, speaker: SPEAKER[v], ph: r.ph, prog: r.prog, f0: r.f0 });
  }
  return { T, voices: out };
}
