// aiBuild.js
// The model describes a process in plain terms (lanes, steps, arrows). It never
// writes coordinates — geometry is our job, not the LLM's. This module turns a
// SPEC into the exact { lanes, nodes, edges } shape that
// data/diagrams/processes/process-<id>.json expects.

import { SHAPES, STYLES, nodeDefaults } from '../nodeStyle.js';
import { autoNodeHeight } from '../nodeMeasure.js';
import { repackLanes, laneLabelMinH } from '../laneRepack.js';
import { edgePoints, anchor, endpointOffsets } from '../DiagramCanvas.jsx';
import { routeEdges, layoutScore } from './aiRoute.js';

const START_X = 85;    // clears the 56px left rail, matches hand-made diagrams
const COL_GAP = 70;
const ROW_GAP = 20;
const LANE_TOP_PAD = 30;
const MIN_W = 2200;    // same defaults the "Yeni diaqram" flow uses
const MIN_H = 900;

export function safeShape(s) {
  const v = String(s || '').toLowerCase();
  if (SHAPES.includes(v)) return v;
  // tolerate a few names the model reaches for
  if (v === 'rectangle' || v === 'process' || v === 'step') return 'rect';
  if (v === 'decision' || v === 'romb') return 'diamond';
  if (v === 'start' || v === 'end' || v === 'terminator') return 'pill';
  if (v === 'data' || v === 'io' || v === 'input' || v === 'output') return 'parallelogram';
  if (v === 'circle' || v === 'stop' || v === 'finish') return 'pill';
  if (v === 'predefined' || v === 'predefined-process' || v === 'subroutine' || v === 'sub-process') return 'subprocess';
  if (v === 'manual' || v === 'manual-input') return 'manualinput';
  if (v === 'doc' || v === 'documents') return 'document';
  if (v === 'wait') return 'delay';
  if (v === 'connector' || v === 'offpage' || v === 'off-page' || v === 'pentagon' || v === 'merge') return 'triangledown';
  return 'rect';
}
export function safeStyle(s) {
  const v = String(s || '').toLowerCase();
  return STYLES.includes(v) ? v : 'solid';
}
function cleanList(v) {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x || '').trim()).filter(Boolean);
}

function buildInfo(specNode) {
  const general = cleanList(specNode.general ?? specNode.info?.general);
  const risks = cleanList(specNode.risks ?? specNode.info?.risks);
  const info = { general: general.length ? general : [''] };
  if (risks.length) info.risks = risks;
  return info;
}

/**
 * Column per node = longest path from any root, so branches fan out to the
 * right instead of piling on top of each other. Cycles are broken by the
 * iteration cap rather than hanging.
 */
function assignColumns(refs, edges) {
  const col = new Map(refs.map(r => [r, 0]));
  const incoming = new Map(refs.map(r => [r, []]));
  edges.forEach(e => {
    if (incoming.has(e.to) && col.has(e.from)) incoming.get(e.to).push(e.from);
  });

  for (let pass = 0; pass < refs.length + 2; pass++) {
    let moved = false;
    for (const r of refs) {
      const preds = incoming.get(r) || [];
      if (!preds.length) continue;
      const want = Math.max(...preds.map(p => col.get(p) ?? 0)) + 1;
      if (want > (col.get(r) ?? 0)) { col.set(r, want); moved = true; }
    }
    if (!moved) break;
  }
  return col;
}

/**
 * spec: {
 *   lanes: [{ label }],
 *   nodes: [{ id?, ref?, lane, col?, row?, shape, style, text, general[], risks[] }],
 *   edges: [{ from, to, s?, e?, dashed, label }]
 * }
 * Returns { lanes, nodes, edges, width, height } ready to drop into a process.
 *
 * Two layouts:
 *   GRID  — any node has `col`. Used when copying a document: every box keeps
 *           the column/row it had on paper, lanes grow to fit their rows, arrows
 *           use the sides the document used. This is how the hand-made
 *           diagrams (e.g. diagram-55) are laid out.
 *   AUTO  — no positions given: columns from the longest path (new diagrams).
 *
 * Node ids follow the hand-made diagrams: the document's step number IS the id
 * (1, 2, "5.1", "A.2"), and the text does not repeat it.
 */
const PORTS = ['top', 'right', 'bottom', 'left'];
const GRID = {
  startX: 110,      // clears the lane rail and leaves a gutter for arrows
  colGap: 90,       // room for vertical runs between columns
  laneTop: 20,
  lanePadTop: 40,
  lanePadBottom: 40,
  rowGap: 60,       // room for horizontal runs between rows
  laneMinH: 160
};

function normId(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/[.)]$/, '');
  if (!s) return null;
  return /^\d+$/.test(s) ? Number(s) : s;
}

// "5.1 Vaqonların ..." with id "5.1" -> "Vaqonların ..."
function stripNumber(text, id) {
  const t = String(text || '').trim();
  if (id === null || id === undefined) return t;
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return t.replace(new RegExp(`^${esc}[.)]?\\s+`), '').trim() || t;
}

function widthFor(shape, style, text) {
  const len = String(text || '').length;
  let w;
  switch (shape) {
    case 'pill': w = 260; break;
    case 'diamond': return 160;
    case 'parallelogram': w = 280; break;
    case 'subprocess': w = 260; break;
    case 'triangledown': return 120;
    default: w = style === 'solid' ? 240 : 260;
  }
  if (len > 110) w += 40;
  if (len > 180) w += 40;
  return w;
}

function measure(shape, style, w, text) {
  const def = nodeDefaults(shape);
  if (shape === 'triangledown') return { w: 120, h: 90 };
  let h = def.h;
  try { h = autoNodeHeight({ type: shape, style, w }, text); } catch { /* no DOM */ }
  if (shape === 'diamond') h = Math.max(h, 150);
  return { w, h: Math.max(h, def.h) };
}

// The same spec is built several times (preview picture, self-check, popup,
// final create) and the layout search takes a moment — remember results.
const buildCache = new Map();
export function buildFromSpec(spec) {
  let key = null;
  try { key = JSON.stringify(spec); } catch { /* not cacheable */ }
  if (key && buildCache.has(key)) return JSON.parse(buildCache.get(key));
  const out = buildFromSpecRaw(spec);
  if (key) {
    buildCache.set(key, JSON.stringify(out));
    if (buildCache.size > 12) buildCache.delete(buildCache.keys().next().value);
  }
  return out;
}

function buildFromSpecRaw(spec) {
  const specLanes = Array.isArray(spec?.lanes) && spec.lanes.length
    ? spec.lanes
    : [{ label: 'Proses' }];
  const specNodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const specEdges = Array.isArray(spec?.edges) ? spec.edges : [];

  const base = Date.now();
  const lanes = specLanes.map((l, i) => ({
    id: `lane-${base}-${i}`,
    label: String((typeof l === 'string' ? l : l?.label) || `Panel ${i + 1}`),
    y: 20 + i * 160,
    h: 160
  }));

  if (!specNodes.length) {
    return { lanes, nodes: [], edges: [], width: MIN_W, height: MIN_H };
  }

  /* ---------- ids: document number when given, otherwise 1..n ---------- */
  const used = new Set();
  const wanted = specNodes.map(n => normId(n?.id ?? n?.num ?? n?.number));
  const finalIds = wanted.map(w => {
    if (w === null) return null;
    if (used.has(String(w))) return null;
    used.add(String(w));
    return w;
  });
  let nextInt = 1;
  for (let i = 0; i < finalIds.length; i++) {
    if (finalIds[i] !== null) continue;
    while (used.has(String(nextInt))) nextInt++;
    finalIds[i] = nextInt;
    used.add(String(nextInt));
  }
  // edges may point at a node by its ref, its id, or its index
  const lookup = new Map();
  specNodes.forEach((n, i) => {
    const id = finalIds[i];
    if (n?.ref != null) lookup.set(String(n.ref), id);
    if (wanted[i] !== null) lookup.set(String(wanted[i]), id);
    lookup.set(String(id), id);
  });
  const resolve = v => (v == null ? undefined : lookup.get(String(normId(v) ?? v)) ?? lookup.get(String(v)));

  const edgeRefs = specEdges
    .map(e => ({
      from: resolve(e?.from),
      to: resolve(e?.to),
      s: PORTS.includes(e?.s) ? e.s : null,
      e: PORTS.includes(e?.e) ? e.e : null,
      dashed: !!e?.dashed,
      label: e?.label ? String(e.label) : ''
    }))
    .filter(e => e.from !== undefined && e.to !== undefined && String(e.from) !== String(e.to));

  const grid = specNodes.some(n => n?.col !== undefined && n?.col !== null && n?.col !== '');

  /* ---------- size each node ---------- */
  const draft = specNodes.map((n, i) => {
    const shape = safeShape(n.shape ?? n.type);
    const style = safeStyle(n.style);
    const id = finalIds[i];
    const text = stripNumber(n.text, wanted[i]) || 'Yeni addım';
    const w = grid ? widthFor(shape, style, text) : nodeDefaults(shape).w;
    const { h } = grid ? measure(shape, style, w, text) : { h: (() => {
      try { return autoNodeHeight({ type: shape, style, w }, text); } catch { return nodeDefaults(shape).h; }
    })() };
    const laneIdx = Math.min(Math.max(parseInt(n.lane, 10) || 1, 1), lanes.length) - 1;
    return {
      id, shape, style, text, w, h, laneIdx,
      col: Math.max(0, parseInt(n.col, 10) || 0),
      row: Math.max(0, parseInt(n.row, 10) || 0),
      info: buildInfo(n)
    };
  });

  let nodes;
  let outLanes;

  if (grid) {
    /* ---------- GRID: positions as on paper ---------- */
    // two boxes in the same lane+col+row -> push the later one a row down
    const taken = new Set();
    for (const d of draft) {
      while (taken.has(`${d.laneIdx}:${d.col}:${d.row}`)) d.row++;
      taken.add(`${d.laneIdx}:${d.col}:${d.row}`);
    }
    draft.forEach(d => { d.w0 = d.w; d.h0 = d.h; d.col0 = d.col; d.row0 = d.row; });

    // cells: [{ col, row }] per draft index → placed nodes + lanes
    const place = (cells) => {
      const ds = draft.map((d, i) => ({ ...d, col: cells[i].col, row: cells[i].row, w: d.w0, h: d.h0 }));
      // drop empty columns so moving a block never leaves a hole
      const usedCols = [...new Set(ds.map(d => d.col))].sort((x, y) => x - y);
      const remap = new Map(usedCols.map((c, k) => [c, k]));
      ds.forEach(d => { d.col = remap.get(d.col); });
      const maxCol = Math.max(...ds.map(d => d.col));
      const colW = Array.from({ length: maxCol + 1 }, (_, c) => {
        const inCol = ds.filter(d => d.col === c);
        return inCol.length ? Math.max(...inCol.map(d => d.w)) : 120;
      });
      // Same column → same width, so box edges line up and arrows run in clean gutters.
      for (const d of ds) {
        if (d.shape === 'diamond' || d.shape === 'triangledown') continue;
        if (d.w !== colW[d.col]) { d.w = colW[d.col]; d.h = measure(d.shape, d.style, d.w, d.text).h; }
      }
      const colX = [];
      let cx = GRID.startX;
      for (let c = 0; c <= maxCol; c++) { colX[c] = cx; cx += colW[c] + GRID.colGap; }
      const rowH = lanes.map((_, li) => {
        const inLane = ds.filter(d => d.laneIdx === li);
        const maxRow = inLane.length ? Math.max(...inLane.map(d => d.row)) : -1;
        return Array.from({ length: maxRow + 1 }, (_, r) => {
          const inRow = inLane.filter(d => d.row === r);
          return inRow.length ? Math.max(...inRow.map(d => d.h)) : 0;
        });
      });
      let y = GRID.laneTop;
      const ls = lanes.map((l, li) => {
        const used = rowH[li].filter(h => h > 0);
        const content = used.reduce((t, h) => t + h, 0) + Math.max(0, used.length - 1) * GRID.rowGap;
        const h = Math.max(GRID.laneMinH, laneLabelMinH(l.label), GRID.lanePadTop + content + GRID.lanePadBottom);
        const lane = { ...l, y, h };
        y += h;
        return lane;
      });
      const ns = ds.map(d => {
        const lane = ls[d.laneIdx];
        const rows = rowH[d.laneIdx];
        let top = lane.y + GRID.lanePadTop;
        for (let r = 0; r < d.row; r++) if (rows[r] > 0) top += rows[r] + GRID.rowGap;
        return {
          id: d.id, type: d.shape, style: d.style,
          x: Math.round(colX[d.col] + (colW[d.col] - d.w) / 2), y: Math.round(top + (rows[d.row] - d.h) / 2),
          laneId: lane.id, w: d.w, h: d.h, text: d.text, info: d.info
        };
      });
      return { nodes: ns, lanes: ls };
    };

    // ---- layout search: move boxes instead of bending arrows around them ----
    const idx = new Map(draft.map((d, i) => [String(d.id), i]));
    const links = edgeRefs.map(e => [idx.get(String(e.from)), idx.get(String(e.to))]).filter(([u, v]) => u !== undefined && v !== undefined);
    const evaluate = (cells) => {
      const pl = place(cells);
      const byId = new Map(pl.nodes.map(n => [String(n.id), n]));
      const pairs = edgeRefs.map(e => ({ a: byId.get(String(e.from)), b: byId.get(String(e.to)), docS: e.s, docE: e.e }))
        .filter(p => p.a && p.b);
      let q;
      try { q = layoutScore(pl.nodes, pairs); } catch { q = { score: Infinity, crossings: 99, crossPairs: [] }; }
      // staying close to the document still matters a little
      const moved = cells.reduce((t, c, i) => t + (c.col !== draft[i].col0 || c.row !== draft[i].row0 ? 1 : 0), 0);
      // a wider diagram is harder to read and drifts from the paper layout
      const width = Math.max(...pl.nodes.map(n => n.x + n.w));
      return { ...q, score: q.score + moved * 12 + width / 6, cells, pl };
    };
    const free = (cells, li, col, row, ignore) => !cells.some((c, k) => !ignore.has(k) && draft[k].laneIdx === li && c.col === col && c.row === row);

    let best = evaluate(draft.map(d => ({ col: d.col, row: d.row })));
    const started = Date.now();
    for (let round = 0; round < 3 && Date.now() - started < 6000; round++) {
      let improved = false;
      const cands = [];
      // (a) an arrow that jumps back LEFT into a lower row: put that whole
      //     downstream group under its source (10 → 11 · 12 · 13)
      for (const [u, v] of links) {
        const cu = best.cells[u], cv = best.cells[v];
        const below = draft[v].laneIdx > draft[u].laneIdx || (draft[v].laneIdx === draft[u].laneIdx && cv.row > cu.row);
        if (!below || cv.col >= cu.col) continue;
        const shift = cu.col - cv.col;
        const block = new Set([v]);
        const queue = [v];
        while (queue.length) {
          const x = queue.shift();
          for (const [a, b] of links) {
            if (a !== x || block.has(b) || b === u) continue;
            const cb = best.cells[b];
            const lowerBand = draft[b].laneIdx > draft[u].laneIdx || (draft[b].laneIdx === draft[u].laneIdx && cb.row > cu.row);
            if (lowerBand && cb.col >= cv.col) { block.add(b); queue.push(b); }
          }
        }
        const cells = best.cells.map(c => ({ ...c }));
        let ok = true;
        for (const k of block) {
          const nc = cells[k].col + shift;
          if (!free(best.cells, draft[k].laneIdx, nc, cells[k].row, block)) { ok = false; break; }
          cells[k].col = nc;
        }
        if (ok) cands.push(cells);
      }
      // (b) boxes on crossing arrows: try every free spot in their own lane
      if (best.crossings) {
        const involved = new Set();
        (best.crossPairs || []).forEach(([i, j]) => {
          [edgeRefs[i], edgeRefs[j]].forEach(e => {
            if (!e) return;
            [idx.get(String(e.from)), idx.get(String(e.to))].forEach(k => { if (k !== undefined) involved.add(k); });
          });
        });
        const maxCol = Math.max(...best.cells.map(c => c.col));
        for (const k of involved) {
          const li = draft[k].laneIdx;
          const maxRow = Math.max(0, ...best.cells.filter((c, j) => draft[j].laneIdx === li).map(c => c.row));
          for (let col = 0; col <= maxCol + 1; col++) for (let row = 0; row <= maxRow + 1; row++) {
            if (col === best.cells[k].col && row === best.cells[k].row) continue;
            if (!free(best.cells, li, col, row, new Set([k]))) continue;
            const cells = best.cells.map(c => ({ ...c }));
            cells[k] = { col, row };
            cands.push(cells);
          }
        }
      }
      for (const cells of cands) {
        if (Date.now() - started > 6000) break;
        const r = evaluate(cells);
        if (r.score < best.score - 1) { best = r; improved = true; }
      }
      if (!improved) break;
    }
    nodes = best.pl.nodes;
    outLanes = best.pl.lanes;
  } else {
    /* ---------- AUTO: columns from the longest path ---------- */
    const keys = draft.map(d => String(d.id));
    const colByKey = assignColumns(keys, edgeRefs.map(e => ({ from: String(e.from), to: String(e.to) })));
    draft.forEach(d => { d.col = colByKey.get(String(d.id)) ?? 0; });

    const maxCol = Math.max(...draft.map(d => d.col));
    const colW = [];
    for (let c = 0; c <= maxCol; c++) {
      const inCol = draft.filter(d => d.col === c);
      colW[c] = inCol.length ? Math.max(...inCol.map(d => d.w)) : 200;
    }
    const colX = [];
    let cursor = START_X;
    for (let c = 0; c <= maxCol; c++) { colX[c] = cursor; cursor += colW[c] + COL_GAP; }

    // several nodes in one lane+column stack down — by their REAL heights,
    // so a tall box never overlaps the next one
    const stackY = new Map();
    const placed = draft.map(d => {
      const key = `${d.laneIdx}:${d.col}`;
      const lane = lanes[d.laneIdx];
      const yTop = stackY.has(key) ? stackY.get(key) : lane.y + LANE_TOP_PAD;
      stackY.set(key, yTop + d.h + ROW_GAP);
      return {
        id: d.id, type: d.shape, style: d.style,
        x: Math.round(colX[d.col] + (colW[d.col] - d.w) / 2), y: Math.round(yTop),
        laneId: lane.id, w: d.w, h: d.h, text: d.text, info: d.info
      };
    });
    const packed = repackLanes(lanes, placed);
    nodes = packed.nodes;
    outLanes = packed.lanes;
  }

  /* ---------- edges: sides chosen by the route they really produce ---------- */
  const byId = new Map(nodes.map(n => [String(n.id), n]));
  const pairs = edgeRefs.map(e => ({ e, a: byId.get(String(e.from)), b: byId.get(String(e.to)) }));
  // Real router first (clean paths through the gaps, saved as bend points);
  // anything it can't place falls back to the canvas' own routing.
  let routed = [];
  try {
    routed = routeEdges(nodes, pairs.map(({ e, a, b }) => ({ a, b, docS: e.s, docE: e.e })));
  } catch (err) {
    console.warn('[ai] router failed, using canvas routing', err);
  }
  const fallback = routed.every(Boolean) ? null : untangle(nodes, pairs);
  const edges = pairs.map(({ e, a, b }, i) => {
    const r = routed[i];
    const edge = r
      ? { from: a.id, to: b.id, s: r.s, e: r.t, dashed: e.dashed }
      : { from: a.id, to: b.id, s: fallback[i].s, e: fallback[i].t, dashed: e.dashed };
    if (r?.via) { edge.via = r.via; edge.viaFor = r.viaFor; }
    if (e.label) edge.label = e.label;
    return edge;
  });

  const right = Math.max(...nodes.map(n => n.x + n.w));
  const bottom = Math.max(...outLanes.map(l => l.y + l.h));

  return {
    lanes: outLanes,
    nodes,
    edges,
    width: Math.max(MIN_W, right + 200),
    height: Math.max(MIN_H, bottom + 40)
  };
}


/* ------------------------------------------------------------------ *
 * Untangling
 * ------------------------------------------------------------------ *
 * Every arrow is routed with the canvas' OWN router (edgePoints) for all 16
 * side combinations, and the one that draws the cleanest line wins: no line
 * through a box, as few crossings / shared runs with other arrows as
 * possible, few bends, short. The side the document used gets a small bonus
 * so the result still looks like the paper version. Two passes, so arrows
 * placed early get re-checked against the ones placed after them.
 */
const SIDES4 = ['right', 'bottom', 'left', 'top'];

function segs(pts) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    if (Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5) continue;
    out.push([p, q]);
  }
  return out;
}
function cross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}
// length two axis-parallel segments run on top of each other
function overlapLen([a, b], [c, d]) {
  const H = s => Math.abs(s[0].y - s[1].y) < 0.5, V = s => Math.abs(s[0].x - s[1].x) < 0.5;
  if (H([a, b]) && H([c, d]) && Math.abs(a.y - c.y) < 6) {
    return Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)));
  }
  if (V([a, b]) && V([c, d]) && Math.abs(a.x - c.x) < 6) {
    return Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)));
  }
  return 0;
}
function hitsBox(p, q, n, m = 6) {
  const x1 = n.x - m, y1 = n.y - m, x2 = n.x + n.w + m, y2 = n.y + n.h + m;
  if (Math.abs(p.y - q.y) < 0.5) {
    if (p.y <= y1 || p.y >= y2) return false;
    return Math.max(p.x, q.x) > x1 && Math.min(p.x, q.x) < x2;
  }
  if (Math.abs(p.x - q.x) < 0.5) {
    if (p.x <= x1 || p.x >= x2) return false;
    return Math.max(p.y, q.y) > y1 && Math.min(p.y, q.y) < y2;
  }
  return false;
}

function routeScore(pts, a, b, nodes, others, s, t, offs = {}) {
  const ss = segs(pts);
  let score = 0;
  // A path that no longer starts/ends on its boxes draws a broken line.
  const A = anchor(a, s, offs.fromOff || 0), B = anchor(b, t, offs.toOff || 0);
  const first = pts[0], last = pts[pts.length - 1];
  if (!first || !last || Math.hypot(first.x - A.x, first.y - A.y) > 3 || Math.hypot(last.x - B.x, last.y - B.y) > 3) return 1e6;
  // slanted segments never look right on this canvas
  for (const [p, q] of ss) if (Math.abs(p.x - q.x) > 0.5 && Math.abs(p.y - q.y) > 0.5) return 1e5;
  // same-side U-turns (left→left, top→top…) read as a loop
  if (s === t) score += 25;
  let len = 0;
  for (const [p, q] of ss) len += Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
  score += len / 40 + Math.max(0, ss.length - 1) * 15;
  // lines through boxes (endpoints' own boxes excepted)
  for (const n of nodes) {
    if (n === a || n === b) continue;
    for (const [p, q] of ss) if (hitsBox(p, q, n)) { score += 400; break; }
  }
  // the first/last segment must not run back through its own box
  if (ss.length > 2) {
    for (const [p, q] of ss.slice(1, -1)) {
      if (hitsBox(p, q, a, 2) || hitsBox(p, q, b, 2)) { score += 300; break; }
    }
  }
  for (const o of others) {
    for (const s1 of ss) for (const s2 of o) {
      if (cross(s1[0], s1[1], s2[0], s2[1])) score += 45;
      const ov = overlapLen(s1, s2);
      if (ov > 8) score += 30 + ov / 10;
    }
  }
  // a route much longer than the straight distance is a loop-around
  const direct = Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) + Math.abs((a.y + a.h / 2) - (b.y + b.h / 2));
  if (len > direct * 1.9 + 120) score += (len - direct) / 12;
  return score;
}

function untangle(nodes, pairs) {
  const obstacles = pair => nodes.filter(n => n !== pair.a && n !== pair.b);
  // The canvas fans out arrows that share a side (endpointOffsets) — score
  // the route it will REALLY draw, offsets included.
  const proc = { nodes, edges: [] };
  const offsetsFor = (i, s, t) => {
    proc.edges = pairs.map((pr, j) => ({ from: pr.a.id, to: pr.b.id, s: j === i ? s : pick[j].s, e: j === i ? t : pick[j].t }));
    try { return endpointOffsets(proc)[i] || { fromOff: 0, toOff: 0 }; } catch { return { fromOff: 0, toOff: 0 }; }
  };
  const route = (pair, s, t, off = { fromOff: 0, toOff: 0 }) => {
    try { return edgePoints(pair.a, pair.b, s, t, null, obstacles(pair), off.fromOff, off.toOff); } catch { return null; }
  };
  // starting point: document sides when they still point the right way, else geometry
  const pick = pairs.map(({ e, a, b }) => {
    let s = e.s, t = e.e;
    const backwards =
      (s === 'right' && b.x < a.x + a.w) || (s === 'left' && b.x + b.w > a.x) ||
      (s === 'bottom' && b.y < a.y + a.h) || (s === 'top' && b.y + b.h > a.y);
    if (!s || !t || backwards) {
      if (b.y >= a.y + a.h) { s = 'bottom'; t = 'top'; }
      else if (b.y + b.h <= a.y) { s = 'top'; t = 'bottom'; }
      else { const auto = portsFor(a, b); s = auto.s; t = auto.t; }
    }
    return { s, t, doc: e.s && e.e && !backwards ? `${e.s}:${e.e}` : null };
  });
  const paths = pick.map((p, i) => route(pairs[i], p.s, p.t, offsetsFor(i, p.s, p.t)) || []);

  for (let pass = 0; pass < 3; pass++) {
    pairs.forEach((pair, i) => {
      const others = paths.filter((_, j) => j !== i).map(segs);
      let best = null;
      for (const s of SIDES4) for (const t of SIDES4) {
        const off = offsetsFor(i, s, t);
        const pts = route(pair, s, t, off);
        if (!pts) continue;
        let sc = routeScore(pts, pair.a, pair.b, nodes, others, s, t, off);
        if (pick[i].doc === `${s}:${t}`) sc -= (s === t ? 37 : 12);  // stay close to the paper
        if (s === pick[i].s && t === pick[i].t) sc -= 4;              // mild stickiness
        if (!best || sc < best.sc) best = { s, t, pts, sc };
      }
      if (best) { pick[i].s = best.s; pick[i].t = best.t; paths[i] = best.pts; }
    });
    // offsets depend on everyone's sides — refresh all paths after a pass
    pairs.forEach((pair, i) => { paths[i] = route(pair, pick[i].s, pick[i].t, offsetsFor(i, pick[i].s, pick[i].t)) || paths[i]; });
  }
  return pick;
}

/** Pick the pair of sides that gives the shortest, least-crossing arrow. */
export function portsFor(a, b) {
  if (!a || !b) return { s: 'right', t: 'left' };
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  const dx = bcx - acx, dy = bcy - acy;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { s: 'right', t: 'left' } : { s: 'left', t: 'right' };
  }
  return dy >= 0 ? { s: 'bottom', t: 'top' } : { s: 'top', t: 'bottom' };
}

/** Next free numeric node id — mirrors Diagram.jsx's nextNodeId. */
export function nextNodeId(nodes) {
  const used = new Set((nodes || []).map(n => String(n.id)));
  let n = 1;
  while (used.has(String(n))) n++;
  return n;
}

/** Resolve a lane by id, exact label, or fuzzy label; null if nothing matches. */
export function findLane(lanes, needle) {
  if (!lanes?.length) return null;
  if (needle == null || needle === '') return lanes[0];
  const s = String(needle).trim().toLowerCase();
  return lanes.find(l => String(l.id).toLowerCase() === s)
    || lanes.find(l => String(l.label || '').toLowerCase() === s)
    || lanes.find(l => String(l.label || '').toLowerCase().includes(s))
    || null;
}
