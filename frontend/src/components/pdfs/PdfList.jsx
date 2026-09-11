import { useState, useEffect, useRef } from 'react';
import { LogoFull } from '../Logo.jsx';
import {
  ChevronLeft, ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown,
  LogOut, Plus, Loader2, Trash2,
  Eye, Edit3, Search, Folder, FolderOpen, FolderPlus, Pencil, GripVertical,
  Save, Check, Undo2, Upload
} from '../icons.jsx';
import { Archive, ArchiveRestore, FileSpreadsheet } from 'lucide-react';
import { api, setToken } from '../../api/client.js';
import { pdfsApi } from '../../api/pdfsClient.js';
import { StatusControl, DOC_STATUS_META, DOC_STATUS_ORDER } from '../Status.jsx';
import PdfFormModal from './PdfFormModal.jsx';
import NameModal from '../NameModal.jsx';
import TitleEditButton from '../TitleEditButton.jsx';
import { useLabels } from '../../labels/LabelsContext.jsx';

function fmtTime(d) {
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const period = h >= 12 ? 'PM' : 'AM';
  const hh = (h % 12 || 12).toString().padStart(2, '0');
  return `${hh}:${m} ${period}`;
}
function fmtDate(d) {
  const dd = d.getDate().toString().padStart(2, '0');
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}
function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function DownloadIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

// normalize a group's parentId to either null or a Number
function normPid(g) {
  return (g.parentId === undefined || g.parentId === null || g.parentId === 0)
    ? null
    : Number(g.parentId);
}

export default function PdfList({
  onBack,
  onLogout,
  onOpenSheets,
  apiClient = pdfsApi,
  pageTitleKey = 'pdf_page_title',
  pageTitleDefault = 'Normativ Sənədlər',
  withStatus = true,
  sheetsKind = 'pdfs',
}) {
  const { t, tByText, rawByText, LabelPen } = useLabels();
  const [now, setNow] = useState(new Date());
  const [groups, setGroups] = useState([]);
  const [pdfs, setPdfs] = useState([]);
  const [archived, setArchived] = useState([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [modal, setModal] = useState(null); // pdf modal: {mode, pdf?, defaultGroupId?}
  const [gmodal, setGmodal] = useState(null); // group modal: {type:'create'|'rename', group?, parentId?}
  const [settings, setSettings] = useState(null);
  const [pendingArchive, setPendingArchive] = useState(null); // pdf id awaiting confirm
  const [sheetOptions, setSheetOptions] = useState([]);
  const searchInputRef = useRef(null);

  // ---- staged (unsaved) folder edits ----
  // Folder create/rename/move/delete/reorder are applied to local state only.
  // pristineGroupsRef holds the last-saved-from-server snapshot so "Save All"
  // can diff against it and send only what actually changed.
  const pristineGroupsRef = useRef([]);
  const pristinePdfsRef = useRef([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const tempIdRef = useRef(-1);
  function nextTempId() { return tempIdRef.current--; }
  function isTempId(id) { return typeof id === 'number' && id < 0; }
  // Set when an edit lands while saveAll() is already mid-request — tells
  // saveAll to immediately run itself again once the in-flight save
  // finishes, instead of the newer edit getting silently dropped.
  const pendingAutoSaveRef = useRef(false);

  // warn before leaving the tab with unsaved folder changes
  useEffect(() => {
    function onBeforeUnload(e) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Auto-save staged folder changes (create/rename/move/reorder/delete) a
  // short moment after the last edit. This used to require a manual click
  // on "Hamısını yadda saxla" because every save was a GitHub commit
  // (rate-limited, so batching mattered). Writes now land straight on
  // local disk — there's no reason to make the admin do that by hand
  // anymore. The button still works too, as a manual/fallback trigger.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => { saveAll(); }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, groups, pdfs]);

  // ---- drag & drop ordering ----
  const groupDrag = useRef(null);
  const [groupOver, setGroupOver] = useState(null);
  const [draggingGroupId, setDraggingGroupId] = useState(null);
  const itemDrag = useRef(null);
  const [itemOver, setItemOver] = useState(null);

  const role = localStorage.getItem('role');
  const isAdmin = role === 'admin' || role === 'editor_2';

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { load(); }, []);
  useEffect(() => { api.getSettings().then(setSettings).catch(() => setSettings({})); }, []);
  useEffect(() => { if (searchOpen) searchInputRef.current?.focus(); }, [searchOpen]);

  async function saveSettings(patch) {
    const next = await api.updateSettings(patch);
    setSettings(next);
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await apiClient.list();
      const gs = data.groups || [];
      const list = data.pdfs || []; // keep stored order (drag & drop reordering)
      setGroups(gs);
      setPdfs(list);
      setArchived((data.archived || []).filter(Boolean));
      // all groups start CLOSED the first time we see them
      setExpanded(prev => {
        const o = { ...prev };
        gs.forEach(g => { if (!(g.id in o)) o[g.id] = false; });
        return o;
      });
      pristineGroupsRef.current = gs.map(g => ({ id: g.id, name: g.name, parentId: normPid(g) }));
      pristinePdfsRef.current = list;
      setDirty(false);
      setSaveError('');
      try {
        const sheets = await api.listSheets(sheetsKind);
        setSheetOptions(sheets?.items || []);
      } catch {
        setSheetOptions([]);
      }
    } catch (e) {
      setError(e.message);
      if (e.status === 401) onLogout();
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    setToken(null);
    localStorage.removeItem('role');
    localStorage.removeItem('username');
    onLogout();
  }
  function toggleGroup(gid) { setExpanded(prev => ({ ...prev, [gid]: !prev[gid] })); }

  /* ---------- collapse / expand all (any depth) ---------- */
  const allGroupIds = groups.map(g => g.id);
  const allOpen = allGroupIds.length > 0 && allGroupIds.every(id => expanded[id]);
  function toggleCollapseAll() {
    setExpanded(() => {
      const o = {};
      allGroupIds.forEach(id => { o[id] = !allOpen; });
      return o;
    });
  }

  /* ---------- nested-group helpers ---------- */
  function childGroupsOf(parentId) {
    const p = parentId == null ? null : Number(parentId);
    return groups.filter(g => normPid(g) === p);
  }
  // Cancelled (Ləğv edildi) items are hidden from this list entirely — they
  // stay reachable/editable only from the Sheets page.
  function itemsOfGroup(gid) {
    return pdfs.filter(p => Number(p.groupId) === Number(gid) && p.status !== 'cancelled');
  }
  function groupNumber(g) {
    const parts = [];
    let cur = g;
    while (cur) {
      const pid = normPid(cur);
      const siblings = childGroupsOf(pid);
      const idx = siblings.findIndex(s => s.id === cur.id);
      parts.unshift(idx + 1);
      cur = pid ? groups.find(x => Number(x.id) === pid) : null;
    }
    return parts.join('.');
  }
  function groupHasAnyItemsDeep(g) {
    if (itemsOfGroup(g.id).length > 0) return true;
    return childGroupsOf(g.id).some(cg => groupHasAnyItemsDeep(cg));
  }
  function groupHasMatchDeep(g) {
    if (itemsOfGroup(g.id).some(matches)) return true;
    return childGroupsOf(g.id).some(cg => groupHasMatchDeep(cg));
  }

  /* ---------- drag & drop: folders ---------- */
  function collectDescendantGroupIds(gid, groupList) {
    const ids = [gid];
    let frontier = [gid];
    while (frontier.length) {
      const kids = groupList.filter(x => frontier.includes(normPid(x)));
      const kidIds = kids.map(x => x.id);
      ids.push(...kidIds);
      frontier = kidIds;
    }
    return ids;
  }

  function onGroupDragStart(e, gid) {
    if (!isAdmin) return;
    groupDrag.current = gid;
    setDraggingGroupId(gid);
    e.dataTransfer.effectAllowed = 'move';
  }
  function onGroupDragOver(e, gid) {
    if (groupDrag.current == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (groupOver !== gid) setGroupOver(gid);
  }
  function onGroupDrop(e, gid) {
    e.preventDefault();
    const from = groupDrag.current;
    groupDrag.current = null;
    setDraggingGroupId(null);
    setGroupOver(null);
    if (from == null || from === gid) return;
    const fromG = groups.find(g => g.id === from);
    const toG = groups.find(g => g.id === gid);
    if (!fromG || !toG) return;

    if (normPid(fromG) === normPid(toG)) {
      // same parent -> just reorder these siblings
      const order = groups.map(g => g.id);
      const fi = order.indexOf(from);
      const ti = order.indexOf(gid);
      if (fi < 0 || ti < 0) return;
      order.splice(ti, 0, order.splice(fi, 1)[0]);
      const next = order.map(id => groups.find(g => g.id === id));
      setGroups(next);
      setDirty(true);
      return;
    }

    // different parent -> dragging this folder onto another folder nests it
    // inside that folder. Anything already inside `fromG` (subgroups and
    // PDFs) stays linked to it by id, so it all moves along together.
    const descendantIds = collectDescendantGroupIds(from, groups);
    if (descendantIds.includes(toG.id)) {
      alert('Qrupu öz alt qrupunun içinə köçürmək olmaz.');
      return;
    }
    setGroups(prev => prev.map(g => g.id === from ? { ...g, parentId: toG.id } : g));
    setExpanded(prev => ({ ...prev, [toG.id]: true }));
    setDirty(true);
  }
  function onGroupDragEnd() { groupDrag.current = null; setDraggingGroupId(null); setGroupOver(null); }

  // Dropping a dragged folder on this zone (shown only while dragging a
  // nested folder) moves it back out to the top level.
  function onRootDragOver(e) {
    if (groupDrag.current == null) return;
    const fromG = groups.find(g => g.id === groupDrag.current);
    if (!fromG || normPid(fromG) === null) return; // already top-level
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (groupOver !== '__root__') setGroupOver('__root__');
  }
  function onRootDrop(e) {
    e.preventDefault();
    const from = groupDrag.current;
    groupDrag.current = null;
    setDraggingGroupId(null);
    setGroupOver(null);
    if (from == null) return;
    const fromG = groups.find(g => g.id === from);
    if (!fromG || normPid(fromG) === null) return;
    setGroups(prev => prev.map(g => g.id === from ? { ...g, parentId: null } : g));
    setDirty(true);
  }

  /* ---------- drag & drop: PDFs inside a folder ---------- */
  function onItemDragStart(e, gid, id) {
    if (!isAdmin) return;
    e.stopPropagation();
    itemDrag.current = { gid, id };
    e.dataTransfer.effectAllowed = 'move';
  }
  function onItemDragOver(e, gid, id) {
    const d = itemDrag.current;
    if (!d || Number(d.gid) !== Number(gid)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (!itemOver || itemOver.id !== id) setItemOver({ gid, id });
  }
  async function onItemDrop(e, gid, id) {
    const d = itemDrag.current;
    itemDrag.current = null;
    setItemOver(null);
    if (!d || Number(d.gid) !== Number(gid) || d.id === id) return;
    e.preventDefault();
    e.stopPropagation();
    const groupIds = pdfs.filter(p => Number(p.groupId) === Number(gid)).map(p => p.id);
    const fi = groupIds.indexOf(d.id), ti = groupIds.indexOf(id);
    if (fi < 0 || ti < 0) return;
    groupIds.splice(ti, 0, groupIds.splice(fi, 1)[0]);
    const byId = new Map(pdfs.map(p => [p.id, p]));
    let k = 0;
    const reordered = pdfs.map(p => {
      if (Number(p.groupId) !== Number(gid)) return p;
      return byId.get(groupIds[k++]) || p;
    }).filter(Boolean);
    setPdfs(reordered);
    try { await apiClient.reorderPdfs(Number(gid), groupIds); } catch { load(); }
  }
  function onItemDragEnd() { itemDrag.current = null; setItemOver(null); }

  async function viewPdf(p) {
    setBusy(p.id);
    try { await apiClient.view(p.id); }
    catch (e) { alert('Xəta: ' + e.message); }
    finally { setBusy(null); }
  }
  async function downloadPdf(p) {
    setBusy(p.id);
    try { await apiClient.download(p.id, p.filename); }
    catch (e) { alert('Xəta: ' + e.message); }
    finally { setBusy(null); }
  }
  async function removePdf(e, p) {
    e.stopPropagation();
    if (!confirm(`"${p.title}" PDF-i silmək istəyirsiniz?`)) return;
    try {
      await apiClient.remove(p.id);
      setPdfs(prev => prev.filter(x => x.id !== p.id));
    } catch (err) { alert('Silinə bilmədi: ' + err.message); }
  }

  async function changeStatus(p, s) {
    setPdfs(prev => prev.map(x => x.id === p.id ? { ...x, status: s } : x));
    try { await apiClient.setStatus(p.id, s); }
    catch (err) { alert('Status dəyişdirilə bilmədi: ' + err.message); load(); }
  }

  /* ---------- archive (two-step: ask, then confirm) ---------- */
  function requestArchive(e, p) {
    e.stopPropagation();
    setPendingArchive(p.id);
  }
  function cancelArchive(e) {
    e.stopPropagation();
    setPendingArchive(null);
  }
  async function confirmArchive(e, p) {
    e.stopPropagation();
    try {
      await apiClient.archive(p.id);
      setPendingArchive(null);
      await load();
      setArchiveOpen(true);
    } catch (err) { alert('Arxivə köçürülə bilmədi: ' + err.message); }
  }
  async function unarchivePdf(e, p) {
    e.stopPropagation();
    try { await apiClient.unarchive(p.id); await load(); }
    catch (err) { alert('Bərpa edilə bilmədi: ' + err.message); }
  }
  async function deleteArchivedPdf(e, p) {
    e.stopPropagation();
    if (!confirm(`"${p.title}" sənədini tamamilə silmək istəyirsiniz? Geri alına bilməz.`)) return;
    try {
      await apiClient.remove(p.id);
      setArchived(prev => prev.filter(x => x.id !== p.id));
    } catch (err) { alert('Silinə bilmədi: ' + err.message); }
  }

  async function handleModalSave(payload) {
    try {
      if (modal?.mode === 'create') await apiClient.create(payload);
      else if (modal?.mode === 'edit') await apiClient.update(modal.pdf.id, payload);
      setModal(null);
      await load();
    } catch (e) { alert('Xəta: ' + e.message); }
  }

  /* ---------- group actions (staged locally, sent on Save All) ---------- */
  function saveGroupCreate({ name }) {
    const parentId = gmodal?.parentId ?? null;
    const tempId = nextTempId();
    setGroups(prev => [...prev, { id: tempId, name, parentId: parentId || null }]);
    setExpanded(prev => ({ ...prev, [tempId]: true }));
    setGmodal(null);
    setDirty(true);
  }
  function saveGroupRename({ name }) {
    const gid = gmodal.group.id;
    setGroups(prev => prev.map(g => g.id === gid ? { ...g, name } : g));
    setGmodal(null);
    setDirty(true);
  }
  function deleteGroup(g) {
    const count = itemsOfGroup(g.id).length;
    const subCount = childGroupsOf(g.id).length;
    let msg = `"${g.name}" qrupunu silmək istəyirsiniz?`;
    if (count || subCount) {
      msg = `"${g.name}" qrupunu`
        + (subCount ? ` və ${subCount} alt qrupunu` : '')
        + (count ? ` və içindəki ${count} sənədi` : '')
        + ` silmək istəyirsiniz? "Yadda saxla"ya basana qədər tətbiq olunmayacaq.`;
    }
    if (!confirm(msg)) return;
    const allIds = collectDescendantGroupIds(g.id, groups);
    setGroups(prev => prev.filter(x => !allIds.includes(x.id)));
    setPdfs(prev => prev.filter(p => !allIds.includes(Number(p.groupId))));
    setDirty(true);
  }

  /* ---------- flush every staged folder change to the backend ---------- */
  async function doFlush() {
    const idMap = new Map(); // tempId -> real id
    const resolve = (id) => (isTempId(id) && idMap.has(id)) ? idMap.get(id) : id;

    // 1) create brand-new groups, parents before children, so a new
    //    subgroup's parentId (possibly itself a temp id) can be resolved.
    let remaining = groups.filter(g => isTempId(g.id));
    let guard = 0;
    while (remaining.length && guard++ < 50) {
      const ready = remaining.filter(g => g.parentId == null || !isTempId(g.parentId) || idMap.has(g.parentId));
      if (!ready.length) break; // shouldn't happen, safety valve
      for (const g of ready) {
        const parentId = g.parentId == null ? null : resolve(g.parentId);
        const created = await apiClient.createGroup(g.name, parentId);
        idMap.set(g.id, created.id);
      }
      remaining = remaining.filter(g => !idMap.has(g.id));
    }

    // 2) existing groups: rename / move as needed
    const pristineById = new Map(pristineGroupsRef.current.map(g => [g.id, g]));
    for (const g of groups) {
      if (isTempId(g.id)) continue;
      const before = pristineById.get(g.id);
      if (!before) continue;
      if (before.name !== g.name) {
        await apiClient.renameGroup(g.id, g.name);
      }
      const newParentId = g.parentId == null ? null : resolve(g.parentId);
      if (before.parentId !== newParentId) {
        await apiClient.moveGroup(g.id, newParentId);
      }
    }

    // 3) deleted groups — only call delete on the topmost deleted group in
    //    each removed subtree (backend cascades to subgroups + PDFs).
    const currentIds = new Set(groups.filter(g => !isTempId(g.id)).map(g => g.id));
    const deletedIds = pristineGroupsRef.current.filter(g => !currentIds.has(g.id)).map(g => g.id);
    const deletedSet = new Set(deletedIds);
    const deletedRoots = deletedIds.filter(id => {
      const g = pristineById.get(id);
      return !g.parentId || !deletedSet.has(g.parentId);
    });
    for (const gid of deletedRoots) {
      await apiClient.deleteGroup(gid);
    }

    // 4) final sibling order — send the fully-resolved current order so
    //    display order matches exactly what was arranged locally.
    const finalOrder = groups.filter(g => !isTempId(g.id) || idMap.has(g.id)).map(g => resolve(g.id));
    await apiClient.reorderGroups(finalOrder);

    return idMap;
  }

  async function saveAll() {
    // A save already in flight while another edit lands (e.g. auto-save
    // firing mid-request) — queue one more run right after this one
    // finishes instead of dropping the newer changes.
    if (saving) { pendingAutoSaveRef.current = true; return; }
    if (!dirty) return;
    setSaving(true);
    setSaveError('');
    try {
      await doFlush();
      await load();
    } catch (e) {
      setSaveError(e.message || 'Yadda saxlanmadı');
    } finally {
      setSaving(false);
      if (pendingAutoSaveRef.current) {
        pendingAutoSaveRef.current = false;
        saveAll();
      }
    }
  }

  // Discard every staged (unsaved) folder create/rename/move/delete and go
  // back to what's actually on the server.
  function cancelAll() {
    if (!dirty || saving) return;
    if (!confirm('Yadda saxlanmamış qovluq dəyişikliklərini ləğv etmək istəyirsiniz?')) return;
    setGroups(pristineGroupsRef.current.map(g => ({ ...g })));
    setPdfs(pristinePdfsRef.current.map(p => ({ ...p })));
    setExpanded(prev => {
      const o = { ...prev };
      pristineGroupsRef.current.forEach(g => { if (!(g.id in o)) o[g.id] = false; });
      return o;
    });
    setDirty(false);
    setSaveError('');
  }

  // A brand-new (unsaved) folder only exists locally — the backend needs a
  // real id before a PDF can be uploaded into it. Rather than leaving the
  // "add PDF" button disabled and confusing, silently save the pending
  // folder structure first, then continue with the real id.
  async function ensureGroupSaved(gid) {
    if (!isTempId(gid)) return gid;
    setSaving(true);
    setSaveError('');
    try {
      const idMap = await doFlush();
      await load();
      return idMap.get(gid) ?? null;
    } catch (e) {
      setSaveError(e.message || 'Yadda saxlanmadı');
      return null;
    } finally {
      setSaving(false);
    }
  }

  const q = query.trim().toLowerCase();
  function matches(p) {
    if (!q) return true;
    return (p.title || '').toLowerCase().includes(q)
      || (p.subtitle || '').toLowerCase().includes(q);
  }

  const noResults = !loading && !error && groups.length === 0 && pdfs.length === 0;

  /* ---------- recursive group render ---------- */
  function renderGroup(g, depth) {
    const fullItems = itemsOfGroup(g.id);
    const items = fullItems.filter(matches);
    const children = childGroupsOf(g.id);
    const total = fullItems.length;

    if (q && !groupHasMatchDeep(g)) return null;
    if (!isAdmin && !groupHasAnyItemsDeep(g)) return null;

    const isOpen = q ? true : !!expanded[g.id];
    const dndOn = isAdmin && !q;
    const folderNo = groupNumber(g);
    const isGroupOver = groupOver === g.id && groupDrag.current !== g.id;
    const draggingG = draggingGroupId != null ? groups.find(x => x.id === draggingGroupId) : null;
    const isNestTarget = isGroupOver && draggingG && normPid(draggingG) !== normPid(g);

    return (
      <div
        key={g.id}
        className={`group-card ${isOpen ? 'open' : ''} ${isNestTarget ? 'drag-nest' : (isGroupOver ? 'drag-over' : '')} ${depth > 0 ? 'nested' : ''}`}
        style={depth > 0 ? { marginLeft: 0, borderRadius: '12px' } : undefined}
        title={isNestTarget ? `"${draggingG.name}" bura köçürüləcək` : undefined}
      >
        <div
          className="group-head"
          onClick={() => toggleGroup(g.id)}
          draggable={dndOn}
          onDragStart={e => onGroupDragStart(e, g.id)}
          onDragOver={e => onGroupDragOver(e, g.id)}
          onDrop={e => onGroupDrop(e, g.id)}
          onDragEnd={onGroupDragEnd}
        >
          {dndOn && (
            <span className="order-grip group-grip" title="Sürüklə" onClick={e => e.stopPropagation()}>
              <GripVertical size={15} />
            </span>
          )}
          <span className="folder-no">{folderNo}</span>
          <span className="group-chevron">
            {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          </span>
          <span className="group-folder">
            {isOpen ? <FolderOpen size={18} /> : <Folder size={18} />}
          </span>
          <span className="group-name">{g.name}</span>
          <span className="group-count">{total}</span>

          {isAdmin && (
            <span className="group-actions" onClick={e => e.stopPropagation()}>
              <button className="group-act-btn" title="PDF əlavə et"
                disabled={saving}
                onClick={async () => {
                  const gid = await ensureGroupSaved(g.id);
                  if (gid == null) return;
                  setModal({ mode: 'create', defaultGroupId: gid });
                }}>
                <Plus size={16} />
              </button>
              <button className="group-act-btn" title="Alt qrup əlavə et"
                onClick={() => setGmodal({ type: 'create', parentId: g.id })}>
                <FolderPlus size={15} />
              </button>
              <button className="group-act-btn" title="Adı dəyiş"
                onClick={() => setGmodal({ type: 'rename', group: g })}>
                <Pencil size={15} />
              </button>
              <button className="group-act-btn danger" title="Qrupu sil"
                onClick={() => deleteGroup(g)}>
                <Trash2 size={15} />
              </button>
            </span>
          )}
        </div>

        {isOpen && (
          <div className="group-body">
            {children.length === 0 && items.length === 0 && (
              <div className="child-empty">Bu qrupda sənəd yoxdur.</div>
            )}

            {children.map(cg => renderGroup(cg, depth + 1))}

            {items.map((p) => {
              const itemNo = fullItems.indexOf(p) + 1;
              const isItemOver = itemOver && itemOver.id === p.id
                && (!itemDrag.current || itemDrag.current.id !== p.id);
              return (
                <div
                  key={p.id}
                  className={`process-item pdf-item ${isItemOver ? 'drag-over' : ''}`}
                  draggable={dndOn}
                  onDragStart={e => onItemDragStart(e, g.id, p.id)}
                  onDragOver={e => onItemDragOver(e, g.id, p.id)}
                  onDrop={e => onItemDrop(e, g.id, p.id)}
                  onDragEnd={onItemDragEnd}
                >
                  {dndOn && (
                    <span className="order-grip item-grip" title="Sürüklə" onClick={e => e.stopPropagation()}>
                      <GripVertical size={14} />
                    </span>
                  )}
                  <div className="num">{folderNo}.{itemNo}</div>
                  <div className="label">
                    <span className="row-title">
                      {p.title}
                      {p.size ? <span className="pdf-size">{fmtSize(p.size)}</span> : null}
                    </span>
                    {p.subtitle ? <span className="row-subtitle">{p.subtitle}</span> : null}
                  </div>

                  {withStatus && (
                    <div className="row-status" onClick={e => e.stopPropagation()}>
                      <StatusControl
                        value={p.status}
                        editable={isAdmin}
                        onChange={(s) => changeStatus(p, s)}
                        meta={DOC_STATUS_META}
                        order={DOC_STATUS_ORDER}
                      />
                    </div>
                  )}

                  {(p.noFile || !p.filename) && (
                    isAdmin ? (
                      <button
                        type="button"
                        className="pdf-nofile-badge pdf-nofile-upload"
                        title="Fayl yükləmək üçün klikləyin"
                        onClick={(e) => { e.stopPropagation(); setModal({ mode: 'edit', pdf: p }); }}
                      >
                        <Upload size={12} />
                        <span>{tByText('Fayl yüklənməyib')}</span>
                      </button>
                    ) : (
                      <span className="pdf-nofile-badge" title="Sheets-dən avtomatik yaradılıb — fayl hələ yüklənməyib">
                        {tByText('Fayl yüklənməyib')}
                      </span>
                    )
                  )}

                  <div className="pdf-actions">
                    <button className="action-btn" onClick={() => viewPdf(p)} disabled={busy === p.id || p.noFile || !p.filename} title={rawByText('Bax')}>
                      {busy === p.id ? <Loader2 size={15} className="spin" /> : <Eye size={15} />}
                      <span>{tByText('Bax')}</span>
                    </button>
                    <button className="action-btn" onClick={() => downloadPdf(p)} disabled={busy === p.id || p.noFile || !p.filename} title={rawByText('Yüklə')}>
                      <DownloadIcon size={15} /><span>{tByText('Yüklə')}</span>
                    </button>
                    {isAdmin && (
                      <>
                        {pendingArchive === p.id ? (
                          <div className="archive-confirm">
                            <span className="archive-confirm-q"> </span>
                            <button className="action-btn confirm-yes" title="Təsdiq et"
                              onClick={(e) => confirmArchive(e, p)}>
                              <Archive size={15} /><span>Təsdiq</span>
                            </button>
                            <button className="action-btn" title="Ləğv et"
                              onClick={cancelArchive}>
                              <span>Ləğv</span>
                            </button>
                          </div>
                        ) : (
                          <>
                            <button className="action-btn action-btn-icon nospace"
                              onClick={(e) => { e.stopPropagation(); setModal({ mode: 'edit', pdf: p }); }} title="Redaktə et">
                              <Edit3 size={15} />
                            </button>
                            <button className="action-btn action-btn-icon nospace"
                              onClick={(e) => requestArchive(e, p)} title="Arxivə köçür">
                              <Archive size={15} />
                            </button>
                            <button className="action-btn action-btn-icon action-btn-danger"
                              onClick={(e) => removePdf(e, p)} title="Sil">
                              <Trash2 size={15} />
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="topbar">
        <div className="top-left">
          <button className="pill-chip back-chip" onClick={onBack}>
            <ChevronLeft size={16} /><span>{tByText('Geri')}</span>
          </button>
          <div className="pill-chip">{fmtTime(now)}</div>
          <div className="pill-chip">{fmtDate(now)}</div>
        </div>
        <div className="top-right">
          <div className={`topbar-search ${searchOpen ? 'open' : ''}`}>
            {searchOpen && (
              <input
                ref={searchInputRef}
                type="text"
                placeholder={rawByText('Ad və ya nömrə ilə axtar')}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); setSearchOpen(false); } }}
              />
            )}
            <LabelPen text="Ad və ya nömrə ilə axtar" />
            <button
              className="icon-btn"
              title={searchOpen ? 'Axtarışı bağla' : 'Axtar'}
              onClick={() => setSearchOpen(v => {
                const next = !v;
                if (!next) setQuery('');
                return next;
              })}
            >
              <Search size={17} />
            </button>
          </div>
          {groups.length > 0 && (
            <button
              className="icon-btn"
              title={allOpen ? 'Hamısını bağla' : 'Hamısını aç'}
              onClick={toggleCollapseAll}
            >
              {allOpen ? <ChevronsDownUp size={17} /> : <ChevronsUpDown size={17} />}
            </button>
          )}
          {isAdmin && dirty && (
            <button
              className="icon-btn cancel-all-btn"
              title="Yadda saxlanmamış dəyişiklikləri ləğv et"
              onClick={cancelAll}
              disabled={saving}
            >
              <Undo2 size={17} />
              <span>Ləğv et</span>
            </button>
          )}
          {isAdmin && (
            <button
              className={`icon-btn save-all-btn ${dirty ? 'dirty' : ''}`}
              title={dirty ? 'Yadda saxlanmamış dəyişikliklər var' : 'Bütün dəyişikliklər saxlanılıb'}
              onClick={saveAll}
              disabled={!dirty || saving}
            >
              {saving ? <Loader2 size={17} className="spin" /> : (dirty ? <Save size={17} /> : <Check size={17} />)}
              <span>{saving ? tByText('Saxlanılır...') : (dirty ? tByText('Hamısını yadda saxla') : tByText('Saxlanılıb'))}</span>
            </button>
          )}
          <button className="logout-btn" onClick={logout}>
            <LogOut size={16} /><span>{t('topbar.logout', 'Çıxış')}</span>
          </button>
        </div>
      </div>
      {saveError && (
        <div className="empty-state error" style={{ margin: '8px 24px 0' }}>
          Yadda saxlanmadı: {saveError}
        </div>
      )}
      <br />
      <div className="home-wrap">
        <LogoFull size="large" />
        <h2 className="home-title">
          {(settings?.[pageTitleKey]) || pageTitleDefault}
          {isAdmin && settings && (
            <TitleEditButton
              heading="Başlığı dəyiş"
              nameLabel="Səhifə başlığı"
              name0={(settings?.[pageTitleKey]) || pageTitleDefault}
              onSave={({ name }) => saveSettings({ [pageTitleKey]: name })}
            />
          )}
        </h2>

        <div className="process-list">
          {loading && <div className="empty-state"><Loader2 size={20} className="spin" />Yüklənir...</div>}
          {error && !loading && <div className="empty-state error">{error}</div>}
          {noResults && <div className="empty-state">Heç bir qrup yoxdur</div>}
      {isAdmin && !loading && onOpenSheets && (
            <button className="process-item create-btn sheets-open-btn" onClick={onOpenSheets}>
              <div className="num"><FileSpreadsheet size={20} /></div>
              <div className="label">{t('home.open_sheets', 'İş axışların hesabatı')}</div>
            </button>
          )}
      {isAdmin && !loading && (
            <button className="process-item create-btn" onClick={() => setGmodal({ type: 'create', parentId: null })}>
              <div className="num"><FolderPlus size={20} /></div>
              <div className="label">{t('home.new_group', 'Yeni qrup yarat')}</div>
            </button>
          )}

          {isAdmin && draggingGroupId != null && normPid(groups.find(g => g.id === draggingGroupId) || {}) !== null && (
            <div
              className={`root-drop-zone ${groupOver === '__root__' ? 'drag-over' : ''}`}
              onDragOver={onRootDragOver}
              onDrop={onRootDrop}
            >
              Bura burax — kök səviyyəyə (əsas siyahıya) köçür
            </div>
          )}

          {!loading && !error && childGroupsOf(null).map((g) => renderGroup(g, 0))}

          {isAdmin && !loading && !error && archived.length > 0 && (() => {
            const items = archived.filter(Boolean).filter(matches);
            if (q && items.length === 0) return null;
            const isOpen = q ? true : archiveOpen;
            return (
              <div className={`group-card archive-card ${isOpen ? 'open' : ''}`}>
                <div className="group-head" onClick={() => setArchiveOpen(v => !v)}>
                  <span className="group-chevron">
                    {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                  </span>
                  <span className="group-folder"><Archive size={17} /></span>
                  <span className="group-name">Arxiv</span>
                  <span className="group-count">{archived.length}</span>
                </div>
                {isOpen && (
                  <div className="group-body">
                    {items.map((p) => (
                      <div key={p.id} className="process-item pdf-item archived-row">
                        <div className="num"><Archive size={14} /></div>
                        <div className="label">
                          <span className="row-title">
                            {p.title}
                            {p.size ? <span className="pdf-size">{fmtSize(p.size)}</span> : null}
                          </span>
                          {p.subtitle ? <span className="row-subtitle">{p.subtitle}</span> : null}
                        </div>
                        <div className="pdf-actions">
                          <button className="action-btn" onClick={() => viewPdf(p)} disabled={busy === p.id} title={rawByText('Bax')}>
                            {busy === p.id ? <Loader2 size={15} className="spin" /> : <Eye size={15} />}
                            <span>{tByText('Bax')}</span>
                          </button>
                          {isAdmin && (
                            <>
                              <button className="action-btn action-btn-icon nospace"
                                onClick={(e) => unarchivePdf(e, p)} title="Arxivdən çıxar">
                                <ArchiveRestore size={15} />
                              </button>
                              <button className="action-btn action-btn-icon action-btn-danger"
                                onClick={(e) => deleteArchivedPdf(e, p)} title="Tamamilə sil">
                                <Trash2 size={15} />
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
          })()}
        </div>
      </div>

      {modal && (
        <PdfFormModal
          mode={modal.mode}
          pdf={modal.pdf}
          groups={groups.filter(g => !isTempId(g.id))}
          defaultGroupId={modal.defaultGroupId}
          sheetOptions={modal.mode === 'create' ? sheetOptions : null}
          onClose={() => setModal(null)}
          onSave={handleModalSave}
        />
      )}
      {gmodal?.type === 'create' && (
        <NameModal heading={gmodal.parentId ? 'Yeni alt qrup' : 'Yeni qrup'} nameLabel="Qrup adı" namePlaceholder="Qrupun adı"
          saveLabel="Yarat" sheetOptions={sheetOptions} sheetPickAs="group" groups={groups}
          onClose={() => setGmodal(null)} onSave={saveGroupCreate} />
      )}
      {gmodal?.type === 'rename' && (
        <NameModal heading="Qrupu adlandır" nameLabel="Qrup adı" name0={gmodal.group.name}
          onClose={() => setGmodal(null)} onSave={saveGroupRename} />
      )}
    </>
  );
}
