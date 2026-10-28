import { Archive, ArchiveRestore, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { StatusBadge } from './Status.jsx';
import './homeArchive.css';

/*
  The ONE archive block used on every Home page (İş Axışları, Normativ
  Sənədlər, Şablonlar). It is drawn exactly like a folder: same header card,
  same item cards, same buttons — only the icon and the actions differ
  (open, "Bərpa et" which asks for the folder, delete which is kept in data/).
*/
function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

export default function ArchiveSection({
  items,            // archived entries (already filtered by search)
  total,            // count shown in the header
  open,             // expanded?
  onToggle,
  statusMeta,       // optional: show the status badge
  canEdit = true,
  onOpen,           // (item) => void — row click
  onRestore,        // (event, item)
  onDelete,         // (event, item)
  extra,            // (item) => ReactNode — extra buttons (e.g. "Bax")
  meta              // (item) => ReactNode — extra meta (e.g. file size)
}) {
  const sorted = [...items].sort((a, b) => String(b.archivedAt || '').localeCompare(String(a.archivedAt || '')));
  return (
    <div className={`group-card archive-group ${open ? 'open' : ''}`}>
      <div className="group-head" onClick={onToggle}>
        <span className="folder-no archive-no"><Archive size={14} /></span>
        <span className="group-chevron">{open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</span>
        <span className="group-name">Arxiv</span>
        <span className="group-count">{total}</span>
      </div>

      {open && (
        <div className="group-body">
          {sorted.length === 0 && <div className="child-empty">Axtarışa uyğun element yoxdur.</div>}
          {sorted.map((p) => (
            <div
              key={p.id}
              className={`process-item diagram-row archive-row ${onOpen ? '' : 'static'}`}
              onClick={onOpen ? () => onOpen(p) : undefined}
              title={onOpen ? 'Aç' : undefined}
            >
              <div className="num"><Archive size={15} /></div>
              <div className="label">
                <span className="row-title">{p.title || `#${p.id}`}</span>
                <span className="row-subtitle archive-meta">
                  {p.subtitle ? <span>{p.subtitle}</span> : null}
                  {meta ? meta(p) : null}
                  <span>{p.groupName ? `Qovluq: ${p.groupName}` : 'Qovluqsuz'}</span>
                  {p.archivedAt ? <span>Arxivə: {fmtDate(p.archivedAt)}</span> : null}
                  {p.note ? <span className="ha-tag">{p.note}</span> : null}
                </span>
              </div>
              {statusMeta && p.status ? (
                <div className="row-status"><StatusBadge value={p.status} meta={statusMeta} /></div>
              ) : null}
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                {extra ? extra(p) : null}
                {canEdit && (
                  <>
                    <button className="action-btn" title={p.groupName ? `"${p.groupName}" qovluğuna qaytar` : 'Siyahıya qaytar'}
                      onClick={(e) => onRestore(e, p)}>
                      <ArchiveRestore size={16} /><span>Bərpa et</span>
                    </button>
                    <button className="action-btn action-btn-icon action-btn-danger" title="Arxivdən sil" onClick={(e) => onDelete(e, p)}>
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
