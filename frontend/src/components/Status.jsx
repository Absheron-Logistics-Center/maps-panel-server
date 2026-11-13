import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Clock, Signature, CheckCircle2, Hammer, RefreshCw, MessageCircleQuestion, Ban, ChevronDown
} from './icons.jsx';
import { useLabels } from '../labels/LabelsContext.jsx';

// Two independent status sets, one per section:
//   PROCESS_* → İş Axışları (diagrams)
//   DOC_*     → Normativ Sənədlər (pdfs) & Şablonlar (templates)
// Every key has its own icon/color — nothing reused across the same set.

export const PROCESS_STATUS_META = {
  progress:  { id: 'status.progress',  default: 'Planlaşdırılır',          Icon: Clock,                 cls: 'progress' },
  prep:      { id: 'status.prep',      default: 'Hazırlıq prosesindədir',  Icon: Hammer,                cls: 'prep' },
  notdone:   { id: 'status.notdone',   default: 'Müzakirədədir',           Icon: MessageCircleQuestion, cls: 'notdone' },
  done:      { id: 'status.done',      default: 'Təsdiqlənmiş',            Icon: CheckCircle2,          cls: 'done' },
  cancelled: { id: 'status.cancelled', default: 'Ləğv edilmiş',            Icon: Ban,                   cls: 'cancelled' }
};
export const PROCESS_STATUS_ORDER = ['progress', 'prep', 'notdone', 'done', 'cancelled'];

export const DOC_STATUS_META = {
  progress:  { id: 'docstatus.progress',  default: 'Planlaşdırılır',         Icon: Clock,                 cls: 'progress' },
  prep:      { id: 'docstatus.prep',      default: 'Hazırlıq prosesində',    Icon: Hammer,                cls: 'prep' },
  notdone:   { id: 'docstatus.notdone',   default: 'Müzakirədədir',          Icon: MessageCircleQuestion, cls: 'notdone' },
  sign:      { id: 'docstatus.sign',      default: 'İmza prosesindədir',     Icon: Signature,             cls: 'sign' },
  done:      { id: 'docstatus.done',      default: 'Təsdiq edildi',          Icon: CheckCircle2,          cls: 'done' },
  cancelled: { id: 'docstatus.cancelled', default: 'Ləğv edildi',            Icon: Ban,                   cls: 'cancelled' },
  renew:     { id: 'docstatus.renew',     default: 'Yeniləcək',              Icon: RefreshCw,             cls: 'renew' }
};
export const DOC_STATUS_ORDER = ['progress', 'prep', 'notdone', 'sign', 'done', 'cancelled', 'renew'];

// Vəzifə Təlimatları — only two states
export const JOB_STATUS_META = {
  exists:  { id: 'jobstatus.exists',  default: 'Mövcuddur',    Icon: CheckCircle2, cls: 'done' },
  missing: { id: 'jobstatus.missing', default: 'Mövcud deyil', Icon: Ban,          cls: 'cancelled' }
};
export const JOB_STATUS_ORDER = ['exists', 'missing'];

// Back-compat default export — code that hasn't been made kind-aware
// (Diagram.jsx / Home.jsx / NameModal.jsx, all İş Axışları-only) keeps
// working against the process status set.
export const STATUS_META = PROCESS_STATUS_META;
export const STATUS_ORDER = PROCESS_STATUS_ORDER;

function norm(meta, value) {
  return meta[value] ? value : null;
}

// Read-only coloured pill with icon + label. Renders nothing when no status.
export function StatusBadge({ value, size = 14, meta = PROCESS_STATUS_META }) {
  const { t } = useLabels();
  const v = norm(meta, value);
  if (!v) return null;
  const { default: def, Icon, cls, id } = meta[v];
  const label = t(id, def);
  return (
    <span className={`status-badge ${cls}`} title={label}>
      <Icon size={size} />
      <span>{label}</span>
    </span>
  );
}

// Interactive control for admins. Shows the current status and, on click,
// a small menu to pick a status. Viewers get <StatusBadge> instead.
// Pass `meta`/`order` to switch between the İş Axışları and Normativ
// Sənədlər/Şablonlar status sets — defaults to İş Axışları.
export function StatusControl({
  value, editable, onChange, size = 14,
  meta = PROCESS_STATUS_META, order = PROCESS_STATUS_ORDER
}) {
  const { t } = useLabels();
  const v = norm(meta, value);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null); // { left, top, up }
  const ref = useRef(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e) {
      if (document.body.dataset.labelEdit === '1') return;
      if (ref.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // The menu lives in <body> (portal) with fixed coordinates, so no row,
  // hover effect or stacking context of the list can ever paint over it.
  // It opens below the button, or above it when there is no room, and
  // follows the button while the page scrolls.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    function place() {
      const b = btnRef.current?.getBoundingClientRect();
      const m = menuRef.current;
      if (!b) return;
      if (b.bottom < 0 || b.top > window.innerHeight) { setOpen(false); return; }
      const mw = m?.offsetWidth || 180;
      const mh = m?.offsetHeight || 220;
      const gap = 6, edge = 8;
      const roomBelow = window.innerHeight - b.bottom - gap - edge;
      const up = roomBelow < mh && b.top - gap - edge > roomBelow;
      let top = up ? b.top - gap - mh : b.bottom + gap;
      top = Math.max(edge, Math.min(top, window.innerHeight - mh - edge));
      let left = b.right - mw;
      left = Math.max(edge, Math.min(left, window.innerWidth - mw - edge));
      setPos(p => (p && p.left === left && p.top === top && p.up === up) ? p : { left, top, up });
    }
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open]);

  if (!editable) return <StatusBadge value={v} size={size} meta={meta} />;

  const m = v ? meta[v] : null;
  const metaLabel = m ? t(m.id, m.default) : null;

  function pick(next) {
    setOpen(false);
    if (next !== v) onChange(next);
  }

  return (
    <span className={`status-control ${open ? 'is-open' : ''}`} ref={ref} onClick={e => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        className={`pill-chip edit-chip ${m ? m.cls : 'none'}`}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="status-btn-main">
          {m ? <m.Icon size={size} /> : <Clock size={size} />}
          <span>{m ? metaLabel : t('status.placeholder', 'Status')}</span>
        </span>
        <ChevronDown size={13} className="status-btn-chevron" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className={`status-menu portal ${pos?.up ? 'up' : ''}`}
          role="listbox"
          style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
          onClick={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
        >
          {order.map(k => {
            const opt = meta[k];
            return (
              <button
                type="button"
                key={k}
                role="option"
                aria-selected={v === k}
                className={`status-opt ${opt.cls} ${v === k ? 'active' : ''}`}
                onClick={() => pick(k)}
              >
                <opt.Icon size={14} /><span>{t(opt.id, opt.default)}</span>
                {v === k && <CheckCircle2 size={13} className="status-opt-tick" />}
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </span>
  );
}
