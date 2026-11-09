// colorUtils.js — derive a full set of CSS custom properties from one
// user-picked accent color, so every state (hover, selected, soft bg,
// stroke border, ...) stays visually consistent instead of drifting
// back to the fixed teal defaults.

function hexToRgb(hex) {
  if (!hex) return null;
  let h = String(hex).trim().replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const num = parseInt(h, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function clamp255(n) { return Math.max(0, Math.min(255, Math.round(n))); }

function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map(v => clamp255(v).toString(16).padStart(2, '0')).join('');
}

function mix(hex, targetHex, amt) {
  const c = hexToRgb(hex);
  const t = hexToRgb(targetHex);
  if (!c || !t) return hex;
  return rgbToHex({
    r: c.r + (t.r - c.r) * amt,
    g: c.g + (t.g - c.g) * amt,
    b: c.b + (t.b - c.b) * amt
  });
}

export function shade(hex, amt) { return mix(hex, '#000000', amt); }
export function tint(hex, amt) { return mix(hex, '#ffffff', amt); }
export function isValidHex(hex) { return !!hexToRgb(hex); }

// Coerce ANY stored colour value into a safe plain string. Older diagrams (and
// some imports) saved a colour as an OBJECT — e.g.
//   theme.node = { base:'#2c5f7a', light:'#e8f0f5', medium:'#4a8ba8', dark:'#1a3d4f' }
// instead of a plain '#2c5f7a'. Passing that object into anything that expects a
// string (a colour <input>, or `(value||'').toLowerCase()` in the swatch grid)
// used to throw "toLowerCase is not a function" and crash the whole editor.
// This normalises every shape (string / number / colour-object / null) → string.
export function asColorString(v) {
  if (typeof v === 'string') return v;
  if (v == null || typeof v !== 'object') return '';
  const cand = v.base ?? v.hex ?? v.color ?? v.value ?? v.main
    ?? v.primary ?? v.accent ?? v.node ?? v.medium ?? v.dark ?? v.light;
  return typeof cand === 'string' ? cand : '';
}

// Normalise a diagram theme so node / edge / lane are always strings (or absent).
// Legacy object themes carried several colours per field; pick the one that maps
// to how each field is used (node/edge = the main colour, lane = its accent).
export function normalizeTheme(theme) {
  if (!theme || typeof theme !== 'object') return theme;
  const prefer = { node: ['base'], edge: ['base'], lane: ['accent', 'base'] };
  const out = { ...theme };
  for (const k of ['node', 'edge', 'lane']) {
    if (!(k in out)) continue;
    const v = out[k];
    let s = '';
    if (typeof v === 'string') s = v;
    else if (v && typeof v === 'object') {
      for (const pk of prefer[k]) { if (typeof v[pk] === 'string') { s = v[pk]; break; } }
      if (!s) s = asColorString(v);
    }
    if (s) out[k] = s; else delete out[k];
  }
  return out;
}

// WCAG-ish relative luminance -> pick readable text color (white on dark
// fills, dark on light fills) so a light custom node color never ends up
// with invisible white-on-white text.
function relativeLuminance({ r, g, b }) {
  const chan = v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

export function contrastTextColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#ffffff';
  return relativeLuminance(rgb) > 0.55 ? '#1f2933' : '#ffffff';
}

// Full accent variant set — matches the relationships between the
// default --primary-* tokens in styles.css so custom colors behave
// exactly like the built-in teal does across hover/selected/soft states.
export function deriveAccentVars(hex) {
  if (!isValidHex(hex)) return null;
  return {
    '--primary': hex,
    '--primary-hover': shade(hex, 0.08),
    '--primary-dark': shade(hex, 0.18),
    '--primary-darker': shade(hex, 0.35),
    '--primary-light': tint(hex, 0.55),
    '--primary-lighter': tint(hex, 0.70),
    '--primary-soft': tint(hex, 0.88),
    // stroke/kəsik border previously stayed on the fixed teal constant —
    // now it follows the same custom color as everything else.
    '--stroke-border': hex,
    // solid-style nodes hard-code white text (works for the default dark
    // teal) — for a custom color that's light, switch to dark text instead
    // so the label stays readable.
    '--node-text-on-fill': contrastTextColor(hex)
  };
}

export function deriveLaneVars(hex) {
  if (!isValidHex(hex)) return null;
  return { '--lane-accent': hex };
}

export function deriveEdgeVars(hex) {
  if (!isValidHex(hex)) return null;
  return { '--edge-color': hex };
}
