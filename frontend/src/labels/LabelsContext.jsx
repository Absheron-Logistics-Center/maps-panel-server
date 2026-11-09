import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { Pencil } from 'lucide-react';
import { api } from '../api/client.js';
import { setOverrides, setOverride, label, subscribe } from './labelStore.js';

const LabelsCtx = createContext({
  t: (id, fallback) => fallback,
  raw: (id, fallback) => fallback,
  tByText: (text) => text,
  rawByText: (text) => text,
  LabelPen: () => null,
  loaded: false,
  labelEdit: false,
  setLabelEdit: () => {},
  applyLabel: () => {},
  resetToDefault: () => {},
  commit: async () => {},
  pendingCount: 0,
  saving: false,
  savedTick: 0,
  refresh: async () => {}
});

// Stable label id derived from the default text, so the SAME string appearing
// in several places shares one override (edit it once, it changes everywhere),
// while different strings stay independent — no per-call-site id bookkeeping.
export function textId(text) {
  return 'ui.' + String(text).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
}

// enabled = true once there's an authenticated user.
export function LabelsProvider({ children, enabled }) {
  const [, forceRender] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const [labelEdit, setLabelEdit] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(0);
  const pending = useRef(new Map()); // id -> text ('' means reset to default)

  const refresh = useCallback(async () => {
    try {
      const data = await api.getLabels();
      setOverrides(data || {});
    } catch (e) {
      // fall back to defaults silently
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { if (enabled) refresh(); }, [enabled, refresh]);
  useEffect(() => subscribe(() => forceRender(n => n + 1)), []);

  // Body flag transient popups/menus read so they stay open ("freeze") while
  // the editor is renaming text inside them, instead of closing on the click.
  useEffect(() => {
    document.body.dataset.labelEdit = labelEdit ? '1' : '';
    return () => { document.body.dataset.labelEdit = ''; };
  }, [labelEdit]);

  const applyLabel = useCallback((id, text) => {
    setOverride(id, text);
    pending.current.set(id, text);
    setPendingCount(pending.current.size);
  }, []);

  const resetToDefault = useCallback((id) => { applyLabel(id, ''); }, [applyLabel]);

  const commit = useCallback(async () => {
    if (!pending.current.size) return;
    setSaving(true);
    const entries = [...pending.current.entries()];
    try {
      for (const [id, text] of entries) {
        if (text && text.trim()) await api.setLabel(id, text.trim());
        else await api.resetLabel(id);
        pending.current.delete(id);
      }
      setPendingCount(pending.current.size);
      setSavedTick(n => n + 1);
    } catch (e) {
      await refresh();
      throw e;
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  // Plain string (attributes: placeholder/title, or JS use). Never an element.
  const raw = useCallback((id, fallback) => label(id, fallback), []);
  const rawByText = useCallback((text) => label(textId(text), text), []);

  // Child text. Plain string normally (identical to before); an <EditableLabel>
  // element in edit mode. Every call site renders t()'s result as a child.
  const t = useCallback((id, fallback) => {
    const text = label(id, fallback);
    if (!labelEdit) return text;
    return <EditableLabel id={id} text={text} fallback={fallback} onApply={applyLabel} />;
  }, [labelEdit, applyLabel]);

  const tByText = useCallback((text) => t(textId(text), text), [t]);

  // Standalone pen for text that can't be a child (placeholders, icon-only bits).
  const LabelPen = useCallback(({ id, text, fallback }) => {
    if (!labelEdit) return null;
    const rid = id || textId(text ?? fallback);
    const cur = label(rid, fallback ?? text);
    return <InlinePen id={rid} current={cur} fallback={fallback ?? text} onApply={applyLabel} />;
  }, [labelEdit, applyLabel]);

  return (
    <LabelsCtx.Provider value={{
      t, raw, tByText, rawByText, LabelPen,
      loaded, labelEdit, setLabelEdit,
      applyLabel, resetToDefault, commit,
      pendingCount, saving, savedTick, refresh
    }}>
      {children}
    </LabelsCtx.Provider>
  );
}

// In-place editable string. Pen icon or double-click edits; single click is
// swallowed so it never triggers the underlying control (navigate/delete/close).
function EditableLabel({ id, text, fallback, onApply }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(text);
  const inputRef = useRef(null);

  useEffect(() => { if (!editing) setVal(text); }, [text, editing]);
  useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  function begin(e) { e.preventDefault(); e.stopPropagation(); setVal(text); setEditing(true); }
  function commitLocal() {
    setEditing(false);
    const next = val.trim();
    if (next !== text) onApply(id, next); // '' => reset to default
  }
  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); commitLocal(); }
    else if (e.key === 'Escape') { e.preventDefault(); setVal(text); setEditing(false); }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="tedit-input"
        value={val}
        size={Math.max(4, val.length + 1)}
        placeholder={fallback}
        onChange={e => setVal(e.target.value)}
        onKeyDown={onKey}
        onBlur={commitLocal}
        onMouseDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
      />
    );
  }

  const overridden = text !== fallback;
  return (
    <span
      className={'tedit' + (overridden ? ' is-overridden' : '')}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => { e.preventDefault(); e.stopPropagation(); }}
      onDoubleClick={begin}
      title={'İnterfeys mətni — dəyişmək üçün klikləyin' + (overridden ? ` · standart: ${fallback}` : '')}
    >
      {text}
      <span
        role="button" tabIndex={0} className="tedit-pen" aria-label="Mətni dəyiş"
        onMouseDown={e => e.stopPropagation()} onClick={begin}
      >
        <Pencil size={11} />
      </span>
    </span>
  );
}

// Pen shown next to non-child text (placeholder etc.). Opens the same inline input.
function InlinePen({ id, current, fallback, onApply }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(current);
  const inputRef = useRef(null);
  useEffect(() => { if (!editing) setVal(current); }, [current, editing]);
  useEffect(() => { if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, [editing]);

  function begin(e) { e.preventDefault(); e.stopPropagation(); setVal(current); setEditing(true); }
  function done() { setEditing(false); const n = val.trim(); if (n !== current) onApply(id, n); }
  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); done(); }
    else if (e.key === 'Escape') { e.preventDefault(); setVal(current); setEditing(false); }
  }

  if (editing) {
    return (
      <input
        ref={inputRef} className="tedit-input tedit-input-loose"
        value={val} size={Math.max(6, val.length + 1)} placeholder={fallback}
        onChange={e => setVal(e.target.value)} onKeyDown={onKey} onBlur={done}
        onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
      />
    );
  }
  const overridden = current !== fallback;
  return (
    <span
      role="button" tabIndex={0}
      className={'tedit-pen tedit-pen-loose' + (overridden ? ' is-overridden' : '')}
      aria-label="Mətni dəyiş" title={`İnterfeys mətni: “${current}”`}
      onMouseDown={e => e.stopPropagation()} onClick={begin}
    >
      <Pencil size={11} />
    </span>
  );
}

export function useLabels() { return useContext(LabelsCtx); }
