import { useState, useEffect, useRef, useCallback } from 'react';
import { Archive, Trash2, X, MousePointerSquareDashed } from 'lucide-react';
import './marquee.css';

/*
  Desktop-style selection for the Home pages (all sections).
  - Press on an empty part of the page and drag: a blue box appears, every
    folder / item it touches gets selected (Ctrl/Shift adds to the selection).
  - Ctrl/⌘ + click toggles one item or folder.
  - Right-click a selected one (or the empty page while something is selected)
    -> menu: Arxivlə / Sil.  A bar at the bottom shows the same actions.
  - Esc or a click on the empty page clears it.

  Selectable elements carry data-sel="p:<id>" (item) or "g:<id>" (folder).
*/
export function useMarquee(enabled) {
  const [sel, setSel] = useState(() => new Set());
  const [box, setBox] = useState(null);   // {x, y, w, h} in client px
  const [menu, setMenu] = useState(null); // {x, y}
  const selRef = useRef(sel);
  selRef.current = sel;
  const justDragged = useRef(false);

  const clear = useCallback(() => { setSel(new Set()); setMenu(null); }, []);

  useEffect(() => {
    if (!enabled) { setSel(new Set()); setBox(null); setMenu(null); return undefined; }
    const BLOCK = 'button,a,input,textarea,select,label,[contenteditable="true"],.group-card,.process-item,'
      + '.sel-bar,.sel-menu,[role="dialog"],.rd-backdrop,.modal-backdrop,.modal,header,.topbar,.archive-section';
    let start = null; let base = null; let raf = 0; let last = null;

    function hitTest(x1, y1, x2, y2) {
      const L = Math.min(x1, x2), R = Math.max(x1, x2), T = Math.min(y1, y2), B = Math.max(y1, y2);
      const next = new Set(base);
      document.querySelectorAll('[data-sel]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width && r.right >= L && r.left <= R && r.bottom >= T && r.top <= B) next.add(el.getAttribute('data-sel'));
      });
      return next;
    }
    function frame() {
      raf = 0;
      if (!start || !last) return;
      // auto-scroll near the top / bottom edge
      const edge = 48;
      if (last.y > window.innerHeight - edge) window.scrollBy(0, 14);
      else if (last.y < edge) window.scrollBy(0, -14);
      const sx = start.x - window.scrollX, sy = start.y - window.scrollY;
      setBox({ x: Math.min(sx, last.x), y: Math.min(sy, last.y), w: Math.abs(last.x - sx), h: Math.abs(last.y - sy) });
      setSel(hitTest(sx, sy, last.x, last.y));
      if (last.y > window.innerHeight - edge || last.y < edge) raf = requestAnimationFrame(frame);
    }
    function onDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest(BLOCK) || !e.target.closest('.app-page, .home-page, #root')) return;
      start = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY, moved: false };
      base = e.ctrlKey || e.metaKey || e.shiftKey ? new Set(selRef.current) : new Set();
      setMenu(null);
    }
    function onMove(e) {
      if (!start) return;
      const dx = e.clientX + window.scrollX - start.x, dy = e.clientY + window.scrollY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 5) return;
      if (!start.moved) { start.moved = true; document.body.classList.add('sel-dragging'); window.getSelection()?.removeAllRanges(); }
      e.preventDefault();
      last = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(frame);
    }
    function onUp() {
      if (!start) return;
      if (!start.moved && !base.size) setSel(new Set()); // plain click on empty page
      else if (start.moved) justDragged.current = true;
      start = null; last = null; setBox(null);
      document.body.classList.remove('sel-dragging');
      setTimeout(() => { justDragged.current = false; }, 0);
    }
    function onClickCapture(e) {
      if (justDragged.current) { e.preventDefault(); e.stopPropagation(); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      const el = e.target.closest('[data-sel]');
      if (!el || e.target.closest('button,a,input')) return;
      e.preventDefault(); e.stopPropagation();
      const k = el.getAttribute('data-sel');
      setSel((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
    }
    function onContext(e) {
      if (e.target.closest('input,textarea,[contenteditable="true"],[role="dialog"]')) return;
      const el = e.target.closest('[data-sel]');
      if (el) {
        const k = el.getAttribute('data-sel');
        e.preventDefault();
        if (!selRef.current.has(k)) setSel(new Set([k]));
        setMenu({ x: e.clientX, y: e.clientY });
      } else if (selRef.current.size && !e.target.closest('button,a')) {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }
    }
    function onKey(e) {
      if (e.key === 'Escape' && (selRef.current.size || menu)) { setSel(new Set()); setMenu(null); }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('contextmenu', onContext);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('click', onClickCapture, true);
      document.removeEventListener('contextmenu', onContext);
      document.removeEventListener('keydown', onKey);
      cancelAnimationFrame(raf);
      document.body.classList.remove('sel-dragging');
    };
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // close the right-click menu on any outside click
  useEffect(() => {
    if (!menu) return undefined;
    const off = (e) => { if (!e.target.closest('.sel-menu')) setMenu(null); };
    const t = setTimeout(() => document.addEventListener('mousedown', off), 0);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', off); };
  }, [menu]);

  const ids = (prefix) => [...sel].filter((k) => k.startsWith(prefix + ':')).map((k) => Number(k.slice(2)));
  return {
    sel, box, menu, clear, setMenu,
    isSel: (k) => sel.has(k),
    itemIds: () => ids('p'),
    groupIds: () => ids('g')
  };
}

/* The blue box, the bottom bar and the right-click menu. */
export function MarqueeLayer({ m, itemWord = 'element', onArchive, onDelete, busy }) {
  const nItems = m.itemIds().length, nGroups = m.groupIds().length;
  const total = nItems + nGroups;
  const label = [nItems ? `${nItems} ${itemWord}` : '', nGroups ? `${nGroups} qovluq` : ''].filter(Boolean).join(', ');
  const menuPos = m.menu ? {
    left: Math.min(m.menu.x, window.innerWidth - 220),
    top: Math.min(m.menu.y, window.innerHeight - 140)
  } : null;
  return (
    <>
      {m.box && m.box.w + m.box.h > 4 && (
        <div className="marquee-box" style={{ left: m.box.x, top: m.box.y, width: m.box.w, height: m.box.h }} />
      )}
      {total > 0 && (
        <div className="sel-bar" role="toolbar">
          <span className="sel-bar-count"><MousePointerSquareDashed size={16} /> {total} seçildi <em>({label})</em></span>
          <button className="sel-btn" disabled={busy} onClick={onArchive}><Archive size={15} /> Arxivlə</button>
          <button className="sel-btn danger" disabled={busy} onClick={onDelete}><Trash2 size={15} /> Sil</button>
          <button className="sel-x" title="Seçimi ləğv et (Esc)" onClick={m.clear}><X size={16} /></button>
        </div>
      )}
      {m.menu && total > 0 && (
        <div className="sel-menu" style={menuPos} role="menu" onContextMenu={(e) => e.preventDefault()}>
          <div className="sel-menu-head">{total} seçildi · {label}</div>
          <button role="menuitem" disabled={busy} onClick={() => { m.setMenu(null); onArchive(); }}><Archive size={15} /> Arxivlə</button>
          <button role="menuitem" className="danger" disabled={busy} onClick={() => { m.setMenu(null); onDelete(); }}><Trash2 size={15} /> Sil</button>
          <div className="sel-menu-sep" />
          <button role="menuitem" onClick={m.clear}><X size={15} /> Seçimi ləğv et</button>
        </div>
      )}
    </>
  );
}
