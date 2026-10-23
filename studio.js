// Studio: a stage plan seen from above, drawn like an architect's sheet. You stand at the front;
// each voice is a marker on the risers. Nearer to you is louder, the angle sets left or right.
// Drag a marker, or focus it and use the arrow keys.

const W = 1060;
const H = 540;
const CX = W / 2;
const CY = 500;        // the listener
const R_NEAR = 110;    // full volume
const R_FAR = 440;     // silent
const SPREAD = 62;     // degrees either side of centre for full left / right
const NS = "http://www.w3.org/2000/svg";

const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
};
const rad = (deg) => (deg * Math.PI) / 180;
const polar = (r, deg) => ({ x: CX + r * Math.sin(rad(deg)), y: CY - r * Math.cos(rad(deg)) });
const arc = (r, a0, a1) => { const p = polar(r, a0); const q = polar(r, a1); return `M${p.x},${p.y} A${r},${r} 0 0 1 ${q.x},${q.y}`; };

const toPlan = (level, pan) => polar(R_NEAR + (1 - level) * (R_FAR - R_NEAR), pan * SPREAD);
function fromPlan(x, y) {
  const dx = x - CX;
  const dy = CY - y;
  const r = Math.hypot(dx, dy);
  const deg = (Math.atan2(dx, Math.max(1, dy)) * 180) / Math.PI;
  return {
    level: Math.max(0, Math.min(1, 1 - (r - R_NEAR) / (R_FAR - R_NEAR))),
    pan: Math.max(-1, Math.min(1, deg / SPREAD)),
  };
}

export class Studio {
  constructor(dialog) {
    this.dialog = dialog;
    this.svg = dialog.querySelector("svg");
    this.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  }

  /** members: [{ch, name, color, kind: "singer"|"piano"}]; mix: {level: {}, pan: {}}; onChange(ch, level, pan) */
  open(members, mix, onChange, defaults) {
    this.members = members;
    this.mix = mix;
    this.onChange = onChange;
    this.defaults = defaults;
    this.draw();
    if (!this.dialog.open) this.dialog.showModal();
  }

  draw() {
    const svg = this.svg;
    svg.innerHTML = "";
    const plan = el("g", { class: "st-plan" }, svg);
    // the stage edge and three choir risers
    const a0 = -SPREAD - 14;
    const a1 = SPREAD + 14;
    const ro = R_FAR + 30;
    const ri = R_NEAR - 40;
    const [o0, o1, i1, i0] = [polar(ro, a0), polar(ro, a1), polar(ri, a1), polar(ri, a0)];
    el("path", { d: `M${o0.x},${o0.y} A${ro},${ro} 0 0 1 ${o1.x},${o1.y} L${i1.x},${i1.y} A${ri},${ri} 0 0 0 ${i0.x},${i0.y} Z`, class: "st-floor" }, plan);
    for (const r of [190, 270, 350]) {
      el("path", { d: arc(r + 22, -SPREAD - 8, SPREAD + 8), class: "st-riser" }, plan);
      el("path", { d: arc(r - 22, -SPREAD - 8, SPREAD + 8), class: "st-riser thin" }, plan);
    }
    // loudness rings, labelled at the right edge
    [[R_NEAR, "100%"], [R_NEAR + (R_FAR - R_NEAR) * 0.25, "75%"], [R_NEAR + (R_FAR - R_NEAR) * 0.5, "50%"], [R_NEAR + (R_FAR - R_NEAR) * 0.75, "25%"]].forEach(([r, label]) => {
      el("path", { d: arc(r, -SPREAD - 18, SPREAD + 18), class: "st-ring" }, plan);
      const p = polar(r, SPREAD + 21);
      const t = el("text", { x: p.x, y: p.y, class: "st-ringlabel" }, plan);
      t.textContent = label;
    });
    // centre line and the stereo edges
    for (const d of [-SPREAD, 0, SPREAD]) {
      const a = polar(R_NEAR - 30, d);
      const b = polar(R_FAR + 22, d);
      el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: d === 0 ? "st-axis-line centre" : "st-axis-line" }, plan);
    }
    for (const [d, label] of [[-SPREAD - 6, "Left"], [SPREAD + 6, "Right"]]) {
      const p = polar(R_FAR + 44, d);
      const t = el("text", { x: p.x, y: p.y, class: "st-edge", "text-anchor": "middle" }, plan);
      t.textContent = label;
    }
    // the listener
    el("path", { d: `M${CX - 9},${CY + 8} L${CX},${CY - 10} L${CX + 9},${CY + 8} Z`, class: "st-you" }, svg);
    const you = el("text", { x: CX, y: CY + 30, class: "st-edge", "text-anchor": "middle" }, svg);
    you.textContent = "You";

    const order = [...this.members].sort((a, b) => (this.mix.level[a.ch] ?? 0.8) - (this.mix.level[b.ch] ?? 0.8));
    for (const m of order) this.marker(m);
  }

  marker(m) {
    const level = this.mix.level[m.ch] ?? 0.8;
    const pan = this.mix.pan[m.ch] ?? 0;
    const p = toPlan(level, pan);
    const g = el("g", { class: "st-member", tabindex: 0, role: "slider", "aria-valuemin": 0, "aria-valuemax": 100, transform: `translate(${p.x},${p.y})` }, this.svg);
    g.style.setProperty("--c", m.color);
    el("circle", { r: 31, class: "st-halo" }, g);
    if (m.kind === "piano") {
      // a grand piano in plan
      el("path", { d: "M-20 -16 h40 v20 c0 14 -10 20 -20 20 c-12 0 -20 -8 -20 -20 z", class: "st-mark" }, g);
      for (let x = -16; x <= 16; x += 6) el("line", { x1: x, y1: -16, x2: x, y2: -8, class: "st-keys" }, g);
    } else {
      el("circle", { r: 22, class: "st-mark" }, g);
      const ini = el("text", { y: 7, "text-anchor": "middle", class: "st-initial" }, g);
      ini.textContent = m.name[0];
    }
    const name = el("text", { y: 48, "text-anchor": "middle", class: "st-name" }, g);
    name.textContent = m.name;
    const val = el("text", { y: 64, "text-anchor": "middle", class: "st-level" }, g);
    const label = (lv, pn) => `${Math.round(lv * 100)}%${Math.abs(pn) < 0.08 ? "" : `, ${Math.round(Math.abs(pn) * 100)}% ${pn < 0 ? "left" : "right"}`}`;
    val.textContent = label(level, pan);
    const aria = (lv, pn) => {
      g.setAttribute("aria-label", `${m.name}: ${label(lv, pn)}`);
      g.setAttribute("aria-valuenow", Math.round(lv * 100));
    };
    aria(level, pan);

    const move = (lv, pn) => {
      this.mix.level[m.ch] = lv;
      this.mix.pan[m.ch] = pn;
      this.onChange(m.ch, lv, pn);
      const q = toPlan(lv, pn);
      g.setAttribute("transform", `translate(${q.x},${q.y})`);
      val.textContent = label(lv, pn);
      aria(lv, pn);
    };
    g.addEventListener("pointerdown", (e) => {
      g.setPointerCapture(e.pointerId);
      g.classList.add("dragging");
      const pt = this.svg.createSVGPoint();
      const onMove = (ev) => {
        pt.x = ev.clientX;
        pt.y = ev.clientY;
        const s = pt.matrixTransform(this.svg.getScreenCTM().inverse());
        const r = fromPlan(s.x, s.y);
        move(r.level, r.pan);
      };
      const onUp = () => {
        g.classList.remove("dragging");
        g.removeEventListener("pointermove", onMove);
        g.removeEventListener("pointerup", onUp);
        this.draw(); // nearer markers drawn on top
        this.svg.querySelector(`[aria-label^="${m.name}:"]`)?.focus();
      };
      g.addEventListener("pointermove", onMove);
      g.addEventListener("pointerup", onUp);
    });
    g.addEventListener("keydown", (e) => {
      // up walks the voice back (softer), down brings it nearer (louder)
      const step = { ArrowUp: [-0.05, 0], ArrowDown: [0.05, 0], ArrowLeft: [0, -0.1], ArrowRight: [0, 0.1] }[e.key];
      if (!step) return;
      e.preventDefault();
      const lv = this.mix.level[m.ch] ?? 0.8;
      const pn = this.mix.pan[m.ch] ?? 0;
      move(Math.max(0, Math.min(1, lv + step[0])), Math.max(-1, Math.min(1, pn + step[1])));
    });
  }

  reset() {
    for (const m of this.members) {
      const d = this.defaults[m.ch];
      this.mix.level[m.ch] = d.level;
      this.mix.pan[m.ch] = d.pan;
      this.onChange(m.ch, d.level, d.pan);
    }
    this.draw();
  }
}
