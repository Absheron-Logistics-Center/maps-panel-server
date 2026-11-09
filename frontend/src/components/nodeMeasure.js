// nodeMeasure.js
// Nodes keep one uniform width; when the text changes the HEIGHT grows to
// fit instead of the width. This measures the wrapped text off-screen using
// the same font metrics as `.node .text` and returns the height the node
// needs. The user can still resize manually afterwards.
import { nodeDefaults, nodeView } from './nodeStyle.js';

const SNAP = 10;

// horizontal / vertical paddings from styles.css (.node / .node.pill)
function paddings(shape) {
  if (shape === 'pill') return { px: 22, py: 13 };
  return { px: 16, py: 12 };
}

// SVG shapes (diamond, parallelogram, …) taper inward, so their usable
// text width is narrower than the box.
const SVG_INSET = { diamond: 0.45, parallelogram: 0.72, preparation: 0.55, manualinput: 0.9, document: 0.92 };

let measurer = null;
function getMeasurer() {
  if (measurer && document.body.contains(measurer)) return measurer;
  measurer = document.createElement('div');
  Object.assign(measurer.style, {
    position: 'fixed', left: '-9999px', top: '0', visibility: 'hidden',
    pointerEvents: 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    fontSize: '12.5px', lineHeight: '1.38', fontFamily: 'inherit'
  });
  document.body.appendChild(measurer);
  return measurer;
}

/**
 * Height (snapped to the grid) that `node` needs to fit `text` at its
 * current width. Never smaller than the shape's default height.
 */
export function autoNodeHeight(node, text) {
  const { shape } = nodeView(node);
  const def = nodeDefaults(shape);
  const w = node.w || def.w;
  const { px, py } = paddings(shape);

  // content width = node width − paddings − id number column (16) − gap (12)
  let contentW = w - px * 2 - 16 - 12;
  const inset = SVG_INSET[shape];
  if (inset) contentW *= inset;
  contentW = Math.max(40, contentW);

  const el = getMeasurer();
  el.style.width = `${contentW}px`;
  el.style.fontWeight = shape === 'pill' ? '600' : '500';
  el.textContent = text || '';
  const textH = el.offsetHeight || 0;

  let h = Math.max(def.h, textH + py * 2 + 4);
  h = Math.ceil(h / SNAP) * SNAP;
  return h;
}
