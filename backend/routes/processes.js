import { Router } from 'express';
import { getFile, putFile } from '../services/store.js';
import { homePath, homeArchivePath, diagramPath } from '../services/paths.js';
import { linkRowToItem, autoLinkNewItem } from '../services/sheetsStore.js';
import { keepHomeDeleted, homeDeletedIds } from '../services/homeTrash.js';

/*
  İş Axışları — Home page list (data/diagrams/home.json), its archive
  (home-archive.json) and the diagrams themselves (items/diagram-<id>.json).

  Nothing here touches the Hesabat table. Nothing is hard-deleted either:
  "delete" on a diagram or a folder moves the diagram(s) to the archive.
*/
const router = Router();
const KIND = 'diagrams';

/* ---------- helpers ---------- */
async function readArchive() {
  const c = (await getFile(homeArchivePath(KIND)))?.content;
  return { items: (Array.isArray(c?.items) ? c.items : []).filter(Boolean) };
}
const writeArchive = (content) => putFile(homeArchivePath(KIND), content);

function ensureGroups(idx) {
  let changed = false;
  if (!idx || typeof idx !== 'object') idx = {};
  if (!Array.isArray(idx.processes)) { idx.processes = []; changed = true; }
  if (!Array.isArray(idx.groups)) { idx.groups = []; changed = true; }
  const orphans = idx.processes.filter(p => !p.groupId);
  if (orphans.length && idx.groups.length === 0) { idx.groups.push({ id: 1, name: 'Ümumi', parentId: null }); changed = true; }
  if (orphans.length) { const gid = idx.groups[0].id; orphans.forEach(p => { p.groupId = gid; }); changed = true; }
  return { idx, changed };
}
async function readIndex() {
  return ensureGroups((await getFile(homePath(KIND)))?.content || null).idx;
}
const writeIndex = (content) => putFile(homePath(KIND), content);

function nextId(list) {
  const ids = (list || []).map(x => Number(x.id)).filter(Number.isFinite);
  return ids.length ? Math.max(...ids) + 1 : 1;
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}
function collectGroupIds(idx, rootId) {
  const ids = [rootId];
  let frontier = [rootId];
  while (frontier.length) {
    const kids = idx.groups.filter(g => frontier.includes(Number(g.parentId))).map(g => Number(g.id));
    ids.push(...kids);
    frontier = kids;
  }
  return ids;
}
// Move index entries into the archive (diagram files stay where they are).
async function archiveEntries(idx, entries) {
  if (!entries.length) return;
  const ids = new Set(entries.map(e => Number(e.id)));
  const archive = await readArchive();
  const now = new Date().toISOString();
  archive.items = [
    ...archive.items.filter(a => !ids.has(Number(a.id))),
    ...entries.map(e => ({
      ...e,
      groupName: idx.groups.find(g => Number(g.id) === Number(e.groupId))?.name || '',
      archivedAt: now
    }))
  ];
  await writeArchive(archive); // archive first: a crash in between leaves it visible, never lost
  idx.processes = idx.processes.filter(p => !ids.has(Number(p.id)));
}

/* =========================== LIST =========================== */
router.get('/', async (req, res, next) => {
  try {
    const file = await getFile(homePath(KIND));
    const { idx, changed } = ensureGroups(file ? file.content : null);
    if (changed) await writeIndex(idx).catch(() => {});
    const archive = await readArchive();
    res.json({ groups: idx.groups, processes: idx.processes, archived: archive.items });
  } catch (e) { next(e); }
});

/* =========================== GROUPS =========================== */
router.post('/group', requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Qrup adı tələb olunur' });
    const idx = await readIndex();
    const parentId = req.body?.parentId != null ? Number(req.body.parentId) : null;
    if (parentId && !idx.groups.some(g => Number(g.id) === parentId)) {
      return res.status(400).json({ error: 'Valideyn qrup tapılmadı' });
    }
    const group = { id: nextId(idx.groups), name, parentId: parentId || null };
    idx.groups = [...idx.groups, group];
    await writeIndex(idx);
    res.status(201).json(group);
  } catch (e) { next(e); }
});

router.put('/group/:gid', requireAdmin, async (req, res, next) => {
  try {
    const gid = Number(req.params.gid);
    const idx = await readIndex();
    const g = idx.groups.find(x => Number(x.id) === gid);
    if (!g) return res.status(404).json({ error: 'Qrup tapılmadı' });
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Qrup adı tələb olunur' });
      g.name = name;
    }
    if (req.body?.parentId !== undefined) {
      const newParentId = req.body.parentId === null ? null : Number(req.body.parentId);
      if (newParentId !== null) {
        if (newParentId === gid) return res.status(400).json({ error: 'Qrup öz-özünün alt qrupu ola bilməz' });
        if (!idx.groups.some(x => Number(x.id) === newParentId)) return res.status(400).json({ error: 'Valideyn qrup tapılmadı' });
        if (collectGroupIds(idx, gid).includes(newParentId)) return res.status(400).json({ error: 'Qrupu öz alt qrupunun içinə köçürmək olmaz' });
      }
      g.parentId = newParentId;
    }
    await writeIndex(idx);
    res.json(g);
  } catch (e) { next(e); }
});

// Removing a folder archives every diagram inside it (and its subfolders).
router.delete('/group/:gid', requireAdmin, async (req, res, next) => {
  try {
    const gid = Number(req.params.gid);
    const idx = await readIndex();
    const all = collectGroupIds(idx, gid);
    const inGroup = idx.processes.filter(p => all.includes(Number(p.groupId)));
    await archiveEntries(idx, inGroup);
    idx.groups = idx.groups.filter(g => !all.includes(Number(g.id)));
    await writeIndex(idx);
    res.json({ ok: true, archivedDiagrams: inGroup.length, removedGroups: all.length });
  } catch (e) { next(e); }
});

/* =========================== REORDER =========================== */
router.put('/groups/reorder', requireAdmin, async (req, res, next) => {
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order.map(Number) : null;
    if (!order) return res.status(400).json({ error: 'order array required' });
    const idx = await readIndex();
    const byId = new Map(idx.groups.map(g => [Number(g.id), g]));
    const out = [];
    for (const id of order) if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); }
    idx.groups = [...out, ...byId.values()];
    await writeIndex(idx);
    res.json({ groups: idx.groups });
  } catch (e) { next(e); }
});

router.put('/reorder', requireAdmin, async (req, res, next) => {
  try {
    const groupId = Number(req.body?.groupId);
    const order = Array.isArray(req.body?.order) ? req.body.order.map(Number) : null;
    if (!groupId || !order) return res.status(400).json({ error: 'groupId and order required' });
    const idx = await readIndex();
    const byId = new Map(idx.processes.filter(p => Number(p.groupId) === groupId).map(p => [Number(p.id), p]));
    const seq = [];
    for (const id of order) if (byId.has(id)) { seq.push(byId.get(id)); byId.delete(id); }
    seq.push(...byId.values());
    let k = 0;
    idx.processes = idx.processes.map(p => (Number(p.groupId) === groupId ? seq[k++] : p));
    await writeIndex(idx);
    res.json({ processes: idx.processes });
  } catch (e) { next(e); }
});

/* =========================== ARCHIVE =========================== */
router.post('/:id/archive', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const idx = await readIndex();
    const entry = idx.processes.find(p => Number(p.id) === id);
    if (!entry) return res.status(404).json({ error: 'Diaqram tapılmadı' });
    await archiveEntries(idx, [entry]);
    await writeIndex(idx);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Back to its old folder; if that folder is gone, to a folder with the same
// name (created if needed); otherwise the first folder.
router.post('/:id/unarchive', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const archive = await readArchive();
    const entry = archive.items.find(a => Number(a.id) === id);
    if (!entry) return res.status(404).json({ error: 'Arxivdə tapılmadı' });
    const idx = await readIndex();
    let gid = null;
    // A new folder typed in the restore dialog
    const newName = String(req.body?.newGroupName || '').trim();
    if (newName) {
      const ex = idx.groups.find(g => String(g.name).trim() === newName);
      if (ex) gid = Number(ex.id);
      else { const g = { id: nextId(idx.groups), name: newName, parentId: null }; idx.groups.push(g); gid = g.id; }
    }
    const wantGroup = req.body?.groupId != null ? Number(req.body.groupId) : Number(entry.groupId);
    if (gid == null && idx.groups.some(g => Number(g.id) === wantGroup)) gid = wantGroup;
    if (gid == null && entry.groupName) {
      const byName = idx.groups.find(g => String(g.name).trim() === String(entry.groupName).trim());
      if (byName) gid = Number(byName.id);
      else {
        const g = { id: nextId(idx.groups), name: String(entry.groupName).trim(), parentId: null };
        idx.groups.push(g);
        gid = g.id;
      }
    }
    if (gid == null) {
      if (!idx.groups.length) idx.groups.push({ id: 1, name: 'Ümumi', parentId: null });
      gid = Number(idx.groups[0].id);
    }
    const { groupName, archivedAt, note, ...meta } = entry;
    idx.processes = [...idx.processes.filter(p => Number(p.id) !== id), { ...meta, groupId: gid }];
    await writeIndex(idx);
    archive.items = archive.items.filter(a => Number(a.id) !== id);
    await writeArchive(archive);
    res.json({ ok: true, groupId: gid });
  } catch (e) { next(e); }
});

// Delete from the archive: off the page, a copy is kept in home-deleted.json
// and the diagram file stays in data/ + Mongo.
router.delete('/archived/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const archive = await readArchive();
    const entry = archive.items.find(a => Number(a.id) === id);
    if (!entry) return res.json({ ok: true, alreadyGone: true });
    await keepHomeDeleted(KIND, [entry]);
    archive.items = archive.items.filter(a => a !== entry);
    await writeArchive(archive);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* =========================== DIAGRAMS =========================== */
const ALLOWED_STATUS = ['progress', 'prep', 'notdone', 'done', 'cancelled'];

router.get('/:id', async (req, res, next) => {
  try {
    const file = await getFile(diagramPath(req.params.id));
    if (!file) return res.status(404).json({ error: 'Diaqram tapılmadı' });
    const idx = await readIndex();
    let entry = idx.processes.find(p => Number(p.id) === Number(req.params.id));
    if (!entry) entry = (await readArchive()).items.find(p => Number(p.id) === Number(req.params.id));
    res.json({ ...file.content, status: entry?.status ?? null });
  } catch (e) { next(e); }
});

router.put('/:id/status', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const raw = req.body?.status;
    const status = raw == null || raw === '' ? null : String(raw);
    if (status !== null && !ALLOWED_STATUS.includes(status)) return res.status(400).json({ error: 'Yanlış status' });
    const idx = await readIndex();
    const entry = idx.processes.find(p => Number(p.id) === id);
    if (!entry) return res.status(404).json({ error: 'Diaqram tapılmadı' });
    if (status === null) delete entry.status; else entry.status = status;
    await writeIndex(idx);
    res.json({ id, status });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const idx = await readIndex();
    const groupId = Number(req.body.groupId);
    if (!groupId || !idx.groups.some(g => Number(g.id) === groupId)) {
      return res.status(400).json({ error: 'Diaqram bir qrupa aid olmalıdır' });
    }
    const archive = await readArchive();
    const newId = req.body.id || nextId([...idx.processes, ...archive.items, ...(await homeDeletedIds(KIND)).map(id => ({ id }))]);
    const title = req.body.title || `Yeni proses ${newId}`;
    const subtitle = req.body.subtitle ? String(req.body.subtitle) : '';
    const status = req.body.status == null || req.body.status === '' ? null : String(req.body.status);
    if (status !== null && !ALLOWED_STATUS.includes(status)) return res.status(400).json({ error: 'Yanlış status' });

    const body = {
      id: newId, title, subtitle,
      width: req.body.width || 1600,
      height: req.body.height || 600,
      lanes: req.body.lanes || [],
      nodes: req.body.nodes || [],
      edges: req.body.edges || []
    };
    if (req.body.theme && typeof req.body.theme === 'object') body.theme = req.body.theme;
    await putFile(diagramPath(newId), body);
    const entry = { id: newId, title, subtitle, groupId };
    if (status) entry.status = status;
    idx.processes = [...idx.processes, entry];
    await writeIndex(idx);
    // Picked a Hesabat row in the dialog -> only remember the link.
    if (req.body.sheetId != null) await linkRowToItem(KIND, req.body.sheetId, newId).catch(() => {});
    else await autoLinkNewItem(KIND, newId, title, idx.groups.find(g => Number(g.id) === groupId)?.name || '').catch(() => {});
    res.status(201).json({ ...body, status });
  } catch (e) { next(e); }
});

router.put('/:id/meta', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const idx = await readIndex();
    const entry = idx.processes.find(p => Number(p.id) === id);
    if (!entry) return res.status(404).json({ error: 'Diaqram tapılmadı' });
    if (typeof req.body.title === 'string') entry.title = req.body.title;
    if (typeof req.body.subtitle === 'string') entry.subtitle = req.body.subtitle;
    if (req.body.groupId !== undefined) {
      const gid = Number(req.body.groupId);
      if (idx.groups.some(g => Number(g.id) === gid)) entry.groupId = gid;
    }
    await writeIndex(idx);
    const file = await getFile(diagramPath(id));
    if (file) await putFile(diagramPath(id), { ...file.content, title: entry.title, subtitle: entry.subtitle || '' });
    res.json(entry);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = req.body;
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Diaqram məlumatı tələb olunur' });
    const { status, ...diagram } = body; // status lives on the Home list
    diagram.id = id;
    await putFile(diagramPath(id), diagram);
    const idx = await readIndex();
    const entry = idx.processes.find(p => Number(p.id) === id);
    if (entry) {
      let changed = false;
      if (typeof diagram.title === 'string' && entry.title !== diagram.title) { entry.title = diagram.title; changed = true; }
      if (typeof diagram.subtitle === 'string' && entry.subtitle !== diagram.subtitle) { entry.subtitle = diagram.subtitle; changed = true; }
      if (changed) await writeIndex(idx);
    }
    res.json(body);
  } catch (e) { next(e); }
});

// No hard delete: removing a diagram archives it.
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const idx = await readIndex();
    const entry = idx.processes.find(p => Number(p.id) === id);
    if (entry) {
      await archiveEntries(idx, [entry]);
      await writeIndex(idx);
    }
    res.json({ ok: true, archived: !!entry });
  } catch (e) { next(e); }
});

export default router;
