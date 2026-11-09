// Node shapes and border styles.
// A node has a SHAPE (geometry) and a STYLE (how its border/fill looks).
//
//   STYLE:
//     solid  (Tam)   — filled primary background, white text
//     stroke         — white background, SOLID border, dark text
//     dashed (Kəsik) — white background, DASHED border, dark text

export const SHAPES = [
  'pill', 'rect', 'diamond', 'parallelogram',
  'subprocess', 'manualinput', 'document', 'preparation', 'delay', 'trapezoid',
  'triangledown', 'roundright'
];
export const STYLES = ['solid', 'stroke', 'dashed'];

// Shapes whose body is an SVG polygon/path overlay (ShapeBg in
// DiagramCanvas.jsx) instead of a plain CSS-box (border-radius etc).
// diamond/parallelogram were the original two; preparation, manualinput,
// document, trapezoid and triangledown reuse the same overlay mechanism.
export const SVG_SHAPES = ['diamond', 'parallelogram', 'preparation', 'manualinput', 'document', 'trapezoid', 'triangledown'];

export const SHAPE_LABEL = {
  pill: 'Başlıq',
  rect: 'Əsas Proses',
  diamond: 'Şərt',
  parallelogram: 'Data Məlumatı',
  subprocess: 'Alt Proses',
  manualinput: 'Əl ilə görülən işlər',
  document: 'Sənəd/Qeyd',
  preparation: 'Hazırlıq',
  delay: 'Gecikmə',
  trapezoid: 'Trapesiya',
  triangledown: 'Birləşdirmə',
  roundright: 'Gecikmə',
};

export const STYLE_LABEL = {
  solid: 'Tam',
  stroke: 'Stroke',
  dashed: 'Kəsik',
};

// Resolve a node's { shape, style }, keeping older data working:
//  - legacy type 'stroke'  -> rect + stroke
//  - legacy type 'dashed'  -> rect + dashed
//  - legacy `dash:true`    -> dashed
export function nodeView(node) {
  let shape = node.type;
  let style = node.style;

  if (shape === 'stroke') { shape = 'rect'; if (!style) style = 'stroke'; }
  else if (shape === 'dashed') { shape = 'rect'; if (!style) style = 'dashed'; }

  if (!style) style = node.dash ? 'dashed' : 'solid';

  if (!SHAPES.includes(shape)) shape = 'rect';
  if (!STYLES.includes(style)) style = 'solid';
  return { shape, style };
}

export function nodeDefaults(shape) {
  switch (shape) {
    case 'pill': return { w: 200, h: 50 };
    case 'rect': return { w: 200, h: 70 };
    case 'diamond': return { w: 150, h: 150 };
    case 'parallelogram': return { w: 210, h: 70 };
    case 'subprocess': return { w: 210, h: 70 };
    case 'manualinput': return { w: 210, h: 75 };
    case 'document': return { w: 200, h: 85 };
    case 'preparation': return { w: 190, h: 110 };
    case 'delay': return { w: 190, h: 60 };
    case 'trapezoid': return { w: 210, h: 80 };
    case 'triangledown': return { w: 180, h: 130 };
    case 'roundright': return { w: 210, h: 60 };
    default: return { w: 200, h: 70 };
  }
}
