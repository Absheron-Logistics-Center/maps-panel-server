// laneRepack.js
// The single correct swim-lane repack used across the editor.
//
// It stacks lanes top-to-bottom, grows each lane to fit its nodes, AND shifts
// every node by the same amount its lane moved — so nodes never visually detach
// from their lane. (The older AdminPanel copy resized lanes but left nodes in
// place, which made shapes appear to "jump/shift columns" after an edit.)
//
// Returns { lanes, nodes }.
const LANE_PAD = 20;
const LANE_MIN_H = 160;

// The lane name is written vertically in the 56px rail: about 3 lines of
// 12px bold text fit side by side. A long name ("Səhmdar Cəmiyyətin
// Marketinq və kommunikasiya departamenti") needs a taller lane, otherwise
// the rail cuts it off.
export function laneLabelMinH(label) {
  const lines = String(label || '').split('\n');
  const longest = Math.max(...lines.map(l => l.length), 0);
  const explicit = lines.length;
  const perLine = explicit >= 3 ? longest : Math.ceil(String(label || '').length / 3);
  return Math.ceil(perLine * 7.6) + 36;
}

export function repackLanes(lanes, nodes) {
  if (!lanes || lanes.length === 0) return { lanes: lanes || [], nodes: nodes || [] };

  // 1. Ensure every node has a valid laneId (infer from current Y if missing).
  const tagged = (nodes || []).map(n => {
    if (n.laneId && lanes.some(l => l.id === n.laneId)) return n;
    const cy = (n.y || 0) + (n.h || 100) / 2;
    let best = lanes[0];
    let bestDist = Infinity;
    let contained = false;
    for (const lane of lanes) {
      if (cy >= lane.y && cy < lane.y + lane.h) { best = lane; contained = true; break; }
      const dist = Math.min(Math.abs(cy - lane.y), Math.abs(cy - (lane.y + lane.h)));
      if (!contained && dist < bestDist) { bestDist = dist; best = lane; }
    }
    return { ...n, laneId: best.id };
  });

  // 2. Stack lanes; compute each lane's required height + the shift for its nodes.
  let cursorY = 20;
  const shiftByLane = {};
  const newLanes = lanes.map(lane => {
    const laneNodes = tagged.filter(n => n.laneId === lane.id);
    const minH = Math.max(LANE_MIN_H, laneLabelMinH(lane.label));
    let height = minH;
    if (laneNodes.length > 0) {
      const maxBottomRel = Math.max(...laneNodes.map(n => (n.y || 0) + (n.h || 100) - lane.y));
      height = Math.max(minH, maxBottomRel + LANE_PAD);
    }
    const newY = cursorY;
    shiftByLane[lane.id] = newY - lane.y;
    cursorY += height;
    return { ...lane, y: newY, h: height };
  });

  // 3. Apply shifts so nodes ride along with their lane.
  const newNodes = tagged.map(n => ({
    ...n,
    y: Math.round((n.y || 0) + (shiftByLane[n.laneId] || 0))
  }));

  return { lanes: newLanes, nodes: newNodes };
}
