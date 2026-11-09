import { useState, useEffect, useRef, useMemo, useCallback, useDeferredValue, startTransition } from 'react';
import {
  LogOut, ChevronLeft, Download, Upload, Plus, Search, X, Archive, ArchiveRestore,
  Link2, Unlink, ExternalLink, Loader2, Check, ArrowRight, ArrowLeft, FolderOpen, Trash2, AlertTriangle, Menu, Link2Off, MoreHorizontal, ListChecks
} from 'lucide-react';
import { api } from '../api/client.js';
import {
  StatusControl, StatusBadge, PROCESS_STATUS_META, PROCESS_STATUS_ORDER, DOC_STATUS_META, DOC_STATUS_ORDER,
  JOB_STATUS_META, JOB_STATUS_ORDER
} from './Status.jsx';
import { useLabels } from '../labels/LabelsContext.jsx';
import { exportSheetToExcel, importSheetRowsFromExcel } from './sheetsExcel.js';
import { buildImportPlan, defaultDecisions, resolvePlan, foldText } from './sheetsImportMerge.js';
import ImportConflictModal from './ImportConflictModal.jsx';
import SheetColumnFilter, { BLANK_FILTER_VALUE, uniqueColumnValues } from './SheetColumnFilter.jsx';
import './hesabat.css';
import './homeArchive.css';
import AiButton from './ai/AiButton.jsx';
import AiSidebar from './ai/AiSidebar.jsx';
import FileTypePill from './FileTypePill.jsx';

/*
  Hesabat — a report table that lives SEPARATELY from the Home page.
  Nothing here changes Home and nothing on Home changes this table. A row can
  optionally point at a Home item (link icon); the link dialog shows where the
  two differ and lets the admin pick which value to keep, field by field.
  Rows are archived, never deleted, and are always numbered 1..n.
*/

const sheetsCache = new Map(); // kind -> rows (instant repaint when coming back)

const KIND_COLUMNS = {
  diagrams: [
    { field: 'title', label: 'İş axışının adı', cls: 'c-title', aliases: ['ad', 'title', 'diaqramadı', 'diaqramadi', 'işaxınınadı', 'isaxininadi', 'name'] },
    { field: 'strukturAdi', label: 'Struktur adı', cls: 'c-struct', aliases: ['strukturadı', 'strukturadi', 'struktur', 'qrupadı', 'qrupadi', 'group'] },
    { field: 'subtitle', label: 'İş axışının nömrəsi', cls: 'c-code', aliases: ['ikinciad', 'subtitle', 'işaxınınnömrəsi', 'isaxininnomresi', 'nömrə', 'nomre', 'code'] }
  ],
  pdfs: [
    { field: 'title', label: 'Sənədin adı', cls: 'c-title', aliases: ['ad', 'title', 'sənədadı', 'senedadi', 'name'] },
    { field: 'docType', label: 'Sənədin növü', cls: 'c-mid', aliases: ['sənədinnövü', 'senedinnovu', 'doctype'] },
    { field: 'strukturAdi', label: 'Struktur adı', cls: 'c-struct', aliases: ['strukturadı', 'strukturadi', 'struktur', 'qrupadı', 'qrupadi', 'group'] },
    { field: 'edition', label: 'Nəşr', cls: 'c-narrow', aliases: ['nəşr', 'nesr', 'edition'] },
    { field: 'approvalDate', label: 'Təsdiq tarixi', cls: 'c-mid', aliases: ['təsdiqtarixi', 'tesdiqtarixi', 'approvaldate'] },
    { field: 'subtitle', label: 'Sənədin nömrəsi', cls: 'c-code', aliases: ['sənədinnömrəsi', 'senedinnomresi', 'nömrə', 'nomre', 'subtitle', 'code'] },
    { field: 'protocol', label: 'Qərar / Protokol', cls: 'c-mid', aliases: ['qərarprotokol', 'qerarprotokol', 'protocol'] },
    { field: 'pageCount', label: 'Səhifə sayı', cls: 'c-narrow', aliases: ['səhifəsayı', 'sehifesayi', 'pagecount'] }
  ],
  templates: [
    { field: 'title', label: 'Formanın adı', cls: 'c-title', aliases: ['ad', 'title', 'formanınadı', 'formaninadi', 'şablonadı', 'sablonadi', 'name'] },
    { field: 'strukturAdi', label: 'Struktur adı', cls: 'c-struct', aliases: ['strukturadı', 'strukturadi', 'struktur', 'qrupadı', 'qrupadi', 'group'] },
    { field: 'subtitle', label: 'Sənədin adı', cls: 'c-mid', aliases: ['sənədinadı', 'senedinadi', 'subtitle'] },
    { field: 'docType', label: 'Sənədin növü', cls: 'c-mid', aliases: ['sənədinnövü', 'senedinnovu', 'doctype'] },
    { field: 'edition', label: 'Nəşr', cls: 'c-narrow', aliases: ['nəşr', 'nesr', 'edition'] },
    { field: 'approvalDate', label: 'Təsdiq tarixi', cls: 'c-mid', aliases: ['təsdiqtarixi', 'tesdiqtarixi', 'approvaldate'] }
  ]
};
// Vəzifə Təlimatları: Struktur vahidi -> Struktur bölməsi -> Vəzifə (one file each)
KIND_COLUMNS.jobs = [
  { field: 'strukturAdi', label: 'Struktur vahidi', cls: 'c-struct', aliases: ['strukturvahidi', 'əsasqrup', 'esasqrup', 'struktur', 'strukturadı', 'strukturadi'] },
  { field: 'bolme', label: 'Struktur bölməsi', cls: 'c-struct', aliases: ['strukturbölməsi', 'strukturbolmesi', 'altqrup', 'bölmə', 'bolme'] },
  { field: 'title', label: 'Vəzifə', cls: 'c-pos', aliases: ['vəzifə', 'vezife', 'title', 'ad', 'name'] }
];
const SHOW_DATE = { diagrams: true, pdfs: false, templates: false, jobs: true };
const ALL_FIELDS = ['title', 'strukturAdi', 'bolme', 'subtitle', 'docType', 'edition', 'approvalDate', 'protocol', 'pageCount'];

const KIND_META = {
  diagrams: { section: 'İş Axışları', title: 'İş axışların hesabatı', home: 'İş Axışları' },
  pdfs: { section: 'Normativ Sənədlər', title: 'Normativ sənədlərin hesabatı', home: 'Normativ Sənədlər' },
  templates: { section: 'Şablonlar', title: 'Şablonların hesabatı', home: 'Şablonlar' },
  jobs: { section: 'Vəzifə Təlimatları', title: 'Vəzifə təlimatlarının hesabatı', home: 'Vəzifə Təlimatları' }
};

const LINK_COL = { field: 'linkTitle', label: 'Əlaqəli element (əsas səhifə)', aliases: ['əlaqəlielement', 'elaqelielement', 'əlaqəlielementəsassəhifə', 'linked', 'əlaqə', 'elaqe'] };

const LINK_LABELS = { title: 'Ad', subtitle: 'Nömrə', strukturAdi: 'Struktur adı', bolme: 'Struktur bölməsi', status: 'Status' };
const JOB_LINK_LABELS = { ...LINK_LABELS, title: 'Vəzifə', strukturAdi: 'Struktur vahidi' };

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
function fmtTime(d) {
  const h = d.getHours();
  return `${String(h % 12 || 12).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Excel imports can leave a Date.toString() dump in a free-text date field.
function fmtFreeDate(v) {
  if (!v || typeof v !== 'string') return v;
  if (!/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{4} \d{2}:\d{2}:\d{2} GMT/.test(v)) return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}

/* ---------------- inline editable cell ---------------- */
// Shows plain text; click (admin) turns it into an auto-growing editor.
// Enter / leaving the cell saves, Esc cancels.
function Cell({ value, editable, onSave, suggestions, placeholder = '—' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const ref = useRef(null);

  useEffect(() => { if (!editing) setDraft(value || ''); }, [value, editing]);
  useEffect(() => {
    if (!editing || !ref.current) return;
    const el = ref.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    fit();
  }, [editing]);

  function fit() {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }
  function commit(v = draft) {
    setEditing(false);
    if ((v || '') !== (value || '')) onSave(v);
  }

  const shown = suggestions && draft
    ? suggestions.filter(s => s !== draft && foldText(s).includes(foldText(draft))).slice(0, 6)
    : (suggestions || []).slice(0, 6);

  if (!editing) {
    return (
      <div
        className={`hs-cell ${editable ? 'is-editable' : ''} ${value ? '' : 'is-empty'}`}
        onClick={() => editable && setEditing(true)}
        tabIndex={editable ? 0 : -1}
        onKeyDown={(e) => { if (editable && (e.key === 'Enter' || e.key === 'F2')) { e.preventDefault(); setEditing(true); } }}
      >
        {value || placeholder}
      </div>
    );
  }
  return (
    <div className="hs-cell-edit">
      <textarea
        ref={ref}
        rows={1}
        value={draft}
        onChange={(e) => { setDraft(e.target.value); fit(); }}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { setDraft(value || ''); setEditing(false); }
        }}
      />
      {suggestions && shown.length > 0 && (
        <div className="hs-suggest">
          {shown.map(s => (
            <button key={s} type="button" onMouseDown={(e) => { e.preventDefault(); commit(s); }}>{s}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- link dialog ---------------- */
function LinkDialog({ kind, row, homeLabel, statusMeta, onClose, onRowChanged, onOpenItem }) {
  const LABELS = kind === 'jobs' ? JOB_LINK_LABELS : LINK_LABELS;
  const { t } = useLabels();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [choices, setChoices] = useState({});

  const load = useCallback(async () => {
    setError('');
    try {
      const d = await api.getSheetLink(kind, row.id);
      setInfo(d);
      setPicking(!d.item);
      setChoices({});
    } catch (e) { setError(e.message || 'Yüklənmədi'); }
  }, [kind, row.id]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function run(fn) {
    setBusy(true);
    setError('');
    try {
      const d = await fn();
      setInfo(d);
      setPicking(!d.item);
      setChoices({});
      onRowChanged(d.row);
    } catch (e) { setError(e.message || 'Alınmadı'); }
    finally { setBusy(false); }
  }

  const statusText = (k) => (k && statusMeta[k] ? t(statusMeta[k].id, statusMeta[k].default) : '');
  const show = (field, v) => (field === 'status' ? (v ? <StatusBadge value={v} meta={statusMeta} size={12} /> : <span className="hs-muted">—</span>) : (v || <span className="hs-muted">—</span>));

  const options = useMemo(() => {
    const list = info?.options || [];
    const f = foldText(q);
    const filtered = f ? list.filter(o => foldText(`${o.title} ${o.subtitle} ${o.strukturAdi}`).includes(f)) : list;
    // best guesses first: same name, then same place (vahid / bölmə), then same status
    const eq = (a, b) => !!foldText(a) && foldText(a) === foldText(b);
    const rowBolme = row.bolme || row.strukturAdi;
    const scored = filtered.map(o => {
      const m = {
        title: eq(o.title, row.title),
        vahid: eq(o.strukturAdi, row.strukturAdi),
        bolme: kind === 'jobs' ? eq(o.bolme, rowBolme) : null,
        status: kind === 'templates' || !o.status || !row.status ? null : o.status === row.status
      };
      const score = (m.title ? 8 : 0) + (m.bolme ? 4 : 0) + (m.vahid ? 2 : 0) + (m.status ? 1 : 0) - (o.linkedRow != null ? 3 : 0);
      return { ...o, m, score };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, 80);
  }, [info, q, row.title, row.strukturAdi, row.bolme, row.status, kind]);
  const placeOf = (o) => (kind === 'jobs'
    ? [o.strukturAdi, foldText(o.bolme) !== foldText(o.strukturAdi) ? o.bolme : ''].filter(Boolean).join(' / ')
    : [o.subtitle, o.strukturAdi].filter(Boolean).join(' · '));
  const rowPlace = kind === 'jobs'
    ? [row.strukturAdi, foldText(row.bolme) !== foldText(row.strukturAdi) ? row.bolme : ''].filter(Boolean).join(' / ')
    : [row.subtitle, row.strukturAdi].filter(Boolean).join(' · ');

  const diffs = (info?.diffs || []);
  const different = diffs.filter(d => !d.same);
  const chosen = Object.keys(choices).length;

  return (
    <div className="hs-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="hs-modal" role="dialog" aria-modal="true">
        <div className="hs-modal-head">
          <div>
            <div className="hs-eyebrow">Əlaqə · {homeLabel}</div>
            <h3>{row.title || 'Adsız sətir'}</h3>
          </div>
          <button className="hs-icon" onClick={onClose} title="Bağla"><X size={18} /></button>
        </div>

        {!info && !error && <div className="hs-modal-body hs-center"><Loader2 size={18} className="spin" /></div>}
        {error && <div className="hs-alert">{error}</div>}

        {info && !picking && info.item && (
          <div className="hs-modal-body">
            <div className="hs-linked-card">
              <div className="hs-linked-ico"><FolderOpen size={18} /></div>
              <div className="hs-linked-text">
                <div className="hs-linked-title">{info.item.title}</div>
                <div className="hs-linked-sub">
                  {placeOf(info.item) || '—'}
                  {info.archived && <span className="hs-tag warn">Arxivdədir</span>}
                </div>
              </div>
              {!info.archived && onOpenItem && (
                <button className="hs-btn ghost" onClick={() => onOpenItem(kind, { ...row, itemId: info.item.id })}>
                  <ExternalLink size={15} /><span>Aç</span>
                </button>
              )}
            </div>

            {different.length === 0 ? (
              <div className="hs-same"><Check size={16} /> Hesabat və {homeLabel} eynidir.</div>
            ) : (
              <>
                <p className="hs-hint">
                  {different.length} sahə fərqlidir. Hər biri üçün hansını saxlamaq istədiyinizi seçin —
                  digər tərəf seçdiyinizə görə yenilənəcək.
                </p>
                <div className="hs-compare">
                  <div className="hs-compare-head">
                    <span />
                    <span>Hesabat</span>
                    <span>{homeLabel}</span>
                  </div>
                  {diffs.map(d => (
                    <div key={d.field} className={`hs-compare-row ${d.same ? 'is-same' : ''}`}>
                      <span className="hs-compare-label">{LABELS[d.field]}</span>
                      {d.same ? (
                        <span className="hs-compare-same">{show(d.field, d.hesabat)} <Check size={14} /></span>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={info.archived}
                            className={`hs-pick ${choices[d.field] === 'hesabat' ? 'on' : ''}`}
                            onClick={() => setChoices(c => ({ ...c, [d.field]: c[d.field] === 'hesabat' ? undefined : 'hesabat' }))}
                            title={`${homeLabel} bu dəyərlə yenilənsin`}
                          >
                            {show(d.field, d.hesabat)}
                          </button>
                          <button
                            type="button"
                            disabled={info.archived}
                            className={`hs-pick ${choices[d.field] === 'home' ? 'on' : ''}`}
                            onClick={() => setChoices(c => ({ ...c, [d.field]: c[d.field] === 'home' ? undefined : 'home' }))}
                            title="Hesabat bu dəyərlə yenilənsin"
                          >
                            {show(d.field, d.home)}
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                {chosen > 0 && (
                  <ul className="hs-plan">
                    {Object.entries(choices).filter(([, v]) => v).map(([f, v]) => (
                      <li key={f}>
                        {v === 'hesabat'
                          ? <><ArrowRight size={13} /> {homeLabel}: <b>{LABELS[f]}</b> → {f === 'status' ? statusText(row.status) || '—' : (row[f] || '—')}</>
                          : <><ArrowLeft size={13} /> Hesabat: <b>{LABELS[f]}</b> → {f === 'status' ? statusText(info.item.status) || '—' : (info.item[f] || '—')}</>}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        {info && picking && (
          <div className="hs-modal-body">
            <p className="hs-hint">Bu sətri {homeLabel} siyahısındakı bir elementə bağlayın. Bağlantı yalnız müqayisə və açmaq üçündür — heç nə avtomatik dəyişmir.</p>
            <div className="hs-link-self">
              <span className="hs-link-self-k">Bu sətir</span>
              <b>{row.title || '—'}</b>
              {rowPlace && <span className="hs-link-self-p">{rowPlace}</span>}
              {row.status && kind !== 'templates' && <StatusBadge value={row.status} meta={statusMeta} size={11} />}
            </div>
            <div className="hs-search in-modal">
              <Search size={15} />
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Ad, nömrə və ya qovluq ilə axtar" />
            </div>
            <div className="hs-options">
              {options.length === 0 && <div className="hs-muted hs-pad">Uyğun element yoxdur</div>}
              {options.map((o, i) => (
                <button
                  key={o.id}
                  type="button"
                  className={`hs-option ${info.item?.id === o.id ? 'on' : ''}`}
                  disabled={busy}
                  onClick={() => run(() => api.setSheetLink(kind, row.id, o.id))}
                >
                  <span className="hs-option-title">
                    {o.title}
                    {o.filename && <FileTypePill filename={o.filename} className="ft-inline" />}
                    {i === 0 && o.m.title && (o.m.bolme ?? o.m.vahid) && !q && <span className="hs-tag good">Ən uyğun</span>}
                  </span>
                  <span className="hs-option-sub">{placeOf(o) || '—'}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {info && (
          <div className="hs-modal-foot">
            {info.item && !picking && (
              <>
                <button className="hs-btn ghost danger" disabled={busy} onClick={() => run(() => api.setSheetLink(kind, row.id, null))}>
                  <Unlink size={15} /><span>Əlaqəni sil</span>
                </button>
                <button className="hs-btn ghost" disabled={busy} onClick={() => setPicking(true)}>
                  <Link2 size={15} /><span>Başqa elementə bağla</span>
                </button>
                <span className="hs-grow" />
                {different.length > 0 && (
                  <button className="hs-btn primary" disabled={busy || chosen === 0 || info.archived}
                    onClick={() => run(() => api.applySheetLink(kind, row.id, Object.fromEntries(Object.entries(choices).filter(([, v]) => v))))}>
                    {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
                    <span>Seçilənləri tətbiq et{chosen ? ` (${chosen})` : ''}</span>
                  </button>
                )}
              </>
            )}
            {picking && info.item && (
              <>
                <span className="hs-grow" />
                <button className="hs-btn ghost" onClick={() => setPicking(false)}>Geri</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- archive drawer ---------------- */
function ArchiveDrawer({ kind, columns, statusMeta, withStatus, isAdmin, onClose, onRestored, onDeleted, refreshKey }) {
  const [items, setItems] = useState(null);
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.listSheetArchive(kind).then(d => setItems(d?.items || [])).catch(e => setError(e.message));
  }, [kind, refreshKey]);
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const list = useMemo(() => {
    const f = foldText(q);
    return (items || []).filter(r => !f || foldText(columns.map(c => r[c.field]).join(' ')).includes(f));
  }, [items, q, columns]);

  async function restore(r) {
    setBusyId(r.id);
    try {
      const back = await api.restoreSheet(kind, r.id);
      setItems(prev => prev.filter(x => x.id !== r.id));
      onRestored(back);
    } catch (e) { setError(e.message); }
    finally { setBusyId(null); }
  }

  async function remove(r) {
    if (!confirm(`“${r.title || 'Bu sətir'}” arxivdən silinsin?`)) return;
    setBusyId(r.id);
    try {
      await api.deleteArchivedSheet(kind, r.id);
      setItems(prev => prev.filter(x => x.id !== r.id));
      onDeleted?.();
    } catch (e) { setError(e.message); }
    finally { setBusyId(null); }
  }

  return (
    <div className="hs-drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="hs-drawer">
        <div className="hs-drawer-head">
          <div>
            <div className="hs-eyebrow">Hesabat</div>
            <h3><Archive size={18} /> Arxiv {items ? <span className="hs-count">{items.length}</span> : null}</h3>
          </div>
          <button className="hs-icon" onClick={onClose} title="Bağla"><X size={18} /></button>
        </div>
        <div className="hs-search in-drawer">
          <Search size={15} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Arxivdə axtar" />
        </div>
        {error && <div className="hs-alert">{error}</div>}
        <div className="hs-drawer-list">
          {!items && <div className="hs-center hs-pad"><Loader2 size={18} className="spin" /></div>}
          {items && list.length === 0 && (
            <div className="hs-empty-small">
              <Archive size={22} />
              <span>{items.length ? 'Uyğun sətir yoxdur' : 'Arxiv boşdur'}</span>
            </div>
          )}
          {list.map(r => (
            <div key={r.id} className="hs-arch-item">
              <div className="hs-arch-main">
                <div className="hs-arch-title">{r.title || 'Adsız sətir'}</div>
                <div className="hs-arch-sub">
                  {[r.strukturAdi, r.subtitle].filter(Boolean).join(' · ') || '—'}
                </div>
                <div className="hs-arch-meta">
                  {withStatus && r.status && <StatusBadge value={r.status} meta={statusMeta} size={11} />}
                  <span>Arxivə: {fmtDate(r.archivedAt)}</span>
                  {r.archivedFromOrder ? <span>· əvvəl №{r.archivedFromOrder}</span> : null}
                  {r.note ? <span className="hs-tag info">{r.note}</span> : null}
                </div>
              </div>
              {isAdmin && (
                <button className="hs-btn ghost" disabled={busyId === r.id} onClick={() => restore(r)} title="Hesabata qaytar">
                  {busyId === r.id ? <Loader2 size={15} className="spin" /> : <ArchiveRestore size={15} />}
                  <span>Bərpa et</span>
                </button>
              )}
              {isAdmin && (
                <button className="hs-icon del-solid" disabled={busyId === r.id} onClick={() => remove(r)} title="Arxivdən sil">
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

/* ---------------- clear the whole table ---------------- */
function ClearAllDialog({ count, homeLabel, onExport, onArchiveAll, onDeleteAll, onClose }) {
  const [busy, setBusy] = useState(null);
  const [exported, setExported] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' && !busy) onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);
  async function run(which, fn) {
    setBusy(which); setError('');
    try { await fn(); onClose(); } catch (e) { setError(e.message || 'Alınmadı'); setBusy(null); }
  }
  return (
    <div className="hs-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="hs-modal hs-modal-sm" role="alertdialog" aria-modal="true">
        <div className="hs-modal-head">
          <div className="hs-warn-head">
            <span className="hs-warn-ico"><AlertTriangle size={20} /></span>
            <div>
              <div className="hs-eyebrow danger">Diqqət</div>
              <h3>Bütün hesabat təmizlənsin?</h3>
            </div>
          </div>
          <button className="hs-icon" onClick={onClose} disabled={!!busy} title="Bağla"><X size={18} /></button>
        </div>
        <div className="hs-modal-body">
          <p className="hs-hint">
            Cədvəldəki <b>{count} sətrin hamısı</b> götürüləcək. Bu yalnız hesabata aiddir —
            <b> {homeLabel} (əsas səhifə) dəyişmir</b>, oradakı heç nə silinmir.
          </p>
          <div className="hs-steps">
            <button className={`hs-step ${exported ? 'done' : ''}`} disabled={!!busy} onClick={() => { onExport(); setExported(true); }}>
              <span className="hs-step-ico">{exported ? <Check size={16} /> : <Download size={16} />}</span>
              <span className="hs-step-text"><b>1. Əvvəlcə Excel-ə çıxart</b><small>{exported ? 'Fayl yükləndi' : 'Tövsiyə olunur — bütün sətirlərin nüsxəsi'}</small></span>
            </button>
            <button className="hs-step" disabled={!!busy} onClick={() => run('archive', onArchiveAll)}>
              <span className="hs-step-ico">{busy === 'archive' ? <Loader2 size={16} className="spin" /> : <Archive size={16} />}</span>
              <span className="hs-step-text"><b>2. Hamısını arxivə köçür</b><small>Arxivdən istənilən vaxt geri qaytarmaq olar</small></span>
            </button>
            <button className="hs-step danger" disabled={!!busy}
              onClick={() => { if (confirm(`${count} sətir hesabatdan silinsin?`)) run('delete', onDeleteAll); }}>
              <span className="hs-step-ico">{busy === 'delete' ? <Loader2 size={16} className="spin" /> : <Trash2 size={16} />}</span>
              <span className="hs-step-text"><b>Hamısını sil</b><small>Səhifədən götürülür, Arxivdə görünmür{exported ? '' : ' — əvvəlcə Excel-ə çıxartmağınız tövsiyə olunur'}</small></span>
            </button>
          </div>
          {error && <div className="hs-alert" style={{ margin: '12px 0 0' }}>{error}</div>}
        </div>
      </div>
    </div>
  );
}

/* =============================== PAGE =============================== */
const foldAz = (v) => String(v ?? '').trim().toLocaleLowerCase('az').replace(/\s+/g, ' ');
const posKey = (vahid, bolme, title) => `${foldAz(vahid)}|${foldAz(bolme)}|${foldAz(title)}`;
// Home tree of Vəzifə Təlimatları -> position key -> file (same rule as the backend's jobFolder)
// Dropdowns open as position:fixed so the rounded table card never clips them.
function fixedMenuStyle(el) {
  const btn = el?.querySelector('.hs-info-btn');
  if (!btn) return undefined;
  const r = btn.getBoundingClientRect();
  return { position: 'fixed', top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right), left: 'auto' };
}
function buildPosFiles(d) {
  const groups = new Map((d?.groups || []).map(g => [Number(g.id), g]));
  const m = new Map();
  for (const x of (d?.pdfs || [])) {
    if (!x.filename || x.noFile) continue;
    const g = groups.get(Number(x.groupId));
    if (!g) continue;
    const parent = g.parentId != null ? groups.get(Number(g.parentId)) : null;
    const vahid = parent ? parent.name : g.name;
    m.set(posKey(vahid, g.name, x.title), { id: Number(x.id), filename: String(x.filename) });
  }
  return m;
}

export default function SheetsPage({ kind = 'diagrams', onBack, onLogout, onOpenItem, withStatus = true }) {
  const { t, tByText } = useLabels();
  const role = localStorage.getItem('role');
  const isAdmin = role === 'admin';
  const meta = KIND_META[kind] || KIND_META.diagrams;
  const columns = KIND_COLUMNS[kind] || KIND_COLUMNS.diagrams;
  const showDate = SHOW_DATE[kind] !== false;
  const STATUS_META = kind === 'diagrams' ? PROCESS_STATUS_META : kind === 'jobs' ? JOB_STATUS_META : DOC_STATUS_META;
  const STATUS_ORDER = kind === 'diagrams' ? PROCESS_STATUS_ORDER : kind === 'jobs' ? JOB_STATUS_ORDER : DOC_STATUS_ORDER;

  const [now, setNow] = useState(new Date());
  const [items, setItems] = useState(() => sheetsCache.get(kind) || []);
  const [loading, setLoading] = useState(() => !sheetsCache.has(kind));
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState(null);
  const [colFilters, setColFilters] = useState({});
  const [openColFilter, setOpenColFilter] = useState(null);
  const [groups, setGroups] = useState([]);
  const [homeItems, setHomeItems] = useState(() => new Map()); // id -> title (for links / Excel)
  const [homeFiles, setHomeFiles] = useState(() => new Map()); // id -> filename (Vəzifə Təlimatları)
  const [posFiles, setPosFiles] = useState(() => new Map()); // "vahid|bölmə|vəzifə" -> { id, filename } (no link needed)
  const [autoLink, setAutoLink] = useState(false); // "Avtomatik bağla" for this section (off by default)
  const [fileBusy, setFileBusy] = useState(null);
  const fileInputRef = useRef(null);
  const fileRowRef = useRef(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [linkFilter, setLinkFilter] = useState(null); // null | 'linked' | 'unlinked'
  const [infoOpen, setInfoOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [archivedRows, setArchivedRows] = useState([]); // for the AI context
  const [drawerKey, setDrawerKey] = useState(0);
  const infoRef = useRef(null);
  const [draft, setDraft] = useState(null); // new-row form or null
  const [savingDraft, setSavingDraft] = useState(false);
  const [linkRow, setLinkRow] = useState(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveCount, setArchiveCount] = useState(null);
  const [toast, setToast] = useState(null);
  const [homeTick, setHomeTick] = useState(0);
  const [importBusy, setImportBusy] = useState(false);
  const [importPlan, setImportPlan] = useState(null);
  const [importDecisions, setImportDecisions] = useState({});
  const importInputRef = useRef(null);
  const linkByTitleRef = useRef(new Map());
  // sticky sideways scrollbar (only when the table overflows and its own bar is off-screen)
  const scrollRef = useRef(null);
  const hbarRef = useRef(null);
  const syncing = useRef(false);
  const [hbar, setHbar] = useState({ show: false, width: 0 });
  const [scrolledX, setScrolledX] = useState(false);
  const measureHbar = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const overflow = sc.scrollWidth > sc.clientWidth + 2;
    const bottomOff = sc.getBoundingClientRect().bottom > window.innerHeight - 2;
    const next = { show: overflow && bottomOff, width: sc.scrollWidth };
    setHbar(prev => (prev.show === next.show && prev.width === next.width ? prev : next));
  }, []);
  function onTableScroll(e) {
    const left = e.currentTarget.scrollLeft;
    setScrolledX(left > 2);
    if (syncing.current) { syncing.current = false; return; }
    if (hbarRef.current) { syncing.current = true; hbarRef.current.scrollLeft = left; }
  }
  const draftRef = useRef(null);
  const toastTimer = useRef(null);

  useEffect(() => { const id = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(id); }, []);
  useEffect(() => {
    measureHbar();
    window.addEventListener('scroll', measureHbar, true);
    window.addEventListener('resize', measureHbar);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measureHbar) : null;
    if (ro && scrollRef.current) { ro.observe(scrollRef.current); if (scrollRef.current.firstChild) ro.observe(scrollRef.current.firstChild); }
    return () => {
      window.removeEventListener('scroll', measureHbar, true);
      window.removeEventListener('resize', measureHbar);
      ro?.disconnect();
    };
  }, [measureHbar, loading]);
  useEffect(() => {
    if (hbar.show && hbarRef.current && scrollRef.current) hbarRef.current.scrollLeft = scrollRef.current.scrollLeft;
  }, [hbar.show]);

  const setRows = useCallback((updater) => {
    setItems(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      sheetsCache.set(kind, next);
      return next;
    });
  }, [kind]);

  const load = useCallback(async () => {
    try {
      const d = await api.listSheets(kind);
      setRows(Array.isArray(d?.items) ? d.items : []);
      setError('');
    } catch (e) { setError(e.message || 'Yüklənmədi'); }
    finally { setLoading(false); }
  }, [kind, setRows]);

  useEffect(() => {
    setItems(sheetsCache.get(kind) || []);
    setLoading(!sheetsCache.has(kind));
    setQuery(''); setStatusFilter(null); setColFilters({}); setDraft(null); setLinkFilter(null);
    load();
    api.listSheetArchive(kind).then(d => { setArchiveCount((d?.items || []).length); setArchivedRows(d?.items || []); }).catch(() => {});
    // folder names (only as suggestions for Struktur adı)
    const req = kind === 'diagrams' ? api.listProcesses()
      : kind === 'pdfs' ? import('../api/pdfsClient.js').then(m => m.pdfsApi.list())
      : kind === 'jobs' ? import('../api/jobsClient.js').then(m => m.jobsApi.list())
      : import('../api/templatesClient.js').then(m => m.templatesApi.list());
    Promise.resolve(req).then(d => {
      setGroups(Array.from(new Set((d?.groups || []).map(g => String(g?.name || '').trim()).filter(Boolean))));
      const list = Array.isArray(d?.processes) ? d.processes : (Array.isArray(d?.pdfs) ? d.pdfs : []);
      setHomeItems(new Map(list.map(x => [Number(x.id), String(x.title || '')])));
      setHomeFiles(new Map(list.filter(x => x.filename && !x.noFile).map(x => [Number(x.id), String(x.filename)])));
      setPosFiles(kind === 'jobs' ? buildPosFiles(d) : new Map());
    }).catch(() => { setGroups([]); setHomeItems(new Map()); });
    api.getSettings().then(st => setAutoLink(st?.[`autolink_${kind}`] === true)).catch(() => setAutoLink(false));
  }, [kind, load, homeTick]);

  async function toggleAutoLink() {
    const next = !autoLink;
    setAutoLink(next);
    try {
      await api.updateSettings({ [`autolink_${kind}`]: next });
      flash(next ? 'Avtomatik bağlama açıldı — eyni adlı sətir və fayllar özü bağlanacaq' : 'Avtomatik bağlama bağlandı');
    } catch (e) { setAutoLink(!next); flash('Yadda saxlanmadı: ' + (e.message || '')); }
  }
  // The Vəzifə file belongs to its position (vahid + bölmə + Vəzifə), linked or not.
  function fileFor(r) {
    if (kind !== 'jobs') return null;
    if (r.itemId != null && homeFiles.has(Number(r.itemId))) return { id: Number(r.itemId), filename: homeFiles.get(Number(r.itemId)) };
    return posFiles.get(posKey(r.strukturAdi, r.bolme || r.strukturAdi, r.title)) || null;
  }

  function flash(msg, undo) {
    clearTimeout(toastTimer.current);
    setToast({ msg, undo });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }

  /* ---------- filtering ---------- */
  const statusLabel = useCallback((k) => (STATUS_META[k] ? t(STATUS_META[k].id, STATUS_META[k].default) : ''), [STATUS_META, t]);

  const getters = useMemo(() => {
    const m = {};
    for (const c of columns) m[c.field] = c.field === 'approvalDate' ? (r) => fmtFreeDate(r[c.field]) : (r) => r[c.field];
    if (withStatus) m.status = (r) => (r.status ? statusLabel(r.status) : '');
    if (showDate) m.date = (r) => (r.date ? fmtDate(r.date) : '');
    return m;
  }, [columns, withStatus, showDate, statusLabel]);

  const colOptions = useMemo(() => {
    const o = {};
    for (const [k, get] of Object.entries(getters)) o[k] = uniqueColumnValues(items, get);
    return o;
  }, [items, getters]);

  const dq = useDeferredValue(query);
  const dCol = useDeferredValue(colFilters);
  const dStatus = useDeferredValue(statusFilter);

  const visible = useMemo(() => {
    const f = foldText(dq);
    const active = Object.entries(dCol).filter(([, s]) => s != null);
    return items.filter(r => {
      if (dStatus === 'none' ? !!r.status : (dStatus && r.status !== dStatus)) return false;
      if (linkFilter === 'linked' && r.itemId == null) return false;
      if (linkFilter === 'unlinked' && r.itemId != null) return false;
      for (const [k, allowed] of active) {
        const raw = getters[k]?.(r);
        const v = raw == null || String(raw).trim() === '' ? BLANK_FILTER_VALUE : String(raw).trim();
        if (!allowed.has(v)) return false;
      }
      if (f && !foldText(columns.map(c => r[c.field]).join(' ')).includes(f)) return false;
      return true;
    });
  }, [items, dq, dCol, dStatus, getters, columns, linkFilter]);

  const stats = useMemo(() => {
    const by = {};
    STATUS_ORDER.forEach(k => { by[k] = 0; });
    let none = 0;
    for (const r of items) { if (r.status && by[r.status] != null) by[r.status]++; else none++; }
    return { total: items.length, by, none };
  }, [items, STATUS_ORDER]);

  const filtersActive = !!statusFilter || !!query || !!linkFilter || Object.values(colFilters).some(Boolean);
  const linkedCount = useMemo(() => items.filter(r => r.itemId != null).length, [items]);
  useEffect(() => {
    if (!infoOpen) return;
    const onDoc = (e) => { if (infoRef.current && !infoRef.current.contains(e.target)) setInfoOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [infoOpen]);

  /* ---------- row actions ---------- */
  async function patchRow(id, patch) {
    if (kind === 'jobs' && typeof patch.title === 'string') {
      const r0 = items.find(x => x.id === id);
      // only a LINKED row renames the Home item / file (the backend does the same)
      const f0 = r0 && r0.itemId != null && homeFiles.has(Number(r0.itemId)) ? { id: Number(r0.itemId), filename: homeFiles.get(Number(r0.itemId)) } : null;
      if (f0 && patch.title.trim()) {
        const ext = (/\.([a-z0-9]+)$/i.exec(f0.filename) || [])[1] || 'pdf';
        const fn = `${patch.title.trim()}.${ext}`;
        setHomeFiles(m => new Map(m).set(f0.id, fn));
        setHomeItems(m => new Map(m).set(f0.id, patch.title.trim()));
        setPosFiles(m => {
          const n = new Map(m);
          n.delete(posKey(r0.strukturAdi, r0.bolme || r0.strukturAdi, r0.title));
          n.set(posKey(r0.strukturAdi, r0.bolme || r0.strukturAdi, patch.title.trim()), { id: f0.id, filename: fn });
          return n;
        });
      }
    }
    setRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
    try {
      const updated = await api.updateSheet(kind, id, patch);
      if (updated) setRows(prev => prev.map(r => (r.id === id ? updated : r)));
    } catch (e) {
      flash('Yadda saxlanmadı: ' + (e.message || ''));
      load();
    }
  }

  async function archiveRow(row) {
    // optimistic: remove + renumber so there is never a gap
    setRows(prev => prev.filter(r => r.id !== row.id).map((r, i) => ({ ...r, order: i + 1 })));
    try {
      await api.archiveSheet(kind, row.id);
      setArchiveCount(c => (c == null ? c : c + 1));
      flash(`“${row.title || 'Sətir'}” arxivə köçürüldü`, async () => {
        try {
          await api.restoreSheet(kind, row.id);
          setArchiveCount(c => (c == null ? c : Math.max(0, c - 1)));
          await load();
          setToast(null);
        } catch (e) { flash('Bərpa olunmadı: ' + e.message); }
      });
    } catch (e) {
      flash('Arxivə köçürülmədi: ' + (e.message || ''));
      load();
    }
  }

  const [foldersBusy, setFoldersBusy] = useState(false);
  // Vəzifə Təlimatları: build the Home folder tree from the table (explicit, one click)
  async function buildJobFolders() {
    const pairs = [];
    const seen = new Set();
    for (const r of items) {
      const vahid = (r.strukturAdi || '').trim(), bolme = (r.bolme || '').trim();
      if (!vahid && !bolme) continue;
      const k = `${foldText(vahid)}|${foldText(bolme)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push({ vahid, bolme });
    }
    if (!pairs.length) return 0;
    const { jobsApi } = await import('../api/jobsClient.js');
    const r = await jobsApi.structure(pairs);
    return r?.created || 0;
  }

  /* ---------- ⋯ link menu: link all / unlink all / choose / auto ---------- */
  const [linkMenu, setLinkMenu] = useState(false);
  const [pickOpen, setPickOpen] = useState(null); // null | { items, picked:Set }
  const linkMenuTimer = useRef(null);
  const moreRef = useRef(null);
  useEffect(() => {
    if (!linkMenu && !infoOpen) return undefined;
    const close = () => { setLinkMenu(false); setInfoOpen(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [linkMenu, infoOpen]);
  async function linkAll(ids) {
    setFoldersBusy(true);
    try {
      const made = kind === 'jobs' ? await buildJobFolders().catch(() => 0) : 0;
      const r = await api.linkAllSheets(kind, ids);
      if (Array.isArray(r?.items)) setRows(() => r.items);
      flash(`${r?.linked || 0} sətir bağlandı${made ? ` · ${made} qovluq yaradıldı` : ''}`);
      if (made) setHomeTick(t => t + 1);
    } catch (e) { flash('Bağlanmadı: ' + (e.message || '')); }
    finally { setFoldersBusy(false); setLinkMenu(false); setPickOpen(null); }
  }
  async function unlinkAll() {
    if (!confirm('Bütün bağlantılar kəsilsin? Sətirlər və əsas səhifə olduğu kimi qalır.')) return;
    try {
      const r = await api.unlinkAllSheets(kind);
      flash(`${r?.unlinked || 0} bağlantı kəsildi`);
      load();
    } catch (e) { flash('Alınmadı: ' + (e.message || '')); }
    finally { setLinkMenu(false); }
  }
  async function openPicker() {
    setLinkMenu(false);
    try {
      const d = await api.linkCandidates(kind);
      const list = d?.items || [];
      if (!list.length) { flash('Bağlana biləcək eyni adlı sətir tapılmadı'); return; }
      setPickOpen({ items: list, picked: new Set(list.map(x => x.rowId)) });
    } catch (e) { flash('Alınmadı: ' + (e.message || '')); }
  }

  async function deleteRow(row) {
    if (!confirm(`“${row.title || 'Bu sətir'}” hesabatdan silinsin?\n\nƏsas səhifəyə toxunulmur.`)) return;
    setRows(prev => prev.filter(r => r.id !== row.id).map((r, i) => ({ ...r, order: i + 1 })));
    try {
      await api.deleteSheet(kind, row.id);
      flash(`“${row.title || 'Sətir'}” silindi`);
    } catch (e) {
      flash('Silinmədi: ' + (e.message || ''));
      load();
    }
  }

  function startDraft() {
    const d = { status: null };
    ALL_FIELDS.forEach(f => { d[f] = ''; });
    setDraft(d);
    setStatusFilter(null); setQuery(''); setColFilters({});
    requestAnimationFrame(() => draftRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }
  async function saveDraft() {
    if (!draft || savingDraft) return;
    const has = columns.some(c => (draft[c.field] || '').trim()) || draft.status;
    if (!has) { setDraft(null); return; }
    setSavingDraft(true);
    try {
      const body = { status: withStatus ? draft.status : null };
      ALL_FIELDS.forEach(f => { body[f] = (draft[f] || '').trim(); });
      const row = await api.createSheet(kind, body);
      setRows(prev => [...prev, row]);
      setDraft(null);
    } catch (e) { flash('Əlavə edilmədi: ' + (e.message || '')); }
    finally { setSavingDraft(false); }
  }

  function onRowChanged(row) {
    if (row) setRows(prev => prev.map(r => (r.id === row.id ? row : r)));
  }

  /* ---------- Excel ---------- */
  function handleExport(rows = visible) {
    const cols = [
      { label: '№', get: (_r, i) => i + 1 },
      ...columns.map(c => ({ label: tByText(c.label), get: (r) => (c.field === 'approvalDate' ? fmtFreeDate(r[c.field]) : r[c.field]) || '' }))
    ];
    if (withStatus) cols.push({ label: tByText('Status'), get: (r) => (r.status ? statusLabel(r.status) : '') });
    if (showDate) cols.push({ label: tByText('Tarix'), get: (r) => fmtDate(r.date) });
    cols.push({ label: LINK_COL.label, get: (r) => (r.itemId != null ? homeItems.get(Number(r.itemId)) || '' : '') });
    exportSheetToExcel({ fileTitle: `${tByText(meta.title)}`, sheetName: tByText(meta.title), items: rows, columns: cols });
  }

  function statusKeyFromLabel(raw) {
    const s = foldText(raw);
    if (!s) return null;
    for (const k of STATUS_ORDER) {
      if (foldText(k) === s || foldText(statusLabel(k)) === s || foldText(STATUS_META[k].default) === s) return k;
    }
    if (s.startsWith('planlas')) return 'progress';
    if (s.startsWith('hazirliq')) return 'prep';
    if (s.startsWith('tesdiq')) return 'done';
    if (s.startsWith('muzakire') || s.startsWith('qaralama')) return 'notdone';
    if (s.startsWith('imza')) return 'sign';
    if (s.startsWith('legv')) return 'cancelled';
    if (s.startsWith('yenile')) return 'renew';
    return null;
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !isAdmin) return;
    setImportBusy(true);
    try {
      const rows = await importSheetRowsFromExcel(file, {
        columns: columns.map(c => ({ field: c.field, label: tByText(c.label), aliases: c.aliases })),
        withStatus,
        statusKeyFromLabel,
        extraColumns: [LINK_COL]
      });
      if (!rows.length) { flash('Excel faylında sətir tapılmadı'); return; }
      // "Əlaqəli element" column: row title -> linked Home item title
      linkByTitleRef.current = new Map(rows.filter(r => r.linkTitle).map(r => [foldText(r.title), r.linkTitle]));
      const plan = buildImportPlan({ rows, items, fields: columns.map(c => c.field), withStatus, getStruktur: (r) => r.strukturAdi || '', keyFields: kind === 'jobs' ? ['title', 'strukturAdi', 'bolme'] : null });
      if (plan.conflicts.length) {
        setImportDecisions(defaultDecisions(plan));
        setImportPlan(plan);
        return;
      }
      await applyImport(plan, {});
    } catch (err) { flash('İdxal edilmədi: ' + (err.message || '')); }
    finally { setImportBusy(false); }
  }

  async function applyImport(plan, decisions) {
    const { creates, updates } = resolvePlan(plan, decisions);
    const idByTitle = new Map([...homeItems].map(([id, title]) => [foldText(title), id]));
    const linkFor = (title) => {
      const lt = linkByTitleRef.current.get(foldText(title));
      return lt ? idByTitle.get(foldText(lt)) : undefined;
    };
    setImportBusy(true);
    try {
      for (const u of updates) {
        const patch = { ...u.patch };
        const cur = items.find(x => Number(x.id) === Number(u.id));
        const link = linkFor(patch.title ?? cur?.title);
        if (link != null) patch.itemId = link;
        await api.updateSheet(kind, u.id, patch);
      }
      const bodies = creates.map((r) => {
        const body = { status: withStatus ? (r.status || null) : null };
        ALL_FIELDS.forEach(f => { body[f] = r[f] || ''; });
        const link = linkFor(r.title);
        if (link != null) body.itemId = link;
        return body;
      });
      for (let i = 0; i < bodies.length; i += 500) await api.createSheets(kind, bodies.slice(i, i + 500));
      await load();
      flash(`${creates.length} yeni sətir əlavə edildi, ${updates.length} sətir yeniləndi`);
    } catch (err) {
      flash('İdxal edilmədi: ' + (err.message || ''));
      load();
    } finally { setImportBusy(false); }
  }

  /* ---------- AI assistant (Hesabat) ---------- */
  // Rebuilt on every turn so the model always sees the current rows.
  function aiContext() {
    return {
      view: 'hesabat',
      kind,
      section: meta.section,
      note: 'Hesabat əsas səhifədən AYRIDIR. Buradakı əməliyyatlar əsas səhifəyə toxunmur.',
      statuses: withStatus ? STATUS_ORDER.map(k => ({ key: k, label: statusLabel(k) })) : [],
      rows: items.map(r => ({
        id: r.id, order: r.order, title: r.title, strukturAdi: r.strukturAdi, subtitle: r.subtitle,
        ...(kind === 'jobs' ? { bolme: r.bolme } : {}),
        ...(withStatus ? { status: r.status || null } : {}),
        linkedItemId: r.itemId ?? null
      })),
      archivedRows: archivedRows.map(r => ({ id: r.id, title: r.title, strukturAdi: r.strukturAdi, status: r.status || null })),
      homeItems: [...homeItems].map(([id, title]) => ({ id, title })),
      folders: groups,
      currentFilter: { query: query || null, status: statusFilter, link: linkFilter }
    };
  }

  async function runAiActions(actions) {
    const log = [];
    const ids = (a) => (Array.isArray(a.rowIds) ? a.rowIds : (a.rowId != null ? [a.rowId] : []));
    const pick = (a) => {
      const out = {};
      for (const f of ALL_FIELDS) if (typeof a[f] === 'string') out[f] = a[f];  // incl. bolme (jobs)
      if (a.status !== undefined && withStatus) out.status = a.status;
      return out;
    };
    let changed = false;
    for (const a of actions) {
      try {
        switch (a.type) {
          case 'create_row': await api.createSheet(kind, { status: null, ...pick(a) }); log.push(`Sətir əlavə edildi: "${a.title || ''}"`); changed = true; break;
          case 'update_row':
          case 'update_rows':
            for (const id of ids(a)) await api.updateSheet(kind, id, pick(a));
            log.push(`${ids(a).length} sətir yeniləndi`); changed = true; break;
          case 'archive_rows':
            for (const id of ids(a)) await api.archiveSheet(kind, id);
            log.push(`${ids(a).length} sətir arxivə köçürüldü`); changed = true; break;
          case 'delete_rows':
            for (const id of ids(a)) await api.deleteSheet(kind, id);
            log.push(`${ids(a).length} sətir silindi (data-da saxlanılır)`); changed = true; break;
          case 'archive_all': { const r = await api.archiveAllSheets(kind); log.push(`${r?.archived || 0} sətir arxivə köçürüldü`); changed = true; break; }
          case 'delete_all': { const r = await api.deleteAllSheets(kind); log.push(`${r?.deleted || 0} sətir silindi`); changed = true; break; }
          case 'restore_rows':
            for (const id of ids(a)) await api.restoreSheet(kind, id);
            log.push(`${ids(a).length} sətir arxivdən qaytarıldı`); changed = true; break;
          case 'delete_archived_rows':
            for (const id of ids(a)) await api.deleteArchivedSheet(kind, id);
            log.push(`${ids(a).length} sətir arxivdən silindi`); changed = true; break;
          case 'link_row': await api.setSheetLink(kind, a.rowId, a.itemId); log.push('Sətir bağlandı'); changed = true; break;
          case 'unlink_rows':
            for (const id of ids(a)) await api.setSheetLink(kind, id, null);
            log.push(`${ids(a).length} sətrin bağlantısı silindi`); changed = true; break;
          case 'unlink_all': { const r = await api.unlinkAllSheets(kind); log.push(`${r?.unlinked || 0} bağlantı silindi`); changed = true; break; }
          case 'filter':
            setQuery(a.query || '');
            setStatusFilter(a.status === undefined ? null : a.status);
            setLinkFilter(a.link === 'linked' || a.link === 'unlinked' ? a.link : null);
            log.push('Filtr tətbiq olundu'); break;
          case 'export_excel': handleExport(); log.push('Excel faylı hazırlandı'); break;
          case 'open_archive': setAiOpen(false); setArchiveOpen(true); log.push('Arxiv açıldı'); break;
          case 'logout': onLogout(); return log;
          default: log.push(`Naməlum əməliyyat: ${a.type}`);
        }
      } catch (e) { log.push(`Xəta (${a.type}): ${e.message || e}`); }
    }
    if (changed) {
      await load();
      try {
        const d = await api.listSheetArchive(kind);
        setArchivedRows(d?.items || []);
        setArchiveCount((d?.items || []).length);
      } catch { /* ignore */ }
      setDrawerKey(k => k + 1);
    }
    return log;
  }

  /* ---------- render ---------- */
  const total = stats.total || 1;
  const hasFileCol = kind === 'jobs';
  const colCount = 1 + columns.length + (withStatus ? 1 : 0) + (showDate ? 1 : 0) + 1;

  // Vəzifə Təlimatları: upload / replace the ONE file of a row's Vəzifə
  function pickFileFor(row) {
    fileRowRef.current = row;
    fileInputRef.current?.click();
  }
  async function onRowFilePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    const row = fileRowRef.current;
    if (!file || !row) return;
    if (!/\.(pdf|docx?|xlsx?)$/i.test(file.name)) { flash('Yalnız PDF, Word və ya Excel faylı yükləmək olar'); return; }
    const current = fileFor(row)?.filename || null;
    if (current && !confirm(`"${row.title}" — köhnə fayl (${current}) yeni faylla əvəz olunsun?\nYeni fayl: ${file.name}`)) return;
    setFileBusy(row.id);
    try {
      const { jobsApi } = await import('../api/jobsClient.js');
      const r = await jobsApi.fromRow(row.id, file);
      if (r?.row) setRows(prev => prev.map(x => (x.id === r.row.id ? r.row : x)));
      if (r?.item) {
        setHomeFiles(m => new Map(m).set(Number(r.item.id), r.item.filename));
        setHomeItems(m => new Map(m).set(Number(r.item.id), r.item.title));
        setPosFiles(m => new Map(m).set(posKey(row.strukturAdi, row.bolme || row.strukturAdi, r.item.title), { id: Number(r.item.id), filename: r.item.filename }));
      }
      flash(r?.replaced ? 'Fayl dəyişdirildi' : 'Fayl yükləndi və əsas səhifədəki qovluğa qoyuldu');
    } catch (err) { flash('Fayl yüklənmədi: ' + (err.message || '')); }
    finally { setFileBusy(null); }
  }
  async function viewRowFile(row) {
    const f = fileFor(row);
    if (!f) return;
    try { const { jobsApi } = await import('../api/jobsClient.js'); await jobsApi.view(f.id); }
    catch (err) { flash('Açılmadı: ' + (err.message || '')); }
  }

  function header(key, label, cls) {
    return (
      <th key={key} className={cls}>
        <div className="hs-th">
          <span>{label}</span>
          <SheetColumnFilter
            options={colOptions[key] || []}
            applied={colFilters[key] || null}
            open={openColFilter === key}
            onToggleOpen={() => setOpenColFilter(p => (p === key ? null : key))}
            onApply={(set) => startTransition(() => setColFilters(p => { const c = { ...p }; if (set == null) delete c[key]; else c[key] = set; return c; }))}
            onClose={() => setOpenColFilter(null)}
            searchPlaceholder={tByText('Search')}
            selectAllLabel={tByText('(Select All)')}
            blankLabel={tByText('(Boş)')}
            okLabel={tByText('OK')}
            cancelLabel={tByText('Cancel')}
          />
        </div>
      </th>
    );
  }

  return (
    <div className="hs-page">
      <div className="topbar">
        <div className="top-left">
          <button className="pill-chip back-chip" onClick={onBack}>
            <ChevronLeft size={16} /><span>{tByText('Geri')}</span>
          </button>
          <div className="pill-chip">{fmtTime(now)}</div>
          <div className="pill-chip">{fmtDate(now)}</div>
        </div>
        <div className="top-right">
          {isAdmin && <AiButton active={aiOpen} onClick={() => setAiOpen(v => !v)} />}
          <button className="logout-btn" onClick={onLogout}>
            <LogOut size={16} /><span>{t('topbar.logout', 'Çıxış')}</span>
          </button>
        </div>
      </div>

      <main className="hs-main">
        <header className="hs-head">
          <div className="hs-head-text">
            <div className="hs-eyebrow">{meta.section}</div>
            <h1>{tByText(meta.title)}</h1>
            <p>Əsas səhifədən ayrıca saxlanılır · {stats.total} sətir</p>
          </div>
          <div className="hs-head-actions">
            <button className="hs-btn ghost" onClick={() => handleExport()} title="Görünən sətirləri Excel-ə çıxart">
              <Download size={16} /><span>{tByText('Excel-ə çıxart')}</span>
            </button>
            {isAdmin && (
              <button className="hs-btn ghost" onClick={() => importInputRef.current?.click()} disabled={importBusy}>
                {importBusy ? <Loader2 size={16} className="spin" /> : <Upload size={16} />}<span>{tByText('Excel-dən idxal et')}</span>
              </button>
            )}
            <button className="hs-btn ghost" onClick={() => setArchiveOpen(true)}>
              <Archive size={16} /><span>Arxiv</span>{archiveCount ? <span className="hs-count">{archiveCount}</span> : null}
            </button>
            {isAdmin && items.length > 0 && (
              <button className="hs-btn ghost danger" onClick={() => setClearOpen(true)} title="Bütün hesabatı təmizlə (əsas səhifəyə toxunmur)">
                <Trash2 size={16} /><span>Hamısını təmizlə</span>
              </button>
            )}
            {isAdmin && (
              <button className="hs-btn primary" onClick={startDraft}>
                <Plus size={16} /><span>Yeni sətir</span>
              </button>
            )}
            <input ref={importInputRef} type="file" accept=".xlsx,.xls" hidden onChange={handleImportFile} />
            <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx" hidden onChange={onRowFilePicked} />
          </div>
        </header>

        {withStatus && (
          <section className="hs-overview">
            <div className="hs-bar" aria-hidden>
              {STATUS_ORDER.map(k => stats.by[k] ? (
                <span key={k} className={`hs-bar-seg st-${k}`} style={{ width: `${(stats.by[k] / total) * 100}%` }} />
              ) : null)}
            </div>
            <div className="hs-chips">
              <button className={`hs-chip ${!statusFilter ? 'on' : ''}`} onClick={() => setStatusFilter(null)}>
                <span>Hamısı</span><b>{stats.total}</b>
              </button>
              {STATUS_ORDER.map(k => (
                <button key={k} className={`hs-chip st-${k} ${statusFilter === k ? 'on' : ''}`}
                  onClick={() => setStatusFilter(p => (p === k ? null : k))}>
                  <i className="hs-dot" /><span>{statusLabel(k)}</span><b>{stats.by[k]}</b>
                </button>
              ))}
              {stats.none > 0 && (
                <button className={`hs-chip ${statusFilter === 'none' ? 'on' : ''}`} onClick={() => setStatusFilter(p => (p === 'none' ? null : 'none'))}>
                  <i className="hs-dot none" /><span>Statussuz</span><b>{stats.none}</b>
                </button>
              )}
            </div>
          </section>
        )}

        <section className="hs-card">
          <div className="hs-toolbar">
            <div className="hs-search">
              <Search size={15} />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Cədvəldə axtar…" />
              {query && <button className="hs-icon sm" onClick={() => setQuery('')}><X size={14} /></button>}
            </div>
            <span className="hs-toolbar-info">
              {filtersActive ? `${visible.length} / ${items.length} sətir göstərilir` : `${items.length} sətir`}
            </span>
            {filtersActive && (
              <button className="hs-link" onClick={() => { setStatusFilter(null); setQuery(''); setColFilters({}); setLinkFilter(null); }}>Filtrləri sıfırla</button>
            )}
            {isAdmin && (
              <div className="hs-info hs-more" ref={moreRef} onMouseEnter={() => { clearTimeout(linkMenuTimer.current); setLinkMenu(true); }}
                onMouseLeave={() => { linkMenuTimer.current = setTimeout(() => setLinkMenu(false), 250); }}>
                <button className={`hs-icon hs-info-btn ${linkMenu ? 'on' : ''}`} title="Bağlantılar" onClick={() => setLinkMenu(v => !v)}>
                  {foldersBusy ? <Loader2 size={17} className="spin" /> : <MoreHorizontal size={17} />}
                  {autoLink && !linkMenu && <i className="hs-info-dot" />}
                </button>
                {linkMenu && (
                  <div className="hs-info-menu" style={fixedMenuStyle(moreRef.current)}>
                    <div className="hs-info-title">Bağlantılar</div>
                    <button className="hs-info-row" disabled={foldersBusy} onClick={() => linkAll()}
                      title={kind === 'jobs' ? 'Eyni vahid / bölmə / Vəzifə adlı fayllara bağlayır; olmayan qovluqları da yaradır' : 'Əsas səhifədə eyni adlı olanlara bağlayır'}>
                      <Link2 size={15} /><span>Hamısını bağla</span>
                    </button>
                    <button className="hs-info-row" onClick={openPicker}>
                      <ListChecks size={15} /><span>Seçərək bağla…</span>
                    </button>
                    <button className="hs-info-row" disabled={!linkedCount} onClick={unlinkAll}>
                      <Link2Off size={15} /><span>Hamısının bağlantısını kəs</span><b>{linkedCount || ''}</b>
                    </button>
                    <div className="hs-info-sep" />
                    <button className="hs-info-row hs-auto" role="switch" aria-checked={autoLink} onClick={toggleAutoLink}
                      title="Açıq olanda yeni fayl / diaqram və ya yeni sətir eyni adlı tərəfə özü bağlanır. Default: bağlı">
                      <Link2 size={15} /><span>Avtomatik bağla</span>
                      <i className={`hs-switch ${autoLink ? 'on' : ''}`}><i /></i>
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="hs-info" ref={infoRef}>
              <button className={`hs-icon hs-info-btn ${infoOpen ? 'on' : ''}`} title="Məlumat və filtr" onClick={() => setInfoOpen(v => !v)}>
                <Menu size={17} />
                {linkFilter && !infoOpen && <i className="hs-info-dot" />}
              </button>
              {infoOpen && (
                <div className="hs-info-menu" style={fixedMenuStyle(infoRef.current)}>
                  <div className="hs-info-title">Hesabat haqqında</div>
                  <button className={`hs-info-row ${!linkFilter ? 'on' : ''}`} onClick={() => setLinkFilter(null)}>
                    <Menu size={15} /><span>Hamısı</span><b>{items.length}</b>
                  </button>
                  <button className={`hs-info-row ${linkFilter === 'linked' ? 'on' : ''}`} onClick={() => setLinkFilter(f => (f === 'linked' ? null : 'linked'))}>
                    <Link2 size={15} /><span>Əlaqəli</span><b>{linkedCount}</b>
                  </button>
                  <button className={`hs-info-row ${linkFilter === 'unlinked' ? 'on' : ''}`} onClick={() => setLinkFilter(f => (f === 'unlinked' ? null : 'unlinked'))}>
                    <Link2Off size={15} /><span>Əlaqəsiz</span><b>{items.length - linkedCount}</b>
                  </button>
                  <div className="hs-info-sep" />
                  <button className="hs-info-row" onClick={() => { setInfoOpen(false); setArchiveOpen(true); }}>
                    <Archive size={15} /><span>Arxivdə</span><b>{archiveCount ?? '—'}</b>
                  </button>
                </div>
              )}
            </div>
          </div>

          {error && <div className="hs-alert">{error}</div>}

          <div className={`hs-scroll ${scrolledX ? 'is-scrolled-x' : ''}`} ref={scrollRef} onScroll={onTableScroll}>
            <table className="hs-table">
              <thead>
                <tr>
                  <th className="c-n">№</th>
                  {columns.map(c => header(c.field, tByText(c.label), c.cls))}
                  {withStatus && header('status', tByText('Status'), 'c-status')}
                  {showDate && header('date', tByText('Tarix'), 'c-date')}
                  <th className="c-act" aria-label="Əməliyyatlar" />
                </tr>
              </thead>
              <tbody>
                {loading && items.length === 0 && Array.from({ length: 8 }).map((_, i) => (
                  <tr key={`sk${i}`} className="hs-skel"><td colSpan={colCount}><span /></td></tr>
                ))}

                {visible.map(r => {
                  const isLinked = r.itemId != null;
                  return (
                    <tr key={r.id}>
                      <td className="c-n">
                        <button
                          type="button"
                          className={`hs-num ${isLinked ? 'linked' : ''}`}
                          onClick={() => setLinkRow(r)}
                          title={isLinked ? `Əlaqəli: ${homeItems.get(Number(r.itemId)) || 'element'} — müqayisə et / aç` : 'Əsas səhifədəki elementə bağla'}
                        >
                          <span className="hs-num-n">{r.order}</span>
                          <span className="hs-num-ico"><Link2 size={15} /></span>
                        </button>
                      </td>
                      {columns.map(c => {
                        const cell = (
                          <Cell
                            value={c.field === 'approvalDate' ? fmtFreeDate(r[c.field]) : r[c.field]}
                            editable={isAdmin}
                            suggestions={c.field === 'strukturAdi' ? groups : null}
                            onSave={(v) => patchRow(r.id, { [c.field]: v })}
                          />
                        );
                        if (!(hasFileCol && c.field === 'title')) return <td key={c.field} className={c.cls}>{cell}</td>;
                        // Vəzifə: name, then the file's format pill and a small upload / replace icon
                        const fn = fileFor(r)?.filename || null;
                        return (
                          <td key={c.field} className={c.cls}>
                            <div className="hs-title-file">
                              <div className="hs-title-file-text">{cell}</div>
                              {fn && (
                                <button type="button" className="hs-file-name" onClick={() => viewRowFile(r)} title={`Aç: ${fn}`}>
                                  <FileTypePill filename={fn} className="ft-inline" />
                                </button>
                              )}
                              {isAdmin && (
                                <button type="button" className={`hs-icon hs-file-act ${fn ? '' : 'empty'}`} disabled={fileBusy === r.id}
                                  title={fn ? 'Faylı dəyiş (yenisini yüklə)' : 'Fayl yüklə — əsas səhifədə öz qovluğuna qoyulur'}
                                  onClick={() => pickFileFor(r)}>
                                  {fileBusy === r.id ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
                                </button>
                              )}
                            </div>
                          </td>
                        );
                      })}
                      {withStatus && (
                        <td className="c-status">
                          {isAdmin ? (
                            <StatusControl value={r.status} editable meta={STATUS_META} order={STATUS_ORDER}
                              onChange={(s) => patchRow(r.id, { status: s })} />
                          ) : (r.status ? <StatusBadge value={r.status} meta={STATUS_META} /> : <span className="hs-muted">—</span>)}
                        </td>
                      )}
                      {showDate && <td className="c-date">{fmtDate(r.date)}</td>}
                      <td className="c-act">
                        <div className="hs-actions">
                          {isAdmin && (
                            <>
                              <button className="hs-icon" title="Arxivə köçür (səhifədəki Arxivdən qaytarmaq olar)" onClick={() => archiveRow(r)}>
                                <Archive size={16} />
                              </button>
                              <button className="hs-icon del" title="Sil" onClick={() => deleteRow(r)}>
                                <Trash2 size={16} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {draft && (
                  <tr className="hs-draft" ref={draftRef}
                    onKeyDown={(e) => { if (e.key === 'Escape') setDraft(null); }}>
                    <td className="c-n"><Plus size={14} /></td>
                    {columns.map((c, i) => (
                      <td key={c.field} className={c.cls}>
                        <input
                          autoFocus={i === 0}
                          list={c.field === 'strukturAdi' ? `hs-groups-${kind}` : undefined}
                          value={draft[c.field]}
                          placeholder={tByText(c.label)}
                          onChange={(e) => setDraft(d => ({ ...d, [c.field]: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveDraft(); } }}
                        />
                      </td>
                    ))}
                    {withStatus && (
                      <td className="c-status">
                        <StatusControl value={draft.status} editable meta={STATUS_META} order={STATUS_ORDER}
                          onChange={(s) => setDraft(d => ({ ...d, status: s }))} />
                      </td>
                    )}
                    {showDate && <td className="c-date">{fmtDate(now)}</td>}
                    <td className="c-act">
                      <div className="hs-actions">
                        <button className="hs-icon ok" title="Yadda saxla (Enter)" onClick={saveDraft} disabled={savingDraft}>
                          {savingDraft ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
                        </button>
                        <button className="hs-icon" title="Ləğv et (Esc)" onClick={() => setDraft(null)}><X size={16} /></button>
                      </div>
                    </td>
                  </tr>
                )}

                {!loading && visible.length === 0 && !draft && (
                  <tr><td colSpan={colCount} className="hs-empty">
                    {items.length ? 'Bu filtrə uyğun sətir yoxdur' : 'Hesabat boşdur'}
                    {isAdmin && !items.length && <button className="hs-link" onClick={startDraft}>İlk sətri əlavə et</button>}
                  </td></tr>
                )}
              </tbody>
            </table>
            <datalist id={`hs-groups-${kind}`}>{groups.map(g => <option key={g} value={g} />)}</datalist>
          </div>

          {hbar.show && (
            <div className="hs-hbar" ref={hbarRef} onScroll={(e) => {
              if (syncing.current) { syncing.current = false; return; }
              const sc = scrollRef.current; if (!sc) return;
              syncing.current = true; sc.scrollLeft = e.currentTarget.scrollLeft;
            }}>
              <div style={{ width: hbar.width }} />
            </div>
          )}
        </section>
      </main>

      {pickOpen && (
        <div className="rd-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !foldersBusy) setPickOpen(null); }}>
          <div className="rd-card" role="dialog" aria-modal="true">
            <div className="rd-head">
              <span className="rd-ico"><Link2 size={18} /></span>
              <div className="rd-head-text">
                <div className="rd-eyebrow">Seçərək bağla</div>
                <h3>Eyni adlı {pickOpen.items.length} sətir tapıldı</h3>
                <p>Hansıların əsas səhifədəki elementə bağlanacağını seçin</p>
              </div>
              <button className="rd-x" onClick={() => setPickOpen(null)} disabled={foldersBusy} title="Bağla"><X size={18} /></button>
            </div>
            <div className="rd-body">
              <div className="ge-list-head">
                <label className="ge-check">
                  <input type="checkbox" checked={pickOpen.picked.size === pickOpen.items.length}
                    onChange={() => setPickOpen(p => ({ ...p, picked: p.picked.size === p.items.length ? new Set() : new Set(p.items.map(x => x.rowId)) }))} />
                  <span>Hamısını seç</span>
                </label>
                <span className="ge-count">{pickOpen.picked.size} / {pickOpen.items.length} seçilib</span>
              </div>
              <div className="rd-folders">
                {pickOpen.items.map(x => (
                  <label key={x.rowId} className={`ge-item ${pickOpen.picked.has(x.rowId) ? 'on' : ''}`}>
                    <input type="checkbox" checked={pickOpen.picked.has(x.rowId)}
                      onChange={() => setPickOpen(p => { const n = new Set(p.picked); if (n.has(x.rowId)) n.delete(x.rowId); else n.add(x.rowId); return { ...p, picked: n }; })} />
                    <span className="ge-item-text">
                      <span className="ge-item-title">{x.title}</span>
                      <span className="ge-item-sub">→ {x.itemTitle}{x.folder ? ` · ${x.folder}` : ''}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div className="rd-foot">
              <button className="rd-btn" onClick={() => setPickOpen(null)} disabled={foldersBusy}>Ləğv et</button>
              <button className="rd-btn primary" disabled={!pickOpen.picked.size || foldersBusy} onClick={() => linkAll([...pickOpen.picked])}>
                {foldersBusy ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />}<span>Bağla ({pickOpen.picked.size})</span>
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div className="hs-toast">
          <span>{toast.msg}</span>
          {toast.undo && <button onClick={toast.undo}>Geri qaytar</button>}
          <button className="hs-icon sm" onClick={() => setToast(null)}><X size={14} /></button>
        </div>
      )}

      {linkRow && (
        <LinkDialog
          kind={kind}
          row={items.find(r => r.id === linkRow.id) || linkRow}
          homeLabel={meta.home}
          statusMeta={STATUS_META}
          onClose={() => setLinkRow(null)}
          onRowChanged={onRowChanged}
          onOpenItem={onOpenItem}
        />
      )}

      {isAdmin && (
        <AiSidebar
          open={aiOpen}
          onClose={() => setAiOpen(false)}
          context={aiContext}
          runActions={runAiActions}
          suggestions={[
            'Bütün bağlantıları sil',
            'Ləğv edilmiş sətirləri arxivə köçür',
            'Biznes departamentinin sətirlərini göstər',
            'Nə edə bilərsən?'
          ]}
        />
      )}

      {clearOpen && (
        <ClearAllDialog
          count={items.length}
          homeLabel={meta.home}
          onExport={() => handleExport(items)}
          onArchiveAll={async () => {
            const r = await api.archiveAllSheets(kind);
            setArchiveCount(c => (c == null ? c : c + (r?.archived || 0)));
            await load();
            flash(`${r?.archived || 0} sətir arxivə köçürüldü`);
          }}
          onDeleteAll={async () => {
            const r = await api.deleteAllSheets(kind);
            await load();
            flash(`${r?.deleted || 0} sətir silindi`);
          }}
          onClose={() => setClearOpen(false)}
        />
      )}

      {archiveOpen && (
        <ArchiveDrawer
          kind={kind}
          columns={columns}
          statusMeta={STATUS_META}
          withStatus={withStatus}
          isAdmin={isAdmin}
          onClose={() => setArchiveOpen(false)}
          onRestored={(row) => { setArchiveCount(c => (c == null ? c : Math.max(0, c - 1))); if (row) load(); }}
          onDeleted={() => setArchiveCount(c => (c == null ? c : Math.max(0, c - 1)))}
          refreshKey={drawerKey}
        />
      )}

      {importPlan && (
        <ImportConflictModal
          plan={importPlan}
          decisions={importDecisions}
          setDecisions={setImportDecisions}
          labelOf={(f) => (f === 'status' ? tByText('Status') : tByText(columns.find(c => c.field === f)?.label || f))}
          valueLabel={(f, v) => (f === 'status' ? (v ? statusLabel(v) : '—') : (v || '—'))}
          onApply={() => { const p = importPlan; setImportPlan(null); if (p) applyImport(p, importDecisions); }}
          onCancel={() => setImportPlan(null)}
        />
      )}
    </div>
  );
}
