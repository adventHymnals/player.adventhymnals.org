// Renders the score with Verovio in "tracks" (one long system) or "page" (stacked systems) mode,
// and knows where every staff, bar and note is, for headers, highlighting and the playhead.

const SVG_ATTRS = ["staff@n", "layer@n", "verse@n", "measure@n"];

export class ScoreView {
  constructor(tk, content) {
    this.tk = tk;
    this.content = content; // element that holds the SVG; positions are relative to it
    this.notes = [];
    this.systems = [];
    this.measures = [];
    this.harms = [];
    this.active = new Set();
  }

  render(xml, { mode, zoom, width, tracks, barOffset = 0, transpose = "" }) {
    this.barOffset = barOffset; // printed bar numbers start at 0 when there is a pickup
    const scale = Math.round(46 * zoom);
    const base = {
      scale, header: "none", footer: "none", svgHtml5: true, svgViewBox: true, svgAdditionalAttribute: SVG_ATTRS,
      pageMarginLeft: 30, pageMarginRight: 60, pageMarginTop: 50, pageMarginBottom: 40, lyricSize: 4.2,
      spacingStaff: 14, adjustPageHeight: true,
      transpose, // the toolkit keeps options between calls, so always set it
    };
    if (mode === "tracks") {
      this.tk.setOptions({ ...base, breaks: "none", adjustPageWidth: true, pageWidth: 60000, pageHeight: 60000 });
    } else {
      this.tk.setOptions({ ...base, breaks: "auto", adjustPageWidth: false, pageWidth: Math.round((Math.max(320, width) * 100) / scale), pageHeight: 60000 });
    }
    this.tk.loadData(xml);
    let svg = "";
    for (let p = 1; p <= this.tk.getPageCount(); p++) svg += this.tk.renderToSVG(p);
    this.content.innerHTML = svg;
    if (mode === "tracks") {
      // one long system at its natural size; the viewport scrolls sideways
      for (const s of this.content.querySelectorAll(":scope > svg")) {
        const vb = s.viewBox.baseVal;
        s.setAttribute("width", vb.width);
        s.setAttribute("height", vb.height);
      }
    }
    this.mode = mode;
    this.tracks = tracks;

    const times = new Map();
    for (const e of this.tk.renderToTimemap({ includeMeasures: true })) {
      for (const id of e.on || []) times.set(id, { on: e.qstamp, off: Infinity });
      for (const id of e.off || []) { const x = times.get(id); if (x) x.off = e.qstamp; }
    }
    this.notes = [];
    for (const el of this.content.querySelectorAll("g.note")) {
      const tm = times.get(el.dataset.id);
      if (!tm) continue;
      const staffN = Number(el.closest("g.staff")?.dataset.n) || 1;
      const layer = Number(el.closest("g.layer")?.dataset.n) || 1;
      const track = tracks[staffN - 1] || [];
      this.notes.push({ el, on: tm.on, off: tm.off, voice: track[layer - 1] ?? track[0], staffN, system: el.closest("g.system") });
    }
    this.harms = [...this.content.querySelectorAll("g.harm")];
    this.active = new Set();
    this.measureGeometry();
  }

  rel(el) {
    const c = this.content.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height };
  }

  /** Recompute positions (after render or resize). */
  measureGeometry() {
    this.systems = [...this.content.querySelectorAll("g.system")].map((el) => {
      const box = this.rel(el);
      const staves = [...el.querySelectorAll("g.staff")].reduce((acc, st) => {
        const n = Number(st.dataset.n);
        if (acc.some((s) => s.n === n)) return acc;
        const lines = [...st.children].filter((c) => c.tagName === "path");
        const rs = (lines.length ? lines : [st]).map((l) => this.rel(l));
        acc.push({ n, top: Math.min(...rs.map((r) => r.y)), bottom: Math.max(...rs.map((r) => r.y + r.h)) });
        return acc;
      }, []);
      return { el, box, staves, anchors: [] };
    });
    // playhead anchors: x of each onset, per system
    const bySys = new Map(this.systems.map((s) => [s.el, s]));
    const onsets = new Map();
    for (const n of this.notes) {
      const head = n.el.querySelector("g.notehead") || n.el;
      const r = this.rel(head);
      n.box = r;
      const sys = bySys.get(n.system);
      if (!sys) continue;
      const k = `${sys.box.y}:${n.on}`;
      if (!onsets.has(k)) onsets.set(k, { sys, q: n.on, xs: [] });
      onsets.get(k).xs.push(r.x + r.w / 2);
    }
    for (const { sys, q, xs } of onsets.values()) sys.anchors.push({ q, x: xs.reduce((a, b) => a + b, 0) / xs.length });
    for (const s of this.systems) {
      s.anchors.sort((a, b) => a.q - b.q);
      const ends = this.notes.filter((n) => n.system === s.el).map((n) => n.off).filter(Number.isFinite);
      s.qStart = s.anchors[0]?.q ?? 0;
      s.qEnd = ends.length ? Math.max(...ends) : s.qStart;
      s.anchors.push({ q: s.qEnd, x: s.box.x + s.box.w - 8 });
    }
    this.measures = [...this.content.querySelectorAll("g.measure")].map((el) => ({
      n: Number(el.dataset.n) + this.barOffset, el, box: this.rel(el), system: el.closest("g.system"),
    }));
  }

  systemAt(q) {
    return this.systems.find((s) => q >= s.qStart - 1e-6 && q < s.qEnd - 1e-6) || this.systems[this.systems.length - 1];
  }

  /** Smooth playhead: interpolates between note onsets. */
  playhead(q) {
    const s = this.systemAt(q);
    if (!s || !s.anchors.length) return null;
    const a = s.anchors;
    let i = a.findIndex((x) => x.q > q) - 1;
    if (i < 0) i = a[0].q > q ? 0 : a.length - 1;
    const p = a[i];
    const nx = a[i + 1];
    const x = nx ? p.x + ((nx.x - p.x) * (q - p.q)) / Math.max(1e-6, nx.q - p.q) : p.x;
    return { x: Math.max(p.x, x), top: s.box.y, height: s.box.h, system: s };
  }

  /** Colour the sounding notes and their sung syllable. */
  highlight(q, verseN) {
    const now = new Set(this.notes.filter((n) => n.on <= q + 1e-6 && q < n.off - 1e-6));
    for (const n of this.active) {
      if (now.has(n)) continue;
      n.el.classList.remove(`on-${n.voice}`);
      n.el.querySelectorAll("g.verse.sung").forEach((v) => v.classList.remove("sung"));
    }
    for (const n of now) {
      if (this.active.has(n)) continue;
      n.el.classList.add(`on-${n.voice}`);
      if (verseN === 0) n.el.querySelectorAll("g.verse").forEach((v) => v.classList.add("sung"));
      else n.el.querySelector(`g.verse[data-n="${verseN}"]`)?.classList.add("sung");
    }
    this.active = now;
  }

  clear() { this.highlight(-1, 0); this.harms.forEach((h) => h.classList.remove("sounding")); }

  markChord(i) { this.harms.forEach((h, k) => h.classList.toggle("sounding", k === i)); }

  /** Bar number under a point given in content coordinates. */
  barAt(x, y) {
    const m = this.measures.find((b) => x >= b.box.x && x <= b.box.x + b.box.w && y >= b.box.y - 20 && y <= b.box.y + b.box.h + 20);
    return m ? m.n : null;
  }

  /** Boxes covering bars from..to, one per system. */
  barBoxes(from, to) {
    const out = new Map();
    for (const m of this.measures) {
      if (m.n < from || m.n > to) continue;
      const k = m.system;
      const b = out.get(k);
      if (!b) out.set(k, { ...m.box });
      else { const r = Math.max(b.x + b.w, m.box.x + m.box.w); b.x = Math.min(b.x, m.box.x); b.w = r - b.x; }
    }
    return [...out.values()];
  }

  /** The score position under a point (content coords): the reverse of playhead(). */
  qAt(x, y) {
    if (!this.systems.length) return 0;
    // the system under the point, or the nearest one above or below it
    const s = this.systems.reduce((best, sys) => {
      const d = y < sys.box.y ? sys.box.y - y : y > sys.box.y + sys.box.h ? y - sys.box.y - sys.box.h : 0;
      return !best || d < best.d ? { sys, d } : best;
    }, null).sys;
    const a = s.anchors;
    if (!a.length) return s.qStart;
    if (x <= a[0].x) return a[0].q;
    for (let i = 0; i < a.length - 1; i++) {
      if (x < a[i + 1].x) return a[i].q + ((a[i + 1].q - a[i].q) * (x - a[i].x)) / Math.max(1e-6, a[i + 1].x - a[i].x);
    }
    return a[a.length - 1].q - 1e-3;
  }

  /** x position (content coords) of score time q inside the single tracks-mode system. */
  xAt(q) { return this.playhead(q)?.x ?? 0; }
}
