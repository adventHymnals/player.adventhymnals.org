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
      pageMarginLeft: 20, pageMarginRight: 40, pageMarginTop: 30, pageMarginBottom: 20, lyricSize: 4.4, spacingStaff: 10,
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
      anchors.push({ q: qEnd, x: base.width - 30 });
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

  draw(s) {
    if (s.mode === "words") return this.drawWords(s);
    const g = this.g;
    const c = s.colors;
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
    const types = ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => onDone(new Blob(chunks, { type: rec.mimeType || "video/webm" }));
    rec.start(1000);
    return { stop: () => rec.state !== "inactive" && rec.stop(), mimeType: rec.mimeType };
  }
}

function svgImage(svg) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}
