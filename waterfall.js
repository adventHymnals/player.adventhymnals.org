// Piano waterfall: notes fall onto a keyboard, coloured by voice. Draws into any 2D context area.

const BLACK = new Set([1, 3, 6, 8, 10]);

export class Waterfall {
  constructor() {
    this.events = [];
    this.lo = 48;
    this.hi = 72;
    this.ahead = 3; // seconds of music visible above the keys
  }

  setPerformance(perf) {
    this.events = perf.events.filter((e) => e.ch !== "click");
    let lo = 127;
    let hi = 0;
    for (const e of this.events) { lo = Math.min(lo, e.p); hi = Math.max(hi, e.p); }
    // widen to whole octaves (C to B) so the keyboard looks like a keyboard
    this.lo = Math.max(21, Math.floor((lo - 2) / 12) * 12);
    this.hi = Math.min(108, Math.ceil((hi + 3) / 12) * 12 - 1);
  }

  layout(x, w) {
    const whites = [];
    for (let p = this.lo; p <= this.hi; p++) if (!BLACK.has(p % 12)) whites.push(p);
    const ww = w / whites.length;
    const keys = new Map();
    whites.forEach((p, i) => keys.set(p, { x: x + i * ww, w: ww, black: false }));
    for (let p = this.lo; p <= this.hi; p++) {
      if (!BLACK.has(p % 12)) continue;
      const left = keys.get(p - 1);
      if (left) keys.set(p, { x: left.x + ww * 0.68, w: ww * 0.64, black: true });
    }
    return keys;
  }

  /** colors: {S,A,T,B,acc,paper,ink,rule}; heard(ch) -> bool */
  draw(g, x, y, w, h, t, colors, heard) {
    const keys = this.layout(x, w);
    const keyH = Math.min(90, h * 0.24);
    const fallH = h - keyH;
    const keyTop = y + fallH;
    g.save();
    g.fillStyle = colors.cloth;
    g.fillRect(x, y, w, fallH);
    // octave guides
    g.strokeStyle = "rgba(252,251,247,0.07)";
    for (const [p, k] of keys) if (p % 12 === 0) { g.beginPath(); g.moveTo(k.x, y); g.lineTo(k.x, keyTop); g.stroke(); }

    const down = new Map();
    for (const e of this.events) {
      if (e.t > t + this.ahead) break;
      if (e.t + e.dur < t) continue;
      const k = keys.get(e.p);
      if (!k) continue;
      const on = heard(e.ch);
      const y1 = keyTop - ((e.t - t) / this.ahead) * fallH;
      const y0 = keyTop - ((e.t + e.dur - t) / this.ahead) * fallH;
      const top = Math.max(y, y0);
      const bottom = Math.min(keyTop, y1);
      if (bottom - top > 2) {
        g.globalAlpha = on ? 0.95 : 0.25;
        g.fillStyle = colors[e.ch] || colors.acc;
        const pad = k.black ? 1 : 2;
        roundRect(g, k.x + pad, top, k.w - pad * 2, bottom - top - 1, 4);
        g.fill();
      }
      if (on && e.t <= t && t < e.t + e.dur) down.set(e.p, colors[e.ch] || colors.acc);
    }
    g.globalAlpha = 1;
    // keys: whites first, then blacks on top
    for (const pass of [false, true]) {
      for (const [p, k] of keys) {
        if (k.black !== pass) continue;
        const kh = k.black ? keyH * 0.62 : keyH;
        g.fillStyle = down.get(p) || (k.black ? colors.ink : colors.paper);
        g.fillRect(k.x + 0.5, keyTop, k.w - 1, kh);
        if (!k.black) { g.strokeStyle = colors.rule; g.strokeRect(k.x + 0.5, keyTop, k.w - 1, kh); }
      }
    }
    // middle C mark
    const c4 = keys.get(60);
    if (c4) { g.fillStyle = colors.gilt; g.fillRect(c4.x + c4.w / 2 - 3, keyTop + keyH - 10, 6, 6); }
    g.restore();
  }
}

function roundRect(g, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}
