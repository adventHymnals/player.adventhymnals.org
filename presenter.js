import { SVG_CSS } from "./core.js";
// Presenter stage (also the video source): one system at a time on a fixed 1920x1080 canvas.
// The playhead sweeps left to right; behind it the next system is uncovered, so when the eye
// returns to the left edge the next line is already there.

const W = 1920;
const H = 1080;
const MARGIN = 70;

export class Presenter {
  constructor(canvas, measureHost) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d");
    canvas.width = W;
    canvas.height = H;
    this.host = measureHost; // off-screen element used to measure SVG geometry
    this.pages = [];
    this.key = "";
  }

  /** Render one system per page and measure notes. key: cache key for the current settings. */
  async prepare(tk, xml, key, barOffset = 0, transpose = "") {
    if (key === this.key && this.pages.length) return;
    this.key = key;
    const gen = (this.gen = (this.gen || 0) + 1); // a newer prepare makes this one obsolete
    const scale = 62;
    tk.setOptions({
      scale, header: "none", footer: "none", svgHtml5: true, svgViewBox: true,
      svgAdditionalAttribute: ["staff@n", "layer@n", "verse@n", "measure@n"],
      breaks: "auto", adjustPageWidth: false, adjustPageHeight: true,
      pageWidth: Math.round(((W - 2 * MARGIN) * 100) / scale), pageHeight: 100, // one system per page
      pageMarginLeft: 20, pageMarginRight: 40, pageMarginTop: 30, pageMarginBottom: 20, lyricSize: 4.4, spacingStaff: 10, svgCss: SVG_CSS,
      transpose,
    });
    tk.loadData(xml);
    const times = new Map();
    for (const e of tk.renderToTimemap({})) {
      for (const id of e.on || []) times.set(id, { on: e.qstamp, off: Infinity });
      for (const id of e.off || []) { const x = times.get(id); if (x) x.off = e.qstamp; }
    }
    // The toolkit is shared with the main view, so every toolkit call and measurement happens in
    // this one synchronous pass; images are made afterwards, when other renders may run.
    const pages = [];
    this.host.style.width = `${W - 2 * MARGIN}px`;
    for (let p = 1; p <= tk.getPageCount(); p++) {
      const svg = tk.renderToSVG(p);
      this.host.innerHTML = svg;
      const root = this.host.querySelector("svg");
      const base = root.getBoundingClientRect();
      const rel = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }; };
      const notes = [];
      const onsets = new Map();
      for (const el of root.querySelectorAll("g.note")) {
        const tm = times.get(el.dataset.id);
        if (!tm) continue;
        const head = rel(el.querySelector("g.notehead") || el);
        const syl = {};
        el.querySelectorAll("g.verse").forEach((v) => { const t = v.querySelector("g.syl, text"); if (t) syl[v.dataset.n] = rel(t); });
        notes.push({ on: tm.on, off: tm.off, staffN: Number(el.closest("g.staff")?.dataset.n) || 1, layer: Number(el.closest("g.layer")?.dataset.n) || 1, head, syl });
        if (!onsets.has(tm.on)) onsets.set(tm.on, []);
        onsets.get(tm.on).push(head.x + head.w / 2);
      }
      const anchors = [...onsets].map(([q, xs]) => ({ q, x: xs.reduce((a, b) => a + b, 0) / xs.length })).sort((a, b) => a.q - b.q);
      const measures = [...root.querySelectorAll("g.measure")].map((el) => ({ n: Number(el.dataset.n) + barOffset, box: rel(el) }));
      const qEnd = Math.max(...notes.map((n) => n.off).filter(Number.isFinite));
      // the line ends at its last barline, which on a short last line is well before the page edge
      const staffEnd = Math.max(...measures.map((m) => m.box.x + m.box.w));
      anchors.push({ q: qEnd, x: Number.isFinite(staffEnd) ? staffEnd - 4 : base.width - 30 });
      // keep the SVG at the measured size when it becomes an image
      root.setAttribute("width", base.width);
      root.setAttribute("height", base.height);
      pages.push({ svg: new XMLSerializer().serializeToString(root), w: base.width, h: base.height, notes, anchors, measures, qStart: anchors[0]?.q ?? 0, qEnd });
    }
    this.host.innerHTML = "";
    for (const pg of pages) pg.img = await svgImage(pg.svg);
    if (gen !== this.gen) return; // settings changed while the images were being made
    this.pages = pages;
  }

  pageIndex(q) {
    const i = this.pages.findIndex((p) => q >= p.qStart - 1e-6 && q < p.qEnd - 1e-6);
    return i < 0 ? (q < (this.pages[0]?.qStart ?? 0) ? 0 : this.pages.length - 1) : i;
  }

  cursorX(page, q) {
    const a = page.anchors;
    let i = a.findIndex((x) => x.q > q) - 1;
    if (i < 0) i = a[0].q > q ? 0 : a.length - 1;
    const p = a[i];
    const n = a[i + 1];
    return n ? p.x + ((n.x - p.x) * (q - p.q)) / Math.max(1e-6, n.q - p.q) : p.x;
  }

  /**
   * s: { hymn, q (or null when stopped), verseN, verseLabel, tracks, colors, chord, nextChord,
   *      line: [{text, sung}], nextLine, piano: Waterfall|null, t, heard(ch), loop: {from, to}|null }
   */
  /** Words only, for projecting in church: the line being sung, large, with the next under it. */
  drawWords(s) {
    const g = this.g;
    const c = s.colors;
    g.fillStyle = c.cloth;
    g.fillRect(0, 0, W, H);
    g.textBaseline = "alphabetic";
    g.textAlign = "left";
    g.fillStyle = c.gilt;
    g.font = `800 54px Alegreya, serif`;
    g.fillText(s.hymn.number, MARGIN, 96);
    const nw = g.measureText(s.hymn.number).width;
    g.fillStyle = "rgba(252,251,247,0.82)";
    g.font = `600 34px Alegreya, serif`;
    g.fillText(s.hymn.title, MARGIN + nw + 22, 90);
    g.textAlign = "right";
    g.font = `italic 400 30px Alegreya, serif`;
    g.fillStyle = "rgba(252,251,247,0.6)";
    g.fillText(s.verseLabel || "", W - MARGIN, s.chord ? 150 : 90);
    if (s.chord) { g.fillStyle = c.paper; g.font = `700 56px Alegreya, serif`; g.fillText(s.chord, W - MARGIN, 96); }

    // wrap the current line at word ends, centred
    const maxW = W - 2 * 170;
    const big = `500 92px Alegreya, serif`;
    g.font = big;
    const rows = [[]];
    let rowW = 0;
    for (const part of s.line || []) {
      const w = g.measureText(part.text).width;
      // break only where a word has ended
      if (rowW + w > maxW && rows[rows.length - 1].length && rows[rows.length - 1].at(-1).text.endsWith(" ")) { rows.push([]); rowW = 0; }
      rows[rows.length - 1].push({ ...part, w });
      rowW += w;
    }
    const lineH = 122;
    const top = H / 2 - ((rows.length - 1) * lineH) / 2 + 10;
    g.textAlign = "left";
    rows.forEach((row, i) => {
      const total = row.reduce((a, p) => a + p.w, 0) - (row.at(-1)?.text.endsWith(" ") ? g.measureText(" ").width : 0);
      let x = (W - total) / 2;
      const y = top + i * lineH;
      for (const p of row) {
        g.fillStyle = p.sung ? c.gilt : c.paper;
        g.fillText(p.text, x, y);
        if (p.sung) g.fillRect(x, y + 16, p.w - (p.text.endsWith(" ") ? g.measureText(" ").width : 0), 6);
        x += p.w;
      }
    });
    g.textAlign = "center";
    g.font = `400 54px Alegreya, serif`;
    g.fillStyle = "rgba(252,251,247,0.5)";
    g.fillText(s.nextLine || "", W / 2, top + (rows.length - 1) * lineH + 118);
    g.textAlign = "left";
  }

  /** Words only, the whole stanza at once (as the app's presenter shows it), the line being sung bright
   *  and its syllable lit, the lines sung already dimmed. */
  drawStanza(s) {
    const g = this.g;
    const c = s.colors;
    g.fillStyle = c.cloth;
    g.fillRect(0, 0, W, H);
    g.textBaseline = "alphabetic";
    g.textAlign = "left";
    g.fillStyle = c.gilt;
    g.font = `800 54px Alegreya, serif`;
    g.fillText(s.hymn.number, MARGIN, 96);
    const nw = g.measureText(s.hymn.number).width;
    g.fillStyle = "rgba(252,251,247,0.82)";
    g.font = `600 34px Alegreya, serif`;
    g.fillText(s.hymn.title, MARGIN + nw + 22, 90);
    g.textAlign = "right";
    g.font = `italic 400 30px Alegreya, serif`;
    g.fillStyle = "rgba(252,251,247,0.6)";
    g.fillText(s.verseLabel || "", W - MARGIN, s.chord ? 150 : 90);
    if (s.chord) { g.fillStyle = c.paper; g.font = `700 56px Alegreya, serif`; g.fillText(s.chord, W - MARGIN, 96); }

    // the short phrases joined into fuller lines (as a hymnal prints them), each wrapped at word ends;
    // the largest size at which the whole stanza fits
    const lines = joinPhrases(s.stanza);
    g.textAlign = "left";
    const top = 170;
    const room = H - top - 70;
    const maxW = W - 2 * 150;
    let size = 76;
    let rows;
    for (;;) {
      g.font = `500 ${size}px Alegreya, serif`;
      rows = [];
      lines.forEach(({ parts, lis }) => {
        const li = lis.includes(s.stanzaAt) ? s.stanzaAt : lis[0];
        let row = [];
        let rowW = 0;
        for (const part of parts) {
          const w = g.measureText(part.text).width;
          if (rowW + w > maxW && row.length && row.at(-1).text.endsWith(" ")) { rows.push({ li, parts: row }); row = []; rowW = 0; }
          row.push({ ...part, w });
          rowW += w;
        }
        rows.push({ li, parts: row });
      });
      if (rows.length * size * 1.32 <= room || size <= 30) break;
      size -= 2;
    }
    const lineH = size * 1.32;
    let y = top + (room - rows.length * lineH) / 2 + size;
    const space = g.measureText(" ").width;
    for (const row of rows) {
      const total = row.parts.reduce((a, p) => a + p.w, 0) - (row.parts.at(-1)?.text.endsWith(" ") ? space : 0);
      let x = (W - total) / 2;
      const now = row.li === s.stanzaAt;
      for (const p of row.parts) {
        g.fillStyle = p.sung ? c.gilt : now ? c.paper : s.stanzaAt >= 0 && row.li < s.stanzaAt ? "rgba(252,251,247,0.38)" : "rgba(252,251,247,0.72)";
        g.fillText(p.text, x, y);
        if (p.sung) g.fillRect(x, y + size * 0.16, p.w - (p.text.endsWith(" ") ? space : 0), Math.max(3, size * 0.06));
        x += p.w;
      }
      y += lineH;
    }
    g.textAlign = "left";
  }

  /** The tall stage (1080x1920) of a Short. Everything stays inside the zone that YouTube Shorts, Reels and
   *  TikTok all leave clear (x 60-940, y 220-1480): the hymnal and number, the title, then the line being
   *  sung, large, with the next under it. */
  drawVertical(s) {
    const g = this.g;
    const c = s.colors;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const L = SAFE.x0;
    const R = SAFE.x1;
    const mid = (L + R) / 2;
    g.fillStyle = c.cloth;
    g.fillRect(0, 0, w, h);
    g.textBaseline = "alphabetic";
    // the badge: "SDA Hymnal 610"
    g.font = `700 40px "Alegreya Sans", sans-serif`;
    const badge = s.badge || s.hymn.number;
    const bw = g.measureText(badge).width + 48;
    g.fillStyle = BRAND.gold;
    roundRect(g, mid - bw / 2, SAFE.y0 + 20, bw, 64, 32);
    g.fill();
    g.fillStyle = BRAND.maroon;
    g.textAlign = "center";
    g.fillText(badge, mid, SAFE.y0 + 66);
    // the title, two lines at most
    let y = SAFE.y0 + 190;
    g.fillStyle = c.paper;
    for (const line of wrapText(g, s.hymn.title, R - L, 76, 2, `700 SIZEpx Alegreya, serif`)) {
      g.fillText(line, mid, y);
      y += 90;
    }
    g.fillStyle = "rgba(252,251,247,0.6)";
    g.font = `italic 400 40px Alegreya, serif`;
    g.fillText(s.verseLabel || "", mid, y + 4);

    // the line being sung (short phrases joined, as a hymnal prints them), wrapped at word ends, its sung
    // part lit; the next line under it, dimmer
    const joined = joinPhrases(s.stanza, 30, /[.;]\s*$/); // "Glory! glory! Hallelujah!" is one line here
    const at = joined.findIndex((l) => l.lis.includes(s.stanzaAt));
    const now = at >= 0 ? joined[at].parts : s.line || [];
    const nextText = at >= 0 ? (joined[at + 1]?.parts || []).map((p) => p.text).join("") : s.nextLine || "";
    const size = 80;
    const lineH = size * 1.28;
    const big = `500 ${size}px Alegreya, serif`;
    g.font = big;
    const space = g.measureText(" ").width;
    const rows = [[]];
    let rowW = 0;
    for (const part of now) {
      const pw = g.measureText(part.text).width;
      if (rowW + pw > R - L && rows.at(-1).length && rows.at(-1).at(-1).text.endsWith(" ")) { rows.push([]); rowW = 0; }
      rows.at(-1).push({ ...part, w: pw });
      rowW += pw;
    }
    const next = wrapText(g, nextText, R - L, 64, 2, `400 SIZEpx Alegreya, serif`, 64); // never under 64 px
    const block = rows.length * lineH + 40 + next.length * 64 * 1.25;
    let ly = Math.max(y + 140, (SAFE.y0 + 560 + SAFE.y1 - 120) / 2 - block / 2) + size;
    g.textAlign = "left";
    g.font = big;
    for (const row of rows) {
      const total = row.reduce((a, p) => a + p.w, 0) - (row.at(-1)?.text.endsWith(" ") ? space : 0);
      let x = mid - total / 2;
      for (const p of row) {
        g.fillStyle = p.sung ? c.gilt : c.paper;
        g.fillText(p.text, x, ly);
        if (p.sung) g.fillRect(x, ly + 14, p.w - (p.text.endsWith(" ") ? space : 0), 6);
        x += p.w;
      }
      ly += lineH;
    }
    g.textAlign = "center";
    g.fillStyle = "rgba(252,251,247,0.5)";
    g.font = `400 64px Alegreya, serif`;
    ly += 40 - lineH + 64 * 1.25;
    for (const line of next) { g.fillText(line, mid, ly); ly += 64 * 1.25; }
    g.textAlign = "left";
  }

  /** The watermark of a tall video: the same faint name across the middle, and the address at the
   *  bottom right of the clear zone (the platforms' buttons cover the real corner). */
  drawVerticalMark(ink = "#ffffff", cornerOnly = false) {
    const g = this.g;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!cornerOnly) {
      g.save();
      g.fillStyle = ink;
      g.translate(w / 2, h / 2);
      g.rotate(-Math.atan2(h, w));
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = `800 150px Alegreya, serif`;
      g.globalAlpha = 0.07;
      g.fillText("Advent Hymnals", 0, 0);
      g.restore();
    }
    g.save();
    g.textAlign = "right";
    g.font = `600 34px "Alegreya Sans", sans-serif`;
    g.globalAlpha = 0.6;
    g.fillStyle = ink;
    g.fillText("adventhymnals.org", SAFE.x1, SAFE.y1 - 20);
    g.restore();
  }

  /** The card at the end of every automatic video, k seconds into it. It fades in over `last` (the final
   *  frame of the music) in half a second. A wide video keeps its bottom 40 % plain: YouTube's end screen
   *  (subscribe, next video) goes there. lines: [big, middle, small]. */
  drawEndCard({ k, last, logo, lines }) {
    const g = this.g;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const tall = h > w;
    if (last && k < 0.5) g.drawImage(last, 0, 0);
    g.save();
    g.globalAlpha = Math.min(1, k / 0.5);
    g.fillStyle = BRAND.maroon;
    g.fillRect(0, 0, w, h);
    const mid = tall ? (SAFE.x0 + SAFE.x1) / 2 : w / 2;
    const room = tall ? SAFE.x1 - SAFE.x0 : w - 200;
    const d = tall ? 300 : 250; // the logo, centred in the top third (of the clear zone, when tall)
    const cy = tall ? SAFE.y0 + 300 : 195;
    drawLogo(g, logo, mid, cy, d);
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    let y = cy + d / 2 + (tall ? 190 : 140);
    const sizes = tall ? [76, 56, 34] : [84, 56, 34];
    lines.forEach((text, i) => {
      if (!text) return;
      let size = sizes[i];
      const font = (px) => `${i === 0 ? 800 : i === 1 ? 500 : 600} ${px}px ${i === 2 ? '"Alegreya Sans", sans-serif' : "Alegreya, serif"}`;
      g.font = font(size);
      while (g.measureText(text).width > room && size > 24) g.font = font(--size);
      g.fillStyle = i === 1 ? BRAND.gold : i === 2 ? "rgba(252,251,247,0.82)" : "#fcfbf7";
      g.fillText(text, mid, y);
      y += i === 0 ? size * 1.0 : size * 1.25 + 12;
    });
    g.restore();
  }

  /** A card between the sections of the rehearsal video: "Alto part", in the voice's colour. */
  drawTitleCard({ hymn, colors, title, voice, badge }) {
    const g = this.g;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const tall = h > w;
    const mid = tall ? (SAFE.x0 + SAFE.x1) / 2 : w / 2;
    g.fillStyle = colors.stage || colors.paper;
    g.fillRect(0, 0, w, h);
    g.fillStyle = colors[voice] || colors.cloth;
    g.fillRect(0, 0, w, tall ? SAFE.y0 : 24);
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    const cy = tall ? (SAFE.y0 + SAFE.y1) / 2 : h / 2;
    g.fillStyle = colors[voice] || colors.cloth;
    g.font = `800 ${tall ? 120 : 150}px Alegreya, serif`;
    g.fillText(title, mid, cy);
    g.fillStyle = colors.cloth;
    g.font = `600 ${tall ? 48 : 54}px Alegreya, serif`;
    const sub = wrapText(g, `${hymn.title}`, tall ? SAFE.x1 - SAFE.x0 : w - 300, tall ? 48 : 54, 2, `600 SIZEpx Alegreya, serif`);
    sub.forEach((line, i) => g.fillText(line, mid, cy + 110 + i * 64));
    g.fillStyle = colors.muted;
    g.font = `500 36px "Alegreya Sans", sans-serif`;
    g.fillText(badge || "", mid, cy + 110 + sub.length * 64 + 20);
    g.textAlign = "left";
  }

  /** A 1280x720 thumbnail on `canvas`: the first line of the score, faint, behind the title (two lines at
   *  most), a badge with the hymnal and number, what the video is ("Alto Part") and the logo. */
  drawThumb(canvas, { hymn, colors, badge, label, voice, logo }) {
    const g = canvas.getContext("2d");
    const w = (canvas.width = 1280);
    const h = (canvas.height = 720);
    g.fillStyle = colors.stage || colors.paper;
    g.fillRect(0, 0, w, h);
    const pg = this.pages[0];
    if (pg?.img) {
      const k = (w + 160) / pg.w;
      g.globalAlpha = 0.16;
      g.drawImage(pg.img, -80, h - pg.h * k - 10, pg.w * k, pg.h * k);
      g.globalAlpha = 1;
      // a wash of the stage colour behind the words, so the title reads at a glance
      const wash = g.createLinearGradient(0, 0, w, 0);
      wash.addColorStop(0, colors.stage || colors.paper);
      wash.addColorStop(0.75, "rgba(244,236,217,0.55)");
      wash.addColorStop(1, "rgba(244,236,217,0)");
      g.fillStyle = wash;
      g.fillRect(0, 0, w, h);
    }
    // the badge
    g.textBaseline = "alphabetic";
    g.font = `700 44px "Alegreya Sans", sans-serif`;
    const bw = g.measureText(badge).width + 56;
    g.fillStyle = BRAND.maroon;
    roundRect(g, 60, 52, bw, 76, 38);
    g.fill();
    g.fillStyle = BRAND.gold;
    g.fillText(badge, 88, 106);
    // the title, as large as fits in two lines (at least 90 px)
    g.fillStyle = colors.cloth;
    const lines = wrapText(g, hymn.title, w - 120, 124, 2, `800 SIZEpx Alegreya, serif`, 90);
    const size = Number(/(\d+)px/.exec(g.font)[1]);
    lines.forEach((line, i) => g.fillText(line, 60, 150 + size * (i + 1) * 1.02));
    // what this video is
    g.font = `800 58px "Alegreya Sans", sans-serif`;
    const lw = g.measureText(label).width + 60;
    const ly = 150 + size * lines.length * 1.02 + 40;
    g.fillStyle = colors[voice] || BRAND.gold;
    roundRect(g, 60, ly, lw, 92, 18);
    g.fill();
    g.fillStyle = voice ? "#ffffff" : BRAND.maroon;
    g.fillText(label, 90, ly + 66);
    drawLogo(g, logo, w - 110, h - 110, 150);
  }

  draw(s) {
    if (s.format === "vertical") { this.drawVertical(s); if (s.watermark) this.drawVerticalMark(); return; }
    if (s.mode === "stanza") { this.drawStanza(s); this.drawMark(s); return; }
    if (s.mode === "words") { this.drawWords(s); this.drawMark(s); return; }
    this.drawScore(s);
    this.drawMark(s);
  }

  /** The watermark of every recorded video (anyone can make one on the site, so it is always there):
   *  "Advent Hymnals" faintly across the middle, corner to corner, and the address in the corner. */
  drawMark(s, cornerOnly = false) {
    if (!s.watermark) return;
    const g = this.g;
    const dark = s.mode === "words" || s.mode === "stanza";
    if (!cornerOnly) { // (the end card has the address only)
      g.save();
      g.fillStyle = dark ? "#ffffff" : s.colors.cloth;
      g.translate(W / 2, H / 2);
      g.rotate(-Math.atan2(H, W));
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = `800 170px Alegreya, serif`;
      g.globalAlpha = dark ? 0.08 : 0.07;
      g.fillText("Advent Hymnals", 0, 0);
      g.restore();
    }
    g.save();
    g.textAlign = "right";
    g.textBaseline = "alphabetic";
    g.font = `600 30px "Alegreya Sans", sans-serif`;
    g.globalAlpha = dark ? 0.55 : 0.5;
    g.fillStyle = dark ? "#ffffff" : s.colors.cloth;
    g.fillText("adventhymnals.org", W - 36, H - 30);
    g.restore();
  }

  drawScore(s) {
    const g = this.g;
    const c = { ...s.colors, paper: s.colors.stage || s.colors.paper }; // the stage is cream, easier on the eyes than white
    g.fillStyle = c.paper;
    g.fillRect(0, 0, W, H);

    // heading: the gilt number, the title, and where we are
    g.textBaseline = "alphabetic";
    g.fillStyle = c.gilt;
    g.font = `800 86px Alegreya, serif`;
    g.fillText(s.hymn.number, MARGIN, 110);
    const numW = g.measureText(s.hymn.number).width;
    g.fillStyle = c.cloth;
    g.font = `700 46px Alegreya, serif`;
    g.fillText(s.hymn.title, MARGIN + numW + 28, 84);
    g.fillStyle = c.muted;
    g.font = `italic 400 26px Alegreya, serif`;
    g.fillText(s.verseLabel || "", MARGIN + numW + 30, 118);
    if (s.chord) {
      g.textAlign = "right";
      g.fillStyle = c.cloth;
      g.font = `700 70px Alegreya, serif`;
      g.fillText(s.chord, W - MARGIN, 100);
      if (s.nextChord) { g.fillStyle = c.muted; g.font = `400 24px "Alegreya Sans", sans-serif`; g.fillText(`Next: ${s.nextChord}`, W - MARGIN, 130); }
      g.textAlign = "left";
    }

    const lyricH = 150;
    const pianoH = s.piano ? 300 : 0;
    const areaY = 150;
    const areaH = H - areaY - lyricH - pianoH;
    if (!this.pages.length) return;
    const q = s.q ?? this.pages[0].qStart;
    const ci = this.pageIndex(q);
    const cur = this.pages[ci];
    const next = this.pages[ci + 1];
    const fit = (p) => Math.min(1, areaH / p.h);
    const place = (p) => { const k = fit(p); return { k, x: MARGIN, y: areaY + (areaH - p.h * k) / 2 }; };
    const pc = place(cur);
    const cx = this.cursorX(cur, q) * pc.k + pc.x;

    // loop shading for the looped bars on this system
    if (s.loop) {
      const bars = cur.measures.filter((m) => m.n >= s.loop.from && m.n <= s.loop.to);
      if (bars.length) {
        const x0 = Math.min(...bars.map((m) => m.box.x));
        const x1 = Math.max(...bars.map((m) => m.box.x + m.box.w));
        g.fillStyle = c.loop;
        g.fillRect(pc.x + x0 * pc.k, pc.y, (x1 - x0) * pc.k, cur.h * pc.k);
      }
    }
    // halos behind the sounding notes, tinted by voice
    if (s.q !== null) {
      for (const n of cur.notes) {
        if (!(n.on <= q + 1e-6 && q < n.off - 1e-6)) continue;
        const voice = (s.tracks[n.staffN - 1] || [])[n.layer - 1] ?? (s.tracks[n.staffN - 1] || [])[0];
        if (s.only && !s.only.includes(voice)) continue; // an introduction for one voice lights only that voice
        g.fillStyle = c[voice] || c.cloth;
        g.globalAlpha = 0.28;
        g.beginPath();
        g.ellipse(pc.x + (n.head.x + n.head.w / 2) * pc.k, pc.y + (n.head.y + n.head.h / 2) * pc.k, n.head.w * pc.k * 1.1, n.head.h * pc.k * 1.25, 0, 0, Math.PI * 2);
        g.fill();
        const sb = n.syl[s.verseN];
        if (sb) {
          g.globalAlpha = 0.16;
          g.fillRect(pc.x + (sb.x - 4) * pc.k, pc.y + (sb.y - 2) * pc.k, (sb.w + 8) * pc.k, (sb.h + 4) * pc.k);
          g.globalAlpha = 1;
          g.fillRect(pc.x + sb.x * pc.k, pc.y + (sb.y + sb.h + 2) * pc.k, sb.w * pc.k, 3);
        }
        g.globalAlpha = 1;
      }
    }
    g.drawImage(cur.img, pc.x, pc.y, cur.w * pc.k, cur.h * pc.k);

    // Once three quarters of the line is sung, the next system is uncovered behind the playhead.
    // The two systems crossfade over a wide soft edge, so there is no visible seam.
    const lineStart = cur.anchors[0].x * pc.k + pc.x;
    const lineEnd = cur.anchors[cur.anchors.length - 1].x * pc.k + pc.x;
    const startAt = lineStart + (lineEnd - lineStart) * 0.75;
    if (ci !== this.wipePage) { this.wipePage = ci; this.wipeX = 0; }
    if (next && s.q !== null && cx > startAt) {
      const soft = 28;
      const pn = place(next);
      // The edge sits on a barline of the incoming system, so new music always begins at a
      // clean bar; it glides from barline to barline and stays well behind the playhead.
      const lines = next.measures.map((m) => pn.x + (m.box.x + m.box.w) * pn.k).sort((a, b) => a - b);
      const target = lines.filter((x) => x <= cx - 70).pop() ?? 0;
      this.wipeX += (target - this.wipeX) * 0.18;
      const wipe = this.wipeX;
      const off = this.off || (this.off = Object.assign(document.createElement("canvas"), { width: W, height: H }));
      const og = off.getContext("2d");
      og.clearRect(0, 0, W, H);
      og.fillStyle = c.paper;
      og.fillRect(0, areaY, W, areaH);
      og.drawImage(next.img, pn.x, pn.y, next.w * pn.k, next.h * pn.k);
      // keep the next system only to the left of the edge, fading out across it
      og.globalCompositeOperation = "destination-in";
      const mask = og.createLinearGradient(wipe - soft, 0, wipe, 0); // fade ends on the barline
      mask.addColorStop(0, "rgba(0,0,0,1)");
      mask.addColorStop(1, "rgba(0,0,0,0)");
      og.fillStyle = mask;
      og.fillRect(0, areaY, W, areaH);
      og.globalCompositeOperation = "source-over";
      g.drawImage(off, 0, 0);
    }
    // the ribbon playhead
    if (s.q !== null) {
      g.fillStyle = c.gilt;
      g.globalAlpha = 0.9;
      g.fillRect(cx - 3, pc.y - 12, 6, cur.h * pc.k + 24);
      g.globalAlpha = 1;
    }

    // the line being sung, large, with the next line under it
    const ly = areaY + areaH + 62;
    g.font = `500 52px Alegreya, serif`;
    let x = MARGIN;
    for (const part of s.line || []) {
      g.fillStyle = part.sung ? c.lyric : c.ink;
      g.fillText(part.text, x, ly);
      const w = g.measureText(part.text).width;
      if (part.sung) g.fillRect(x, ly + 10, w - (part.text.endsWith(" ") ? g.measureText(" ").width : 0), 4);
      x += w;
    }
    g.fillStyle = c.muted;
    g.font = `400 34px Alegreya, serif`;
    g.fillText(s.nextLine || "", MARGIN, ly + 58);

    if (s.piano) s.piano.draw(g, 0, H - pianoH, W, pianoH, s.t, c, s.heard);
  }

  /** Record the stage and the engine's audio. Returns a controller with stop(). */
  record(audioStream, onDone) {
    const video = this.canvas.captureStream(30);
    const stream = new MediaStream([...video.getVideoTracks(), ...audioStream.getAudioTracks()]);
    // H.264/AAC mp4 when the browser can record it; otherwise webm (a plain "video/mp4" is often VP9/Opus inside,
    // which most players and phones cannot open), converted to mp4 afterwards by the server
    const types = ['video/mp4;codecs="avc1.640028,mp4a.40.2"', 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
      "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => onDone(new Blob(chunks, { type: rec.mimeType || "video/webm" }));
    rec.start(1000);
    return { stop: () => rec.state !== "inactive" && rec.stop(), mimeType: rec.mimeType };
  }
}

// the brand of the social videos: the site's maroon and a brighter gold (reads better small)
export const BRAND = { maroon: "#8C2F39", gold: "#D4A845" };
// a tall video's clear zone: the platforms' buttons and captions cover the right 140 px and the bottom 440 px
export const SAFE = { x0: 60, x1: 940, y0: 220, y1: 1480 };

/** The short phrases of a stanza joined into fuller lines, as a hymnal prints them: [{ parts, lis }].
 *  A line takes the next phrase while it stays within `max` characters and has not ended at `stop`. */
function joinPhrases(stanza, max = 40, stop = /[.!?;]\s*$/) {
  const lines = [];
  const textOf = (parts) => parts.map((p) => p.text).join("");
  (stanza || []).forEach((parts, li) => {
    const last = lines.at(-1);
    if (last && (textOf(last.parts) + textOf(parts)).length <= max && !stop.test(textOf(last.parts))) {
      last.parts.push(...parts);
      last.lis.push(li);
    } else lines.push({ parts: [...parts], lis: [li] });
  });
  return lines;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Lines of `text` wrapped at spaces to `width`, at most `max` of them: the largest size from `size`
 *  down to `least` at which it fits (font: a CSS font with SIZE for the size). Leaves g.font set. */
function wrapText(g, text, width, size, max, font, least = Math.round(size * 0.6)) {
  const words = String(text).split(/\s+/).filter(Boolean);
  for (let px = size; ; px -= 2) {
    g.font = font.replace("SIZE", px);
    const lines = [""];
    for (const word of words) {
      const tryLine = lines.at(-1) ? `${lines.at(-1)} ${word}` : word;
      if (g.measureText(tryLine).width > width && lines.at(-1)) lines.push(word);
      else lines[lines.length - 1] = tryLine;
    }
    if ((lines.length <= max && lines.every((l) => g.measureText(l).width <= width)) || px <= least) {
      if (lines.length > max) { lines.length = max; lines[max - 1] += "…"; }
      return lines.filter(Boolean);
    }
  }
}

/** The logo (a round image) with a thin gold ring, so it shows on the maroon cards too. */
function drawLogo(g, logo, cx, cy, d) {
  if (!logo) return;
  g.save();
  g.drawImage(logo, cx - d / 2, cy - d / 2, d, d);
  g.strokeStyle = BRAND.gold;
  g.lineWidth = Math.max(2, d / 60);
  g.beginPath();
  g.arc(cx, cy, d / 2 - g.lineWidth / 2, 0, Math.PI * 2);
  g.stroke();
  g.restore();
}

function svgImage(svg) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    // never wait for good: an image that doesn't load (a page held in the background) gives up after 10 s,
    // or the next hymn waited on it and the app's player stayed on "opening"
    const t = setTimeout(() => reject(new Error("page image timed out")), 10000);
    img.onload = () => { clearTimeout(t); URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { clearTimeout(t); reject(e); };
    img.src = url;
  });
}
