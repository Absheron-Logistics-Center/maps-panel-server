import { useState, useMemo, useEffect } from 'react';
import { ArchiveRestore, FolderPlus, Folder, X, Loader2 } from 'lucide-react';
import './homeArchive.css';

/*
  "Bərpa et" from an archive: asks WHERE the item goes back.
  - pick an existing folder (the old one is pre-selected when it still exists), or
  - create a new folder (pre-filled with the old folder name, if there was one).
  onConfirm({ groupId }) or onConfirm({ newGroupName }) — may be async.
*/
function flatten(groups) {
  const pid = (g) => (g.parentId == null || g.parentId === 0 ? null : Number(g.parentId));
  const out = [];
  const walk = (parent, depth) => {
    groups.filter((g) => pid(g) === parent).forEach((g) => {
      out.push({ ...g, depth });
      walk(Number(g.id), depth + 1);
    });
  };
  walk(null, 0);
  // anything unreachable (bad parent) still listed
  groups.forEach((g) => { if (!out.some((o) => o.id === g.id)) out.push({ ...g, depth: 0 }); });
  return out;
}

export default function RestoreDialog({ item, groups, onConfirm, onClose }) {
  const list = useMemo(() => flatten((groups || []).filter((g) => Number(g.id) > 0)), [groups]);
  const oldByName = item.groupName ? list.find((g) => String(g.name).trim() === String(item.groupName).trim()) : null;
  const oldById = list.find((g) => Number(g.id) === Number(item.groupId));
  const preset = oldById || oldByName || null;

  const [mode, setMode] = useState(preset || !item.groupName ? (list.length ? 'existing' : 'new') : 'new');
  const [groupId, setGroupId] = useState(preset ? preset.id : (list[0]?.id ?? null));
  const [newName, setNewName] = useState(preset ? '' : (item.groupName || ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' && !busy) onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const canSave = mode === 'existing' ? groupId != null : newName.trim().length > 0;

  async function save() {
    if (!canSave || busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm(mode === 'existing' ? { groupId: Number(groupId) } : { newGroupName: newName.trim() });
      onClose();
    } catch (e) {
      setError(e.message || 'Bərpa edilmədi');
      setBusy(false);
    }
  }

  return (
    <div className="rd-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="rd-card" role="dialog" aria-modal="true">
        <div className="rd-head">
          <span className="rd-ico"><ArchiveRestore size={18} /></span>
          <div className="rd-head-text">
            <div className="rd-eyebrow">Arxivdən bərpa</div>
            <h3>{item.title || 'Adsız'}</h3>
            <p>{item.groupName ? <>Əvvəlki qovluq: <b>{item.groupName}</b>{preset ? '' : ' (artıq yoxdur)'}</> : 'Bu elementin qovluğu yoxdur — hara qaytarılacağını seçin.'}</p>
          </div>
          <button className="rd-x" onClick={onClose} disabled={busy} title="Bağla"><X size={18} /></button>
        </div>

        <div className="rd-body">
          <label className={`rd-option ${mode === 'existing' ? 'on' : ''} ${list.length ? '' : 'disabled'}`}>
            <input type="radio" name="rd-mode" checked={mode === 'existing'} disabled={!list.length} onChange={() => setMode('existing')} />
            <span className="rd-option-title"><Folder size={15} /> Mövcud qovluğa qaytar</span>
          </label>
          {mode === 'existing' && (
            <div className="rd-folders">
              {list.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={`rd-folder ${Number(groupId) === Number(g.id) ? 'on' : ''}`}
                  style={{ paddingLeft: 12 + g.depth * 18 }}
                  onClick={() => setGroupId(g.id)}
                  onDoubleClick={save}
                >
                  <Folder size={14} />
                  <span>{g.name}</span>
                  {preset && Number(preset.id) === Number(g.id) && <em>əvvəlki</em>}
                </button>
              ))}
            </div>
          )}

          <label className={`rd-option ${mode === 'new' ? 'on' : ''}`}>
            <input type="radio" name="rd-mode" checked={mode === 'new'} onChange={() => setMode('new')} />
            <span className="rd-option-title"><FolderPlus size={15} /> Yeni qovluq yarat</span>
          </label>
          {mode === 'new' && (
            <input
              className="rd-input"
              autoFocus
              value={newName}
              placeholder="Qovluğun adı"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
            />
          )}
          {error && <div className="rd-error">{error}</div>}
        </div>

        <div className="rd-foot">
          <button className="rd-btn" onClick={onClose} disabled={busy}>Ləğv et</button>
          <button className="rd-btn primary" onClick={save} disabled={!canSave || busy}>
            {busy ? <Loader2 size={15} className="spin" /> : <ArchiveRestore size={15} />}
            <span>Bərpa et</span>
          </button>
        </div>
      </div>
    </div>
  );
}
