import { useState, useRef, useEffect } from 'react';
import { X, Loader2, ChevronDown } from '../icons.jsx';
import { uploadsEnabled, uploadsEnabledReady } from '../../api/client.js';

// Flattens a flat groups array (with optional parentId) into depth-first
// order, so a plain <select> can show nested groups with indentation.
function orderedGroupOptions(groups) {
  const pid = (g) => (g.parentId === undefined || g.parentId === null || g.parentId === 0)
    ? null
    : Number(g.parentId);
  const out = [];
  function walk(parentId, depth) {
    groups
      .filter(g => pid(g) === parentId)
      .forEach(g => {
        out.push({ g, depth });
        walk(g.id, depth + 1);
      });
  }
  walk(null, 0);
  return out;
}

const ALLOWED_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx'];
const ACCEPT_ATTR = '.pdf,.doc,.docx,.xls,.xlsx,application/pdf,application/msword,'
  + 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,'
  + 'application/vnd.ms-excel,'
  + 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

// sheetOptions: unused Sheets rows for this section (pdfs/templates) — the
// chevron next to Başlıq lets you pick one to prefill title/subtitle/group
// instead of typing it, mirroring the "Yeni diaqram" Sheets-dən seç flow.
export default function PdfFormModal({ mode, pdf, groups = [], defaultGroupId, sheetOptions = null, onClose, onSave }) {
  const isEdit = mode === 'edit';
  const [title, setTitle] = useState(isEdit ? (pdf?.title || '') : '');
  const [subtitle, setSubtitle] = useState(isEdit ? (pdf?.subtitle || '') : '');
  const [groupId, setGroupId] = useState(
    isEdit ? (pdf?.groupId ?? defaultGroupId ?? (groups[0]?.id))
           : (defaultGroupId ?? (groups[0]?.id))
  );
  const [sheetId, setSheetId] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [canUpload, setCanUpload] = useState(uploadsEnabled);
  useEffect(() => { uploadsEnabledReady.then(setCanUpload); }, []);
  const sheetMenuRef = useRef(null);

  const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB

  const groupName = (groups.find(g => Number(g.id) === Number(groupId))?.name || '').trim();

  // Only unused sheet rows (no itemId/processId yet) whose struktur adı
  // matches the currently selected group (or is empty, i.e. unassigned).
  const visibleSheets = (() => {
    if (!Array.isArray(sheetOptions)) return [];
    return sheetOptions.filter((row) => {
      if ((row.itemId ?? row.processId) != null) return false;
      const s = String(row.strukturAdi || '').trim();
      if (!s) return true;
      if (!groupName) return true;
      return s.localeCompare(groupName, undefined, { sensitivity: 'accent' }) === 0
        || s.toLowerCase() === groupName.toLowerCase();
    });
  })();
  const showSheetChevron = Array.isArray(sheetOptions);
  const hasSheets = visibleSheets.length > 0;

  useEffect(() => {
    if (!sheetOpen) return;
    function onDoc(e) {
      if (sheetMenuRef.current && !sheetMenuRef.current.contains(e.target)) {
        setSheetOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [sheetOpen]);

  function pickSheet(row) {
    setTitle(row.title || '');
    setSubtitle(row.subtitle || '');
    setSheetId(row.id);
    const s = String(row.strukturAdi || '').trim();
    if (s && groups.length) {
      const match = groups.find(g => String(g.name || '').trim().toLowerCase() === s.toLowerCase());
      if (match) setGroupId(match.id);
    }
    setSheetOpen(false);
  }

  function pickFile(e) {
    const f = e.target.files?.[0];
    if (!f) return setFile(null);

    // Some browsers/OSes don't report a MIME type at all (f.type === '').
    // Checking the file extension as well closes that gap, since an empty
    // type would otherwise let anything through unnoticed until the server
    // rejects it.
    const ext = extOf(f.name);
    if (!ALLOWED_EXT.includes(ext)) {
      setError('Yalnız PDF, Word (doc/docx) və ya Excel (xls/xlsx) fayl seçin');
      e.target.value = '';
      return;
    }

    if (f.size > MAX_FILE_BYTES) {
      setError(`Fayl çox böyükdür (maks. ${MAX_FILE_BYTES / (1024 * 1024)}MB)`);
      e.target.value = '';
      return;
    }

    setError('');
    setFile(f);
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!title.trim()) { setError('Başlıq daxil edin'); return; }
    if (!groupId) { setError('Qrup seçin'); return; }
    if (!isEdit && !file && canUpload) { setError('Fayl seçin'); return; }

    setSaving(true);
    try {
      await onSave({
        title: title.trim(),
        subtitle: subtitle.trim(),
        groupId: Number(groupId),
        file,
        sheetId: sheetId != null ? Number(sheetId) : undefined
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pdf-modal-backdrop" onClick={onClose}>
      <form className="pdf-modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="pdf-modal-head nospace">
          <h3>{isEdit ? 'Redaktə et' : 'Yeni sənəd əlavə et'}</h3>
          <button type="button" className="pdf-modal-close" onClick={onClose} aria-label="Bağla">
            <X size={18} />
          </button>
        </div>

        <div className="pdf-modal-body">
          <div className="pdf-field">
            <label>Başlıq</label>
            <div className={`nm-name-row ${showSheetChevron ? 'with-sheet' : ''}`} ref={sheetMenuRef}>
              <input type="text" value={title}
                onChange={(e) => { setTitle(e.target.value); setSheetId(null); }}
                placeholder="Sənədin adı" autoFocus />
              {showSheetChevron && (
                <>
                  <button
                    type="button"
                    className="nm-sheet-chevron"
                    title="Sheets-dən seç"
                    onClick={() => setSheetOpen(o => !o)}
                    aria-expanded={sheetOpen}
                  >
                    <ChevronDown size={16} />
                  </button>
                  {sheetOpen && (
                    <div className="nm-sheet-menu">
                      <div className="nm-sheet-menu-head">Sheets-dən seç</div>
                      {!hasSheets && (
                        <div className="nm-sheet-empty">Sheets-də seçilə bilən sətir yoxdur</div>
                      )}
                      {visibleSheets.map(row => (
                        <button key={row.id} type="button" className="nm-sheet-option" onClick={() => pickSheet(row)}>
                          <span className="nm-sheet-option-title">{row.title || '—'}</span>
                          {row.strukturAdi ? (
                            <span className="nm-sheet-option-sub">{row.strukturAdi}</span>
                          ) : (
                            <span className="nm-sheet-option-sub">Ümumi (struktur boş)</span>
                          )}
                          {row.subtitle ? <span className="nm-sheet-option-sub">{row.subtitle}</span> : null}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="pdf-field">
            <label>İş axışının nömrəsi</label>
            <input type="text" value={subtitle} onChange={(e) => setSubtitle(e.target.value)}
              placeholder="Qısa İş axışının nömrəsi (məcburi deyil)" />
          </div>

          <div className="pdf-field">
            <label>Qrup</label>
            <select value={groupId || ''} onChange={(e) => setGroupId(e.target.value)}>
              {groups.length === 0 && <option value="">Qrup yoxdur</option>}
              {orderedGroupOptions(groups).map(({ g, depth }) => (
                <option key={g.id} value={g.id}>
                  {'\u00A0\u00A0'.repeat(depth)}{depth > 0 ? '↳ ' : ''}{g.name}
                </option>
              ))}
            </select>
          </div>

          <div className="pdf-field">
            <label>{isEdit ? 'Faylı dəyişdir (məcburi deyil)' : 'Fayl (PDF, Word, Excel)'}</label>
            {canUpload ? (
              <>
                <input type="file" accept={ACCEPT_ATTR} onChange={pickFile} />
                {isEdit && pdf?.filename && !file && (
                  <div className="pdf-field-hint">Hazırkı: {pdf.filename}</div>
                )}
                {file && <div className="pdf-field-hint">Seçildi: {file.name}</div>}
              </>
            ) : (
              <div className="pdf-field-hint">
                Fayl yükləmə bu saytda deaktivdir — daxili serverdən (http://172.25.60.81:4000) istifadə edin.
                {isEdit && pdf?.filename && ` Hazırkı fayl: ${pdf.filename}`}
              </div>
            )}
          </div>

          {error && <div className="pdf-modal-error">{error}</div>}
        </div>

        <div className="pdf-modal-foot">
          <button type="button" className="pdf-modal-btn" onClick={onClose} disabled={saving}>Ləğv et</button>
          <button type="submit" className="pdf-modal-btn pdf-modal-btn-primary" disabled={saving}>
            {saving && <Loader2 size={14} className="spin" />}
            <span>{saving ? 'Saxlanılır...' : 'Saxla'}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
