// Lines up the systems (lines of music) of a Verovio score with one another.
//
// Verovio lays out each system on its own: how far apart its staves are, and how far below a staff its
// words sit, depend on that line's own notes (a low alto stem pushes the words down; high tenor notes
// push the bass staff down). Seen one at a time that does not matter, but the app shows the next line
// peeled in beside the one being sung, and the presenter (and its videos) show one line after another
// in the same place: the staves and the words then jump at the join (Brian, 18 Nov 2026).
//
// So after the layout, every system is measured, the common layout is taken (each staff, and each line
// of words under it, as low as the line that needs it lowest), and every system is moved to it. All of
// it is read from the coordinates Verovio wrote into the SVG (no layout pass, no second Verovio call:
// the app's native Verovio and the WebAssembly copy write the same SVG), so it costs a few milliseconds.

const NUM = /-?\d+(?:\.\d+)?/g;
/** Off where the app draws with its native Verovio: there the staff came out giant (18 Nov 2026, being
 *  looked into); the WebAssembly copy keeps it. */
const nativeVerovio = () => { try { return !!window.AHNative?.verovio?.available?.(); } catch { return false; } };
const nums = (s) => (s ? (s.match(NUM) || []).map(Number) : []);
const SHAPES = "text, path, use, rect, ellipse, polygon, polyline";

/** A y coordinate of an SVG element (its first drawn shape), straight from its attributes. */
function shapeY(el) {
  const t = el.matches?.(SHAPES) ? el : el.querySelector(SHAPES);
  if (!t) return null;
  switch (t.tagName) {
    case "text": { const y = t.getAttribute("y") ?? t.querySelector("[y]")?.getAttribute("y"); return y == null ? null : Number(y); }
    case "rect": return Number(t.getAttribute("y")) + Number(t.getAttribute("height") || 0) / 2;
    case "ellipse": return Number(t.getAttribute("cy"));
    case "use": { const m = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/.exec(t.getAttribute("transform") || ""); return m ? Number(m[2]) : null; }
    case "path": { const n = nums(t.getAttribute("d")); return n.length >= 2 ? n[1] : null; }
    default: { const n = nums(t.getAttribute("points")); return n.length >= 2 ? n[1] : null; }
  }
}

/** A vertical line path ("M x y1 L x y2"): its two ends, else null. */
function vline(p) {
  const n = nums(p.getAttribute("d"));
  return n.length === 4 && /^\s*M[^L]*L[^L]*$/i.test(p.getAttribute("d")) && Math.abs(n[0] - n[2]) < 1 ? { x: n[0], y1: Math.min(n[1], n[3]), y2: Math.max(n[1], n[3]), w: n[0] } : null;
}

const move = (el, dy) => { if (Math.abs(dy) > 0.5) el.setAttribute("transform", `translate(0, ${Math.round(dy)})`); };

/** Staff lines and the lines of words of one system. */
function measureSystem(sys) {
  const staves = new Map(); // n -> { top, bottom }
  for (const st of sys.querySelectorAll(":scope > g.measure > g.staff")) {
    const n = Number(st.dataset.n);
    if (staves.has(n)) continue;
    const ys = [];
    for (const c of st.children) if (c.tagName === "path") { const d = nums(c.getAttribute("d")); if (d.length === 4 && Math.abs(d[1] - d[3]) < 1) ys.push(d[1]); }
    if (ys.length) staves.set(n, { top: Math.min(...ys), bottom: Math.max(...ys) });
  }
  const words = new Map(); // n -> Map(verse -> baseline y)
  for (const v of sys.querySelectorAll("g.verse")) {
    const n = Number(v.closest("g.staff")?.dataset.n);
    const k = Number(v.dataset.n);
    if (!staves.has(n) || !k) continue;
    if (!words.has(n)) words.set(n, new Map());
    const w = words.get(n);
    if (w.has(k)) continue;
    const y = shapeY(v.querySelector("text") || v);
    if (y != null) w.set(k, y);
  }
  return { sys, staves, words };
}

/**
 * Line up these systems (g.system elements, from one SVG or several made with the same options).
 * Returns, per system, how much lower its bottom now reaches (to grow its page by).
 */
export function alignSystems(systems) {
  const ms = systems.map(measureSystem).filter((m) => m.staves.size);
  if (ms.length < 2) return systems.map(() => 0);
  const order = [...new Set(ms.flatMap((m) => [...m.staves.keys()]))].sort((a, b) => a - b);
  // each line of words, as far below its staff as the line that has it lowest
  const wordAt = new Map(); // `${n}:${verse}` -> offset below the staff's top line
  for (const m of ms) for (const [n, w] of m.words) for (const [k, y] of w) {
    const off = y - m.staves.get(n).top;
    const key = `${n}:${k}`;
    wordAt.set(key, Math.max(wordAt.get(key) ?? -Infinity, off));
  }
  for (const m of ms) {
    m.wordShift = new Map(); // n -> Map(verse -> dy)
    m.wordsDown = new Map(); // n -> the most its words move down
    for (const [n, w] of m.words) {
      const sh = new Map();
      let most = 0;
      for (const [k, y] of w) { const dy = wordAt.get(`${n}:${k}`) - (y - m.staves.get(n).top); sh.set(k, dy); most = Math.max(most, dy); }
      m.wordShift.set(n, sh);
      m.wordsDown.set(n, most);
    }
  }
  // each staff as far below the one above it as the line that needs the most room there (words that
  // moved down need that much more)
  const at = new Map([[order[0], 0]]); // n -> offset of its top line below the first staff's
  for (let i = 1; i < order.length; i++) {
    const p = order[i - 1], n = order[i];
    let gap = 0;
    for (const m of ms) {
      const a = m.staves.get(p), b = m.staves.get(n);
      if (a && b) gap = Math.max(gap, b.top - a.top + (m.wordsDown.get(p) || 0));
    }
    at.set(n, at.get(p) + gap);
  }
  const grow = new Map();
  for (const m of ms) {
    const top0 = m.staves.get(order[0])?.top ?? Math.min(...[...m.staves.values()].map((s) => s.top));
    const shift = new Map([...m.staves].map(([n, s]) => [n, top0 + at.get(n) - s.top]));
    applySystem(m, shift);
    const last = order.filter((n) => m.staves.has(n)).pop();
    grow.set(m.sys, Math.max(0, shift.get(last) + (m.wordsDown.get(last) || 0)));
  }
  return systems.map((s) => grow.get(s) || 0);
}

function applySystem(m, shift) {
  const { sys, staves, wordShift } = m;
  const ns = [...staves.keys()].sort((a, b) => a - b);
  // the band of each staff, down to halfway between its lowest words (or bottom line) and the next staff
  const bands = ns.map((n, i) => {
    const s = staves.get(n);
    const low = Math.max(s.bottom, ...[...(m.words.get(n)?.values() || [])]);
    const next = staves.get(ns[i + 1]);
    return { n, top: s.top, bottom: s.bottom, to: next ? (low + next.top) / 2 : Infinity };
  });
  const staffAt = (y) => (bands.find((b) => y <= b.to) || bands[bands.length - 1]).n;
  const sh = (n) => shift.get(n) || 0;
  if (ns.every((n) => Math.abs(sh(n)) < 0.5) && [...wordShift.values()].every((w) => [...w.values()].every((d) => Math.abs(d) < 0.5))) return;

  for (const st of sys.querySelectorAll(":scope > g.measure > g.staff")) move(st, sh(Number(st.dataset.n)));
  for (const v of sys.querySelectorAll("g.verse")) {
    const n = Number(v.closest("g.staff")?.dataset.n);
    move(v, wordShift.get(n)?.get(Number(v.dataset.n)) || 0);
  }
  // everything else in the system (slurs, ties, barlines, dynamics, bar numbers, the line at the start,
  // the hyphens between syllables) goes with the staff it is drawn at
  const others = [...sys.querySelectorAll(":scope > g.measure > :not(g.staff)"), ...[...sys.children].filter((c) => !c.matches("g.measure"))];
  for (const el of others) {
    if (el.matches("g.barLine") || el.tagName === "path") {
      for (const p of el.tagName === "path" ? [el] : el.querySelectorAll(":scope > path")) stretch(p, staffAt, sh);
    } else if (el.matches("g.grpSym")) {
      groupSymbol(el, staffAt, sh);
    } else if (el.classList.contains("syl")) {
      // a hyphen or word extender: with the line of words it belongs to
      const y = shapeY(el);
      if (y == null) continue;
      const n = staffAt(y);
      const w = m.words.get(n);
      let best = null;
      for (const [k, wy] of w || []) if (!best || Math.abs(wy - y) < Math.abs(best.y - y)) best = { k, y: wy };
      move(el, sh(n) + (best ? wordShift.get(n)?.get(best.k) || 0 : 0));
    } else {
      const y = shapeY(el);
      if (y != null) move(el, sh(staffAt(y)));
    }
  }
}

/** A vertical line across one or more staves: its ends go with their staves. */
function stretch(p, staffAt, sh) {
  const l = vline(p);
  if (!l) { const y = shapeY(p); if (y != null) move(p, sh(staffAt(y))); return; }
  const a = sh(staffAt(l.y1)), b = sh(staffAt(l.y2));
  if (Math.abs(a - b) < 0.5) { move(p, a); return; }
  p.setAttribute("d", `M${l.x} ${Math.round(l.y1 + a)} L${l.x} ${Math.round(l.y2 + b)}`);
}

/** A brace or bracket over several staves: moved and stretched to its staves' new places. */
function groupSymbol(el, staffAt, sh) {
  let box = null;
  try { box = el.getBBox(); } catch { /* not drawn */ }
  if (!box || !box.height) { const y = shapeY(el); if (y != null) move(el, sh(staffAt(y))); return; }
  const y1 = box.y, y2 = box.y + box.height;
  const a = sh(staffAt(y1 + 1)), b = sh(staffAt(y2 - 1));
  const k = (y2 + b - (y1 + a)) / (y2 - y1);
  if (Math.abs(a) < 0.5 && Math.abs(b) < 0.5) return;
  el.setAttribute("transform", `translate(0, ${Math.round(y1 + a)}) scale(1, ${k.toFixed(4)}) translate(0, ${-Math.round(y1)})`);
}

/** The units of a Verovio SVG: the outer svg's viewBox is in pixels, the inner one in Verovio units. */
function frames(root) {
  const inner = root.querySelector("svg.definition-scale");
  const ov = nums(root.getAttribute("viewBox"));
  const iv = nums(inner?.getAttribute("viewBox"));
  if (!inner || ov.length !== 4 || iv.length !== 4 || !iv[3]) return null;
  const margin = nums(inner.querySelector(":scope > g.page-margin")?.getAttribute("transform"));
  return { inner, ov, iv, k: ov[2] / iv[2], dy: margin[1] || 0 };
}

/** Make a Verovio SVG taller by dy (Verovio units), at its bottom. */
export function growSvg(root, dy) {
  const f = frames(root);
  if (!f || dy <= 0) return;
  f.iv[3] += dy;
  f.ov[3] += dy * f.k;
  f.inner.setAttribute("viewBox", f.iv.join(" "));
  root.setAttribute("viewBox", f.ov.map((v) => Math.round(v * 100) / 100).join(" "));
  if (root.hasAttribute("height")) root.setAttribute("height", f.ov[3]);
}

/** Systems stacked on pages (the page view): all lined up together, and on each page the ones below
 *  moved down by what those above them grew. */
export function alignPage(roots) {
  if (nativeVerovio()) return;
  const pages = roots.map((r) => [...r.querySelectorAll("g.system")]);
  const all = pages.flat();
  if (all.length < 2) return;
  const grow = new Map(alignSystems(all).map((g, i) => [all[i], g]));
  pages.forEach((systems, p) => {
    let below = 0;
    for (const s of systems) {
      if (below > 0.5) s.setAttribute("transform", `translate(0, ${Math.round(below)})`);
      below += grow.get(s);
    }
    growSvg(roots[p], below);
  });
}

/** One system per SVG (the presenter): lined up, and every SVG given the same frame, its first staff
 *  the same distance from the top, so the lines lie in the same place one after another. */
export function alignPages(roots) {
  if (nativeVerovio()) return;
  const sys = roots.map((r) => r.querySelector("g.system"));
  const ok = roots.filter((r, i) => sys[i] && frames(r));
  if (ok.length < 2) return;
  const grow = alignSystems(ok.map((r) => r.querySelector("g.system")));
  const fs = ok.map((r, i) => {
    const f = frames(r);
    const s = r.querySelector("g.system > g.measure > g.staff > path");
    const top = f.dy + (s ? nums(s.getAttribute("d"))[1] : 0);
    return { r, f, top, head: top - f.iv[1], foot: f.iv[1] + f.iv[3] + grow[i] - top };
  });
  const head = Math.max(...fs.map((x) => x.head));
  const foot = Math.max(...fs.map((x) => x.foot));
  for (const { r, f, top } of fs) {
    f.iv[1] = top - head;
    f.iv[3] = head + foot;
    f.ov[3] = f.iv[3] * f.k;
    f.inner.setAttribute("viewBox", f.iv.join(" "));
    r.setAttribute("viewBox", f.ov.map((v) => Math.round(v * 100) / 100).join(" "));
    if (r.hasAttribute("height")) r.setAttribute("height", f.ov[3]);
  }
}
