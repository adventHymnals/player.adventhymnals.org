// Follow my tempo: the player listens to you singing your part and plays at your pace.
//
// Each time you start a new note (a new pitch, or the same pitch after a break), the note is matched to
// the nearest note of your part that is coming up or just passed, in pitch. From the matched notes:
//   - your tempo: how fast you move through the score (written seconds per real second, over the last
//     few notes), and
//   - how far the music is ahead of you or behind you at that moment.
// The playback rate is set to your tempo, nudged so the music closes the gap over the next second or so.

const STABLE_S = 0.07; // a pitch held this long is a sung note (not a slide or a consonant)
const SAME = 0.6; // semitones: a held pitch wobbles less than this
const GAP_S = 0.06; // this much silence between two notes of one pitch makes them two notes
const WINDOW_S = 1.6; // a sung note is matched to a written one this close (written seconds) to the music
const MIC_LAG_S = 0.035; // the pitch is read from the last ~43 ms of sound, so a note is heard a little late

const pcDist = (a, b) => { const d = Math.abs(a - b) % 12; return Math.min(d, 12 - d); };

export class TempoFollower {
  /** notes: [{t, dur, p}] of the part you sing, in written (rate 1) performance seconds. */
  reset(notes = [], base = 1) {
    this.base = base; // the rate playing now
    this.notes = notes.filter((n) => n.p > 0).sort((a, b) => a.t - b.t);
    this.last = -1; // index of the last matched note
    this.cur = null; // the pitch being sung: { p, since (wall s), perfAt (perf s at its start), counted }
    this.quietSince = null;
    this.matches = []; // [{ wall, t }]: when (real time) you reached written time t
    this.rate = null;
    this.lag = 0;
  }

  /**
   * One reading. sung: MIDI pitch or null; perf: what the music plays now (performance s);
   * wall: a steady real clock (s); anyOctave: an octave off counts as the note.
   * Returns the playback rate to use, or null to leave it.
   */
  update(sung, perf, wall, anyOctave = true) {
    if (!this.notes?.length) return null;
    if (sung === null) {
      if (this.quietSince === null) this.quietSince = wall;
      if (wall - this.quietSince >= GAP_S) this.cur = null; // a break: the next pitch is a new note
      return null;
    }
    this.quietSince = null;
    if (!this.cur || Math.abs(sung - this.cur.p) > SAME) {
      this.cur = { p: sung, since: wall, perfAt: perf, counted: false };
      return null;
    }
    this.cur.p += (sung - this.cur.p) * 0.3; // follow the held pitch's drift
    if (this.cur.counted || wall - this.cur.since < STABLE_S) return null;
    this.cur.counted = true;
    return this.onNote(this.cur.p, this.cur.since - MIC_LAG_S, this.cur.perfAt, anyOctave);
  }

  onNote(p, wall, perfAt, anyOctave) {
    // the written note you most likely began: in tune with you, near where the music is, not one already sung
    let best = -1, bestD = Infinity;
    for (let j = this.last + 1; j < this.notes.length; j++) {
      const n = this.notes[j];
      if (n.t > perfAt + WINDOW_S) break;
      if (n.t < perfAt - WINDOW_S) continue;
      const off = anyOctave ? pcDist(p, n.p) : Math.abs(p - n.p);
      if (off > 0.75) continue;
      // nearer in time wins; skipping notes costs a little, so a repeated pitch is taken in order
      // (near where YOU are: the music was this.lag ahead of you at your last note. Measured from where the
      // music is, a music that has got ahead takes the second of two notes of one pitch for the first,
      // reads that as you being ahead, and speeds up further)
      const d = Math.abs(n.t - (perfAt - this.lag)) + 0.12 * (j - this.last - 1);
      if (d < bestD) { bestD = d; best = j; }
    }
    if (best < 0) return null;
    // a jump back (you went back, or the music looped) starts the count again
    if (this.matches.length && this.notes[best].t < this.matches[this.matches.length - 1].t) this.matches = [];
    this.last = best;
    this.matches.push({ wall, t: this.notes[best].t });
    while (this.matches.length > 6) this.matches.shift();
    this.lag = perfAt - this.notes[best].t; // > 0: the music is ahead of you
    if (this.matches.length < 3 || wall - this.matches[0].wall < 1.2) return null; // too few, too close together to judge a pace
    // your pace: written seconds per real second, the least-squares slope over the last few notes
    const m = this.matches;
    const mw = m.reduce((a, x) => a + x.wall, 0) / m.length;
    const mt = m.reduce((a, x) => a + x.t, 0) / m.length;
    let num = 0, den = 0;
    for (const x of m) { num += (x.wall - mw) * (x.t - mt); den += (x.wall - mw) ** 2; }
    if (den < 1e-6) return null;
    const pace = Math.min(2, Math.max(0.5, num / den));
    // close the gap over about two seconds, never more than 15% faster or slower than you
    const nudge = Math.min(0.15, Math.max(-0.15, -this.lag / 2));
    const target = pace * (1 + nudge);
    // a pianist eases into a new pace: at most 15% faster or slower at a time
    const from = this.rate ?? this.base ?? 1;
    const step = Math.min(from * 1.15, Math.max(from * 0.85, from + (target - from) * 0.5));
    this.rate = step;
    return this.rate;
  }
}
