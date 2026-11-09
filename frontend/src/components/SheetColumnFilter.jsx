import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Filter } from 'lucide-react';

export const BLANK_FILTER_VALUE = '';

export function displayFilterValue(v, blankLabel = '(Boş)') {
  return v === BLANK_FILTER_VALUE || v == null || String(v).trim() === ''
    ? blankLabel
    : String(v);
}

/** Unique sorted cell values for a column (empty → BLANK_FILTER_VALUE). */
export function uniqueColumnValues(rows, getValue) {
  const set = new Set();
  for (const row of rows || []) {
    const raw = getValue(row);
    const v = raw == null || String(raw).trim() === '' ? BLANK_FILTER_VALUE : String(raw).trim();
    set.add(v);
  }
  return Array.from(set).sort((a, b) => {
    if (a === BLANK_FILTER_VALUE) return 1;
    if (b === BLANK_FILTER_VALUE) return -1;
    return a.localeCompare(b, 'az', { sensitivity: 'base' });
  });
}

/**
 * Excel-style column filter: funnel button in the header + popup with
 * Search, (Select All), checkboxes, OK / Cancel.
 * Popup is portaled + fixed so table overflow doesn't clip it.
 */
export default function SheetColumnFilter({
  options,
  applied, // Set<string> | null — null means no filter (show all)
  open,
  onToggleOpen,
  onApply,
  onClose,
  searchPlaceholder = 'Search',
  selectAllLabel = '(Select All)',
  blankLabel = '(Boş)',
  okLabel = 'OK',
  cancelLabel = 'Cancel'
}) {
  const btnRef = useRef(null);
  const popupRef = useRef(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState(() => new Set(options));
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setDraft(applied ? new Set(applied) : new Set(options));
  }, [open, applied, options]);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    function place() {
      const r = btnRef.current.getBoundingClientRect();
      const width = Math.min(340, Math.max(260, window.innerWidth * 0.7));
      let left = r.right - width;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      let top = r.bottom + 6;
      const approxH = 320;
      if (top + approxH > window.innerHeight - 8) {
        top = Math.max(8, r.top - approxH - 6);
      }
      setPos({ top, left, width });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e) {
      const t = e.target;
      if (btnRef.current?.contains(t)) return;
      if (popupRef.current?.contains(t)) return;
      onClose?.();
    }
    function onKey(e) {
      if (e.key === 'Escape') onClose?.();
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const filteredOpts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((v) => displayFilterValue(v, blankLabel).toLowerCase().includes(q));
  }, [options, search, blankLabel]);

  const allVisibleSelected =
    filteredOpts.length > 0 && filteredOpts.every((v) => draft.has(v));
  const someVisibleSelected = filteredOpts.some((v) => draft.has(v));
  const isActive =
    applied != null &&
    (applied.size !== options.length || options.some((v) => !applied.has(v)));

  function toggleAll() {
    setDraft((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        filteredOpts.forEach((v) => next.delete(v));
      } else {
        filteredOpts.forEach((v) => next.add(v));
      }
      return next;
    });
  }

  function toggleOne(v) {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }

  function handleOk() {
    const allSelected =
      draft.size >= options.length && options.every((v) => draft.has(v));
    const next = allSelected ? null : new Set(draft);
    // Close popup first so UI feels instant; parent applies filter in a transition.
    onClose?.();
    queueMicrotask(() => onApply(next));
  }

  const popup = open
    ? createPortal(
        <div
          ref={popupRef}
          className="sheets-col-filter-popup"
          role="dialog"
          aria-label="Filter"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          <input
            type="search"
            className="sheets-col-filter-search"
            placeholder={searchPlaceholder}
            value={search}
            autoFocus
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleOk();
              }
            }}
          />

          <div className="sheets-col-filter-list">
            <label className="sheets-col-filter-row sheets-col-filter-all">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                ref={(el) => {
                  if (el) el.indeterminate = !allVisibleSelected && someVisibleSelected;
                }}
                onChange={toggleAll}
              />
              <span>{selectAllLabel}</span>
            </label>

            {filteredOpts.map((v) => (
              <label
                key={v === BLANK_FILTER_VALUE ? '__blank__' : v}
                className="sheets-col-filter-row"
              >
                <input
                  type="checkbox"
                  checked={draft.has(v)}
                  onChange={() => toggleOne(v)}
                />
                <span>{displayFilterValue(v, blankLabel)}</span>
              </label>
            ))}

            {filteredOpts.length === 0 && (
              <div className="sheets-col-filter-empty">—</div>
            )}
          </div>

          <div className="sheets-col-filter-actions">
            <button type="button" className="sheets-col-filter-ok" onClick={handleOk}>
              {okLabel}
            </button>
            <button type="button" className="sheets-col-filter-cancel" onClick={onClose}>
              {cancelLabel}
            </button>
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <div className="sheets-col-filter">
      <button
        ref={btnRef}
        type="button"
        className={`sheets-col-filter-btn ${isActive ? 'active' : ''} ${open ? 'open' : ''}`}
        title="Filter"
        aria-label="Filter"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          onToggleOpen();
        }}
      >
        <Filter size={12} strokeWidth={2.25} />
      </button>
      {popup}
    </div>
  );
}
