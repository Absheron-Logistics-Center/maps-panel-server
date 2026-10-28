// diagramExport.js
// Self-contained exporters for a diagram — no extra npm dependencies.
//   - exportDiagramToJson(process)        -> downloads the diagram as .json
//   - importDiagramFromJson(file)         -> parses a .json back into diagram data
//   - buildDiagramSvg(process, opts)      -> a standalone <svg> string of the whole diagram
//   - exportDiagramToPdf(process, opts)   -> opens a print window (Save as PDF), portrait/landscape
//
// The SVG mirrors DiagramCanvas: same shapes, same edge routing (edgeGeometry
// is imported so arrows are identical), colours resolved to concrete hex so the
// print window needs no CSS variables.
import { nodeView, SVG_SHAPES } from './nodeStyle.js';
import { edgeGeometry, endpointOffsets } from './DiagramCanvas.jsx';
import { asColorString, contrastTextColor } from './colorUtils.js';

/* ---- palette (mirrors the :root tokens in styles.css) ---- */
const PRIMARY = '#3a7894';
const PRIMARY_DARKER = '#1f4456';
const STROKE_BORDER = '#4a85a0';
const STROKE_BG = '#ffffff';
const TEXT_PRIMARY = '#243f4f';
const LANE_BG = '#f0f4f8';
const LANE_TEXT = '#1a2a3a';
const RAIL_W = 56;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function safeName(s) {
  return (s || 'diaqram').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ============================ JSON ============================ */
export function exportDiagramToJson(process) {
  const clean = {
    id: process.id,
    title: process.title || '',
    subtitle: process.subtitle || '',
    width: process.width || 1200,
    height: process.height || 600,
    theme: process.theme || undefined,
    lanes: process.lanes || [],
    nodes: process.nodes || [],
    edges: process.edges || []
  };
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
  download(blob, `${safeName(process.title)}.json`);
}

export function importDiagramFromJson(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || typeof data !== 'object') throw new Error('Boş və ya yanlış JSON.');
        resolve({
          title: data.title || file.name.replace(/\.json$/i, '') || 'Yeni diaqram',
          subtitle: data.subtitle || '',
          width: data.width || 2200,
          height: data.height || 900,
          theme: data.theme,
          lanes: Array.isArray(data.lanes) ? data.lanes : [],
          nodes: Array.isArray(data.nodes) ? data.nodes : [],
          edges: Array.isArray(data.edges) ? data.edges : []
        });
      } catch (e) {
        reject(new Error('JSON oxuna bilmədi: ' + e.message));
      }
    };
    reader.onerror = () => reject(new Error('Fayl oxuna bilmədi.'));
    reader.readAsText(file);
  });
}

/* ============================ SVG snapshot ============================ */
// Resolve a node's fill / border / text colours from its style + theme.
function nodeColors(node, theme) {
  const { style } = nodeView(node);
  const accent = asColorString(node.color) || asColorString(theme?.node) || PRIMARY;
  if (style === 'solid') {
    return { fill: accent, stroke: 'none', strokeWidth: 0, dash: null, text: contrastTextColor(accent) };
  }
  return {
    fill: STROKE_BG, stroke: accent || STROKE_BORDER, strokeWidth: 2,
    dash: style === 'dashed' ? '7 5' : null, text: TEXT_PRIMARY
  };
}

const POLY = {
  diamond: '50,2 98,50 50,98 2,50',
  parallelogram: '20,5 98,5 80,95 2,95',
  preparation: '25,2 75,2 98,50 75,98 25,98 2,50',
  manualinput: '2,22 98,2 98,98 2,98',
  trapezoid: '22,4 78,4 98,96 2,96',
  triangledown: '3,6 97,6 50,97',
};

function shapeMarkup(node, c) {
  const { shape } = nodeView(node);
  const { x, y, w, h } = node;
  const sx = v => x + (v / 100) * w;
  const sy = v => y + (v / 100) * h;
  const common = `fill="${c.fill}" stroke="${c.stroke}" stroke-width="${c.strokeWidth}"` +
    (c.dash ? ` stroke-dasharray="${c.dash}"` : '') + ` stroke-linejoin="round"`;

  if (POLY[shape]) {
    const pts = POLY[shape].split(' ').map(p => {
      const [px, py] = p.split(',').map(Number);
      return `${sx(px)},${sy(py)}`;
    }).join(' ');
    return `<polygon points="${pts}" ${common} />`;
  }
  if (shape === 'document') {
    const d = `M ${sx(0)} ${sy(0)} L ${sx(100)} ${sy(0)} L ${sx(100)} ${sy(86)} ` +
      `C ${sx(78)} ${sy(99)} ${sx(64)} ${sy(99)} ${sx(50)} ${sy(88)} ` +
      `C ${sx(36)} ${sy(77)} ${sx(22)} ${sy(77)} ${sx(0)} ${sy(86)} Z`;
    return `<path d="${d}" ${common} />`;
  }
  if (shape === 'delay') {
    const r = h / 2;
    const d = `M ${x} ${y} L ${x + w - r} ${y} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} L ${x} ${y + h} Z`;
    return `<path d="${d}" ${common} />`;
  }
  if (shape === 'roundright') {
    const r = h / 2;
    const d = `M ${x} ${y} L ${x + w - r} ${y} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} L ${x} ${y + h} Z`;
    return `<path d="${d}" ${common} />`;
  }
  if (shape === 'pill') {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" ry="${h / 2}" ${common} />`;
  }
  if (shape === 'subprocess') {
    const bar1 = `<rect x="${x + 8}" y="${y + 7}" width="3" height="${h - 14}" rx="1.5" fill="${c.text}" opacity="0.5" />`;
    const bar2 = `<rect x="${x + w - 11}" y="${y + 7}" width="3" height="${h - 14}" rx="1.5" fill="${c.text}" opacity="0.5" />`;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" ry="8" ${common} />${bar1}${bar2}`;
  }
  // rect (default)
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" ry="8" ${common} />`;
}

// Very small word-wrapper so labels fit the shape width.
function wrapLines(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? cur + ' ' + word : word;
    if (test.length > maxChars && cur) { lines.push(cur); cur = word; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function nodeTextMarkup(node, c) {
  const { shape } = nodeView(node);
  const { x, y, w, h } = node;
  const inset = shape === 'diamond' ? 0.5 : (SVG_SHAPES.includes(shape) ? 0.75 : 1);
  const usableW = Math.max(40, w * inset - 28);
  const maxChars = Math.max(6, Math.floor(usableW / 6.3));
  const lines = wrapLines(node.text, maxChars);
  const fs = 12.5, lh = 16;
  const cx = x + w / 2;
  const totalH = lines.length * lh;
  let ty = y + h / 2 - totalH / 2 + lh - 4;
  const weight = shape === 'pill' ? 600 : 500;
  const tspans = lines.map((ln, i) =>
    `<text x="${cx}" y="${ty + i * lh}" font-size="${fs}" font-weight="${weight}" ` +
    `fill="${c.text}" text-anchor="middle" font-family="'Segoe UI',system-ui,sans-serif">${esc(ln)}</text>`
  ).join('');
  const idBadge = `<text x="${x + 10}" y="${y + 16}" font-size="11" font-weight="800" ` +
    `fill="${c.text}" opacity="0.85" font-family="'Segoe UI',system-ui,sans-serif">${esc(node.id)}</text>`;
  return idBadge + tspans;
}

/**
 * Build a standalone <svg> string of the whole diagram.
 * Returns { svg, width, height }.
 */
export function buildDiagramSvg(process, { padding = 24 } = {}) {
  const nodes = process.nodes || [];
  const lanes = process.lanes || [];
  const theme = process.theme || {};
  const laneAccent = asColorString(theme.lane) || PRIMARY;
  const edgeColor = asColorString(theme.edge) || PRIMARY;

  const contentRight = nodes.length ? Math.max(...nodes.map(n => (n.x || 0) + (n.w || 0))) : 400;
  const contentBottom = lanes.length ? Math.max(...lanes.map(l => (l.y || 0) + (l.h || 0)))
    : (nodes.length ? Math.max(...nodes.map(n => (n.y || 0) + (n.h || 0))) : 300);
  const W = Math.ceil(contentRight + padding);
  const H = Math.ceil(contentBottom + padding);

  // lanes (rail + row background)
  let laneSvg = '';
  lanes.forEach(l => {
    laneSvg += `<rect x="0" y="${l.y}" width="${W}" height="${l.h}" fill="none" stroke="#e3e9ee" stroke-width="1" />`;
    laneSvg += `<rect x="0" y="${l.y}" width="${RAIL_W}" height="${l.h}" fill="${LANE_BG}" stroke="${laneAccent}" stroke-width="1" />`;
    const label = String(l.label || '').split('\n');
    const midY = l.y + l.h / 2 - (label.length - 1) * 7;
    laneSvg += `<g transform="translate(${RAIL_W / 2}, ${midY}) rotate(-90)">` +
      label.map((ln, i) =>
        `<text x="0" y="${i * 14}" font-size="12" font-weight="700" fill="${LANE_TEXT}" ` +
        `text-anchor="middle" font-family="'Segoe UI',system-ui,sans-serif">${esc(ln)}</text>`
      ).join('') + `</g>`;
  });

  // edges (reuse the live router)
  const nodeMap = Object.fromEntries(nodes.map(n => [String(n.id), n]));
  const edgeOffsets = endpointOffsets(process);
  let edgeSvg = '';
  (process.edges || []).forEach((e, i) => {
    const from = nodeMap[String(e.from)], to = nodeMap[String(e.to)];
    if (!from || !to) return;
    const obstacles = nodes.filter(n => String(n.id) !== String(from.id) && String(n.id) !== String(to.id));
    const sSide = e.s || 'right', eSide = e.e || 'left';
    const eo = edgeOffsets[i] || { fromOff: 0, toOff: 0 };
    const { d, mid } = edgeGeometry(from, to, sSide, eSide, e.via, obstacles, eo.fromOff, eo.toOff);
    const col = asColorString(e.color) || edgeColor;
    const arrow = e.arrow || 'end';
    const ms = (arrow === 'start' || arrow === 'both') ? ` marker-start="url(#ax-${esc(col).replace(/[^a-z0-9]/gi, '')})"` : '';
    const me = (arrow === 'end' || arrow === 'both') ? ` marker-end="url(#ax-${esc(col).replace(/[^a-z0-9]/gi, '')})"` : '';
    const dash = e.dashed ? ` stroke-dasharray="5 5"` : '';
    edgeSvg += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${dash}${ms}${me} />`;
    if (e.label && String(e.label).trim()) {
      const lw = Math.max(22, String(e.label).length * 7 + 16);
      edgeSvg += `<rect x="${mid.x - lw / 2}" y="${mid.y - 11}" width="${lw}" height="22" rx="6" fill="#fff" stroke="${col}" />` +
        `<text x="${mid.x}" y="${mid.y}" font-size="11.5" fill="${TEXT_PRIMARY}" text-anchor="middle" ` +
        `dominant-baseline="central" font-family="'Segoe UI',system-ui,sans-serif">${esc(e.label)}</text>`;
    }
  });

  // one arrow marker per distinct edge colour
  const edgeCols = new Set();
  (process.edges || []).forEach(e => edgeCols.add(asColorString(e.color) || edgeColor));
  let markers = '';
  edgeCols.forEach(col => {
    const id = 'ax-' + esc(col).replace(/[^a-z0-9]/gi, '');
    markers += `<marker id="${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0.5 1 L 9 5 L 0.5 9 Z" fill="${col}" /></marker>`;
  });

  // nodes
  let nodeSvg = '';
  nodes.forEach(n => {
    const c = nodeColors(n, theme);
    nodeSvg += `<g>${shapeMarkup(n, c)}${nodeTextMarkup(n, c)}</g>`;
  });

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<defs>${markers}</defs>` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" />` +
    laneSvg + edgeSvg + nodeSvg +
    `</svg>`;
  return { svg, width: W, height: H };
}

/* ============================ PDF (print window) ============================ */
/**
 * Open a print window with the diagram laid out on a page, letting the user
 * "Save as PDF". orientation: 'landscape' | 'portrait'.
 */
export function exportDiagramToPdf(process, { orientation = 'landscape' } = {}) {
  const { svg } = buildDiagramSvg(process, { padding: 24 });
  const title = safeName(process.title);
  const win = window.open('', '_blank');
  if (!win) {
    alert('PDF pəncərəsi açıla bilmədi — brauzerin pop-up bloklamasını yoxlayın.');
    return;
  }
  const subtitle = process.subtitle ? ` — ${esc(process.subtitle)}` : '';
  win.document.write(
    `<!doctype html><html lang="az"><head><meta charset="utf-8"><title>${esc(process.title || 'Diaqram')}</title>` +
    `<style>` +
    `@page { size: A4 ${orientation}; margin: 12mm; }` +
    `* { box-sizing: border-box; }` +
    `body { margin: 0; font-family: 'Segoe UI', system-ui, sans-serif; color: #243f4f; }` +
    `.hd { display:flex; align-items:baseline; gap:8px; margin:0 0 10px; }` +
    `.hd h1 { font-size: 16px; margin:0; }` +
    `.hd .sub { font-size: 12px; color:#5b7280; }` +
    `.wrap { width:100%; }` +
    `.wrap svg { width:100%; height:auto; display:block; }` +
    `@media print { .noprint { display:none !important; } }` +
    `.bar { position:fixed; top:10px; right:10px; display:flex; gap:8px; }` +
    `.bar button { font:600 13px 'Segoe UI',sans-serif; padding:8px 14px; border-radius:8px; border:1px solid #cbd5e1; background:#fff; cursor:pointer; }` +
    `.bar button.p { background:#3a7894; color:#fff; border-color:#3a7894; }` +
    `</style></head><body>` +
    `<div class="bar noprint"><button class="p" onclick="window.print()">PDF kimi yadda saxla / Çap et</button>` +
    `<button onclick="window.close()">Bağla</button></div>` +
    `<div class="hd"><h1>${esc(process.title || 'Diaqram')}</h1><span class="sub">${subtitle}</span></div>` +
    `<div class="wrap">${svg}</div>` +
    `<script>window.onload=function(){setTimeout(function(){try{window.focus();}catch(e){}},150);};<\/script>` +
    `</body></html>`
  );
  win.document.close();
}
/* ============================ several diagrams ============================ */
/** One JSON file holding several diagrams (e.g. a whole folder). */
export function exportDiagramsToJson(processes, { name = 'diaqramlar', group = '' } = {}) {
  const data = {
    group: group || undefined,
    exportedAt: new Date().toISOString(),
    count: processes.length,
    diagrams: processes.map((p) => ({
      id: p.id,
      title: p.title || '',
      subtitle: p.subtitle || '',
      status: p.status || undefined,
      width: p.width || 1200,
      height: p.height || 600,
      theme: p.theme || undefined,
      lanes: p.lanes || [],
      nodes: p.nodes || [],
      edges: p.edges || []
    }))
  };
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${safeName(name)}.json`);
}

/** One print window, one diagram per page -> "Save as PDF". */
export function exportDiagramsToPdf(processes, { orientation = 'landscape', name = 'Diaqramlar', win: openedWin = null } = {}) {
  const win = openedWin || window.open('', '_blank');
  if (!win) {
    alert('PDF pəncərəsi açıla bilmədi — brauzerin pop-up bloklamasını yoxlayın.');
    return;
  }
  const pages = processes.map((p) => {
    const { svg } = buildDiagramSvg(p, { padding: 24 });
    const sub = p.subtitle ? `<span class="sub">${esc(p.subtitle)}</span>` : '';
    return `<section class="pg"><div class="hd"><h1>${esc(p.title || 'Diaqram')}</h1>${sub}</div><div class="wrap">${svg}</div></section>`;
  }).join('');
  win.document.write(
    `<!doctype html><html lang="az"><head><meta charset="utf-8"><title>${esc(name)}</title>` +
    `<style>` +
    `@page { size: A4 ${orientation}; margin: 12mm; }` +
    `* { box-sizing: border-box; }` +
    `body { margin: 0; font-family: 'Segoe UI', system-ui, sans-serif; color: #243f4f; }` +
    `.pg { page-break-after: always; break-after: page; padding: 8px 0; }` +
    `.pg:last-child { page-break-after: auto; break-after: auto; }` +
    `.hd { display:flex; align-items:baseline; gap:8px; margin:0 0 10px; }` +
    `.hd h1 { font-size: 16px; margin:0; }` +
    `.hd .sub { font-size: 12px; color:#5b7280; }` +
    `.wrap svg { width:100%; height:auto; max-height: ${orientation === 'portrait' ? '250mm' : '165mm'}; display:block; }` +
    `@media print { .noprint { display:none !important; } }` +
    `@media screen { .pg { border-bottom: 2px dashed #cbd5e1; margin: 0 16px 24px; } }` +
    `.bar { position:sticky; top:0; display:flex; gap:8px; justify-content:flex-end; padding:10px 16px; background:#fff; z-index:2; }` +
    `.bar span { margin-right:auto; font: 600 13px 'Segoe UI',sans-serif; color:#5b7280; align-self:center; }` +
    `.bar button { font:600 13px 'Segoe UI',sans-serif; padding:8px 14px; border-radius:8px; border:1px solid #cbd5e1; background:#fff; cursor:pointer; }` +
    `.bar button.p { background:#3a7894; color:#fff; border-color:#3a7894; }` +
    `</style></head><body>` +
    `<div class="bar noprint"><span>${esc(name)} · ${processes.length} diaqram</span><button class="p" onclick="window.print()">PDF kimi yadda saxla / Çap et</button>` +
    `<button onclick="window.close()">Bağla</button></div>` +
    pages +
    `</body></html>`
  );
  win.document.close();
  try { win.focus(); } catch { /* ignore */ }
}
