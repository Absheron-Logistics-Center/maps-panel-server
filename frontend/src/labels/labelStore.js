// labelStore.js — the single in-memory cache of editor_2's interface-text
// overrides. Kept outside React so both components (via useLabels()) and
// plain helper modules (e.g. nodeStyle.js's SHAPE_LABEL lookups) can read
// the current text for a label id without needing a hook.

let overrides = {};
const listeners = new Set();

export function setOverrides(next) {
  overrides = (next && typeof next === 'object') ? next : {};
  listeners.forEach(fn => fn());
}

export function setOverride(id, text) {
  overrides = { ...overrides };
  if (typeof text === 'string' && text.trim()) overrides[id] = text;
  else delete overrides[id];
  listeners.forEach(fn => fn());
}

export function getOverrides() {
  return overrides;
}

// The one function everything else calls: given a label id and the
// hard-coded default text, return the editor_2 override if one exists.
export function label(id, fallback) {
  const v = overrides[id];
  return (typeof v === 'string' && v.trim()) ? v : fallback;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
