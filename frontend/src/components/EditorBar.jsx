import { useState } from 'react';
import { Pencil, Eye, Save, Check, Loader2, LogOut } from 'lucide-react';
import { useLabels } from '../labels/LabelsContext.jsx';

// The editor_2 navbar. It floats over the real app (which is the same UI admin
// sees) instead of replacing it. "Redaktə et" turns every interface string
// editable in place; "Yadda saxla" persists the batch; "Çıxış" logs out.
export default function EditorBar({ onLogout }) {
  const { labelEdit, setLabelEdit, commit, pendingCount, saving, savedTick } = useLabels();
  const [err, setErr] = useState('');

  async function save() {
    setErr('');
    try { await commit(); }
    catch (e) { setErr('Saxlanmadı'); }
  }

  const showSaved = savedTick > 0 && pendingCount === 0 && !saving;

  return (
    <div className="editorbar">
      <span className="editorbar-brand"><Pencil size={13} /> Mətn redaktoru</span>

      <button
        className={'editorbar-btn' + (labelEdit ? ' active' : '')}
        onClick={() => setLabelEdit(v => !v)}
      >
        {labelEdit
          ? <><Eye size={14} /> Baxış</>
          : <><Pencil size={14} /> Redaktə et</>}
      </button>

      <button
        className={'editorbar-btn primary' + (pendingCount ? ' dirty' : '')}
        onClick={save}
        disabled={saving || pendingCount === 0}
      >
        {saving
          ? <><Loader2 size={14} className="spin" /> Saxlanılır...</>
          : showSaved
            ? <><Check size={14} /> Saxlanıldı</>
            : <><Save size={14} /> Yadda saxla{pendingCount ? ` (${pendingCount})` : ''}</>}
      </button>

      {err && <span className="editorbar-err">{err}</span>}

      <button className="editorbar-btn ghost" onClick={onLogout}>
        <LogOut size={14} /> Çıxış
      </button>
    </div>
  );
}
