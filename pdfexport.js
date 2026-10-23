// Export the score as shown (tracks, words, chords) to a vector PDF, in the browser.
// Uses Verovio for letter-size pages, svg2pdf.js + jsPDF to write the PDF.

const LIBS = [
  "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js",
  "https://cdn.jsdelivr.net/npm/svg2pdf.js@2.2.4/dist/svg2pdf.umd.min.js",
];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}

// Verovio nests an <svg viewBox> in page units inside the outer one; svg2pdf does not scale
// nested SVGs, so turn each into a scaled <g>.
function flattenNested(root) {
  const outer = root.viewBox.baseVal;
  for (const inner of [...root.querySelectorAll("svg")]) {
    const vb = inner.viewBox.baseVal;
    if (!vb || !vb.width) continue;
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("transform", `scale(${outer.width / vb.width} ${outer.height / vb.height}) translate(${-vb.x} ${-vb.y})`);
    for (const a of ["class", "id"]) if (inner.getAttribute(a)) g.setAttribute(a, inner.getAttribute(a));
    while (inner.firstChild) g.append(inner.firstChild);
    inner.replaceWith(g);
  }
}

// Music symbols are <use href="#glyph"> into <symbol viewBox>; svg2pdf skips those, so copy each
// symbol's paths in place, scaled the way <use width height> would scale them.
function inlineGlyphs(root) {
  const NS = "http://www.w3.org/2000/svg";
  for (const use of [...root.querySelectorAll("use")]) {
    const id = (use.getAttribute("href") || use.getAttribute("xlink:href") || "").slice(1);
    const sym = id && root.querySelector(`[id="${id}"]`);
    if (!sym) continue;
    const vb = sym.viewBox?.baseVal;
    const w = parseFloat(use.getAttribute("width")) || vb?.width || 1;
    const h = parseFloat(use.getAttribute("height")) || vb?.height || 1;
    const sx = vb?.width ? w / vb.width : 1;
    const sy = vb?.height ? h / vb.height : 1;
    const x = parseFloat(use.getAttribute("x")) || 0;
    const y = parseFloat(use.getAttribute("y")) || 0;
    const g = document.createElementNS(NS, "g");
    g.setAttribute("transform", `${use.getAttribute("transform") || ""} translate(${x} ${y}) scale(${sx} ${sy})`.trim());
    for (const c of sym.children) g.append(c.cloneNode(true));
    use.replaceWith(g);
  }
}

// Chord symbols and dynamics use SMuFL font characters; the PDF's Times font has none of them.
// Verovio writes chord accidentals with the figured-bass glyphs (U+EA63..EA67).
// An unknown glyph prints as "?" rather than vanishing, so a gap can never silently change a chord.
const SMUFL_TEXT = {
  "": "bb", "": "b", "": "", "": "#", "": "x",
  "": "bb", "": "b", "": "", "": "#", "": "x",
  "": "p", "": "m", "": "f", "": "r", "": "s", "": "z", "": "n",
};
function plainTextGlyphs(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (/[-]/.test(n.nodeValue)) {
      n.nodeValue = n.nodeValue.replace(/[-]/g, (ch) => SMUFL_TEXT[ch] ?? "?");
      const span = n.parentElement;
      if (span) {
        span.removeAttribute("font-family");
        span.style.fontFamily = "Times";
        // the glyph was sized for the music font; match the letter before it
        const prev = span.previousElementSibling;
        if (prev?.getAttribute("font-size")) span.setAttribute("font-size", prev.getAttribute("font-size"));
      }
    }
  }
}

export async function exportPdf(tk, xml, hymn, filename, host, transpose = "") {
  for (const src of LIBS) await loadScript(src); // in order: svg2pdf extends jsPDF
  // letter, in Verovio's tenths of a millimetre
  tk.setOptions({
    pageWidth: 2159, pageHeight: 2794, pageMarginLeft: 120, pageMarginRight: 120, pageMarginTop: 100, pageMarginBottom: 120,
    scale: 100, breaks: "auto", adjustPageHeight: false, adjustPageWidth: false, header: "auto", footer: "none",
    svgHtml5: false, svgViewBox: true, svgAdditionalAttribute: [], lyricSize: 4.2, spacingStaff: 12,
    transpose,
  });
  tk.loadData(xml);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "letter", compress: true });
  const pages = tk.getPageCount();
  for (let p = 1; p <= pages; p++) {
    if (p > 1) doc.addPage("letter");
    host.innerHTML = tk.renderToSVG(p);
    const svg = host.querySelector("svg");
    flattenNested(svg);
    inlineGlyphs(svg);
    plainTextGlyphs(svg);
    await doc.svg(svg, { x: 0, y: 0, width: 215.9, height: 279.4 });
    doc.setFont("times", "normal");
    doc.setFontSize(8);
    doc.setTextColor(90);
    if (p === pages && hymn.copyright) doc.text(doc.splitTextToSize(hymn.copyright, 180), 12, 270);
    doc.text(`${p} / ${pages}`, 203.9, 270, { align: "right" });
  }
  host.innerHTML = "";
  doc.save(filename);
  return pages;
}
