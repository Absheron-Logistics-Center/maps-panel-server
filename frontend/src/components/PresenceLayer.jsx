// PresenceLayer.jsx — live cursors. Everyone on the same page sees the
// other people's mouse pointer with their name under it. Nothing else:
// your own pointer is never drawn.
//
// Positions are sent relative to the page's main area, so different screen
// sizes, scroll positions and diagram zoom levels still line up:
//   diagram canvas  → x and y as fractions of the canvas   (mode "f")
//   lists / tables  → x as a fraction, y in pixels from the top (mode "p")
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { getToken } from '../api/client.js';

const API_URL = import.meta.env.VITE_API_URL || '';
const SEND_MS = 50;

function findRoot() {
  const canvas = document.querySelector('.diagram-canvas');
  if (canvas) return { el: canvas, m: 'f' };
  const table = document.querySelector('.hs-table');
  if (table) return { el: table, m: 'p' };
  const wrap = document.querySelector('.home-wrap');
  if (wrap) return { el: wrap, m: 'p' };
  return { el: document.body, m: 'p' };
}

function pageLabel(page) {
  if (/^\/is-axislari\/hesabat/.test(page)) return 'İş axışları · hesabat';
  if (/^\/is-axislari\/./.test(page)) {
    const t = document.querySelector('.back-chip .label')?.textContent?.trim();
    return t ? `Diaqram: ${t}` : 'Diaqram';
  }
  if (page === '/is-axislari') return 'İş axışları';
  if (/^\/normativ-senedler\/hesabat/.test(page)) return 'Normativ sənədlər · hesabat';
  if (page === '/normativ-senedler') return 'Normativ sənədlər';
  if (/^\/sablonlar\/hesabat/.test(page)) return 'Şablonlar · hesabat';
  if (page === '/sablonlar') return 'Şablonlar';
  if (/^\/vezife-telimatlari\/hesabat/.test(page)) return 'Vəzifə təlimatları · hesabat';
  if (page === '/vezife-telimatlari') return 'Vəzifə təlimatları';
  return 'Əsas səhifə';
}

function textOn(hex) {
  const h = String(hex || '#000').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#1f2937' : '#ffffff';
}

function cid() {
  try {
    let c = sessionStorage.getItem('presence-cid');
    if (!c) { c = 'c' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4); sessionStorage.setItem('presence-cid', c); }
    return c;
  } catch { return 'c' + Math.random().toString(36).slice(2, 14); }
}

export default function PresenceLayer({ page, me }) {
  const [enabled, setEnabled] = useState(false);
  const [roster, setRoster] = useState([]);
  const [cursors, setCursors] = useState({});        // cid -> { x, y, m, v, at }
  const [, setTick] = useState(0);                   // re-place cursors on scroll / resize
  const myCid = useMemo(cid, []);
  const pageRef = useRef(page);
  const last = useRef({ x: null, y: null, v: false });
  const sendState = useRef({ busy: false, pending: null, timer: null, lastAt: 0 });

  // only on the own server (Vercel instances do not share memory)
  useEffect(() => {
    let off = false;
    fetch(`${API_URL}/api/system/version`, { cache: 'no-store' })
      .then(r => r.json()).then(v => { if (!off) setEnabled(v?.where === 'server'); })
      .catch(() => {});
    return () => { off = true; };
  }, []);

  /* ---------------- sending ---------------- */
  const post = useCallback((body) => {
    const st = sendState.current;
    if (st.busy) { st.pending = { ...(st.pending || {}), ...body }; return; }
    st.busy = true;
    st.lastAt = Date.now();
    const token = getToken();
    fetch(`${API_URL}/api/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ cid: myCid, ...body })
    }).catch(() => {}).finally(() => {
      st.busy = false;
      if (st.pending) { const p = st.pending; st.pending = null; post(p); }
    });
  }, [myCid]);

  const coords = useCallback((clientX, clientY) => {
    const { el, m } = findRoot();
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = (clientX - r.left) / r.width;
    const y = m === 'f' ? (clientY - r.top) / r.height : (clientY - r.top);
    return { x, y, m };
  }, []);

  const sendCursor = useCallback((extra = {}) => {
    const l = last.current;
    const c = l.x == null ? null : coords(l.x, l.y);
    const body = {
      page: pageRef.current,
      ...(c ? c : {}),
      v: !!(l.v && c),
      ...extra
    };
    const st = sendState.current;
    const wait = SEND_MS - (Date.now() - st.lastAt);
    if (wait > 0 && !extra.page) {
      clearTimeout(st.timer);
      st.timer = setTimeout(() => post(body), wait);
      return;
    }
    post(body);
  }, [coords, post]);

  /* ---------------- receiving ---------------- */
  useEffect(() => {
    if (!enabled || !me) return;
    const token = getToken();
    if (!token) return;
    const url = `${API_URL}/api/presence/stream?token=${encodeURIComponent(token)}&cid=${myCid}&page=${encodeURIComponent(pageRef.current)}&title=${encodeURIComponent(pageLabel(pageRef.current))}`;
    const es = new EventSource(url);
    es.addEventListener('hello', e => { try { setRoster(JSON.parse(e.data).roster || []); sendCursor({ page: pageRef.current, title: pageLabel(pageRef.current) }); } catch { /* ignore */ } });
    es.addEventListener('roster', e => { try { setRoster(JSON.parse(e.data) || []); } catch { /* ignore */ } });
    es.addEventListener('bye', e => {
      try { const { cid: c } = JSON.parse(e.data); setCursors(prev => { const n = { ...prev }; delete n[c]; return n; }); } catch { /* ignore */ }
    });
    es.addEventListener('cur', e => {
      try {
        const d = JSON.parse(e.data);
        setCursors(prev => ({
          ...prev,
          [d.cid]: {
            ...(prev[d.cid] || {}),
            ...(d.x != null ? { x: d.x, y: d.y, m: d.m } : {}),
            v: d.v,
            at: Date.now()
          }
        }));
      } catch { /* ignore */ }
    });
    return () => es.close();
  }, [enabled, me?.username, myCid, sendCursor]);

  // page changed → tell the others, forget cursors of the old page
  useEffect(() => {
    pageRef.current = page;
    setCursors({});
    if (!enabled) return;
    const t = setTimeout(() => sendCursor({ page, title: pageLabel(page) }), 600); // diagram title appears after load
    return () => clearTimeout(t);
  }, [page, enabled, sendCursor]);

  /* ---------------- local input ---------------- */
  useEffect(() => {
    if (!enabled) return;
    const onMove = e => { last.current = { x: e.clientX, y: e.clientY, v: true }; sendCursor(); };
    const onLeave = e => { if (!e.relatedTarget) { last.current.v = false; sendCursor(); } };
    const onScroll = () => { setTick(t => t + 1); if (last.current.v) sendCursor(); };
    const onResize = () => setTick(t => t + 1);
    const onVis = () => { if (document.hidden) { last.current.v = false; sendCursor(); } };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('mouseout', onLeave);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('mouseout', onLeave);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [enabled, sendCursor]);

  // fade idle cursors
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, [enabled]);

  if (!enabled) return null;

  // only other people: never your own pointer, not even from your other tab
  const others = roster.filter(r => r.cid !== myCid && r.username !== me?.username);
  const here = others.filter(r => r.page === page);
  const { el: rootEl, m: rootMode } = findRoot();
  const rr = rootEl.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const now = Date.now();

  function place(c) {
    if (c.x == null) return null;
    const left = rr.left + c.x * rr.width;
    const top = c.m === 'f' ? rr.top + c.y * rr.height : rr.top + c.y;
    const pad = 10;
    const edge = left < pad || top < pad || left > vw - pad || top > vh - pad;
    return { left: Math.max(pad, Math.min(vw - pad, left)), top: Math.max(pad, Math.min(vh - pad, top)), edge, rawTop: top };
  }

  const layer = (
    <div className="pr-layer" aria-hidden="true">
      {here.map(r => {
        const c = cursors[r.cid];
        if (!c || !c.v || (rootMode !== c.m && c.m)) return null;
        const p = place(c);
        if (!p) return null;
        const idle = now - (c.at || 0) > 30000;
        const fg = textOn(r.color);
        return (
          <div
            key={r.cid}
            className={`pr-cursor ${p.edge ? 'edge' : ''} ${idle ? 'idle' : ''}`}
            style={{ transform: `translate(${p.left}px, ${p.top}px)`, '--pc': r.color, '--pf': fg }}
          >
            <svg className="pr-arrow" width="20" height="22" viewBox="0 0 20 22">
              <path d="M2.2 1.6 L2.2 17.6 L6.6 13.4 L9.6 20.2 L12.6 18.9 L9.7 12.2 L15.6 12 Z" />
            </svg>
            <span className="pr-name">{r.name}</span>
          </div>
        );
      })}

    </div>
  );

  return createPortal(layer, document.body);
}
