// nodeLayout.js
// Free placement with a *gentle* anti-overlap nudge.
//
// The user positions nodes wherever they like. We do NOT reflow the layout or
// fling a node to a new row/column. The only thing we do is: if the node the
// user just dropped ends up literally sitting on top of another node, push it
// out by the SHORTEST distance needed to clear that overlap (the direction
// with the least movement — up, down, left or right). That keeps a natural
// feel: a small move stays a small move.

const RAIL_W = 56;   // left rail width (nodes start right of it)
const CLEAR = 8;     // tiny breathing gap left after un-overlapping

function overlapRect(a, b) {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ix <= 0 || iy <= 0) return null;
  return { ix, iy };
}

/**
 * Nudge `cand` the minimum amount so it doesn't overlap any box in `others`.
 * Returns { x, y }. If there's no overlap, the position is returned unchanged
 * (aside from clamping to the rail / lane top).
 */
export function resolveNodePlacement(cand, others, { laneTop = 0 } = {}) {
  let x = Math.max(RAIL_W + 4, cand.x);
  let y = Math.max(laneTop + 4, cand.y);
  const boxes = (others || []).filter(Boolean);
  if (!boxes.length) return { x, y };

  // A few passes: clearing one overlap can create another, but we only ever
  // move the minimum, so this converges quickly and stays close to the drop.
  for (let pass = 0; pass < 8; pass++) {
    const box = { x, y, w: cand.w, h: cand.h };
    let hit = null;
    for (const o of boxes) {
      const ov = overlapRect(box, o);
      if (ov) { hit = { o, ov }; break; }
    }
    if (!hit) break;

    const { o, ov } = hit;
    // Push along whichever axis needs the least travel to separate.
    if (ov.ix < ov.iy) {
      const boxCx = x + cand.w / 2;
      const oCx = o.x + o.w / 2;
      if (boxCx < oCx) x = o.x - cand.w - CLEAR;      // push left
      else             x = o.x + o.w + CLEAR;          // push right
    } else {
      const boxCy = y + cand.h / 2;
      const oCy = o.y + o.h / 2;
      if (boxCy < oCy) y = o.y - cand.h - CLEAR;       // push up
      else             y = o.y + o.h + CLEAR;          // push down
    }
    x = Math.max(RAIL_W + 4, x);
    y = Math.max(laneTop + 4, y);
  }
  return { x, y };
}
