// Practice tools: feel the meter (conducting pattern, guess-the-meter, tap along) and
// sing in tune (microphone pitch against the notes of your part).

const NS = "http://www.w3.org/2000/svg";

// ---- meter ------------------------------------------------------------------

/** How a bar is felt: beats per bar, length of a beat in quarters, and each beat's weight. */
export function feel(time) {
  const [num, den] = time;
  if (den === 8 && num % 3 === 0) return { beats: num / 3, beatQ: 1.5, label: `${num}/${den}, felt in ${num / 3}` };
  return { beats: num, beatQ: 4 / den, label: `${num}/${den}` };
}

// Ictus (where the beat lands) and rebound points of the usual conducting patterns, in a 220x180 box.
const PATTERNS = {
  1: { ictus: [[110, 150]], rebound: [[110, 50]] },
  2: { ictus: [[110, 150], [150, 92]], rebound: [[132, 112], [110, 42]] },
  3: { ictus: [[110, 150], [182, 138], [110, 42]], rebound: [[86, 116], [168, 100], [110, 42]] },
  4: { ictus: [[110, 150], [40, 134], [182, 134], [110, 42]], rebound: [[128, 114], [60, 106], [162, 104], [110, 42]] },
};

export class Conductor {
  constructor(svg) {
    this.svg = svg;
    svg.setAttribute("viewBox", "0 0 220 180");
  }

  setBeats(beats) {
    this.beats = beats;
    const pat = PATTERNS[beats] || PATTERNS[4];
    this.pat = pat;
    const svg = this.svg;
    svg.innerHTML = "";
    const path = [];
    pat.ictus.forEach((p, i) => {
      path.push(p, pat.rebound[i]);
    });
    path.push(pat.ictus[0]);
    const d = path.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
    const line = document.createElementNS(NS, "path");
    line.setAttribute("d", d);
    line.setAttribute("class", "cd-path");
    svg.append(line);
    this.labels = pat.ictus.map((p, i) => {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", p[0] + (i === 0 ? 0 : p[0] < 110 ? -16 : p[0] > 110 ? 16 : 0));
      t.setAttribute("y", p[1] + (i === 0 ? 24 : p[1] < 60 ? -10 : 6));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("class", `cd-num${i === 0 ? " one" : ""}`);
      t.textContent = i + 1;
      svg.append(t);
      return t;
    });
    this.dot = document.createElementNS(NS, "circle");
    this.dot.setAttribute("r", 9);
    this.dot.setAttribute("class", "cd-dot");
    svg.append(this.dot);
  }

  /** beat: 0-based beat in the bar; f: 0..1 through that beat. */
  show(beat, f) {
    if (!this.pat) return;
    const n = this.pat.ictus.length;
    const a = this.pat.ictus[beat % n];
    const r = this.pat.rebound[beat % n];
    const b = this.pat.ictus[(beat + 1) % n];
    // quick bounce off the beat, then a gathering fall into the next one
    let x;
    let y;
    if (f < 0.35) {
      const k = Math.sin(((f / 0.35) * Math.PI) / 2);
      x = a[0] + (r[0] - a[0]) * k;
      y = a[1] + (r[1] - a[1]) * k;
    } else {
      const k = ((f - 0.35) / 0.65) ** 2;
      x = r[0] + (b[0] - r[0]) * k;
      y = r[1] + (b[1] - r[1]) * k;
    }
    this.dot.setAttribute("cx", x);
    this.dot.setAttribute("cy", y);
    this.labels.forEach((t, i) => t.classList.toggle("on", i === beat % n));
  }
}

/**
 * A short mystery tune in a random meter, for "guess the meter". Returns
 * { time, events: [{t, dur, p, ch, v}], beats, beatQ, beatSec } (seconds from 0).
 */
export function mysteryTune(choices = [[2, 4], [3, 4], [4, 4], [6, 8]]) {
  const time = choices[Math.floor(Math.random() * choices.length)];
  const f = feel(time);
  const tempo = time[1] === 8 ? 66 : 96 + Math.floor(Math.random() * 20); // beats a minute
  const beatSec = 60 / tempo;
  const sub = time[1] === 8 ? 3 : 2; // notes per beat in the tune
  const key = [57, 60, 62, 55][Math.floor(Math.random() * 4)];
  const chords = [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]]; // I IV V I
  const events = [];
  const bars = 4;
  for (let bar = 0; bar < bars; bar++) {
    const ch = chords[bar].map((x) => key + x);
    for (let b = 0; b < f.beats; b++) {
      const t0 = (bar * f.beats + b) * beatSec;
      const strong = b === 0;
      const medium = f.beats === 4 && b === 2;
      // bass on the strong beats, the chord on the others: the accents carry the meter
      if (strong || medium) events.push({ t: t0, dur: beatSec * 0.9, p: ch[0] - 12, ch: "acc", v: strong ? 0.95 : 0.6 });
      else ch.forEach((p) => events.push({ t: t0, dur: beatSec * 0.45, p, ch: "acc", v: 0.32 }));
      // a simple melody, one or two notes per beat
      const n = Math.random() < 0.5 ? 1 : sub;
      for (let i = 0; i < n; i++) {
        const p = ch[Math.floor(Math.random() * 3)] + 12;
        events.push({ t: t0 + (i * beatSec) / n, dur: (beatSec / n) * 0.9, p, ch: "acc", v: strong && i === 0 ? 0.85 : 0.45 });
      }
    }
  }
  events.sort((a, b) => a.t - b.t);
  return { time, events, beats: f.beats, beatQ: f.beatQ, beatSec, length: bars * f.beats * beatSec };
}

export const meterHint = (time) => {
  const f = feel(time);
  if (time[1] === 8) return `A strong beat every ${f.beats}, and each beat splits into three: ${time[0]}/8.`;
  return `A strong beat every ${time[0]}${time[0] === 4 ? ", with a lighter push on beat 3" : ""}: ${time[0]}/${time[1]}.`;
};

// ---- pitch ------------------------------------------------------------------

const midiOf = (hz) => 69 + 12 * Math.log2(hz / 440);

/** Microphone pitch, by autocorrelation (McLeod-style normalised square difference). */
export class PitchListener {
  async start(ctx) {
    this.ctx = ctx;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    this.src = ctx.createMediaStreamSource(this.stream);
    this.an = ctx.createAnalyser();
    this.an.fftSize = 2048;
    this.buf = new Float32Array(this.an.fftSize);
    this.src.connect(this.an);
    // some browsers only run nodes that lead to the speakers: connect through a silent gain
    this.mute = ctx.createGain();
    this.mute.gain.value = 0;
    this.an.connect(this.mute).connect(ctx.destination);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.src?.disconnect();
    this.mute?.disconnect();
    this.stream = null;
  }

  get on() { return !!this.stream; }

  /** The pitch being sung now as a MIDI number (fractional), or null when quiet or unclear. */
  read() {
    if (!this.on) return null;
    const x = this.buf;
    this.an.getFloatTimeDomainData(x);
    let rms = 0;
    for (let i = 0; i < x.length; i++) rms += x[i] * x[i];
    rms = Math.sqrt(rms / x.length);
    if (rms < 0.004) return null; // quiet: nobody is singing
    const sr = this.ctx.sampleRate;
    const minLag = Math.floor(sr / 1100); // about C6
    const maxLag = Math.floor(sr / 70);   // about C#2
    const n = x.length - maxLag;
    let best = 0;
    let bestLag = 0;
    const nsdf = new Float32Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag + 1; lag++) {
      let ac = 0;
      let m = 0;
      for (let i = 0; i < n; i++) { ac += x[i] * x[i + lag]; m += x[i] * x[i] + x[i + lag] * x[i + lag]; }
      nsdf[lag] = m ? (2 * ac) / m : 0;
    }
    // first strong peak (avoids octave errors from later, equally strong peaks)
    let peakMax = 0;
    for (let lag = minLag; lag <= maxLag; lag++) peakMax = Math.max(peakMax, nsdf[lag]);
    for (let lag = minLag + 1; lag <= maxLag; lag++) {
      if (nsdf[lag] > nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1] && nsdf[lag] > 0.88 * peakMax) { best = nsdf[lag]; bestLag = lag; break; }
    }
    if (best < 0.5 || !bestLag) return null; // not clearly pitched (breath, consonants, noise)
    // parabolic refinement between neighbouring lags
    const a = nsdf[bestLag - 1];
    const b = nsdf[bestLag];
    const c = nsdf[bestLag + 1];
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
    return midiOf(sr / (bestLag + shift));
  }
}

const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
/** "A4, 12 cents sharp" style name of a sung pitch. */
export function noteName(m) {
  const n = Math.round(m);
  const cents = Math.round((m - n) * 100);
  return `${NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}${Math.abs(cents) > 5 ? `, ${Math.abs(cents)} cents ${cents > 0 ? "sharp" : "flat"}` : ""}`;
}

/** Cents from target, folding octaves away when anyOctave is set. */
export function centsOff(sung, target, anyOctave) {
  let d = (sung - target) * 100;
  if (anyOctave) d = ((((d + 600) % 1200) + 1200) % 1200) - 600;
  return d;
}

/** Scrolling lane: your part's notes as bars, your voice as a line. */
export function drawLane(g, w, h, now, notes, trace, colors, voiceColor, anyOctave) {
  const past = 3;
  const ahead = 4;
  const xOf = (t) => ((t - (now - past)) / (past + ahead)) * w;
  const near = notes.filter((n) => n.t + n.dur > now - past && n.t < now + ahead);
  // the range covers your part's notes and what you have just sung (folded to the part when any octave counts)
  const recent = trace.filter((x) => x.p !== null && x.t > now - past).map((x) => (anyOctave && x.target !== null ? x.p + 12 * Math.round((x.target - x.p) / 12) : x.p));
  const ps = [...near.map((n) => n.p), ...recent];
  const lo = (ps.length ? Math.min(...ps) : 60) - 4;
  const hi = (ps.length ? Math.max(...ps) : 72) + 4;
  const yOf = (p) => h - 14 - ((p - lo) / Math.max(1, hi - lo)) * (h - 28);
  g.clearRect(0, 0, w, h);
  g.fillStyle = colors.paper;
  g.fillRect(0, 0, w, h);
  // semitone guides, with a stronger line on each C
  for (let p = Math.ceil(lo); p <= hi; p++) {
    g.fillStyle = p % 12 === 0 ? colors.rule : "rgba(217,213,200,0.4)";
    g.fillRect(0, yOf(p), w, 1);
  }
  for (const n of near) {
    const x0 = xOf(n.t);
    const x1 = xOf(n.t + n.dur);
    g.fillStyle = voiceColor;
    g.globalAlpha = n.t <= now && now < n.t + n.dur ? 0.95 : 0.4;
    g.fillRect(x0, yOf(n.p) - 5, Math.max(2, x1 - x0 - 2), 10);
    if (n.label) {
      g.globalAlpha = 0.9;
      g.fillStyle = colors.ink;
      g.font = "13px Alegreya, serif";
      g.fillText(n.label, x0 + 2, yOf(n.p) - 9);
    }
  }
  g.globalAlpha = 1;
  // your voice: gilt when within a quarter-tone of the note, red when off, blue-grey with no note to match
  const colourOf = (x) => (x.target === null ? colors.B : Math.abs(x.off) <= 50 ? colors.gilt : colors.S);
  const fold = (x) => (anyOctave && x.target !== null ? x.p + 12 * Math.round((x.target - x.p) / 12) : x.p);
  for (const x of trace) {
    if (x.p === null || x.t < now - past) continue;
    g.fillStyle = colourOf(x);
    g.beginPath();
    g.arc(xOf(x.t), yOf(fold(x)), 2.6, 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1];
    const b = trace[i];
    if (a.p === null || b.p === null || b.t - a.t > 0.15) continue;
    let pa = a.p;
    let pb = b.p;
    if (anyOctave && b.target !== null) {
      const fold = (p) => p + 12 * Math.round((b.target - p) / 12);
      pa = fold(pa);
      pb = fold(pb);
    }
    g.strokeStyle = colourOf(b);
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(xOf(a.t), yOf(pa));
    g.lineTo(xOf(b.t), yOf(pb));
    g.stroke();
  }
  // now
  g.fillStyle = colors.cloth;
  g.fillRect(xOf(now) - 1, 0, 2, h);
}
