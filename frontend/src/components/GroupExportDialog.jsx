import { useState, useEffect, useMemo } from 'react';
import { Download, FileText, FileJson, X, Loader2, Check, FileArchive, Files } from 'lucide-react';
import { api } from '../api/client.js';
import { exportDiagramsToJson } from './diagramExport.js';
import { diagramsToPdfBlob, diagramsToZip, downloadBlob, safeFileName } from './pdfFiles.js';
import './homeArchive.css';

/*
  Folder "⋯" menu -> download the folder's diagrams.
  - format: PDF (one diagram per page, landscape or portrait) or JSON data
  - choose which diagrams (all ticked by default; subfolders included)
*/
export default function GroupExportDialog({ group, items, initialFormat = 'pdf', onClose }) {
  const [format, setFormat] = useState(initialFormat);
  const [orientation, setOrientation] = useState('landscape');
  const [pdfMode, setPdfMode] = useState('one'); // 'one' = one combined PDF, 'zip' = one PDF per diagram in a ZIP
  const [picked, setPicked] = useState(() => new Set(items.map((p) => p.id)));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' && !busy) onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const allOn = picked.size === items.length && items.length > 0;
  const chosen = useMemo(() => items.filter((p) => picked.has(p.id)), [items, picked]);

  function toggle(id) {
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function run() {
    if (!chosen.length || busy) return;
    setBusy(true);
    setError('');
    setProgress(0);
    try {
      const full = [];
      for (const p of chosen) {
        const d = await api.getProcess(p.id);
        full.push({ ...d, status: p.status });
        setProgress((n) => n + 1);
      }
      const tick = () => setProgress((n) => n + 1);
      if (format === 'json') {
        exportDiagramsToJson(full, { name: group.name, group: group.name });
      } else if (pdfMode === 'zip') {
        downloadBlob(await diagramsToZip(full, { orientation, onProgress: tick }), `${safeFileName(group.name)}.zip`);
      } else {
        downloadBlob(await diagramsToPdfBlob(full, { orientation, onProgress: tick }), `${safeFileName(group.name)}.pdf`);
      }
      onClose();
    } catch (e) {
      setError(e.message || 'Yüklənmədi');
      setBusy(false);
    }
  }
  const steps = format === 'json' ? chosen.length : chosen.length * 2;

  return (
    <div className="rd-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="rd-card" role="dialog" aria-modal="true">
        <div className="rd-head">
          <span className="rd-ico"><Download size={18} /></span>
          <div className="rd-head-text">
            <div className="rd-eyebrow">Qovluğu yüklə</div>
            <h3>{group.name}</h3>
            <p>{items.length} diaqram{items.length ? ' — hansılarının yüklənəcəyini seçin' : ''}</p>
          </div>
          <button className="rd-x" onClick={onClose} disabled={busy} title="Bağla"><X size={18} /></button>
        </div>

        <div className="rd-body">
          <div className="ge-seg">
            <button className={format === 'pdf' ? 'on' : ''} onClick={() => setFormat('pdf')}><FileText size={15} /> PDF</button>
            <button className={format === 'json' ? 'on' : ''} onClick={() => setFormat('json')}><FileJson size={15} /> JSON məlumat</button>
          </div>
          {format === 'pdf' && (
            <div className="ge-seg small">
              <button className={pdfMode === 'one' ? 'on' : ''} onClick={() => setPdfMode('one')}>
                <Files size={14} /> Hamısı bir PDF-də
              </button>
              <button className={pdfMode === 'zip' ? 'on' : ''} onClick={() => setPdfMode('zip')}>
                <FileArchive size={14} /> Ayrı-ayrı PDF (ZIP)
              </button>
            </div>
          )}
          {format === 'pdf' && (
            <div className="ge-seg small">
              <button className={orientation === 'landscape' ? 'on' : ''} onClick={() => setOrientation('landscape')}>
                <span className="ge-page land" /> Albom (üfüqi)
              </button>
              <button className={orientation === 'portrait' ? 'on' : ''} onClick={() => setOrientation('portrait')}>
                <span className="ge-page port" /> Kitab (şaquli)
              </button>
            </div>
          )}

          <div className="ge-list-head">
            <label className="ge-check">
              <input type="checkbox" checked={allOn} onChange={() => setPicked(allOn ? new Set() : new Set(items.map((p) => p.id)))} />
              <span>Hamısını seç</span>
            </label>
            <span className="ge-count">{chosen.length} / {items.length} seçilib</span>
          </div>
          <div className="rd-folders">
            {items.length === 0 && <div className="ge-empty">Bu qovluqda diaqram yoxdur</div>}
            {items.map((p) => (
              <label key={p.id} className={`ge-item ${picked.has(p.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
                <span className="ge-item-text">
                  <span className="ge-item-title">{p.title}</span>
                  {(p.subtitle || p.folder) && <span className="ge-item-sub">{[p.subtitle, p.folder].filter(Boolean).join(' · ')}</span>}
                </span>
              </label>
            ))}
          </div>
          {error && <div className="rd-error">{error}</div>}
        </div>

        <div className="rd-foot">
          <button className="rd-btn" onClick={onClose} disabled={busy}>Ləğv et</button>
          <button className="rd-btn primary" onClick={run} disabled={!chosen.length || busy}>
            {busy ? <Loader2 size={15} className="spin" /> : (format === 'pdf' ? <FileText size={15} /> : <Check size={15} />)}
            <span>{busy ? `Hazırlanır ${Math.min(progress, steps)}/${steps}` : `${format === 'json' ? 'JSON' : (pdfMode === 'zip' ? 'ZIP' : 'PDF')} yüklə (${chosen.length})`}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
