import { useState, useRef, useEffect } from 'react';
import { X, Loader2, ChevronDown } from './icons.jsx';
import { FileSpreadsheet, Download, FileJson } from 'lucide-react';
import { useLabels } from '../labels/LabelsContext.jsx';
import { STATUS_META } from './Status.jsx';

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

// Generic modal: heading + name field (+ optional subtitle + optional group select).
// onSave({ name, subtitle, groupId, sheetId?, status? }) may be async.
// Optional Excel import: pass withImport + onImport(file, { groupId }) (async) and
// optionally onTemplate() to offer a template download.
// Optional sheetOptions: unused Sheets rows — chevron picks one to fill name/subtitle/status.
// sheetPickAs:
//   'item'  (default) → fill diagram/doc name + subtitle + status
//   'group' → fill group name from Struktur adı (fallback: title)
export default function NameModal({
  heading,
  nameLabel = 'Ad',
  namePlaceholder = '',
  subtitleLabel = 'İş axışının nömrəsi',
  subtitlePlaceholder = '',
  withSubtitle = false,
  withGroup = false,
  groups = [],
  groupId0 = null,
  name0 = '',
  subtitle0 = '',
  saveLabel = 'Saxla',
  withImport = false,
  onImport,
  onImportJson,
  onTemplate,
  sheetOptions = null,
  sheetPickAs = 'item',
  onClose,
  onSave
}) {
  const { tByText, t } = useLabels();
  const [name, setName] = useState(name0);
  const [subtitle, setSubtitle] = useState(subtitle0);
  const [groupId, setGroupId] = useState(groupId0 ?? (groups[0]?.id ?? null));
  const [sheetId, setSheetId] = useState(null);
  const [status, setStatus] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  const jsonRef = useRef(null);
  const sheetMenuRef = useRef(null);

  const groupName = (groups.find(g => Number(g.id) === Number(groupId))?.name || '').trim();
  const existingGroupNames = new Set(
    (groups || []).map(g => String(g.name || '').trim().toLowerCase()).filter(Boolean)
  );

  // Yeni qrup chevron: unique Struktur adı values from Sheets (not already a group).
  // Yeni diaqram chevron: unused sheet rows for this group (+ empty struktur pool).
  const visibleSheets = (() => {
    if (!Array.isArray(sheetOptions)) return [];

    if (sheetPickAs === 'group') {
      const seen = new Set();
      const out = [];
      for (const row of sheetOptions) {
        const s = String(row.strukturAdi || '').trim();
        if (!s) continue;
        const key = s.toLowerCase();
        if (existingGroupNames.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: `struktur:${key}`,
          strukturAdi: s,
          title: row.title || '',
          subtitle: row.subtitle || '',
          status: row.status || null
        });
      }
      return out;
    }

    return sheetOptions.filter((row) => {
      // Only unused sheet rows can be claimed by a new diagram/doc
      if ((row.itemId ?? row.processId) != null) return false;
      const s = String(row.strukturAdi || '').trim();
      if (!s) return true;
      if (!groupName) return true;
      return s.localeCompare(groupName, undefined, { sensitivity: 'accent' }) === 0
        || s.toLowerCase() === groupName.toLowerCase();
    });
  })();
  // Always show chevron when sheetOptions was provided (wired for Sheets pick)
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
    const s = String(row.strukturAdi || '').trim();
    if (sheetPickAs === 'group') {
      setName(s);
      setSheetId(null);
      setStatus(null);
      setSheetOpen(false);
      return;
    }
    setName(row.title || '');
    setSubtitle(row.subtitle || '');
    setStatus(row.status || null);
    setSheetId(row.id);
    if (s && withGroup && groups.length) {
      const match = groups.find(g => String(g.name || '').trim().toLowerCase() === s.toLowerCase());
      if (match) setGroupId(match.id);
    }
    setSheetOpen(false);
  }

  async function pickFile(e) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (withGroup && !groupId) { setError('Əvvəlcə qrup seçin'); return; }
    setImporting(true);
    setError('');
    try {
      await onImport(file, { groupId: withGroup ? Number(groupId) : undefined });
    } catch (err) {
      setError(err.message || 'Excel oxuna bilmədi');
    } finally {
      setImporting(false);
    }
  }

  async function pickJson(e) {
    const file = e.target.files?.[0];
    if (jsonRef.current) jsonRef.current.value = '';
    if (!file) return;
    if (withGroup && !groupId) { setError('Əvvəlcə qrup seçin'); return; }
    setImporting(true);
    setError('');
    try {
      await onImportJson(file, { groupId: withGroup ? Number(groupId) : undefined });
    } catch (err) {
      setError(err.message || 'JSON oxuna bilmədi');
    } finally {
      setImporting(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) { setError('Ad daxil edin'); return; }
    if (withGroup && !groupId) { setError('Qrup seçin'); return; }
    setSaving(true);
    setError('');
    try {
      await onSave({
        name: name.trim(),
        subtitle: subtitle.trim(),
        groupId: withGroup ? Number(groupId) : undefined,
        sheetId: sheetId != null ? Number(sheetId) : undefined,
        status: status || undefined
      });
    } catch (err) {
      setError(err.message || 'Xəta');
      setSaving(false);
    }
  }

  return (
    <div className="pdf-modal-backdrop" onClick={onClose}>
      <form className="pdf-modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="pdf-modal-head nospace">
          <h3>{tByText(heading)}</h3>
          <button type="button" className="pdf-modal-close" onClick={onClose} aria-label="Bağla">
            <X size={18} />
          </button>
        </div>

        <div className="pdf-modal-body">
          <div className="pdf-field">
            <label>{tByText(nameLabel)}</label>
            <div className={`nm-name-row ${showSheetChevron ? 'with-sheet' : ''}`} ref={sheetMenuRef}>
              <input
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setSheetId(null); }}
                placeholder={namePlaceholder}
                autoFocus
              />
              {showSheetChevron && (
                <>
                  <button
                    type="button"
                    className="nm-sheet-chevron"
                    title={tByText(sheetPickAs === 'group' ? 'Struktur adından seç' : 'Sheets-dən seç')}
                    onClick={() => setSheetOpen(o => !o)}
                    aria-expanded={sheetOpen}
                  >
                    <ChevronDown size={16} />
                  </button>
                  {sheetOpen && (
                    <div className="nm-sheet-menu">
                      <div className="nm-sheet-menu-head">
                        {tByText(sheetPickAs === 'group' ? 'Struktur adından seç' : 'Sheets-dən seç')}
                      </div>
                      {!hasSheets && (
                        <div className="nm-sheet-empty">{tByText('Sheets-də seçilə bilən sətir yoxdur')}</div>
                      )}
                      {visibleSheets.map(row => {
                        const st = row.status && STATUS_META[row.status];
                        return (
                          <button
                            key={row.id}
                            type="button"
                            className="nm-sheet-option"
                            onClick={() => pickSheet(row)}
                          >
                            {sheetPickAs === 'group' ? (
                              <span className="nm-sheet-option-title">{row.strukturAdi}</span>
                            ) : (
                              <>
                                <span className="nm-sheet-option-title">{row.title || '—'}</span>
                                {row.strukturAdi ? (
                                  <span className="nm-sheet-option-sub">{row.strukturAdi}</span>
                                ) : (
                                  <span className="nm-sheet-option-sub">{tByText('Ümumi (struktur boş)')}</span>
                                )}
                                {row.subtitle ? (
                                  <span className="nm-sheet-option-sub">{row.subtitle}</span>
                                ) : null}
                                {st ? (
                                  <span className={`nm-sheet-option-status ${st.cls}`}>
                                    {t(st.id, st.default)}
                                  </span>
                                ) : null}
                              </>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {withSubtitle && (
            <div className="pdf-field">
              <label>{tByText(subtitleLabel)}</label>
              <input
                type="text"
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                placeholder={subtitlePlaceholder}
              />
            </div>
          )}

          {withGroup && (
            <div className="pdf-field">
              <label>{tByText('Qrup')}</label>
              <select value={groupId || ''} onChange={(e) => setGroupId(e.target.value)}>
                {groups.length === 0 && <option value="">Qrup yoxdur</option>}
                {orderedGroupOptions(groups).map(({ g, depth }) => (
                  <option key={g.id} value={g.id}>
                    {'\u00A0\u00A0'.repeat(depth)}{depth > 0 ? '↳ ' : ''}{g.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {withImport && (
            <div className="nm-import">
              <div className="nm-import-div"><span>və ya</span></div>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls"
                style={{ display: 'none' }}
                onChange={pickFile}
              />
              <button
                type="button"
                className="nm-import-btn"
                onClick={() => fileRef.current?.click()}
                disabled={importing || saving}
              >
                {importing
                  ? <Loader2 size={16} className="spin" />
                  : <FileSpreadsheet size={16} />}
                <span>{importing ? tByText('Oxunur...') : tByText('Excel-dən idxal et')}</span>
              </button>
              {onImportJson && (
                <>
                  <input
                    ref={jsonRef}
                    type="file"
                    accept=".json,application/json"
                    style={{ display: 'none' }}
                    onChange={pickJson}
                  />
                  <button
                    type="button"
                    className="nm-import-btn"
                    style={{ marginTop: 8 }}
                    onClick={() => jsonRef.current?.click()}
                    disabled={importing || saving}
                  >
                    {importing
                      ? <Loader2 size={16} className="spin" />
                      : <FileJson size={16} />}
                    <span>{importing ? tByText('Oxunur...') : tByText('JSON-dan idxal et')}</span>
                  </button>
                </>
              )}
              {onTemplate && (
                <button
                  type="button"
                  className="nm-import-tpl"
                  onClick={onTemplate}
                  disabled={importing || saving}
                >
                  <Download size={13} />
                  <span>{tByText('Nümunə Excel şablonu yüklə')}</span>
                </button>
              )}
              <p className="nm-import-hint">
                {tByText('Excel və ya JSON faylı bütün panelləri, node-ları və oxları avtomatik yeni diaqrama çevirir.')}
              </p>
            </div>
          )}

          {error && <div className="pdf-modal-error">{error}</div>}
        </div>

        <div className="pdf-modal-foot">
          <button type="button" className="pdf-modal-btn" onClick={onClose} disabled={saving || importing}>
            {tByText('Ləğv et')}
          </button>
          <button type="submit" className="pdf-modal-btn pdf-modal-btn-primary" disabled={saving || importing}>
            {saving && <Loader2 size={14} className="spin" />}
            <span>{saving ? tByText('Saxlanılır...') : tByText(saveLabel)}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
