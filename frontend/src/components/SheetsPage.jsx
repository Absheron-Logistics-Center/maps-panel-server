import { useState, useEffect, useRef, useMemo, useCallback, useDeferredValue, startTransition } from 'react';
import { LogoFull } from './Logo.jsx';
import {
  LogOut, Loader2, Trash2, ChevronLeft, Download, Upload, ExternalLink
} from './icons.jsx';
import { LayoutGrid } from 'lucide-react';
import { api } from '../api/client.js';
import { pdfsApi } from '../api/pdfsClient.js';
import { templatesApi } from '../api/templatesClient.js';
import {
  StatusControl, PROCESS_STATUS_META, PROCESS_STATUS_ORDER, DOC_STATUS_META, DOC_STATUS_ORDER
} from './Status.jsx';
import { useLabels } from '../labels/LabelsContext.jsx';
import { exportSheetToExcel, importSheetRowsFromExcel } from './sheetsExcel.js';
import { buildImportPlan, defaultDecisions, resolvePlan } from './sheetsImportMerge.js';
import ImportConflictModal from './ImportConflictModal.jsx';
import SheetColumnFilter, {
  BLANK_FILTER_VALUE,
  uniqueColumnValues
} from './SheetColumnFilter.jsx';

// Survives SheetsPage unmount so revisiting the same kind skips the full
// blur+progress overlay and paints cached rows immediately.
const sheetsCache = new Map(); // kind -> items[]

function cacheSheets(kind, items) {
  sheetsCache.set(kind, Array.isArray(items) ? items : []);
}
function cachedSheets(kind) {
  return sheetsCache.has(kind) ? sheetsCache.get(kind) : null;
}

// ------------------------------------------------------------------------
// Per-kind column layout. Each kind gets its own ordered set of columns —
// the underlying data still lives on the flat row object (title,
// strukturAdi, subtitle, docType, edition, approvalDate, protocol,
// pageCount) so the same GridCell / patchRow plumbing works everywhere.
//
//   diagrams  → İş axışının adı · Struktur adı · İş axışının nömrəsi
//   pdfs      → Sənədin adı · Sənədin növü · Struktur adı · Nəşr ·
//                Təsdiq tarixi · Sənədin nömrəsi · Qərar/Protokol ·
//                Səhifə sayı        (no Date column)
//   templates → Formanın adı · Struktur adı · Sənədin adı · Sənədin növü ·
//                Nəşr · Təsdiq tarixi · Qərar/Protokol · Səhifə sayı
//                (no Date column)
// ------------------------------------------------------------------------
const KIND_COLUMNS = {
  diagrams: [
    { field: 'title', label: 'İş axışının adı', cls: 'col-title', ph: () => 'İş axışının adı…', aliases: ['ad', 'title', 'diaqramadı', 'diaqramadi', 'işaxınınadı', 'isaxininadi', 'name'] },
    { field: 'strukturAdi', label: 'Struktur adı', cls: 'col-struktur', ph: () => 'Qrup adı…', aliases: ['strukturadı', 'strukturadi', 'struktur', 'qrupadı', 'qrupadi', 'group'] },
    { field: 'subtitle', label: 'İş axışının nömrəsi', cls: 'col-sub', ph: () => 'İkinci ad…', aliases: ['ikinciad', 'subtitle', 'işaxınınnömrəsi', 'isaxininnomresi', 'nömrə', 'nomre', 'code'] }
  ],
  pdfs: [
    { field: 'title', label: 'Sənədin adı', cls: 'col-title', ph: () => 'Sənədin adı…', aliases: ['ad', 'title', 'sənədadı', 'senedadi', 'name'] },
    { field: 'docType', label: 'Sənədin növü', cls: 'col-extra', ph: () => 'Sənədin növü…', aliases: ['sənədinnövü', 'senedinnovu', 'doctype'] },
    { field: 'strukturAdi', label: 'Struktur adı', cls: 'col-struktur', ph: () => 'Qrup adı…', aliases: ['strukturadı', 'strukturadi', 'struktur', 'qrupadı', 'qrupadi', 'group'] },
    { field: 'edition', label: 'Nəşr', cls: 'col-extra', ph: () => 'Nəşr…', aliases: ['nəşr', 'nesr', 'edition'] },
    { field: 'approvalDate', label: 'Təsdiq tarixi', cls: 'col-extra', ph: () => 'gg.aa.iiii', aliases: ['təsdiqtarixi', 'tesdiqtarixi', 'approvaldate'] },
    { field: 'subtitle', label: 'Sənədin nömrəsi', cls: 'col-sub', ph: () => 'Sənədin nömrəsi…', aliases: ['sənədinnömrəsi', 'senedinnomresi', 'nömrə', 'nomre', 'subtitle', 'code'] },
    { field: 'protocol', label: 'Qərar / Protokol', cls: 'col-extra', ph: () => 'Qərar / Protokol…', aliases: ['qərarprotokol', 'qerarprotokol', 'protocol'] },
    { field: 'pageCount', label: 'Səhifə sayı', cls: 'col-narrow', ph: () => 'Səhifə sayı…', aliases: ['səhifəsayı', 'sehifesayi', 'pagecount'] }
  ],
  templates: [
    { field: 'title', label: 'Formanın adı', cls: 'col-title', ph: () => 'Formanın adı…', aliases: ['ad', 'title', 'formanınadı', 'formaninadi', 'şablonadı', 'sablonadi', 'name'] },
    { field: 'strukturAdi', label: 'Struktur adı', cls: 'col-struktur', ph: () => 'Qrup adı…', aliases: ['strukturadı', 'strukturadi', 'struktur', 'qrupadı', 'qrupadi', 'group'] },
    { field: 'subtitle', label: 'Sənədin adı', cls: 'col-sub', ph: () => 'Sənədin adı…', aliases: ['sənədinadı', 'senedinadi', 'subtitle'] },
    { field: 'docType', label: 'Sənədin növü', cls: 'col-extra', ph: () => 'Sənədin növü…', aliases: ['sənədinnövü', 'senedinnovu', 'doctype'] },
    { field: 'edition', label: 'Nəşr', cls: 'col-extra', ph: () => 'Nəşr…', aliases: ['nəşr', 'nesr', 'edition'] },
    { field: 'approvalDate', label: 'Təsdiq tarixi', cls: 'col-extra', ph: () => 'gg.aa.iiii', aliases: ['təsdiqtarixi', 'tesdiqtarixi', 'approvaldate'] }
  ]
};
// İş Axışları keeps its Date column; Normativ Sənədlər / Şablonlar don't need it.
const SHOW_DATE = { diagrams: true, pdfs: false, templates: false };
const ALL_FIELDS = ['title', 'strukturAdi', 'subtitle', 'docType', 'edition', 'approvalDate', 'protocol', 'pageCount'];

function emptyDraft() {
  const d = { status: null };
  for (const f of ALL_FIELDS) d[f] = '';
  return d;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = d.getDate().toString().padStart(2, '0');
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A free-text date field (Təsdiq tarixi) can end up holding a literal
// `Date.prototype.toString()` dump — e.g. an Excel import reading a real
// date cell (see sheetsExcel.js cellStr) — instead of a plain date. Shown
// as-is that's "Wed Nov 12 2025 23:59:36 GMT+0400 (Azerbaijan Standard
// Time)"; reformat that specific shape into "Nov 12 2025, 23:59" wherever
// it's displayed, without otherwise touching normal hand-typed text.
function fmtFreeDate(v) {
  if (!v || typeof v !== 'string') return v;
  if (!/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{4} \d{2}:\d{2}:\d{2} GMT/.test(v)) return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const hh = d.getHours().toString().padStart(2, '0');
  const mi = d.getMinutes().toString().padStart(2, '0');
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}, ${hh}:${mi}`;
}

function fmtTime(d) {
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const period = h >= 12 ? 'PM' : 'AM';
  const hh = (h % 12 || 12).toString().padStart(2, '0');
  return `${hh}:${m} ${period}`;
}

function fmtClockDate(d) {
  const dd = d.getDate().toString().padStart(2, '0');
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

// Excel-style cell editor: a single-line textarea that grows to fit
// wrapped text instead of clipping/truncating like a plain <input>.
// Height is only measured while focused — measuring every cell on mount
// (171×N textareas) caused filter OK / page open to freeze.
// commitOnBlur=false is used for the DRAFT (new-row) fields — losing focus
// there must never submit the row, only pressing Enter or the + button.
function GridCell({ value, placeholder, disabled, onChange, onCommit, cellRef, commitOnBlur = true }) {
  const localRef = useRef(null);

  function fitHeight() {
    const el = localRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  return (
    <textarea
      ref={(el) => { localRef.current = el; if (cellRef) cellRef.current = el; }}
      rows={1}
      className="sheets-cell-input"
      value={value || ''}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => {
        onChange(e.target.value);
        // Grow as the user types (focused); skip for bulk re-renders.
        requestAnimationFrame(fitHeight);
      }}
      onFocus={fitHeight}
      onBlur={(e) => { if (commitOnBlur) onCommit?.(e.target.value); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onCommit?.(value);
          e.target.blur();
        }
      }}
    />
  );
}

// Struktur adı cell — a GridCell plus a lightweight suggestions dropdown
// of the real folder/group names from the matching section, so admins can
// pick the exact existing folder instead of retyping it (sync matches by
// exact text, so a typo here would create a duplicate folder).
function StrukturCell({ value, options, placeholder, disabled, onChange, onCommit, commitOnBlur }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const filtered = useMemo(() => {
    const q = (value || '').trim().toLowerCase();
    const list = q ? options.filter(o => o.toLowerCase().includes(q)) : options;
    return list.slice(0, 8);
  }, [value, options]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="struktur-cell" ref={wrapRef}>
      <GridCell
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(v) => { onChange(v); if (options.length) setOpen(true); }}
        onCommit={onCommit}
        commitOnBlur={commitOnBlur}
      />
      {open && filtered.length > 0 && (
        <div className="struktur-suggest">
          {filtered.map(name => (
            <button
              type="button"
              key={name}
              className="struktur-suggest-opt"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(name);
                onCommit?.(name);
                setOpen(false);
              }}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const KIND_META = {
  diagrams: {
    title: 'İş axışların hesabatı',
    sub: 'Diaqram kataloqu — İş Axışlarından ayrıca'
  },
  pdfs: {
    title: 'Sənəd kataloqların hesabatı',
    sub: 'Sənəd kataloqu — Normativ Sənədlərdən ayrıca'
  },
  templates: {
    title: 'Şablon kataloqların hesabatı',
    sub: 'Şablon kataloqu — Şablonlardan ayrıca'
  }
};

export default function SheetsPage({
  kind = 'diagrams',
  onBack,
  onLogout,
  onOpenItem,
  withStatus = true
}) {
  const { t, tByText } = useLabels();
  const role = localStorage.getItem('role');
  const isAdmin = role === 'admin';
  const isViewer = role === 'viewer' || role === 'editor_2';
  const meta = KIND_META[kind] || KIND_META.diagrams;
  const columns = KIND_COLUMNS[kind] || KIND_COLUMNS.diagrams;
  const showDate = SHOW_DATE[kind] !== false;
  const STATUS_META = kind === 'diagrams' ? PROCESS_STATUS_META : DOC_STATUS_META;
  const STATUS_ORDER = kind === 'diagrams' ? PROCESS_STATUS_ORDER : DOC_STATUS_ORDER;
  const initialCached = cachedSheets(kind);

  const [now, setNow] = useState(new Date());
  const [items, setItems] = useState(() => initialCached || []);
  const [loading, setLoading] = useState(() => !initialCached);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Soft progress overlay — only on cold load. Cache hits skip it.
  const [loadUi, setLoadUi] = useState(() => (
    initialCached ? { show: false, pct: 0 } : { show: true, pct: 6 }
  ));

  // Draft text for not-yet-saved blank rows, keyed by their fixed `order`
  // slot number — NOT by array index. This is what lets a blank stay put
  // (and keep its own draft text) no matter what happens in other rows.
  const [blankDrafts, setBlankDrafts] = useState({});
  // Blank slots the admin explicitly removed from the pool (order numbers).
  // Never lets the count of visible blanks hit zero — see removeBlankSlot.
  const [hiddenBlankOrders, setHiddenBlankOrders] = useState(() => new Set());
  const [statusFilter, setStatusFilter] = useState(null); // null | status key | 'nostatus'
  // Excel-style per-column filters: key → Set of allowed values (null = show all)
  const [colFilters, setColFilters] = useState({});
  const [openColFilter, setOpenColFilter] = useState(null); // column key or null
  const [importBusy, setImportBusy] = useState(false);
  // Excel import: plan awaiting the admin's combine/separate decisions (null = no popup)
  const [importPlan, setImportPlan] = useState(null);
  const [importDecisions, setImportDecisions] = useState({});
  // Folder/group names from the matching section (İş Axışları / Normativ
  // Sənədlər / Şablonlar) — so Struktur adı can be picked from the real
  // folder list even before any document exists in it. Sync matches by
  // exact text, so this is what lets admins avoid typos that would create
  // a duplicate folder instead of linking to the existing one.
  const [sectionGroups, setSectionGroups] = useState([]);
  // itemId → folder name, from the section's own index — the fallback
  // used when a linked row's own Struktur adı text is empty (see
  // effectiveStrukturAdi below).
  const [itemStrukturMap, setItemStrukturMap] = useState({});
  const committingRef = useRef(new Set());
  const importInputRef = useRef(null);
  // Folder names already seeded into a blank slot's Struktur adı, so every
  // empty folder gets shown exactly once (not re-added on every re-render/
  // re-fetch) — see the "seed empty folders" effect below.
  const seededGroupsRef = useRef(new Set());
  // order → the folder name we auto-filled into that slot, for as long as
  // it stays untouched (see blankHasContent / updateBlank above).
  const autoSeededRef = useRef({});
  // Folder names the admin explicitly deleted an empty-folder placeholder
  // row for — kept in localStorage (per sheet kind) so a deleted placeholder
  // stays gone after a page reload instead of silently coming back.
  const dismissedFolderKey = `sheets-dismissed-empty-folders:${kind}`;
  const dismissedFoldersRef = useRef(new Set());

  const DEFAULT_BLANK_ROWS = 15;

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);


  // Overlay only for cold load / import / bulk busy — not silent background refresh.
  const showLoadOverlay = (loading && !cachedSheets(kind)) || importBusy || busy;

  useEffect(() => {
    if (showLoadOverlay) {
      setLoadUi((u) => ({ show: true, pct: Math.max(u.pct > 0 && u.pct < 100 ? u.pct : 6, 6) }));
      const id = setInterval(() => {
        setLoadUi((u) => {
          if (!u.show || u.pct >= 90) return u;
          const bump = 3 + Math.random() * 9;
          return { show: true, pct: Math.min(90, u.pct + bump) };
        });
      }, 220);
      return () => clearInterval(id);
    }
    setLoadUi((u) => (u.show ? { show: true, pct: 100 } : u));
    const t = setTimeout(() => setLoadUi({ show: false, pct: 0 }), 280);
    return () => clearTimeout(t);
  }, [showLoadOverlay]);

  async function load({ silent = false } = {}) {
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const data = await api.listSheets(kind);
      const list = Array.isArray(data?.items) ? data.items : [];
      cacheSheets(kind, list);
      setItems(list);
      setError('');
    } catch (e) {
      if (!silent || !cachedSheets(kind)) {
        setError(e.message || 'Yüklənmədi');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const hit = cachedSheets(kind);
    if (hit) {
      setItems(hit);
      setLoading(false);
      setLoadUi({ show: false, pct: 0 });
      // Quiet refresh — keep showing cached rows, no blur overlay.
      load({ silent: true });
    } else {
      load({ silent: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  // Pull the real folder list from the matching section so Struktur adı
  // has proper options even on an otherwise-empty sheet, and build an
  // itemId → folder-name map so a linked row whose own Struktur adı text
  // is blank can still show its real folder instead of "—".
  useEffect(() => {
    let cancelled = false;
    const client = kind === 'pdfs' ? pdfsApi : kind === 'templates' ? templatesApi : null;
    const req = client ? client.list() : api.listProcesses();
    req.then(data => {
      if (cancelled) return;
      const groups = Array.isArray(data?.groups) ? data.groups : [];
      const names = groups.map(g => String(g?.name || '').trim()).filter(Boolean);
      setSectionGroups(Array.from(new Set(names)));

      const entries = Array.isArray(data?.processes)
        ? data.processes
        : Array.isArray(data?.pdfs) ? data.pdfs : [];
      const map = {};
      for (const entry of entries) {
        const g = groups.find(x => Number(x?.id) === Number(entry?.groupId));
        if (g?.name && entry?.id != null) map[Number(entry.id)] = String(g.name).trim();
      }
      setItemStrukturMap(map);
    }).catch(() => { if (!cancelled) { setSectionGroups([]); setItemStrukturMap({}); } });
    return () => { cancelled = true; };
  }, [kind]);

  // Reset per-sheet blank-row bookkeeping whenever the sheet kind changes.
  useEffect(() => {
    setBlankDrafts({});
    setHiddenBlankOrders(new Set());
    setColFilters({});
    setOpenColFilter(null);
    seededGroupsRef.current = new Set();
    autoSeededRef.current = {};
    try {
      const raw = localStorage.getItem(dismissedFolderKey);
      dismissedFoldersRef.current = new Set(raw ? JSON.parse(raw) : []);
    } catch {
      dismissedFoldersRef.current = new Set();
    }
  }, [kind]);

  // Every folder from the matching section should be visible on the sheet,
  // even ones with zero documents yet — otherwise there's no way to tell
  // an empty folder even exists here. For each folder that isn't already
  // represented by a real row, drop its name into an unused blank slot's
  // Struktur adı so it shows up in the table (still just a draft — nothing
  // is saved to the sheet until the admin actually types something in it).
  useEffect(() => {
    if (!isAdmin || !sectionGroups.length) return;
    const covered = new Set(items.map(x => (x.strukturAdi || '').trim()).filter(Boolean));
    const missing = sectionGroups.filter(
      (name) => !covered.has(name)
        && !seededGroupsRef.current.has(name)
        && !dismissedFoldersRef.current.has(name)
    );
    if (!missing.length) return;

    setBlankDrafts((prev) => {
      const next = { ...prev };
      const used = new Set(items.map(x => Number(x.order)));
      const hasContent = (b) => (withStatus && b?.status) || columns.some(c => (b?.[c.field] || '').trim());
      let order = 1;
      for (const name of missing) {
        while (used.has(order) || hiddenBlankOrders.has(order) || hasContent(next[order])) order += 1;
        next[order] = { ...emptyDraft(), strukturAdi: name };
        autoSeededRef.current[order] = name;
        used.add(order);
        seededGroupsRef.current.add(name);
      }
      return next;
    });
  }, [isAdmin, sectionGroups, items, columns, withStatus, hiddenBlankOrders]);

  const maxOrder = useMemo(
    () => items.reduce((m, x) => Math.max(m, Number(x.order) || 0), 0),
    [items]
  );
  // Fresh/near-empty sheets show a full pool of 15 blanks; once real rows
  // pass that, the pool always ends exactly one blank past the highest
  // used position (fill row 45 → row 46 appears empty, etc). Gaps that
  // already exist below that (empty rows 2/3 while 5 is filled) stay put.
  // Also stretches to cover any slot a seeded empty-folder name landed in
  // (e.g. a section with more than 15 folders).
  const maxBlankDraftOrder = useMemo(() => {
    let m = 0;
    for (const k of Object.keys(blankDrafts)) m = Math.max(m, Number(k) || 0);
    return m;
  }, [blankDrafts]);
  const totalSlots = Math.max(maxOrder + 1, DEFAULT_BLANK_ROWS, maxBlankDraftOrder);

  const itemsByOrder = useMemo(() => {
    const m = new Map();
    for (const row of items) m.set(Number(row.order), row);
    return m;
  }, [items]);

  // The single ordered list actually rendered: real rows keep the exact
  // order slot they were saved with, blanks fill every other slot up to
  // totalSlots (minus any the admin removed from the pool).
  const displayRows = useMemo(() => {
    if (!isAdmin) {
      return items
        .slice()
        .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
        .map(row => ({ order: Number(row.order) || 0, row, isBlank: false }));
    }
    const out = [];
    for (let k = 1; k <= totalSlots; k++) {
      const real = itemsByOrder.get(k);
      if (real) {
        out.push({ order: k, row: real, isBlank: false });
      } else if (!hiddenBlankOrders.has(k)) {
        out.push({ order: k, row: blankDrafts[k] || emptyDraft(), isBlank: true });
      }
    }
    return out;
  }, [isAdmin, items, itemsByOrder, totalSlots, hiddenBlankOrders, blankDrafts]);

  const visibleBlankCount = useMemo(
    () => displayRows.filter(r => r.isBlank).length,
    [displayRows]
  );

  // A linked row (itemId/processId set) whose own Struktur adı text is
  // blank — e.g. an older row saved before the folder link was in place —
  // falls back to the folder that item currently lives in, instead of
  // showing an empty cell.
  const effectiveStrukturAdi = useCallback((row) => {
    const own = (row?.strukturAdi || '').trim();
    if (own) return own;
    const iid = row?.itemId ?? row?.processId;
    if (iid == null) return '';
    return itemStrukturMap[Number(iid)] || '';
  }, [itemStrukturMap]);

  const colValueGetters = useMemo(() => {
    const labelStatus = (key) => {
      const m = STATUS_META[key];
      return m ? t(m.id, m.default) : '';
    };
    const map = {};
    for (const c of columns) {
      map[c.field] = c.field === 'strukturAdi'
        ? (row) => effectiveStrukturAdi(row)
        : c.field === 'approvalDate'
          ? (row) => fmtFreeDate(row[c.field])
          : (row) => row[c.field];
    }
    map.status = (row) => (row.status ? labelStatus(row.status) : '');
    if (showDate) map.date = (row) => (row.date ? fmtDate(row.date) : '');
    return map;
  }, [columns, showDate, STATUS_META, t, effectiveStrukturAdi]);

  const colOptions = useMemo(() => {
    const out = {};
    for (const [key, get] of Object.entries(colValueGetters)) {
      out[key] = uniqueColumnValues(items, get);
    }
    if (out.strukturAdi) {
      const merged = new Set(out.strukturAdi.filter(v => v !== BLANK_FILTER_VALUE));
      for (const name of sectionGroups) merged.add(name);
      const list = Array.from(merged).sort((a, b) => a.localeCompare(b, 'az', { sensitivity: 'base' }));
      if (out.strukturAdi.includes(BLANK_FILTER_VALUE)) list.push(BLANK_FILTER_VALUE);
      out.strukturAdi = list;
    }
    return out;
  }, [items, colValueGetters, sectionGroups]);

  function cellFilterValue(row, key) {
    const get = colValueGetters[key];
    if (!get) return BLANK_FILTER_VALUE;
    const raw = get(row);
    return raw == null || String(raw).trim() === '' ? BLANK_FILTER_VALUE : String(raw).trim();
  }

  // Status cards + column filters hide real rows only — blank rows always
  // stay visible so there's somewhere to type.
  // Deferred so filter OK can close the popup immediately without waiting
  // for the full table to re-filter/re-render (~171 rows).
  const deferredColFilters = useDeferredValue(colFilters);
  const deferredStatusFilter = useDeferredValue(statusFilter);

  const filteredDisplayRows = useMemo(() => {
    const activeCols = Object.entries(deferredColFilters).filter(([, set]) => set != null);
    if (!deferredStatusFilter && activeCols.length === 0) return displayRows;
    return displayRows.filter(r => {
      if (r.isBlank) return true;
      if (deferredStatusFilter) {
        if (deferredStatusFilter === 'nostatus') {
          if (r.row.status) return false;
        } else if (r.row.status !== deferredStatusFilter) {
          return false;
        }
      }
      for (const [key, allowed] of activeCols) {
        if (!allowed.has(cellFilterValue(r.row, key))) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayRows, deferredStatusFilter, deferredColFilters, colValueGetters]);

  const applyColFilter = useCallback((key, next) => {
    startTransition(() => {
      setColFilters(prev => {
        const cp = { ...prev };
        if (next == null) delete cp[key];
        else cp[key] = next;
        return cp;
      });
    });
  }, []);

  const closeColFilter = useCallback(() => setOpenColFilter(null), []);

  function renderColHeader(key, label, className) {
    const opts = colOptions[key] || [];
    return (
      <th key={key} className={className}>
        <div className="sheets-th-inner">
          <span className="sheets-th-label">{label}</span>
          <SheetColumnFilter
            options={opts}
            applied={colFilters[key] || null}
            open={openColFilter === key}
            onToggleOpen={() => setOpenColFilter(prev => (prev === key ? null : key))}
            onApply={(set) => applyColFilter(key, set)}
            onClose={closeColFilter}
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

  function blankHasContent(b, order) {
    if (withStatus && b.status) return true;
    return columns.some(c => {
      const v = (b[c.field] || '').trim();
      if (!v) return false;
      // A folder name we pre-filled ourselves (see the "seed empty
      // folders" effect) doesn't count as real content on its own — it's
      // just there so the folder is visible, not something the admin
      // typed. Otherwise every empty folder would silently turn into a
      // real (title-less) sheet row the moment focus passed through it.
      if (c.field === 'strukturAdi' && order != null && autoSeededRef.current[order] === v) {
        return false;
      }
      return true;
    });
  }

  function updateBlank(order, field, value) {
    // Once the admin actually edits this row (any field, or a struktur
    // value that no longer matches what we auto-filled), it's no longer
    // just a placeholder — treat it as real content from here on.
    if (field !== 'strukturAdi' || autoSeededRef.current[order] !== value) {
      delete autoSeededRef.current[order];
    }
    setBlankDrafts(prev => ({
      ...prev,
      [order]: { ...(prev[order] || emptyDraft()), [field]: value }
    }));
  }

  function commitBlankRow(order, draftOverride) {
    if (!isAdmin || committingRef.current.has(order)) return;
    const blank = draftOverride || blankDrafts[order] || emptyDraft();
    if (!blankHasContent(blank, order)) return;
    committingRef.current.add(order);
    (async () => {
      try {
        const body = { order, status: withStatus ? (blank.status || null) : null };
        for (const f of ALL_FIELDS) body[f] = (blank[f] || '').trim();
        const row = await api.createSheet(kind, body);
        setItems(prev => {
          const next = [...prev, row];
          cacheSheets(kind, next);
          return next;
        });
        setBlankDrafts(prev => {
          const cp = { ...prev };
          delete cp[order];
          return cp;
        });
        delete autoSeededRef.current[order];
      } catch (e) {
        alert('Xəta: ' + (e.message || 'Əlavə edilmədi'));
      } finally {
        committingRef.current.delete(order);
      }
    })();
  }

  // Commit a blank row only once focus actually leaves that row — not on
  // every field-to-field tab within the same row.
  function handleBlankRowBlur(e, order) {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      commitBlankRow(order);
    }
  }

  // Remove one blank slot from the pool. Always leaves at least one blank
  // row visible on the sheet so there's somewhere left to type.
  async function removeBlankSlot(order) {
    if (!isAdmin || visibleBlankCount <= 1) return;
    const seededName = autoSeededRef.current[order];

    // A seeded Struktur adı is not merely a visual placeholder: it represents
    // an existing Home folder. Deleting that row must delete the Home folder.
    if (seededName) {
      if (!confirm(`"${seededName}" qrupunu əsas səhifədən də silmək istəyirsiniz?`)) return;
      setBusy(true);
      try {
        await api.deleteSheetGroup(kind, seededName);
        dismissedFoldersRef.current.add(seededName);
        try {
          localStorage.setItem(dismissedFolderKey, JSON.stringify([...dismissedFoldersRef.current]));
        } catch { /* ignore */ }
      } catch (e) {
        alert('Xəta: ' + (e.message || 'Qrup silinmədi'));
        return;
      } finally {
        setBusy(false);
      }
    }

    setHiddenBlankOrders(prev => new Set(prev).add(order));
    delete autoSeededRef.current[order];
    setBlankDrafts(prev => {
      if (!(order in prev)) return prev;
      const cp = { ...prev };
      delete cp[order];
      return cp;
    });
    if (seededName) {
      // Refresh both sides so the deleted group cannot be reseeded into a
      // blank slot by the sectionGroups effect.
      await load({ silent: true });
    }
  }

  async function patchRow(id, patch) {
    if (!isAdmin) return;
    setItems(prev => {
      const next = prev.map(x => Number(x.id) === Number(id) ? { ...x, ...patch } : x);
      cacheSheets(kind, next);
      return next;
    });
    try {
      const updated = await api.updateSheet(kind, id, patch);
      setItems(prev => {
        const next = prev.map(x => Number(x.id) === Number(id) ? updated : x);
        cacheSheets(kind, next);
        return next;
      });
    } catch (e) {
      alert('Xəta: ' + (e.message || 'Yenilənmədi'));
      await load({ silent: true });
    }
  }

  const linked = (row) => row.itemId != null || row.processId != null;

  // Deleting a hesabat row is ONE backend call. For a linked row the server
  // also takes the diagram / pdf / template out of the main list — it is
  // ARCHIVED (restorable from the section's Archive), not destroyed. (The old
  // code hard-deleted the item first, which already removed the row, and then
  // asked the server to delete the row again → "Sheet row not found" error and
  // a row that stayed on screen.)
  async function removeRow(id) {
    if (!isAdmin) return;
    const row = items.find(x => Number(x.id) === Number(id));
    const isLinked = row ? linked(row) : false;
    const msg = isLinked
      ? 'Bu sətir silinsin? Əsas siyahıdakı uyğun element də oradan çıxarılacaq və ARXİVƏ köçürüləcək (arxivdən bərpa edə bilərsiniz).'
      : 'Bu sətir Sheets-dən silinsin? (Əsas siyahıya toxunmur)';
    if (!confirm(msg)) return;
    try {
      await api.deleteSheet(kind, id);
    } catch (e) {
      // already gone on the server → treat as deleted; anything else is real
      if (!/not found|tapılmadı/i.test(String(e?.message || ''))) {
        alert('Xəta: ' + (e.message || 'Silinmədi'));
        await load({ silent: true });
        return;
      }
    }
    setItems(prev => {
      const next = prev.filter(x => Number(x.id) !== Number(id));
      cacheSheets(kind, next);
      return next;
    });
  }

  const stats = useMemo(() => {
    const byStatus = {};
    for (const k of STATUS_ORDER) byStatus[k] = 0;
    let nostatus = 0;
    for (const row of items) {
      if (row.status && byStatus[row.status] != null) byStatus[row.status] += 1;
      else nostatus += 1;
    }
    return { total: items.length, byStatus, nostatus };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, kind]);

  function toggleFilter(key) {
    setStatusFilter(prev => (prev === key ? null : key));
  }

  function statusLabel(key) {
    const m = STATUS_META[key];
    return m ? t(m.id, m.default) : '';
  }

  function statusKeyFromLabel(raw) {
    const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s) return null;
    for (const k of STATUS_ORDER) {
      if (k.toLowerCase() === s) return k;
      const m = STATUS_META[k];
      const lab = t(m.id, m.default).trim().toLowerCase();
      const def = String(m.default || '').trim().toLowerCase();
      if (lab === s || def === s) return k;
    }
    // Excel / hand-typed variants (Sheets-diagrams.xlsx etc.)
    const aliases = {
      'planlaşdırılır': 'progress',
      'planlaşdırılmış': 'progress',
      'planlasdirilir': 'progress',
      'planlasdirilmis': 'progress',
      'planned': 'progress',
      'hazırlıq prosesindədir': 'prep',
      'hazırlıq prosesində': 'prep',
      'hazirliq prosesinde': 'prep',
      'təsdiqlənmiş': 'done',
      'təsdiqlənmişdir': 'done',
      'tesdiqlenmis': 'done',
      'tesdiqlenmisdir': 'done',
      'təsdiq edildi': 'done',
      'tesdiq edildi': 'done',
      'approved': 'done',
      'done': 'done',
      'müzakirədədir': 'notdone',
      'muzakirededir': 'notdone',
      'qaralama': 'notdone',
      'draft': 'notdone',
      'imza prosesindədir': 'sign',
      'imza prosesində': 'sign',
      'imza prosesinde': 'sign',
      'signature': 'sign',
      'ləğv edilmiş': 'cancelled',
      'legv edilmis': 'cancelled',
      'ləğv edildi': 'cancelled',
      'legv edildi': 'cancelled',
      'cancelled': 'cancelled',
      'yeniləcək': 'renew',
      'yenilecek': 'renew',
      'renew': 'renew'
    };
    if (aliases[s]) return aliases[s];
    // Soft stem match (Planlaşdır… / Təsdiqlən… / İmza… / Ləğv… / Yenilə…)
    if (s.startsWith('planlaşdır') || s.startsWith('planlasdir')) return 'progress';
    if (s.startsWith('hazırlıq') || s.startsWith('hazirliq')) return 'prep';
    if (s.startsWith('təsdiqlən') || s.startsWith('tesdiqlen') || s.startsWith('təsdiq') || s.startsWith('tesdiq')) return 'done';
    if (s.startsWith('müzakirə') || s.startsWith('muzakire') || s.startsWith('qaralama')) return 'notdone';
    if (s.startsWith('imza')) return 'sign';
    if (s.startsWith('ləğv') || s.startsWith('legv')) return 'cancelled';
    if (s.startsWith('yenilə') || s.startsWith('yenile')) return 'renew';
    return null;
  }

  function handleExport() {
    const exportColumns = [
      { label: '№', get: (_row, i) => i + 1 },
      ...columns.map(c => ({
        label: tByText(c.label),
        get: (row) => (
          c.field === 'strukturAdi' ? effectiveStrukturAdi(row)
          : c.field === 'approvalDate' ? fmtFreeDate(row[c.field])
          : row[c.field]
        ) || ''
      }))
    ];
    if (withStatus) exportColumns.push({ label: tByText('Status'), get: (row) => (row.status ? statusLabel(row.status) : '') });
    if (showDate) exportColumns.push({ label: tByText('Date'), get: (row) => fmtDate(row.date) });

    exportSheetToExcel({
      fileTitle: `${tByText(meta.title)}-${kind}`,
      sheetName: tByText(meta.title),
      items,
      columns: exportColumns
    });
  }

  function handleImportClick() {
    if (!isAdmin || importBusy) return;
    importInputRef.current?.click();
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !isAdmin) return;
    setImportBusy(true);
    try {
      const importColumns = columns.map(c => ({ field: c.field, label: tByText(c.label), aliases: c.aliases }));
      const rows = await importSheetRowsFromExcel(file, {
        columns: importColumns,
        withStatus,
        statusKeyFromLabel
      });
      if (!rows.length) {
        alert('Excel faylında sətir tapılmadı.');
        return;
      }
      // Match by NAME. Identical rows combine silently (no duplicates); a row
      // with the same name but different status / struktur adı / number opens
      // the popup so the admin chooses: combine (which value wins) or separate.
      const plan = buildImportPlan({
        rows,
        items,
        fields: columns.map(c => c.field),
        withStatus,
        getStruktur: effectiveStrukturAdi
      });
      if (plan.conflicts.length) {
        setImportDecisions(defaultDecisions(plan));
        setImportPlan(plan);   // wait for the admin — nothing is written yet
        return;
      }
      await applyImport(plan, {});
    } catch (err) {
      alert('Xəta: ' + (err.message || 'İdxal edilmədi'));
    } finally {
      setImportBusy(false);
    }
  }

  // Writes the plan. Sequential on purpose: the backend does read-modify-write
  // on one file, so parallel calls would overwrite each other.
  async function applyImport(plan, decisions) {
    const { creates, updates, combined, separate } = resolvePlan(plan, decisions);
    setImportBusy(true);
    try {
      const baseOrder = items.reduce((m, x) => Math.max(m, Number(x.order) || 0), 0);
      const created = [];
      const updatedById = new Map();
      for (const u of updates) {
        const row = await api.updateSheet(kind, u.id, u.patch);
        updatedById.set(Number(u.id), row);
      }
      for (let i = 0; i < creates.length; i++) {
        const r = creates[i];
        const body = { order: baseOrder + i + 1, status: withStatus ? (r.status || null) : null };
        for (const f of ALL_FIELDS) body[f] = r[f] || '';
        created.push(await api.createSheet(kind, body));
      }
      setItems(prev => {
        const next = [...prev.map(x => updatedById.get(Number(x.id)) || x), ...created];
        cacheSheets(kind, next);
        return next;
      });
      alert(
        `${created.length} yeni sətir əlavə edildi, ${updatedById.size} sətir yeniləndi` +
        (combined ? ` (${combined} fərq birləşdirildi)` : '') +
        (separate ? `, ${separate} sətir ayrı əlavə olundu` : '') +
        (plan.mergedInFile ? `, faylda təkrarlanan ${plan.mergedInFile} sətir birləşdirildi` : '') + '.'
      );
    } catch (err) {
      alert('Xəta: ' + (err.message || 'İdxal edilmədi'));
      await load({ silent: true });
    } finally {
      setImportBusy(false);
    }
  }

  function confirmImportPlan() {
    const plan = importPlan;
    const decisions = importDecisions;
    setImportPlan(null);
    if (plan) applyImport(plan, decisions);
  }

  function importValueLabel(field, value) {
    if (field === 'status') return value ? statusLabel(value) : '—';
    return value || '—';
  }
  function importFieldLabel(field) {
    if (field === 'status') return tByText('Status');
    const c = columns.find(x => x.field === field);
    return c ? tByText(c.label) : field;
  }

  const isBlankRow = (row) => {
    if (row.itemId != null || row.processId != null) return false; // never touch linked rows here
    if (row.status) return false;
    if ((row.title || '').trim()) return false;
    // A row with nothing but a Struktur adı (folder name) and no title is
    // effectively still empty — this is what the phantom rows the earlier
    // "seed empty folders" bug created look like, so it's safe to sweep
    // them up here too.
    return !columns.some(c => c.field !== 'strukturAdi' && (row[c.field] || '').trim());
  };
  const blankCount = useMemo(() => items.filter(isBlankRow).length, [items, columns]);

  async function handleClearBlank() {
    if (!isAdmin || blankCount === 0) return;
    if (!confirm(`${blankCount} tamamilə boş sətir silinsin? Bu geri qaytarılmır.`)) return;
    setBusy(true);
    try {
      const toDelete = items.filter(isBlankRow);
      for (const row of toDelete) {
        await api.deleteSheet(kind, row.id);
      }
      await load({ silent: true });
    } catch (e) {
      alert('Xəta: ' + (e.message || 'Silinmədi'));
      await load({ silent: true });
    } finally {
      setBusy(false);
    }
  }

  async function handleClearAll() {
    if (!isAdmin || items.length === 0) return;
    const linkedCount = items.filter(linked).length;
    const msg = linkedCount > 0
      ? `Bu Sheets-in HAMISI (${items.length} sətir) silinsin? Əsas siyahıdakı uyğun ${linkedCount} element də oradan çıxarılıb ARXİVƏ köçürüləcək.`
      : `Bu Sheets-in HAMISI (${items.length} sətir) silinsin? Bu geri qaytarılmır.`;
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      // Deleting a linked row archives its main-list item (restorable) —
      // do that one by one (best-effort), then wipe whatever rows remain.
      for (const row of items.filter(linked)) {
        try { await api.deleteSheet(kind, row.id); }
        catch (e) { console.warn('Arxivə köçürülmədi:', e.message || e); }
      }
      await api.clearAllSheets(kind);
      setHiddenBlankOrders(new Set());
      setBlankDrafts({});
      await load({ silent: true });
    } catch (e) {
      alert('Xəta: ' + (e.message || 'Silinmədi'));
      await load({ silent: true });
    } finally {
      setBusy(false);
    }
  }

  const totalCols = 1 /* № */ + columns.length + (withStatus ? 1 : 0) + (showDate ? 1 : 0) + (isAdmin ? 1 : 0);

  return (
    <div className="sheets-page">
      <div className="topbar">
        <div className="top-left">
          <button className="pill-chip back-chip" onClick={onBack}>
            <ChevronLeft size={16} /><span>{tByText('Geri')}</span>
          </button>
          <div className="pill-chip">{fmtTime(now)}</div>
          <div className="pill-chip">{fmtClockDate(now)}</div>
        </div>
        <div className="top-right">
          <button className="logout-btn" onClick={onLogout}>
            <LogOut size={16} /><span>{t('topbar.logout', 'Çıxış')}</span>
          </button>
        </div>
      </div>

      <div className="sheets-wrap">
        <div className="sheets-brand">
          <LogoFull size="large" />
          <h2 className="home-title sheets-title">
            {tByText(meta.title)}
            <span className="sheets-sub">{tByText(meta.sub)}</span>
          </h2>
          <div className="sheets-io-actions">
            <button type="button" className="pill-chip sheets-io-btn" onClick={handleExport}>
              <Download size={14} /><span>{tByText('Excel-ə çıxart')}</span>
            </button>
            {isAdmin && (
              <button
                type="button"
                className="pill-chip sheets-io-btn"
                onClick={handleImportClick}
                disabled={importBusy}
              >
                {importBusy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
                <span>{tByText('Excel-dən idxal et')}</span>
              </button>
            )}
            {isAdmin && blankCount > 0 && (
              <button
                type="button"
                className="pill-chip sheets-io-btn sheets-io-danger"
                onClick={handleClearBlank}
                disabled={busy}
                title="Tamamilə boş (heç nə yazılmamış) sətirləri sil"
              >
                <Trash2 size={14} /><span>{tByText('Boş sətirləri sil')} ({blankCount})</span>
              </button>
            )}
            <input
              ref={importInputRef}
              type="file"
              accept=".xlsx,.xls"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
          </div>
        </div>

        {!error && withStatus && (
          <div className="sheets-stats">
            <button
              type="button"
              className={`sheets-stat-card total ${!statusFilter ? 'active' : ''}`}
              onClick={() => setStatusFilter(null)}
              disabled={loadUi.show}
            >
              <LayoutGrid size={18} />
              <span className="sheets-stat-text">
                <span className="sheets-stat-num">{stats.total}</span>
                <span className="sheets-stat-label">{tByText('Ümumi say')}</span>
              </span>
            </button>
            {withStatus && STATUS_ORDER.map(k => {
              const m = STATUS_META[k];
              return (
                <button
                  type="button"
                  key={k}
                  className={`sheets-stat-card ${m.cls} ${statusFilter === k ? 'active' : ''}`}
                  onClick={() => toggleFilter(k)}
                  disabled={loadUi.show}
                >
                  <m.Icon size={18} />
                  <span className="sheets-stat-text">
                    <span className="sheets-stat-num">{stats.byStatus[k] || 0}</span>
                    <span className="sheets-stat-label">{t(m.id, m.default)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className={`sheets-table-wrap ${loadUi.show ? 'is-loading' : ''}`}>
          {loadUi.show && (
            <div className="sheets-load-overlay" aria-busy="true" aria-live="polite">
              <div className="sheets-load-card">
                <div className="sheets-load-bar">
                  <div
                    className="sheets-load-bar-fill"
                    style={{ width: `${Math.round(loadUi.pct)}%` }}
                  />
                </div>
                <div className="sheets-load-label">
                  {importBusy
                    ? tByText('İdxal olunur…')
                    : busy
                      ? tByText('Gözləyin…')
                      : tByText('Yüklənir…')}
                  <span className="sheets-load-pct">{Math.round(loadUi.pct)}%</span>
                </div>
              </div>
            </div>
          )}
          {error && !loading && (
            <div className="empty-state error">{error}</div>
          )}

          {!error && (
            <>
              <div className="sheets-table-scroll">
                <table className="sheets-table">
                  <thead>
                    <tr>
                      <th className="col-n">№</th>
                      {columns.map(c => renderColHeader(c.field, tByText(c.label), c.cls))}
                      {withStatus && renderColHeader('status', tByText('Status'), 'col-status')}
                      {showDate && renderColHeader('date', tByText('Date'), 'col-date')}
                      {isAdmin && <th className="col-act" aria-label="Actions" />}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDisplayRows.map(({ order, row, isBlank }) => (
                      isBlank ? (
                        <tr
                          key={`blank-${order}`}
                          className="sheet-only sheets-blank-row"
                          onBlur={(e) => handleBlankRowBlur(e, order)}
                        >
                          <td className="col-n">{order}</td>
                          {columns.map(c => (
                            <td className={c.cls} key={c.field}>
                              {c.field === 'strukturAdi' ? (
                                <StrukturCell
                                  value={row[c.field]}
                                  options={sectionGroups}
                                  placeholder=""
                                  onChange={(v) => updateBlank(order, c.field, v)}
                                  onCommit={() => commitBlankRow(order)}
                                  commitOnBlur={false}
                                />
                              ) : (
                                <GridCell
                                  value={row[c.field]}
                                  placeholder=""
                                  onChange={(v) => updateBlank(order, c.field, v)}
                                  onCommit={() => commitBlankRow(order)}
                                  commitOnBlur={false}
                                />
                              )}
                            </td>
                          ))}
                          {withStatus && (
                            <td className="col-status">
                              <StatusControl
                                value={row.status}
                                editable
                                meta={STATUS_META}
                                order={STATUS_ORDER}
                                onChange={(status) => {
                                  updateBlank(order, 'status', status);
                                  commitBlankRow(order, { ...row, status });
                                }}
                              />
                            </td>
                          )}
                          {showDate && <td className="col-date">{fmtClockDate(now)}</td>}
                          <td className="col-act">
                            {visibleBlankCount > 1 && (
                              <button
                                type="button"
                                className="icon-btn sheets-del"
                                title="Boş sətri sil"
                                onClick={() => removeBlankSlot(order)}
                              >
                                <Trash2 size={15} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ) : (
                        <tr key={row.id} className={linked(row) ? 'linked' : 'sheet-only'}>
                          <td className="col-n">{order}</td>
                          {columns.map(c => (
                            <td className={c.cls} key={c.field}>
                              {isAdmin ? (
                                c.field === 'strukturAdi' ? (
                                  <StrukturCell
                                    value={row[c.field] || effectiveStrukturAdi(row)}
                                    options={sectionGroups}
                                    placeholder="—"
                                    onChange={(v) => setItems(prev => prev.map(x =>
                                      Number(x.id) === Number(row.id) ? { ...x, [c.field]: v } : x
                                    ))}
                                    onCommit={(v) => {
                                      if (v !== (row[c.field] || '')) patchRow(row.id, { [c.field]: v });
                                    }}
                                  />
                                ) : (
                                  <GridCell
                                    value={c.field === 'approvalDate' ? fmtFreeDate(row[c.field]) : row[c.field]}
                                    placeholder="—"
                                    onChange={(v) => setItems(prev => prev.map(x =>
                                      Number(x.id) === Number(row.id) ? { ...x, [c.field]: v } : x
                                    ))}
                                    onCommit={(v) => {
                                      if (v !== (row[c.field] || '')) patchRow(row.id, { [c.field]: v });
                                    }}
                                  />
                                )
                              ) : (
                                <span className="sheets-cell-text">
                                  {(c.field === 'strukturAdi' ? effectiveStrukturAdi(row)
                                    : c.field === 'approvalDate' ? fmtFreeDate(row[c.field])
                                    : row[c.field]) || '—'}
                                </span>
                              )}
                            </td>
                          ))}
                          {withStatus && (
                            <td className="col-status">
                              <StatusControl
                                value={row.status}
                                editable={isAdmin && !isViewer}
                                meta={STATUS_META}
                                order={STATUS_ORDER}
                                onChange={(status) => patchRow(row.id, { status })}
                              />
                            </td>
                          )}
                          {showDate && <td className="col-date">{fmtDate(row.date)}</td>}
                          {isAdmin && (
                            <td className="col-act">
                              {linked(row) && onOpenItem && (
                                <button
                                  type="button"
                                  className="icon-btn sheets-open"
                                  title="Aç"
                                  onClick={() => onOpenItem(kind, row)}
                                >
                                  <ExternalLink size={15} />
                                </button>
                              )}
                              <button
                                type="button"
                                className="icon-btn sheets-del"
                                title="Sil"
                                onClick={() => removeRow(row.id)}
                              >
                                <Trash2 size={15} />
                              </button>
                            </td>
                          )}
                        </tr>
                      )
                    ))}
                    {items.length === 0 && !isAdmin && (
                      <tr>
                        <td colSpan={totalCols} className="sheets-empty-cell">
                          Sheets boşdur
                        </td>
                      </tr>
                    )}
                    {items.length > 0 && filteredDisplayRows.every(r => r.isBlank) && (
                      <tr>
                        <td colSpan={totalCols} className="sheets-empty-cell">
                          {tByText('Bu filtrə uyğun sətir yoxdur')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
      {importPlan && (
        <ImportConflictModal
          plan={importPlan}
          decisions={importDecisions}
          setDecisions={setImportDecisions}
          labelOf={importFieldLabel}
          valueLabel={importValueLabel}
          onApply={confirmImportPlan}
          onCancel={() => setImportPlan(null)}
        />
      )}
    </div>
  );
}