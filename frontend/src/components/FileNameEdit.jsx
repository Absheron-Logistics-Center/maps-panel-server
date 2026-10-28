import { useState, useRef, useEffect } from 'react';
import FileTypePill from './FileTypePill.jsx';

/*
  Uploaded file's name + its type pill, e.g.  "wedwdiwd [PDF]".
  Click the name (admin) to rename it; Enter / leaving saves, Esc cancels.
  The extension never changes — only the name part is edited.
  Click the pill to open the file.
*/
const splitName = (fn) => {
  const m = /^(.*?)(\.[a-z0-9]{2,5})?$/i.exec(String(fn || ''));
  return { base: m?.[1] || '', ext: m?.[2] || '' };
};

export default function FileNameEdit({ filename, editable, onRename, onOpen }) {
  const { base, ext } = splitName(filename);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(base);
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (!editing) setDraft(base); }, [base, editing]);
  useEffect(() => { if (editing) { ref.current?.focus(); ref.current?.select(); } }, [editing]);

  async function commit() {
    const v = draft.trim();
    setEditing(false);
    if (!v || v === base) { setDraft(base); return; }
    setSaving(true);
    try { await onRename(`${v}${ext}`); }
    catch (e) { alert('Ad dəyişdirilmədi: ' + (e.message || e)); setDraft(base); }
    finally { setSaving(false); }
  }

  return (
    <span className="fn-edit" onClick={(e) => e.stopPropagation()}>
      {editing ? (
        <span className="fn-input-wrap">
          <input
            ref={ref}
            className="fn-input"
            value={draft}
            size={Math.max(6, Math.min(40, draft.length + 1))}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { setDraft(base); setEditing(false); }
            }}
          />
          <span className="fn-ext">{ext}</span>
        </span>
      ) : (
        <button
          type="button"
          className={`fn-name ${editable ? 'editable' : ''} ${saving ? 'saving' : ''}`}
          title={editable ? `Fayl adını dəyiş: ${filename}` : filename}
          onClick={() => (editable ? setEditing(true) : onOpen?.())}
        >
          {draft || base}
        </button>
      )}
      <button type="button" className="fn-pill" onClick={() => onOpen?.()} title={`Aç: ${filename}`}>
        <FileTypePill filename={filename} className="ft-inline" />
      </button>
    </span>
  );
}
