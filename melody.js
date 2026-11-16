// Recognising a hymn from someone singing it, and finding where they are in it (query by singing).
//
// The usual way (MIREX query-by-singing/humming systems): the voice's pitch becomes notes; a tune is
// compared by its shape, the steps between notes (so any key is the same tune) and how long each note is
// against the one before (so any tempo is). Two stages:
//   1. candidates: every run of four notes (three steps) of every tune is indexed; the sung runs, and the
//      runs a semitone off in one step (singers slip), vote for a tune and a place in it;
//   2. alignment: the best candidates are matched note by note with dynamic time warping, which forgives a
//      wrong note, a note sung twice or left out, and two repeated notes sung as one. Its best path gives
//      the tune, where the singer is now, the key they sing in and their tempo.

const STEP_CAP = 12;
const clampStep = (s) => Math.max(-STEP_CAP, Math.min(STEP_CAP, Math.round(s)));
const gramKey = (a, b, c) => `${a},${b},${c}`;
/**
 * Is the best match sure enough to act on? Matches that sing the same notes where the singer is (one tune
 * in several hymns, or two hymns sharing a phrase) count as one answer; it is sure when that answer fits
 * well and clearly better than any match singing other notes. margin and fit: score units (see search).
 */
export function decide(results, { fit = 0.9, margin = 0.35 } = {}, index = null) {
  if (!results.length) return null;
  const [best] = results;
  decide.why = "fit";
  if (best.score > fit) return null;
  const mine = sungShape(best, index);
  const rival = results.find((r) => sungShape(r, index) !== mine);
  decide.why = "margin";
  if (rival && rival.score - best.score < margin) return null;
  // the same notes at two places in the tune (a line repeating an earlier one): wait until one is clear
  decide.why = "place";
  if (best.placeGap < margin) return null;
  decide.why = "tunes";
  const same = results.filter((r) => sungShape(r, index) === mine);
  // two different tunes that share this phrase: wait until they part (the same tune in several hymnals,
  // written a little differently, is one answer)
  if (index && new Set(same.map((r) => wholeShape(index.tunes[r.tune]))).size > 1) return null;
  return { ...best, same };
}

/**
 * The written notes a match puts the singer's notes on, repeats left out, counted from the first of them:
 * equal for matches that sound alike in any key (one tune is printed in G in one hymnal and in A flat in
 * another; a singer's key says nothing about which, so they are one answer, not rivals).
 */
function sungShape(r, index) {
  if (!index) return String(r.tune);
  const ps = r.pairs.map(([, w]) => index.tunes[r.tune].cp[w]).filter((p, i, a) => i === 0 || p !== a[i - 1]);
  return ps.map((p) => p - ps[0]).join(",");
}
const wholeShape = (t) => (t.whole ??= t.steps.join(","));

/**
 * Notes of a tune, [[midi, quarters, start], ...] -> its shape as sung: repeated notes as one (a singer
 * joins them, or parts one note in two, at will), the steps between the notes left, where each starts
 * (quarters), the time from each to the next (rests included: a singer holds on or breathes there), and for
 * each the written note it starts at.
 */
function shape(notes) {
  const cp = [], ons = [], cidx = [];
  let acc = 0;
  notes.forEach((n, i) => {
    const q = n.length > 2 ? n[2] : acc;
    acc = q + n[1];
    if (cp.length && cp[cp.length - 1] === n[0]) return;
    cp.push(n[0]); ons.push(q); cidx.push(i);
  });
  const steps = [];
  for (let i = 1; i < cp.length; i++) steps.push(cp[i] - cp[i - 1]);
  const lens = ons.map((q, i) => (i + 1 < ons.length ? Math.max(0.0625, ons[i + 1] - q) : notes[notes.length - 1][1]));
  return { cp, ons, cidx, steps, lens };
}

/** Sung notes the same way: one pitch held or repeated is one note, from its first start to its last end. */
function collapseSung(sung) {
  const out = [];
  for (const n of sung) {
    const last = out[out.length - 1];
    if (last && Math.abs(n.p - last.p) < 0.5) { last.t1 = n.t1; last.open = n.open; continue; }
    out.push({ p: n.p, t0: n.t0, t1: n.t1, open: n.open });
  }
  return out;
}

export class MelodyIndex {
  /** data: data/melodies.json ({ tunes: [{ ids, n: [[midi, quarters], ...] }] }) */
  constructor(data) {
    this.tunes = data.tunes.map((t) => { const sh = shape(t.n); return { ids: t.ids, notes: t.n, ...sh, rel: sh.lens.slice(1).map((l, i) => Math.log2(l / sh.lens[i])) }; });
    this.grams = new Map();
    this.tunes.forEach((t, ti) => {
      // the tune's shape without repeated notes (a repeat is easily sung as one note, or one as two):
      // its steps, and for each the written note it starts from
      const steps = t.steps.map(clampStep);
      for (let i = 0; i + 2 < steps.length; i++) {
        const k = gramKey(steps[i], steps[i + 1], steps[i + 2]);
        let list = this.grams.get(k);
        if (!list) this.grams.set(k, (list = []));
        list.push(ti, i);
      }
    });
  }

  /**
   * sung: [{ p (MIDI, fractional), t0, t1 (seconds) }], oldest first, at least 5 notes; the last may still
   * be sounding. only: tune indexes to search (a hymn already chosen), or null for all.
   * Returns the best matches, best first: [{ tune, ids, end (index of the tune note being sung now),
   *   cost (per note), shift (semitones from written), spq (seconds per quarter), pairs }].
   */
  search(sung, { only = null, top = 5, full = true } = {}) {
    sung = collapseSung(sung);
    if (sung.length < 5) return [];
    const qs = [];
    for (let j = 1; j < sung.length; j++) qs.push(sung[j].p - sung[j - 1].p);
    // 1. candidates by vote: (tune, the written note where the sung notes start)
    const qc = qs.map(clampStep), qat = qs.map((_, j) => j);
    const votes = new Map();
    const vote = (ti, start, w) => { const k = ti * 100000 + Math.max(0, start); votes.set(k, (votes.get(k) || 0) + w); };
    for (let j = 0; !full && j + 2 < qc.length; j++) {
      const g = [qc[j], qc[j + 1], qc[j + 2]];
      const tries = [[g, 1]];
      for (let a = 0; a < 3; a++) for (const d of [-1, 1]) { const v = g.slice(); v[a] += d; tries.push([v, 0.5]); }
      // one wrong note: the step into it and the step out of it are off by the same, either way
      for (let a = 0; a < 2; a++) for (const d of [-1, 1, -2, 2]) { const v = g.slice(); v[a] += d; v[a + 1] -= d; tries.push([v, 0.45]); }
      for (let [v, w] of tries) {
        const list = this.grams.get(gramKey(v[0], v[1], v[2]));
        if (!list) continue;
        // a run found in few tunes says more than one found everywhere (as a word's rarity in text search)
        w *= Math.log(1 + this.tunes.length / (list.length / 2));
        for (let x = 0; x < list.length; x += 2) {
          if (only && !only.has(list[x])) continue;
          // where the sung notes would start: the sung run starts qat[j] notes in; repeats sung or not move it
          const s0 = list[x + 1] - qat[j];
          for (const o of [0, -1, 1, -2, 2]) vote(list[x], s0 + o, o === 0 ? w : Math.abs(o) === 1 ? w * 0.5 : w * 0.25);
        }
      }
    }
    // each tune once, at its best-voted place; the best tunes go on to be aligned
    const perTune = new Map();
    for (const [k, v] of votes) {
      const ti = Math.floor(k / 100000), b = perTune.get(ti);
      if (!b || v > b[1]) perTune.set(ti, [k % 100000, v]);
    }
    let cands = [...perTune].sort((a, b) => b[1][1] - a[1][1]).slice(0, 120).map(([ti, [start]]) => [ti, start]);
    // every tune is aligned whole when it can be afforded (all of them, or a chosen few): the vote then only
    // orders them; the alignment forgives what breaks a run of notes (a slip, a note left out or added)
    if (full || (only && only.size <= 200)) cands = [...(only || this.tunes.keys())].map((ti) => [ti, -1]);
    this.lastCands = cands; // (for tests)
    // 2. each candidate aligned, cost only (fast); the best few again with their path, then judged on the
    //    whole: one key and one steady tempo should fit all the sung notes (a wrong tune that only matches
    //    step by step drifts in key or in time)
    const qLen = sung.map((x, j) => Math.max(0.05, j + 1 < sung.length ? sung[j + 1].t0 - x.t0 : x.t1 - x.t0)); // to the next note
    const rough = [];
    for (const [ti, start] of cands) {
      const t = this.tunes[ti];
      const from = start < 0 ? 0 : Math.max(0, start - 4);
      const to = start < 0 ? t.cp.length : Math.min(t.cp.length, start + sung.length + 8);
      const c = alignCost(qs, qLen, t, from, to);
      if (c < Infinity) rough.push([c, ti, from, to]);
    }
    rough.sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [, ti, from, to] of rough.slice(0, 30)) {
      const t = this.tunes[ti];
      const r = alignPath(sung, qs, qLen, t, from, to);
      if (!r) continue;
      out.push({ tune: ti, ids: t.ids, ...r, score: r.cost + r.keyFit * 0.8 + r.timeFit * 2 });
    }
    return out.sort((x, y) => x.score - y.score).slice(0, top);
  }
}

// a step sung against a step written: off by a semitone costs little, more costs more, up to a cap
const stepCost = (q, r) => { const d = Math.abs(q - r); return d < 1 ? d * 0.8 : Math.min(3, 0.8 + (d - 1) * 1.1); };
// a length sung against a length written, each relative to the note before (log2 of the ratio)
const lenCost = (q, r) => Math.min(1, Math.abs(q - r) * 0.5);

/**
 * Subsequence DTW over the steps: the sung steps all matched, starting and ending anywhere in
 * tune.notes[from..to). Moves: one sung step for one written step; one sung step for two written ones
 * (a note left out, or two repeated notes sung as one: cheap when the left-out step is 0); two sung steps
 * for one written one (a note sung that isn't written). Fills D (and B, the moves, when given).
 */
const RHYTHM = 1.0;
let bufD = new Float64Array(0), bufB = new Int8Array(0);
function dtw(qs, qLen, t, from, to, wantPath) {
  const R = t.steps, REL = t.rel; // REL[w]: log2 of written note w+1's length over note w's
  const n = qs.length, m = to - from - 1;
  if (m < 2) return null;
  if (bufD.length < n * m) { bufD = new Float64Array(n * m * 2); bufB = new Int8Array(n * m * 2); }
  const D = bufD, B = bufB, INF = 1e9;
  const lastFull = qLen.length - 2; // the last sung note may still be sounding: its length says nothing yet
  for (let j = 0; j < n; j++) {
    const qRel = j < lastFull ? Math.log2(qLen[j + 1] / qLen[j]) : null;
    const row = j * m, up = row - m, up2 = row - 2 * m;
    for (let i = 0; i < m; i++) {
      const w = from + i;
      // one for one
      let best = (j === 0 ? 0 : i > 0 ? D[up + i - 1] : INF) + stepCost(qs[j], R[w]);
      if (qRel !== null) best += Math.min(1.5, Math.abs(qRel - REL[w]) * 0.5) * RHYTHM;
      let how = 1;
      // one sung step over two written (a written note not heard)
      if (i > 0) {
        const pen = R[w - 1] === 0 || R[w] === 0 ? 0.25 : 1.1;
        const c = (j === 0 ? 0 : i > 1 ? D[up + i - 2] : INF) + stepCost(qs[j], R[w - 1] + R[w]) + pen;
        if (c < best) { best = c; how = 2; }
      }
      // two sung steps over one written (an extra note sung)
      if (j > 0) {
        const c = (j === 1 ? 0 : i > 0 ? D[up2 + i - 1] : INF) + stepCost(qs[j - 1] + qs[j], R[w]) + 1.2;
        if (c < best) { best = c; how = 3; }
      }
      D[row + i] = best;
      if (wantPath) B[row + i] = how;
    }
  }
  let end = -1, cost = INF;
  const last = (n - 1) * m;
  for (let i = 0; i < m; i++) if (D[last + i] < cost) { cost = D[last + i]; end = i; }
  if (end < 0) return null;
  // the best other place in this tune (a line that repeats an earlier one): how much worse it fits
  let other = INF, otherEnd = -1;
  for (let i = 0; i < m; i++) if (Math.abs(i - end) > 3 && D[last + i] < other) { other = D[last + i]; otherEnd = i; }
  return { cost: cost / n, end, n, m, otherPlace: other < INF ? (other - cost) / n : Infinity, otherEnd };
}

function alignCost(qs, qLen, t, from, to) {
  const r = dtw(qs, qLen, t, from, to, false);
  return r ? r.cost : Infinity;
}

function alignPath(sung, qs, qLen, t, from, to) {
  const r = dtw(qs, qLen, t, from, to, true);
  if (!r) return null;
  const { n, m } = r;
  // back along the path: which written note each sung note is
  // (sung step j joins sung notes j and j+1; written step i joins written notes from+i and from+i+1)
  const pairs = [[n, from + r.end + 1]];
  let j = n - 1, i = r.end;
  while (j >= 0 && i >= 0) {
    const how = bufB[j * m + i];
    if (how === 1) { pairs.push([j, from + i]); j -= 1; i -= 1; }
    else if (how === 2) { pairs.push([j, from + i - 1]); j -= 1; i -= 2; }
    else { pairs.push([j - 1, from + i]); j -= 2; i -= 1; } // sung note j was an extra one
  }
  pairs.reverse();
  // key: the sung pitch against the written, the median over the matched notes; how well one key fits all
  const diffs = pairs.map(([q, w]) => sung[q].p - t.cp[w]);
  const sorted = diffs.slice().sort((a, b) => a - b);
  const shift = sorted[Math.floor(sorted.length / 2)];
  const keyFit = diffs.reduce((a, d) => a + Math.min(2, Math.abs(d - shift)), 0) / diffs.length;
  // tempo: seconds per quarter, sung onsets against written positions (least squares), and how well one
  // steady tempo fits them (the misfit as a share of the time sung)
  const xs = pairs.map(([, w]) => t.ons[w]), ys = pairs.map(([q]) => sung[q].t0);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let k = 0; k < xs.length; k++) { num += (xs[k] - mx) * (ys[k] - my); den += (xs[k] - mx) ** 2; }
  const spq = den > 1e-6 ? num / den : null;
  // the pace lately (the last six notes): a singer who has just sped up or slowed down goes on so
  const fit = (a) => {
    const X = xs.slice(a), Y = ys.slice(a);
    if (X.length < 3) return null;
    const mX = X.reduce((u, v) => u + v, 0) / X.length, mY = Y.reduce((u, v) => u + v, 0) / Y.length;
    let nu = 0, de = 0;
    for (let k = 0; k < X.length; k++) { nu += (X[k] - mX) * (Y[k] - mY); de += (X[k] - mX) ** 2; }
    return de > 1e-6 ? nu / de : null;
  };
  const spqNow = fit(Math.max(0, xs.length - 6)) ?? spq;
  let timeFit = 1;
  if (spq && spq > 0.1 && spq < 3) {
    let e = 0;
    for (let k = 0; k < xs.length; k++) e += Math.abs(my + spq * (xs[k] - mx) - ys[k]);
    timeFit = Math.min(1, e / xs.length / Math.max(0.3, (ys[ys.length - 1] - ys[0]) / Math.max(1, xs.length - 1)));
  }
  // end: the written note the singer is on now (where the held or repeated pitch begins); at: its start
  const endC = from + r.end + 1;
  return { end: t.cidx[endC], at: t.ons[endC], placeGap: r.otherPlace, otherAt: r.otherEnd >= 0 ? t.ons[from + r.otherEnd + 1] : null, cost: r.cost, shift, spq, spqNow, keyFit, timeFit, pairs, sungFrom: sung[sung.length - 1].t0 };
}

/**
 * Pitch readings -> sung notes. feed(midi|null, seconds) about 30 times a second; notes holds the notes so
 * far (the last one may still be sounding: open).
 */
export class NoteTracker {
  constructor() { this.reset(); }
  reset() { this.notes = []; this.cur = null; this.quiet = null; }
  feed(p, t) {
    if (p === null) {
      if (this.quiet === null) this.quiet = t;
      if (this.cur && t - this.quiet >= 0.06) this.close(this.quiet);
      return;
    }
    this.quiet = null;
    if (this.cur && Math.abs(p - this.cur.med()) > 0.6) {
      // a new pitch: the note before ends here (only once the new one holds, not for a slide)
      if (!this.cur.next || Math.abs(p - this.cur.next.p) > 0.6) this.cur.next = { p, t, k: 0 };
      if (++this.cur.next.k >= 2) { const nx = this.cur.next; this.close(nx.t); this.open(nx.p, nx.t); }
      return;
    }
    if (this.cur) { this.cur.ps.push(p); this.cur.next = null; this.cur.note.t1 = t; this.cur.note.p = this.cur.med(); return; }
    this.open(p, t);
  }
  open(p, t) {
    const note = { p, t0: t, t1: t, open: true };
    const ps = [p];
    this.cur = { note, ps, next: null, med: () => { const s = ps.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; } };
    this.pending = note;
  }
  close(t) {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    c.note.open = false;
    c.note.t1 = Math.max(c.note.t1, t);
    if (c.note.t1 - c.note.t0 >= 0.07) this.notes.push(c.note); // shorter: a slide or a consonant
  }
  /** The notes so far, with the one still sounding (if it has lasted) at the end. */
  sung() {
    const out = this.notes.slice();
    if (this.cur && this.cur.note.t1 - this.cur.note.t0 >= 0.07) out.push(this.cur.note);
    return out;
  }
}
