// AiActionPopup.jsx
// Nothing the assistant proposes touches the diagram until this popup is
// approved. One popup per batch: every action in the batch is listed, and the
// admin can drop individual ones before confirming.

import { useState, useEffect } from 'react';
import { X, Trash2, Plus, Edit3, Save, Folder, Archive, Search, Play, LogOut, Check, Loader2 } from '../icons.jsx';
import { Sparkles, ArrowRight, ExternalLink } from 'lucide-react';
import { describeAction } from './aiActions.js';
import { buildFromSpec } from './aiBuild.js';
import { buildDiagramSvg } from '../diagramExport.js';

// What a create/generate_diagram will really look like — drawn by the same
// code the PDF export uses, so the admin sees the result before approving.
function DiagramPreview({ action }) {
  const [url, setUrl] = useState(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let u = null;
    try {
      const built = buildFromSpec(action);
      const { svg } = buildDiagramSvg({ ...built, title: action.title || '' });
      u = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      setUrl(u);
    } catch { setUrl(null); }
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [action]);
  if (!url) return null;
  return (
    <div className={`ai-act-preview ${big ? 'big' : ''}`} onClick={() => setBig(v => !v)} title={big ? 'Kiçilt' : 'Böyüt'}>
      <img src={url} alt="Önizləmə" />
      <span className="ai-act-preview-hint">{big ? 'Kiçiltmək üçün klikləyin' : 'Önizləmə — böyütmək üçün klikləyin'}</span>
    </div>
  );
}

const ICONS = {
  trash: Trash2, plus: Plus, edit: Edit3, save: Save, folder: Folder,
  archive: Archive, search: Search, play: Play, logout: LogOut,
  sparkles: Sparkles, arrow: ArrowRight, open: ExternalLink
};

export default function AiActionPopup({ actions, context, onCancel, onConfirm }) {
  const [skipped, setSkipped] = useState([]);   // indexes the admin dropped
  const [running, setRunning] = useState(false);

  const described = actions.map(a => ({ a, d: describeAction(a, context) }));
  const kept = described.filter((_, i) => !skipped.includes(i));
  const anyDanger = kept.some(x => x.d.danger);

  function toggle(i) {
    setSkipped(prev => prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i]);
  }

  async function confirm() {
    if (running || !kept.length) return;
    setRunning(true);
    try {
      await onConfirm(kept.map(x => x.a));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="ai-popup-backdrop" onClick={running ? undefined : onCancel}>
      <div className={`ai-popup ${anyDanger ? 'danger' : ''}`} onClick={e => e.stopPropagation()}>
        <div className="ai-popup-head">
          <span className="ai-popup-icon"><Sparkles size={16} /></span>
          <h3>Təsdiq tələb olunur</h3>
          <button className="ai-popup-x" onClick={onCancel} disabled={running}>
            <X size={16} />
          </button>
        </div>

        <p className="ai-popup-lead">
          ALM-AI aşağıdakı {actions.length} əməliyyatı təklif edir.
          Təsdiqləməyincə heç nə dəyişmir.
        </p>

        <div className="ai-popup-list">
          {described.map(({ a, d }, i) => {
            const Icon = ICONS[d.icon] || Sparkles;
            const off = skipped.includes(i);
            return (
              <div key={i} className={`ai-act ${d.danger ? 'danger' : ''} ${off ? 'off' : ''}`}>
                <label className="ai-act-check">
                  <input type="checkbox" checked={!off} onChange={() => toggle(i)} disabled={running} />
                </label>
                <span className="ai-act-icon"><Icon size={15} /></span>
                <div className="ai-act-body">
                  <div className="ai-act-title">{d.title}</div>
                  {d.detail && <div className="ai-act-detail">{d.detail}</div>}
                  {(a.type === 'create_diagram' || a.type === 'generate_diagram') && !off && <DiagramPreview action={a} />}
                </div>
              </div>
            );
          })}
        </div>

        {anyDanger && (
          <div className="ai-popup-warn">
            Seçilmişlər arasında geri alınması çətin əməliyyat var. Diqqətlə yoxlayın.
          </div>
        )}

        <div className="ai-popup-actions">
          <button className="ai-btn ghost" onClick={onCancel} disabled={running}>Ləğv et</button>
          <button
            className={`ai-btn primary ${anyDanger ? 'danger' : ''}`}
            onClick={confirm}
            disabled={running || kept.length === 0}
          >
            {running ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
            <span>{running ? 'İcra olunur...' : `Təsdiq et (${kept.length})`}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
