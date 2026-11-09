// aiRoute.js
// Orthogonal arrow router for diagrams the assistant builds.
//
// The canvas' own router (DiagramCanvas.pathPoints + avoidObstacles) only
// knows ONE corridor per arrow and pushes it around whatever is in the way,
// which is what drew arrows looping around boxes. Here every arrow is routed
// the way a person would draw it: through the free gaps between boxes, with
// as few bends as possible, not crossing or running on top of other arrows,
// centred in the gap. The result is saved as the edge's `via` bend points —
// the same field the canvas already uses for hand-placed bends — so the
// canvas draws exactly this path.
//
// `viaFor` stores where the two boxes were when the path was made. If the
// admin later moves one of them, the canvas ignores the stale bends and falls
// back to automatic routing for that arrow (see effectiveVia in DiagramCanvas).

import { anchor, endpointOffsets } from '../DiagramCanvas.jsx';

const STUB = 12;        // must match DiagramCanvas
const CLEAR = 14;       // gap kept between a line and any box
const BEND = 40;        // cost of one bend (in px of length)
const SHORT_RUN = 36;   // a turn after less than this many px reads as a "bump"
const BUMP = 90;        // …and costs this much
const CROSS = 320;      // crossing another arrow (avoid unless there is no other way)
const ENDZONE = 1400;   // passing through another arrow's start / arrowhead
const OVERLAP = 3;      // per px running on top of another arrow
const NEAR = 1.2;       // per px running closer than 18px to another arrow
const HUG = 1.5;       // per px running right along a box edge instead of mid-gap
const SIDES = ['top', 'right', 'bottom', 'left'];
const DIRV = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };

export function viaSignature(a, b, s, t) {
  const r = n => `${Math.round(n.x)},${Math.round(n.y)},${Math.round(n.w)},${Math.round(n.h)}`;
  return `${r(a)}|${r(b)}|${s}|${t}`;
}

// Searches start/end just OUTSIDE the clearance around the box (the canvas'
// own 12px stub is inside it); the point is collinear with the stub, so the
// canvas still draws a straight exit.
const EXT = CLEAR + 4;
function stubOf(node, side, off, dist = EXT) {
  const p = anchor(node, side, off || 0);
  const [dx, dy] = DIRV[side];
  return { x: Math.round(p.x + dx * dist), y: Math.round(p.y + dy * dist), anchor: p };
}

/* ---------------- tiny binary heap ---------------- */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a; a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/* ---------------- geometry helpers ---------------- */
// The 56px lane-name strip on the left is drawn ON TOP of the arrows, so a
// line routed there would be invisible — treat it as a wall.
const RAIL_EDGE = 56 + 10;
function boxesOf(nodes) {
  return [
    { x1: -1e5, y1: -1e5, x2: RAIL_EDGE, y2: 1e5, id: '__rail' },
    ...nodes.map(n => ({ x1: n.x - CLEAR, y1: n.y - CLEAR, x2: n.x + n.w + CLEAR, y2: n.y + n.h + CLEAR, id: String(n.id) }))
  ];
}
function inside(x, y, b) { return x > b.x1 && x < b.x2 && y > b.y1 && y < b.y2; }
function segBlocked(x1, y1, x2, y2, boxes) {
  for (const b of boxes) {
    if (y1 === y2) {
      if (y1 <= b.y1 || y1 >= b.y2) continue;
      if (Math.max(x1, x2) > b.x1 && Math.min(x1, x2) < b.x2) return true;
    } else {
      if (x1 <= b.x1 || x1 >= b.x2) continue;
      if (Math.max(y1, y2) > b.y1 && Math.min(y1, y2) < b.y2) return true;
    }
  }
  return false;
}
function uniqSorted(vals) {
  const s = [...new Set(vals.map(v => Math.round(v)))].sort((a, b) => a - b);
  return s;
}

// Each arrow's last/first 28px (arrowhead + stub) is reserved: no other line
// may run through it, otherwise two arrows look joined.
function endZones(pairs, sides, offs) {
  const z = [];
  pairs.forEach((p, i) => {
    const sd = sides[i];
    if (!sd) return;
    const o = offs[i] || {};
    [[p.a, sd.s, o.fromOff], [p.b, sd.t, o.toOff]].forEach(([n, side, off]) => {
      const a = anchor(n, side, off || 0);
      const [dx, dy] = DIRV[side];
      const L = 30, W = 9;
      const x1 = Math.min(a.x, a.x + dx * L) - (dx ? 0 : W), x2 = Math.max(a.x, a.x + dx * L) + (dx ? 0 : W);
      const y1 = Math.min(a.y, a.y + dy * L) - (dy ? 0 : W), y2 = Math.max(a.y, a.y + dy * L) + (dy ? 0 : W);
      z.push({ x1, y1, x2, y2, edge: i });
    });
  });
  return z;
}
function zoneCost(x1, y1, x2, y2, zones, self) {
  let c = 0;
  for (const z of zones) {
    if (z.edge === self) continue;
    if (y1 === y2) {
      if (y1 > z.y1 && y1 < z.y2 && Math.max(x1, x2) > z.x1 && Math.min(x1, x2) < z.x2) c += ENDZONE;
    } else if (x1 > z.x1 && x1 < z.x2 && Math.max(y1, y2) > z.y1 && Math.min(y1, y2) < z.y2) c += ENDZONE;
  }
  return c;
}

/* Penalty of a candidate move against arrows already placed. */
function trafficCost(x1, y1, x2, y2, placed) {
  let c = 0;
  const horiz = y1 === y2;
  const lo = horiz ? Math.min(x1, x2) : Math.min(y1, y2);
  const hi = horiz ? Math.max(x1, x2) : Math.max(y1, y2);
  for (const s of placed) {
    if (s.h === horiz) {
      const gap = Math.abs(s.c - (horiz ? y1 : x1));
      if (gap < 18) {
        const ov = Math.min(hi, s.hi) - Math.max(lo, s.lo);
        // on top of each other = very bad; just running too close = bad
        if (ov > 0) c += (gap < 6 ? OVERLAP : NEAR) * ov;
      }
    } else {
      // perpendicular: crossing if s.c is strictly between lo..hi and our line is strictly within s.lo..s.hi
      // half-open on our move ([lo, hi)) so a crossing exactly on a grid
      // line is counted once, not missed by both neighbouring moves
      const our = horiz ? y1 : x1;
      if (s.c >= lo - 0.5 && s.c < hi - 0.5 && our > s.lo + 0.5 && our < s.hi - 0.5) c += CROSS;
    }
  }
  return c;
}
function toSegs(pts) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    if (p.x === q.x && p.y === q.y) continue;
    if (p.y === q.y) out.push({ h: true, c: p.y, lo: Math.min(p.x, q.x), hi: Math.max(p.x, q.x) });
    else if (p.x === q.x) out.push({ h: false, c: p.x, lo: Math.min(p.y, q.y), hi: Math.max(p.y, q.y) });
  }
  return out;
}

/**
 * One arrow: A* over the grid of "interesting" coordinates (box edges + gap
 * middles + the candidate stubs). `starts` / `goals` = [{ side, x, y, extra }].
 * Returns { pts, side, goalSide, cost } or null.
 */
function search(grid, boxes, starts, goals, placed, zones = [], self = -1) {
  const { xs, ys, hugX, hugY } = grid;
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));
  const W = xs.length, H = ys.length;
  const key = (i, j, d) => ((j * W + i) << 2) | d;
  const best = new Map();
  const heap = new Heap();
  const goalAt = new Map();
  for (const g of goals) {
    const gi = xi.get(Math.round(g.x)), gj = yi.get(Math.round(g.y));
    if (gi === undefined || gj === undefined) continue;
    goalAt.set(gj * W + gi, g);
  }
  const hFn = (i, j) => {
    let m = Infinity;
    for (const g of goals) m = Math.min(m, Math.abs(xs[i] - g.x) + Math.abs(ys[j] - g.y));
    return m;
  };
  const dirIdx = { right: 0, bottom: 1, left: 2, top: 3 };
  const moves = [[1, 0, 0], [0, 1, 1], [-1, 0, 2], [0, -1, 3]];
  for (const s of starts) {
    const i = xi.get(Math.round(s.x)), j = yi.get(Math.round(s.y));
    if (i === undefined || j === undefined) continue;
    const d = dirIdx[s.side];
    const k = key(i, j, d);
    const g = s.extra || 0;
    if (!best.has(k) || best.get(k).g > g) {
      const node = { i, j, d, g, f: g + hFn(i, j), prev: null, start: s, run: STUB };
      best.set(k, node);
      heap.push(node);
    }
  }
  let expanded = 0;
  while (heap.size) {
    const cur = heap.pop();
    if (best.get(key(cur.i, cur.j, cur.d)) !== cur) continue;
    if (++expanded > 60000) break;
    const gHere = goalAt.get(cur.j * W + cur.i);
    if (gHere && cur.done) {
      const pts = [];
      for (let n = cur; n; n = n.prev) pts.push({ x: xs[n.i], y: ys[n.j] });
      pts.reverse();
      let st = cur; while (st.prev) st = st.prev;
      return { pts, side: st.start.side, goalSide: gHere.side, cost: cur.g };
    }
    if (gHere && !cur.done) {
      // arriving at a goal stub: must continue INTO the box (opposite of its side)
      const inward = dirIdx[{ top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[gHere.side]];
      let turn = cur.d === inward ? 0 : ((cur.d + 2) % 4 === inward ? 4 * BEND : BEND);
      if (cur.d !== inward && cur.run < SHORT_RUN && cur.prev) turn += BUMP;   // step right before the box
      const g2 = cur.g + turn + (gHere.extra || 0);
      const node = { ...cur, g: g2, f: g2, done: true, prev: cur.prev, i: cur.i, j: cur.j };
      heap.push(node);
      best.set(key(cur.i, cur.j, cur.d), node);
      continue;
    }
    for (const [di, dj, nd] of moves) {
      if ((nd + 2) % 4 === cur.d) continue;           // no reversing
      const ni = cur.i + di, nj = cur.j + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const x1 = xs[cur.i], y1 = ys[cur.j], x2 = xs[ni], y2 = ys[nj];
      if (boxes.some(b => inside(x2, y2, b))) continue;
      if (segBlocked(x1, y1, x2, y2, boxes)) continue;
      const len = Math.abs(x2 - x1) + Math.abs(y2 - y1);
      let step = len + (nd === cur.d ? 0 : BEND);
      if (nd !== cur.d && cur.run < SHORT_RUN) step += BUMP;             // short jog = bump
      if (dj === 0 && hugY.has(y1)) step += HUG * len;
      if (di === 0 && hugX.has(x1)) step += HUG * len;
      step += trafficCost(x1, y1, x2, y2, placed);
      if (zones.length) step += zoneCost(x1, y1, x2, y2, zones, self);
      const g = cur.g + step;
      const k = key(ni, nj, nd);
      const old = best.get(k);
      if (old && old.g <= g) continue;
      const node = { i: ni, j: nj, d: nd, g, f: g + hFn(ni, nj), prev: cur, run: nd === cur.d ? cur.run + len : len };
      best.set(k, node);
      heap.push(node);
    }
  }
  return null;
}

function buildGrid(nodes, extraPts) {
  const xsRaw = [], ysRaw = [];
  const hugX = new Set(), hugY = new Set();
  const lefts = [], rights = [], tops = [], bottoms = [];
  for (const n of nodes) {
    const x1 = n.x - CLEAR, x2 = n.x + n.w + CLEAR, y1 = n.y - CLEAR, y2 = n.y + n.h + CLEAR;
    xsRaw.push(x1, x2); ysRaw.push(y1, y2);
    hugX.add(Math.round(x1)); hugX.add(Math.round(x2)); hugY.add(Math.round(y1)); hugY.add(Math.round(y2));
    lefts.push(x1); rights.push(x2); tops.push(y1); bottoms.push(y2);
    xsRaw.push(n.x + n.w / 2); ysRaw.push(n.y + n.h / 2);
  }
  // middles of the free gaps → lines sit centred between boxes
  const mids = (arr) => {
    const s = uniqSorted(arr);
    const out = [];
    for (let i = 0; i < s.length - 1; i++) if (s[i + 1] - s[i] > 8) out.push((s[i] + s[i + 1]) / 2);
    return out;
  };
  xsRaw.push(...mids([...lefts, ...rights]));
  ysRaw.push(...mids([...tops, ...bottoms]));
  const minX = Math.max(RAIL_EDGE + 4, Math.min(...lefts) - 30), maxX = Math.max(...rights) + 30;
  const minY = Math.min(...tops) - 30, maxY = Math.max(...bottoms) + 30;
  xsRaw.push(minX, maxX); ysRaw.push(minY, maxY);
  for (const p of extraPts) { xsRaw.push(p.x); ysRaw.push(p.y); }
  return { xs: uniqSorted(xsRaw), ys: uniqSorted(ysRaw), hugX, hugY };
}

function simplify(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2], b = last;
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) { out[out.length - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}

/**
 * nodes: final placed nodes. pairs: [{ a, b, docS, docE }].
 * Returns [{ s, t, via, viaFor }] in the same order (null via → let the canvas route).
 */
export function routeEdges(nodes, pairs) {
  const boxes = boxesOf(nodes);
  const n = pairs.length;
  const result = pairs.map(() => null);
  const order = pairs.map((p, i) => i).sort((i, j) => {
    const d = p => Math.abs((p.a.x + p.a.w / 2) - (p.b.x + p.b.w / 2)) + Math.abs((p.a.y + p.a.h / 2) - (p.b.y + p.b.h / 2));
    return d(pairs[i]) - d(pairs[j]);
  });

  // ---- phase 1: choose sides (all 4×4 at once inside one search) ----
  const allStubs = [];
  pairs.forEach(p => SIDES.forEach(sd => { allStubs.push(stubOf(p.a, sd)); allStubs.push(stubOf(p.b, sd)); }));
  let grid = buildGrid(nodes, allStubs);
  // Two rounds: the second re-chooses every arrow's sides while seeing ALL
  // the others (an early arrow can't know where a later one will pass).
  const p1 = pairs.map(() => null);
  for (let round = 0; round < 2; round++) {
    const used = new Map();
    p1.forEach((r, j) => {
      if (!r) return;
      used.set(`${pairs[j].a.id}|${r.s}`, (used.get(`${pairs[j].a.id}|${r.s}`) || 0) + 1);
      used.set(`${pairs[j].b.id}|${r.t}`, (used.get(`${pairs[j].b.id}|${r.t}`) || 0) + 1);
    });
    for (const i of order) {
      const { a, b, docS, docE } = pairs[i];
      const mine = p1[i];
      if (mine) {   // don't count this arrow's own sides against itself
        used.set(`${a.id}|${mine.s}`, used.get(`${a.id}|${mine.s}`) - 1);
        used.set(`${b.id}|${mine.t}`, used.get(`${b.id}|${mine.t}`) - 1);
      }
      // a side already used by another arrow gets fanned out by the canvas,
      // which puts a small jog in both lines — use a free side when there is one
      const sideCost = (node, sd) => 130 * Math.max(0, used.get(`${node.id}|${sd}`) || 0);
      const placed = [];
      p1.forEach((r, j) => { if (j !== i && r) placed.push(...r.segs); });
      const starts = SIDES.map(sd => ({ side: sd, ...stubOf(a, sd), extra: (docS && sd !== docS ? 18 : 0) + sideCost(a, sd) }));
      const goals = SIDES.map(sd => ({ side: sd, ...stubOf(b, sd), extra: (docE && sd !== docE ? 18 : 0) + sideCost(b, sd) }));
      const r = search(grid, boxes, starts, goals, placed);
      if (r) {
        p1[i] = { s: r.side, t: r.goalSide, segs: toSegs(simplify(r.pts)) };
      }
      const now = p1[i];
      if (now) {
        used.set(`${a.id}|${now.s}`, (used.get(`${a.id}|${now.s}`) || 0) + 1);
        used.set(`${b.id}|${now.t}`, (used.get(`${b.id}|${now.t}`) || 0) + 1);
      }
    }
  }
  // Conflict resolution: for every pair that still crosses, rip up BOTH and
  // draw them in the other order (the second one then has to go around the
  // first) — keep it only if the diagram ends up with fewer crossings.
  const segsCross = (A, B) => {
    let c = 0;
    for (const s1 of A) for (const s2 of B) {
      if (s1.h === s2.h) continue;
      const h = s1.h ? s1 : s2, v = s1.h ? s2 : s1;
      if (v.c > h.lo + 0.5 && v.c < h.hi - 0.5 && h.c > v.lo + 0.5 && h.c < v.hi - 0.5) c++;
    }
    return c;
  };
  const totalCross = arr => {
    let c = 0;
    for (let x = 0; x < arr.length; x++) for (let y = x + 1; y < arr.length; y++) {
      if (arr[x] && arr[y]) c += segsCross(arr[x].segs, arr[y].segs);
    }
    return c;
  };
  const routeOne = (i, cur) => {
    const { a, b, docS, docE } = pairs[i];
    const used = new Map();
    cur.forEach((r, j) => {
      if (!r || j === i) return;
      used.set(`${pairs[j].a.id}|${r.s}`, (used.get(`${pairs[j].a.id}|${r.s}`) || 0) + 1);
      used.set(`${pairs[j].b.id}|${r.t}`, (used.get(`${pairs[j].b.id}|${r.t}`) || 0) + 1);
    });
    const sideCost = (node, sd) => 130 * (used.get(`${node.id}|${sd}`) || 0);
    const placed = [];
    cur.forEach((r, j) => { if (j !== i && r) placed.push(...r.segs); });
    const starts = SIDES.map(sd => ({ side: sd, ...stubOf(a, sd), extra: (docS && sd !== docS ? 18 : 0) + sideCost(a, sd) }));
    const goals = SIDES.map(sd => ({ side: sd, ...stubOf(b, sd), extra: (docE && sd !== docE ? 18 : 0) + sideCost(b, sd) }));
    const r = search(grid, boxes, starts, goals, placed);
    return r ? { s: r.side, t: r.goalSide, segs: toSegs(simplify(r.pts)) } : cur[i];
  };
  for (let iter = 0; iter < 4; iter++) {
    let improved = false;
    const base = totalCross(p1);
    if (!base) break;
    outer:
    for (let x = 0; x < p1.length; x++) for (let y = 0; y < p1.length; y++) {
      if (x === y || !p1[x] || !p1[y] || segsCross(p1[x].segs, p1[y].segs) === 0) continue;
      for (const [first, second] of [[y, x], [x, y]]) {
        const trial = p1.slice();
        trial[first] = null; trial[second] = null;
        trial[first] = routeOne(first, trial);
        trial[second] = routeOne(second, trial);
        if (trial[first] && trial[second] && totalCross(trial) < base) {
          for (let k = 0; k < p1.length; k++) p1[k] = trial[k];
          improved = true;
          break outer;
        }
      }
    }
    if (!improved) break;
  }
  p1.forEach((r, i) => { if (r) result[i] = { s: r.s, t: r.t }; });

  // ---- phase 2: real fan-out offsets for those sides, final paths ----
  const proc = {
    nodes,
    edges: pairs.map((p, i) => ({ from: p.a.id, to: p.b.id, s: result[i]?.s || 'right', e: result[i]?.t || 'left' }))
  };
  let offs = {};
  try { offs = endpointOffsets(proc); } catch { offs = {}; }
  const stubs2 = pairs.map((p, i) => {
    if (!result[i]) return null;
    const o = offs[i] || { fromOff: 0, toOff: 0 };
    return { s: stubOf(p.a, result[i].s, o.fromOff), e: stubOf(p.b, result[i].t, o.toOff) };
  });
  grid = buildGrid(nodes, stubs2.filter(Boolean).flatMap(x => [x.s, x.e]));
  const zones = endZones(pairs, result, offs);
  let placed = [];
  const out = pairs.map(() => null);
  for (const i of order) {
    const st = stubs2[i];
    if (!st) continue;
    const { a, b } = pairs[i];
    const r = search(grid, boxes,
      [{ side: result[i].s, x: st.s.x, y: st.s.y }],
      [{ side: result[i].t, x: st.e.x, y: st.e.y }], placed, zones, i);
    if (!r) { out[i] = { s: result[i].s, t: result[i].t, via: null }; continue; }
    const pts = simplify(r.pts);
    placed = placed.concat(toSegs(pts));
    const via = pts.map(p => ({ x: p.x, y: p.y }));
    out[i] = { s: result[i].s, t: result[i].t, via, viaFor: viaSignature(a, b, result[i].s, result[i].t), pts };
  }

  // ---- rip-up & re-route: every arrow again, now seeing ALL the others ----
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const i of order) {
      const st = stubs2[i];
      if (!st || !out[i]?.pts) continue;
      const others = [];
      out.forEach((o, j) => { if (j !== i && o?.pts) others.push(...toSegs(o.pts)); });
      const r = search(grid, boxes,
        [{ side: result[i].s, x: st.s.x, y: st.s.y }],
        [{ side: result[i].t, x: st.e.x, y: st.e.y }], others, zones, i);
      if (!r) continue;
      const pts = simplify(r.pts);
      if (JSON.stringify(pts) !== JSON.stringify(out[i].pts)) {
        changed = true;
        out[i] = { ...out[i], pts, via: pts.map(p => ({ x: p.x, y: p.y })) };
      }
    }
    if (!changed) break;
  }
  // same conflict resolution as in phase 1, now on the final paths
  const fixedRoute = (i, cur) => {
    const st = stubs2[i];
    const others = [];
    cur.forEach((o, j) => { if (j !== i && o?.pts) others.push(...toSegs(o.pts)); });
    const r = search(grid, boxes,
      [{ side: result[i].s, x: st.s.x, y: st.s.y }],
      [{ side: result[i].t, x: st.e.x, y: st.e.y }], others, zones, i);
    if (!r) return cur[i];
    const pts = simplify(r.pts);
    return { ...cur[i], pts, via: pts.map(p => ({ x: p.x, y: p.y })) };
  };
  const crossOf = arr => {
    const ss = arr.map(o => (o?.pts ? toSegs(o.pts) : []));
    let c = 0;
    for (let x = 0; x < ss.length; x++) for (let y = x + 1; y < ss.length; y++) {
      for (const s1 of ss[x]) for (const s2 of ss[y]) {
        if (s1.h === s2.h) continue;
        const h = s1.h ? s1 : s2, v = s1.h ? s2 : s1;
        if (v.c > h.lo + 0.5 && v.c < h.hi - 0.5 && h.c > v.lo + 0.5 && h.c < v.hi - 0.5) c++;
      }
    }
    return c;
  };
  for (let iter = 0; iter < 6; iter++) {
    const base = crossOf(out);
    if (!base) break;
    let improved = false;
    outer2:
    for (let x = 0; x < out.length; x++) for (let y = 0; y < out.length; y++) {
      if (x === y || !out[x]?.pts || !out[y]?.pts || !stubs2[x] || !stubs2[y]) continue;
      if (crossOf([out[x], out[y]]) === 0) continue;
      for (const [first, second] of [[y, x], [x, y]]) {
        const trial = out.slice();
        trial[first] = { ...trial[first], pts: null };
        trial[second] = { ...trial[second], pts: null };
        trial[first] = fixedRoute(first, trial);
        trial[second] = fixedRoute(second, trial);
        if (trial[first]?.pts && trial[second]?.pts && crossOf(trial) < base) {
          for (let k = 0; k < out.length; k++) out[k] = trial[k];
          improved = true;
          break outer2;
        }
      }
    }
    if (!improved) break;
  }
  return out.map(o => (o ? { s: o.s, t: o.t, via: o.via, viaFor: o.viaFor } : o));
}


/**
 * Re-route arrows whose saved bends went stale (a box was moved, resized or
 * its text changed) — sides stay as they are, only the path is rebuilt, so
 * editing a box never turns its arrows into the old tangled lines.
 * process: { nodes, edges }. Returns { [edgeIndex]: via[] }.
 */
export function rerouteStale(process, isStale) {
  const nodes = process?.nodes || [];
  const edges = process?.edges || [];
  const idx = edges.map((e, i) => i).filter(i => isStale(edges[i]));
  if (!idx.length) return {};
  const byId = new Map(nodes.map(n => [String(n.id), n]));
  const boxes = boxesOf(nodes);
  let offs = {};
  try { offs = endpointOffsets(process); } catch { offs = {}; }
  // arrows that are fine count as traffic, so the new path avoids them
  let placed = [];
  edges.forEach((e, i) => {
    if (idx.includes(i) || !e.via?.length) return;
    const a = byId.get(String(e.from)), b = byId.get(String(e.to));
    if (!a || !b) return;
    const o = offs[i] || {};
    const sp = stubOf(a, e.s || 'right', o.fromOff, STUB), ep = stubOf(b, e.e || 'left', o.toOff, STUB);
    placed = placed.concat(toSegs(simplify([sp, ...expandVia(sp, e.via), ep])));
  });
  const stubs = idx.map(i => {
    const e = edges[i];
    const a = byId.get(String(e.from)), b = byId.get(String(e.to));
    if (!a || !b) return null;
    const o = offs[i] || {};
    return { i, a, b, s: e.s || 'right', t: e.e || 'left', sp: stubOf(a, e.s || 'right', o.fromOff), ep: stubOf(b, e.e || 'left', o.toOff) };
  }).filter(Boolean);
  const grid = buildGrid(nodes, stubs.flatMap(x => [x.sp, x.ep]));
  const out = {};
  for (const st of stubs) {
    const r = search(grid, boxes, [{ side: st.s, x: st.sp.x, y: st.sp.y }], [{ side: st.t, x: st.ep.x, y: st.ep.y }], placed);
    if (!r) continue;
    const pts = simplify(r.pts);
    placed = placed.concat(toSegs(pts));
    out[st.i] = pts.map(p => ({ x: p.x, y: p.y }));
  }
  return out;
}

// via points → the polyline the canvas draws between the two stubs
function expandVia(start, via) {
  const pts = [];
  let prev = start;
  for (const v of via) { pts.push({ x: v.x, y: prev.y }, { x: v.x, y: v.y }); prev = v; }
  return pts;
}


/** Clean paths for EVERY arrow of a diagram (old or hand-made too). Keeps the
 *  current sides as a preference; returns the new edges array. */
export function tidyEdges(process) {
  const nodes = process?.nodes || [];
  const byId = new Map(nodes.map(n => [String(n.id), n]));
  const edges = process?.edges || [];
  const list = edges.map(e => ({ e, a: byId.get(String(e.from)), b: byId.get(String(e.to)) }));
  const ok = list.filter(x => x.a && x.b);
  const routed = routeEdges(nodes, ok.map(x => ({ a: x.a, b: x.b, docS: x.e.s, docE: x.e.e })));
  const res = new Map(ok.map((x, i) => [x.e, routed[i]]));
  return edges.map(e => {
    const r = res.get(e);
    if (!r) return e;
    const next = { ...e, s: r.s, e: r.t };
    if (r.via) { next.via = r.via; next.viaFor = r.viaFor; } else { delete next.via; delete next.viaFor; }
    return next;
  });
}



/**
 * How clean a layout's arrows come out: route everything, then count.
 * Lower is better. Crossings dominate, then lines that couldn't be placed,
 * then bends and total length.
 */
export function layoutScore(nodes, pairs) {
  const routed = routeEdges(nodes, pairs);
  const lines = routed.map(r => (r?.via?.length ? r.via : null));
  const segs = lines.map(l => (l ? toSegs(simplify(l)) : []));
  let crossings = 0, bends = 0, length = 0, failed = 0;
  segs.forEach((ss, i) => {
    if (!lines[i]) { failed++; return; }
    bends += Math.max(0, ss.length - 1);
    ss.forEach(x => { length += x.hi - x.lo; });
    for (let j = i + 1; j < segs.length; j++) {
      for (const s1 of ss) for (const s2 of segs[j]) {
        if (s1.h === s2.h) continue;
        const h = s1.h ? s1 : s2, v = s1.h ? s2 : s1;
        if (v.c > h.lo + 0.5 && v.c < h.hi - 0.5 && h.c > v.lo + 0.5 && h.c < v.hi - 0.5) crossings++;
      }
    }
  });
  const crossPairs = [];
  segs.forEach((ss, i) => {
    for (let j = i + 1; j < segs.length; j++) {
      let c = false;
      for (const s1 of ss) { for (const s2 of segs[j]) {
        if (s1.h === s2.h) continue;
        const h = s1.h ? s1 : s2, v = s1.h ? s2 : s1;
        if (v.c > h.lo + 0.5 && v.c < h.hi - 0.5 && h.c > v.lo + 0.5 && h.c < v.hi - 0.5) { c = true; break; }
      } if (c) break; }
      if (c) crossPairs.push([i, j]);
    }
  });
  // lines running too close to each other look tangled even without crossing
  let near = 0;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    for (const a of segs[i]) for (const b of segs[j]) {
      if (a.h !== b.h || Math.abs(a.c - b.c) >= 18) continue;
      const ov = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
      if (ov > 0) near += ov;
    }
  }
  return { score: crossings * 1000 + failed * 2000 + bends * 14 + length / 10 + near * 2, crossings, crossPairs, routed };
}
