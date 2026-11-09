// feel.js — makes the app feel "alive": tiny synthesized UI sounds, haptics
// (where the device has them), springy press feedback, and enter/exit motion
// for panels, menus, sheets and dialogs.
//
// No audio files: every sound is generated on the fly with Web Audio, so
// nothing has to load and the first click already sounds. Everything is
// quiet and short on purpose (think iOS keyboard ticks, not game sounds).
//
// One switch (feel.setEnabled) turns sound + haptics on/off; it is saved per
// browser. Motion follows the OS "reduce motion" setting.

const LS_KEY = 'alm-feel-v1';
const listeners = new Set();

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return { sound: s.sound !== false, haptics: s.haptics !== false, volume: typeof s.volume === 'number' ? s.volume : 0.7 };
  } catch {
    return { sound: true, haptics: true, volume: 0.7 };
  }
}
let settings = loadSettings();

function saveSettings() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
  listeners.forEach(fn => { try { fn(settings); } catch { /* ignore */ } });
}

const reduceMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

/* ------------------------------------------------------------------ */
/* Sound                                                                */
/* ------------------------------------------------------------------ */

let ctx = null, out = null, noiseBuf = null;

function audio() {
  if (!settings.sound) return null;
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    try { ctx = new C({ latencyHint: 'interactive' }); } catch { return null; }
    out = ctx.createGain();
    out.gain.value = settings.volume;
    // gentle limiter so several sounds at once never get harsh
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 4;
    comp.attack.value = 0.002; comp.release.value = 0.08;
    out.connect(comp); comp.connect(ctx.destination);
    // 1.2 s of white noise — long enough that a swoosh never loops audibly
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.2), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// a sine/triangle blip with a soft attack and an exponential tail
function tone(c, { f, f2, at = 0, dur = 0.08, gain = 0.05, type = 'sine', attack = 0.004 }) {
  const t0 = c.currentTime + at;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur * 0.9);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(out);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

// a filtered noise tick (kept for custom sounds)
function click(c, { f = 3000, q = 1.2, at = 0, dur = 0.018, gain = 0.2, type = 'bandpass' }) {
  const t0 = c.currentTime + at;
  const s = c.createBufferSource();
  s.buffer = noiseBuf;
  const flt = c.createBiquadFilter();
  flt.type = type; flt.frequency.value = f; flt.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  s.connect(flt); flt.connect(g); g.connect(out);
  s.start(t0); s.stop(t0 + dur + 0.01);
}

// The whole palette is built on swooshes: filtered noise whose colour slides
// up (opening, arriving) or down (closing, leaving). No pitched "bloop"
// sweeps — those are what sounded like water drops.
//   from/to: centre frequency of the band at start/end (Hz)
//   peak:    where the loudest moment sits (0..1 of the duration)
//   pan:     -1 left … 1 right (a panel sliding in from the right whooshes there)
function swoosh(c, { from = 600, to = 2400, at = 0, dur = 0.16, gain = 0.05, q = 0.8, peak = 0.35, pan = 0, air = 7000 }) {
  const t0 = c.currentTime + at;
  const s = c.createBufferSource();
  s.buffer = noiseBuf; s.loop = true;
  // random start inside the noise so two swooshes never sound identical
  const offset = Math.random() * (noiseBuf.duration - dur - 0.05);
  const band = c.createBiquadFilter();
  band.type = 'bandpass'; band.Q.value = q;
  band.frequency.setValueAtTime(from, t0);
  band.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const soft = c.createBiquadFilter();           // takes the hiss off the top
  soft.type = 'lowpass'; soft.frequency.value = air; soft.Q.value = 0.5;
  // band-filtered noise is quiet, very short puffs even more so — make up for it
  const level = gain * 3 * (dur < 0.08 ? 2.2 : 1);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(level, t0 + dur * peak);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  let node = g;
  if (pan && c.createStereoPanner) {
    const p = c.createStereoPanner();
    p.pan.setValueAtTime(pan, t0);
    p.pan.linearRampToValueAtTime(pan * 0.25, t0 + dur);
    g.connect(p); node = p;
  }
  s.connect(band); band.connect(soft); soft.connect(g); node.connect(out);
  s.start(t0, Math.max(0, offset)); s.stop(t0 + dur + 0.03);
}

// a very soft, short bell — only for "done" moments, never on plain clicks
function chime(c, { f, at = 0, dur = 0.5, gain = 0.014 }) {
  tone(c, { f, at, dur, gain, attack: 0.01 });
  tone(c, { f: f * 2, at, dur: dur * 0.6, gain: gain * 0.25, attack: 0.01 });
}

const SOUNDS = {
  // every-day button press: a tiny puff of air
  tap: c => swoosh(c, { from: 1600, to: 3800, dur: 0.05, gain: 0.04, peak: 0.2, q: 0.9 }),
  // big surfaces (rows, cards): a slightly fuller brush
  soft: c => swoosh(c, { from: 900, to: 2600, dur: 0.07, gain: 0.038, peak: 0.25, q: 0.8 }),
  // switches, checkboxes, status picks, filter chips
  toggle: c => swoosh(c, { from: 2400, to: 4600, dur: 0.045, gain: 0.034, peak: 0.2, q: 1.1 }),
  // slider / stepper detent
  tick: c => swoosh(c, { from: 3600, to: 4800, dur: 0.02, gain: 0.022, peak: 0.15, q: 1.4 }),
  // folder opens / closes
  expand: c => swoosh(c, { from: 450, to: 2800, dur: 0.22, gain: 0.05, peak: 0.45 }),
  collapse: c => swoosh(c, { from: 2600, to: 450, dur: 0.18, gain: 0.044, peak: 0.3 }),
  // menus / popovers
  pop: c => swoosh(c, { from: 800, to: 3000, dur: 0.12, gain: 0.04, peak: 0.35 }),
  // sheets, panels, dialogs
  open: c => swoosh(c, { from: 300, to: 2600, dur: 0.3, gain: 0.055, peak: 0.45, pan: 0.35 }),
  close: c => swoosh(c, { from: 2600, to: 300, dur: 0.24, gain: 0.048, peak: 0.3, pan: 0.35 }),
  // done / saved / logged in: rising swoosh that settles into a soft bell
  success: c => { swoosh(c, { from: 500, to: 3200, dur: 0.26, gain: 0.045, peak: 0.5 }); chime(c, { f: 1047, at: 0.16 }); chime(c, { f: 1568, at: 0.24, gain: 0.011 }); },
  // something went wrong: a falling swoosh with a low, soft knock
  error: c => { swoosh(c, { from: 1800, to: 280, dur: 0.24, gain: 0.05, peak: 0.25 }); tone(c, { f: 160, at: 0.02, dur: 0.14, gain: 0.04, type: 'triangle', attack: 0.006 }); },
  // destructive buttons (archive, delete): a short downward brush
  warn: c => swoosh(c, { from: 2400, to: 700, dur: 0.09, gain: 0.042, peak: 0.25 }),
  // AI: message flies off / answer lands
  send: c => swoosh(c, { from: 500, to: 4200, dur: 0.24, gain: 0.05, peak: 0.55 }),
  receive: c => { swoosh(c, { from: 3200, to: 800, dur: 0.22, gain: 0.04, peak: 0.3 }); chime(c, { f: 1319, at: 0.12, gain: 0.01 }); },
  // pick up / drop a box on the canvas
  lift: c => swoosh(c, { from: 700, to: 2000, dur: 0.08, gain: 0.034, peak: 0.3 }),
  drop: c => swoosh(c, { from: 2000, to: 600, dur: 0.09, gain: 0.034, peak: 0.25 })
};

const lastPlayed = {};
function play(name) {
  const fn = SOUNDS[name];
  if (!fn || !settings.sound) return;
  const now = performance.now();
  // "expand all" etc. must not stack up into a loud burst
  if (now - (lastPlayed[name] || 0) < 45) return;
  lastPlayed[name] = now;
  const c = audio();
  if (!c) return;
  try { fn(c); } catch { /* audio graph error — stay silent */ }
}

/* ------------------------------------------------------------------ */
/* Haptics                                                              */
/* ------------------------------------------------------------------ */
// Android / Chrome: navigator.vibrate. iPhone (iOS 18+): toggling a native
// <input switch> fires the Taptic Engine, so a hidden one is clicked.
// Desktop browsers have no haptics API — there it is silently skipped.

const PATTERNS = { light: 6, select: 4, medium: 12, heavy: 20, success: [8, 50, 12], error: [16, 40, 16, 40, 16], warn: [12, 30, 12] };
const isTouch = () => { try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; } };
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let iosSwitch = null;

function haptic(kind = 'light') {
  if (!settings.haptics || !isTouch()) return;
  const p = PATTERNS[kind] ?? PATTERNS.light;
  if (typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(p); return; } catch { /* not allowed */ }
  }
  if (isIOS()) {
    try {
      if (!iosSwitch) {
        iosSwitch = document.createElement('label');
        iosSwitch.setAttribute('aria-hidden', 'true');
        iosSwitch.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9px;top:-9px;overflow:hidden';
        const inp = document.createElement('input');
        inp.type = 'checkbox'; inp.setAttribute('switch', ''); inp.tabIndex = -1;
        iosSwitch.appendChild(inp);
        document.body.appendChild(iosSwitch);
      }
      iosSwitch.click();
      if (Array.isArray(p) && p.length > 2) setTimeout(() => iosSwitch && iosSwitch.click(), 90);
    } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* Spring press                                                         */
/* ------------------------------------------------------------------ */

// damped spring sampled into a CSS linear() easing — the "Apple" settle
function springEasing(stiffness = 420, damping = 22, mass = 1) {
  const dt = 1 / 120;
  let x = 0, v = 0, t = 0;
  const pts = [0];
  while (t < 2) {
    const a = (-stiffness * (x - 1) - damping * v) / mass;
    v += a * dt; x += v * dt; t += dt;
    pts.push(x);
    if (Math.abs(1 - x) < 0.001 && Math.abs(v) < 0.01) break;
  }
  const step = Math.max(1, Math.floor(pts.length / 40));
  const sampled = pts.filter((_, i) => i % step === 0);
  sampled[sampled.length - 1] = 1;
  return { easing: `linear(${sampled.map(n => +n.toFixed(4)).join(', ')})`, duration: Math.round(t * 1000) };
}
let SPRING = null;
function spring() {
  if (SPRING) return SPRING;
  let ok = false;
  try { ok = CSS.supports('animation-timing-function', 'linear(0, 1)'); } catch { /* old browser */ }
  SPRING = ok ? springEasing() : { easing: 'cubic-bezier(.2,1.4,.4,1)', duration: 380 };
  return SPRING;
}

function press(el) {
  if (reduceMotion() || typeof el.animate !== 'function') return;
  const r = el.getBoundingClientRect();
  const big = Math.max(r.width, r.height);
  if (!big) return;
  // press depth ≈ 3px whatever the size: small buttons dip more, rows barely
  const s = Math.max(0.92, 1 - 3 / big);
  if (s > 0.997) return;
  let down;
  try {
    down = el.animate([{ scale: '1' }, { scale: String(s) }], { duration: 90, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' });
  } catch { return; }
  const release = () => {
    window.removeEventListener('pointerup', release, true);
    window.removeEventListener('pointercancel', release, true);
    window.removeEventListener('dragstart', release, true);
    const sp = spring();
    try {
      const cur = getComputedStyle(el).scale;
      down.cancel();
      el.animate([{ scale: cur && cur !== 'none' ? cur : String(s) }, { scale: '1' }], { duration: sp.duration, easing: sp.easing });
    } catch { down.cancel(); }
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  window.addEventListener('dragstart', release, true);
}

/* ------------------------------------------------------------------ */
/* What a click should sound like                                       */
/* ------------------------------------------------------------------ */

const INTERACTIVE = [
  'button', 'a[href]', '[role="button"]', '[role="tab"]', '[role="menuitem"]', '[role="switch"]', '[role="option"]',
  'input[type="checkbox"]', 'input[type="radio"]', 'select', 'summary', 'label[for]',
  '.group-head', '.process-item', '.panel-item', '.hub-card', '.section-card'
].join(',');

function soundFor(el) {
  const ds = el.dataset && el.dataset.sound;
  if (ds) return ds === 'off' ? null : ds;
  const cls = typeof el.className === 'string' ? el.className : '';
  if (el.matches('input[type="checkbox"], input[type="radio"], [role="switch"], .switch, .toggle')) return 'toggle';
  if (/danger|delete|confirm-yes|remove/.test(cls)) return 'warn';
  if (el.matches('.group-head')) return null;          // the folder itself plays expand/collapse
  if (el.matches('.process-item, .panel-item, .hub-card, .section-card, .section-tile')) return 'soft';
  if (el.closest('.status-menu, .aip-menu, .gm-menu, .sel-ctx-menu, .hs-info-menu, .sheets-col-filter-popup')) return 'toggle';
  if (el.matches('.hs-chip')) return 'toggle';
  return 'tap';
}

function hapticFor(name) {
  if (name === 'warn') return 'warn';
  if (name === 'toggle' || name === 'tick') return 'select';
  return 'light';
}

/* ------------------------------------------------------------------ */
/* Enter / exit motion for things that mount and unmount                */
/* ------------------------------------------------------------------ */
// React removes a closed dialog/menu right away. To let it animate out, a
// visual copy ("ghost") is put back in its place for ~200 ms with the
// .feel-leaving class, then removed. The copy is inert and click-through,
// so the app never sees it.

const SURFACES = [
  { sel: '.modal-backdrop, .pdf-modal-backdrop, .confirm-backdrop, .ai-popup-backdrop, .hs-modal-backdrop, .hs-drawer-backdrop, .rd-backdrop', open: 'open', close: 'close', hap: 'medium' },
  { sel: '.aip', open: 'open', close: 'close', hap: 'medium' },
  { sel: '.editor-sidebar', open: 'open', close: 'close', hap: 'light' },
  { sel: '.aip-drawer', open: 'pop', close: null },
  { sel: '.gm-menu, .status-menu, .sel-ctx-menu, .multi-menu, .notif-panel, .pill-dropdown, .aip-menu, .hs-info-menu, .sheets-col-filter-popup', open: 'pop', close: null },
  { sel: '.hs-toast', open: null, close: null }
];
const ALL_SEL = SURFACES.map(s => s.sel).join(', ');
const surfaceOf = el => SURFACES.find(s => el.matches(s.sel));

// last scroll positions, so a ghost of a scrolled panel doesn't jump to top
const scrolled = new Map();

function findSurface(node) {
  if (!(node instanceof Element)) return null;
  if (node.matches(ALL_SEL)) return node;
  // a wrapper that only exists to hold the surface (portal / fragment div)
  const first = node.firstElementChild;
  if (first && node.childElementCount <= 2 && first.matches(ALL_SEL)) return first;
  return null;
}

function copyLiveState(src, dst) {
  const a = src.querySelectorAll('input, textarea, select');
  if (a.length) {
    const b = dst.querySelectorAll('input, textarea, select');
    a.forEach((el, i) => {
      const g = b[i];
      if (!g) return;
      try {
        if (el.type === 'checkbox' || el.type === 'radio') g.checked = el.checked;
        else g.value = el.value;
      } catch { /* file inputs */ }
    });
  }
  // canvases inside (thumbnails, charts) — copy pixels
  const ca = src.querySelectorAll('canvas');
  if (ca.length) {
    const cb = dst.querySelectorAll('canvas');
    ca.forEach((el, i) => { try { cb[i]?.getContext('2d')?.drawImage(el, 0, 0); } catch { /* tainted */ } });
  }
}

function restoreScroll(src, dst) {
  if (!scrolled.size) return;
  let srcAll = null, dstAll = null;
  scrolled.forEach((pos, el) => {
    if (el === src) { dst.scrollTop = pos.top; dst.scrollLeft = pos.left; return; }
    if (!src.contains(el)) return;
    if (!srcAll) { srcAll = Array.from(src.querySelectorAll('*')); dstAll = dst.querySelectorAll('*'); }
    const i = srcAll.indexOf(el);
    const d = i >= 0 ? dstAll[i] : null;
    if (d) { d.scrollTop = pos.top; d.scrollLeft = pos.left; }
  });
}

function ghost(node, parent, before) {
  if (!parent || !parent.isConnected || reduceMotion()) return;
  let g;
  try { g = node.cloneNode(true); } catch { return; }
  g.classList.add('feel-leaving');
  g.setAttribute('aria-hidden', 'true');
  g.inert = true;
  g.removeAttribute('id');
  g.querySelectorAll('[id]').forEach(x => x.removeAttribute('id'));
  copyLiveState(node, g);
  try {
    parent.insertBefore(g, before && before.parentNode === parent ? before : null);
  } catch { return; }
  restoreScroll(node, g);
  let gone = false;
  const done = () => { if (gone) return; gone = true; g.remove(); };
  g.addEventListener('animationend', e => { if (e.target === g) done(); });
  setTimeout(done, 420);
}

let lastSurfaceSound = 0;
function surfaceSound(name, hap) {
  if (!name) return;
  const now = performance.now();
  if (now - lastSurfaceSound < 90) return;  // a dialog swapping for another plays once
  lastSurfaceSound = now;
  play(name);
  if (hap) haptic(hap);
}

function onMutations(records) {
  const added = [];
  for (const r of records) r.addedNodes.forEach(n => { const s = findSurface(n); if (s && !s.classList.contains('feel-leaving')) added.push({ s, parent: r.target }); });
  for (const r of records) {
    r.removedNodes.forEach(n => {
      const s = findSurface(n);
      if (!s || s.classList.contains('feel-leaving')) return;
      const kind = surfaceOf(s);
      // replaced in the same render (e.g. one menu swapped for another) → no exit
      if (added.some(a => a.parent === r.target && surfaceOf(a.s) === kind)) return;
      ghost(n, r.target, r.nextSibling);
      surfaceSound(kind?.close, null);
    });
  }
  for (const a of added) {
    const kind = surfaceOf(a.s);
    surfaceSound(kind?.open, kind?.hap);
  }
}

/* ------------------------------------------------------------------ */
/* Install                                                              */
/* ------------------------------------------------------------------ */

let installed = false;
function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  // press: sound + haptic + spring, as early as possible (pointerdown)
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const el = t.closest(INTERACTIVE);
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    // boxes on the diagram canvas: lift sound only, never scaled (drag maths)
    const onCanvas = el.closest('.diagram-canvas');
    if (onCanvas && !el.matches('button')) return;
    // data-sound="off": the element plays its own sound (or none) but still springs
    const name = el.closest('[data-sound="off"]') ? null : soundFor(el);
    if (name) play(name);
    if (name && e.pointerType !== 'mouse') haptic(hapticFor(name));
    if (!onCanvas && !el.matches('input, select, label, a[href]')) press(el);
  }, true);

  // boxes on the canvas: a soft "lift" when grabbed
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const node = e.target instanceof Element && e.target.closest('.diagram-canvas .node');
    if (!node || e.target.closest('button, input, textarea, [contenteditable="true"]')) return;
    play('lift');
    if (e.pointerType !== 'mouse') haptic('select');
  }, true);

  // sliders: a detent tick per step, like the iOS picker
  let lastTick = 0;
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== 'range') return;
    const now = performance.now();
    if (now - lastTick < 35) return;
    lastTick = now;
    play('tick');
    haptic('select');
  }, true);

  // keyboard activation (Enter / Space on a focused button) sounds too
  document.addEventListener('keydown', (e) => {
    if (e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
    const el = document.activeElement;
    if (!(el instanceof Element) || !el.matches('button, [role="button"]') || el.disabled) return;
    const name = soundFor(el);
    if (name) play(name);
  }, true);

  // remember scroll positions for exit ghosts
  document.addEventListener('scroll', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (!t.closest(ALL_SEL)) return;
    scrolled.set(t, { top: t.scrollTop, left: t.scrollLeft });
    if (scrolled.size > 60) {
      for (const k of scrolled.keys()) { if (!k.isConnected) scrolled.delete(k); }
    }
  }, true);

  // enter / exit of panels, menus, sheets, dialogs
  const start = () => {
    try { new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true }); } catch { /* old browser */ }
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });

  // the audio context may only start after a user gesture — warm it up then
  const warm = () => { audio(); window.removeEventListener('pointerdown', warm, true); window.removeEventListener('keydown', warm, true); };
  window.addEventListener('pointerdown', warm, true);
  window.addEventListener('keydown', warm, true);
}

export const feel = {
  install,
  play,
  haptic,
  /** play + haptic in one go: feel.signal('success') */
  signal(name, hap) { play(name); haptic(hap || (name === 'error' ? 'error' : name === 'success' ? 'success' : 'light')); },
  get enabled() { return settings.sound || settings.haptics; },
  get settings() { return { ...settings }; },
  setEnabled(on) {
    settings = { ...settings, sound: !!on, haptics: !!on };
    saveSettings();
    if (on) { play('toggle'); haptic('select'); }
  },
  setVolume(v) {
    settings = { ...settings, volume: Math.max(0, Math.min(1, v)) };
    if (out) out.gain.value = settings.volume;
    saveSettings();
  },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  reduceMotion
};

// handy from the browser console: almFeel.play('expand')
try { window.almFeel = feel; } catch { /* no window */ }

export default feel;
