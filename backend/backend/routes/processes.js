import { Router } from 'express';
import { getFile, putFile, deleteFile, attribution } from '../services/store.js';
import { syncFromProcess, removeSheetRowsForDeletedItems } from '../services/sheetsStore.js';

const router = Router();
const dataPath = () => (process.env.DATA_PATH || 'data').replace(/^\/|\/$/g, '');

const indexPath = () => `${dataPath()}/diagrams/index.json`;
const archivePath = () => `${dataPath()}/diagrams/archive.json`;
const processPath = id => `${dataPath()}/diagrams/processes/process-${id}.json`;

/* ---------- archive helpers (archived diagrams live in archive.json) ---------- */
async function readArchive() {
  const file = await getFile(archivePath());
  const c = file ? file.content : null;
  // Filter out any null/malformed entries — old data had a stray `null` in
  // here (from a prior bug), which crashed the frontend's archive list.
  return (c && Array.isArray(c.items)) ? { ...c, items: c.items.filter(Boolean) } : { items: [] };
}
// `user` is the logged-in panel admin (req.user) — gets stamped onto the commit
// so GitHub shows who made the change instead of just the token owner.
async function writeArchive(content, message, user) {
  return putFile(archivePath(), content, attribution(user, message));
}

/* ---------- index helpers + one-time migration to groups ---------- */
function ensureGroups(idx) {
  let changed = false;
  if (!idx || typeof idx !== 'object') idx = {};
  if (!Array.isArray(idx.processes)) { idx.processes = []; changed = true; }
  if (!Array.isArray(idx.groups)) { idx.groups = []; changed = true; }

  const orphans = idx.processes.filter(p => !p.groupId);
  if (orphans.length && idx.groups.length === 0) {
    idx.groups.push({ id: 1, name: 'Ümumi' });
    changed = true;
  }
  if (orphans.length && idx.groups.length) {
    const gid = idx.groups[0].id;
    idx.processes.forEach(p => { if (!p.groupId) { p.groupId = gid; changed = true; } });
  }
  return { idx, changed };
}

async function readIndex() {
  const file = await getFile(indexPath());
  const { idx } = ensureGroups(file ? file.content : null);
  return idx;
}

async function writeIndex(content, message, user) {
  return putFile(indexPath(), content, attribution(user, message));
}

function nextId(list) {
  const ids = (list || []).map(x => Number(x.id)).filter(Number.isFinite);
  return ids.length ? Math.max(...ids) + 1 : 1;
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

/* =========================== GROUPS =========================== */
router.get('/', async (req, res, next) => {
  try {
    const file = await getFile(indexPath());
    const { idx, changed } = ensureGroups(file ? file.content : null);
    if (changed) await writeIndex(idx, 'Migrate diagrams to groups', req.user).catch(() => {});
    const archive = await readArchive();
    res.json({ groups: idx.groups || [], processes: idx.processes || [], archived: archive.items || [] });
  } catch (e) { next(e); }
});

router.post('/group', requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Qrup adi teleb olunur' });
    const idx = await readIndex();

    let parentId = req.body?.parentId != null ? Number(req.body.parentId) : null;
    if (parentId && !idx.groups.some(g => Number(g.id) === parentId)) {
      return res.status(400).json({ error: 'Valideyn qrup tapılmadı' });
    }

    const group = { id: nextId(idx.groups), name, parentId: parentId || null };
    idx.groups = [...idx.groups, group];
    await writeIndex(idx, `Create group ${group.id}`, req.user);
    res.status(201).json(group);
  } catch (e) { next(e); }
});

router.put('/group/:gid', requireAdmin, async (req, res, next) => {
  try {
    const gid = Number(req.params.gid);
    const idx = await readIndex();
    const g = idx.groups.find(x => Number(x.id) === gid);
    if (!g) return res.status(404).json({ error: 'Qrup tapilmadi' });

    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Qrup adi teleb olunur' });
      g.name = name;
    }

    // Moving a group under a new parent (drag & drop nesting). Any nested
    // subgroups/diagrams stay attached to this group's id, so they move
    // along with it automatically — nothing else needs to change.
    if (req.body?.parentId !== undefined) {
      const newParentId = req.body.parentId === null ? null : Number(req.body.parentId);
      if (newParentId !== null) {
        if (newParentId === gid) {
          return res.status(400).json({ error: 'Qrup öz-özünün alt qrupu ola bilməz' });
        }
        if (!idx.groups.some(x => Number(x.id) === newParentId)) {
          return res.status(400).json({ error: 'Valideyn qrup tapılmadı' });
        }
        // reject moving a group into one of its own descendants (would create a cycle)
        function isDescendant(candidateId, rootId) {
          let frontier = [rootId];
          while (frontier.length) {
            const kids = idx.groups.filter(x => frontier.includes(Number(x.parentId)));
            if (kids.some(k => Number(k.id) === candidateId)) return true;
            frontier = kids.map(k => Number(k.id));
          }
          return false;
        }
        if (isDescendant(newParentId, gid)) {
          return res.status(400).json({ error: 'Qrupu öz alt qrupunun içinə köçürmək olmaz' });
        }
      }
      g.parentId = newParentId;
    }

    await writeIndex(idx, `Update group ${gid}`, req.user);
    res.json(g);
  } catch (e) { next(e); }
});

router.delete('/group/:gid', requireAdmin, async (req, res, next) => {
  try {
    const gid = Number(req.params.gid);
    const idx = await readIndex();

    // Collect this group + every descendant subgroup (any depth).
    function collectIds(rootId) {
      const ids = [rootId];
      let frontier = [rootId];
      while (frontier.length) {
        const children = idx.groups.filter(g => frontier.includes(Number(g.parentId)));
        const childIds = children.map(g => Number(g.id));
        ids.push(...childIds);
        frontier = childIds;
      }
      return ids;
    }
    const allGroupIds = collectIds(gid);

    const inGroup = idx.processes.filter(p => allGroupIds.includes(Number(p.groupId)));
    const deletedGroupNames = idx.groups
      .filter(g => allGroupIds.includes(Number(g.id)))
      .map(g => String(g.name || '').trim())
      .filter(Boolean);
    const groupNameById = new Map(idx.groups.map(g => [Number(g.id), String(g.name || '').trim()]));
    const deletedItemIds = inGroup.map(p => Number(p.id));
    for (const p of inGroup) {
      await deleteFile(processPath(p.id), attribution(req.user, `Delete process ${p.id} (group ${gid})`)).catch(() => {});
    }
    idx.processes = idx.processes.filter(p => !allGroupIds.includes(Number(p.groupId)));
    idx.groups = idx.groups.filter(g => !allGroupIds.includes(Number(g.id)));
    await writeIndex(idx, `Delete group ${gid} (+ subgroups)`, req.user);
    await removeSheetRowsForDeletedItems('diagrams', deletedItemIds, deletedGroupNames, req.user, inGroup.map(p => ({ ...p, strukturAdi: groupNameById.get(Number(p.groupId)) || '' }))).catch((e) =>
      console.error('[process group delete -> sheets]', e.message)
    );
    res.json({ ok: true, deletedDiagrams: inGroup.length, deletedGroups: allGroupIds.length });
  } catch (e) { next(e); }
});

/* =========================== REORDER =========================== */
// Reorder the folders (groups). body: { order: [gid, gid, ...] }
router.put('/groups/reorder', requireAdmin, async (req, res, next) => {
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order.map(Number) : null;
    if (!order) return res.status(400).json({ error: 'order array required' });
    const idx = await readIndex();
    const byId = new Map(idx.groups.map(g => [Number(g.id), g]));
    const reordered = [];
    for (const id of order) {
      if (byId.has(id)) { reordered.push(byId.get(id)); byId.delete(id); }
    }
    for (const g of byId.values()) reordered.push(g); // keep any not listed
    idx.groups = reordered;
    await writeIndex(idx, 'Reorder groups', req.user);
    res.json({ groups: idx.groups });
  } catch (e) { next(e); }
});

// Reorder diagrams inside one folder. body: { groupId, order: [pid, pid, ...] }
// NOTE: must be declared before '/:id' so "reorder" isn't read as an id.
router.put('/reorder', requireAdmin, async (req, res, next) => {
  try {
    const groupId = Number(req.body?.groupId);
    const order = Array.isArray(req.body?.order) ? req.body.order.map(Number) : null;
    if (!groupId || !order) return res.status(400).json({ error: 'groupId and order required' });
    const idx = await readIndex();
    const groupItems = idx.processes.filter(p => Number(p.groupId) === groupId);
    const byId = new Map(groupItems.map(p => [Number(p.id), p]));
    const seq = [];
    for (const id of order) {
      if (byId.has(id)) { seq.push(byId.get(id)); byId.delete(id); }
    }
    for (const p of byId.values()) seq.push(p); // keep any not listed
    // Re-emit the flat list, swapping this group's slots into the new order.
    let k = 0;
    idx.processes = idx.processes.map(p =>
      Number(p.groupId) === groupId ? seq[k++] : p
    );
    await writeIndex(idx, `Reorder diagrams in group ${groupId}`, req.user);
    res.json({ processes: idx.processes });
  } catch (e) { next(e); }
});

/* =========================== ARCHIVE =========================== */
// Move a diagram out of the index into archive.json (data file stays).
router.post('/:id/archive', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const idx = await readIndex();
    const entry = idx.processes.find(p => Number(p.id) === id);
    if (!entry) return res.status(404).json({ error: 'Process not found' });

    idx.processes = idx.processes.filter(p => Number(p.id) !== id);
    const archive = await readArchive();
    const group = idx.groups.find(g => Number(g.id) === Number(entry.groupId));
    archive.items = [
      ...archive.items.filter(a => Number(a.id) !== id),
      { ...entry, groupName: group?.name || '', archivedAt: new Date().toISOString() }
    ];
    await writeArchive(archive, `Archive process ${id}`, req.user);
    await writeIndex(idx, `Remove process ${id} from index (archived)`, req.user);
    res.json({ ok: true, archived: archive.items });
  } catch (e) { next(e); }
});

// Restore an archived diagram back into the index.
router.post('/:id/unarchive', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const archive = await readArchive();
    const entry = archive.items.find(a => Number(a.id) === id);
    if (!entry) return res.status(404).json({ error: 'Archived process not found' });

    const idx = await readIndex();
    // put back into its old group if it still exists, otherwise the first group
    let gid = Number(entry.groupId);
    if (!idx.groups.some(g => Number(g.id) === gid)) {
      if (!idx.groups.length) idx.groups.push({ id: 1, name: 'Ümumi' });
      gid = Number(idx.groups[0].id);
    }
    const { groupName, archivedAt, ...meta } = entry;
    idx.processes = [...idx.processes, { ...meta, groupId: gid }];
    archive.items = archive.items.filter(a => Number(a.id) !== id);
    await writeIndex(idx, `Restore process ${id} from archive`, req.user);
    await writeArchive(archive, `Unarchive process ${id}`, req.user);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* =========================== PROCESSES =========================== */
// İş Axışları statuses (no "sign" here — that's Normativ/Şablon only).
const ALLOWED_STATUS = ['progress', 'prep', 'notdone', 'done', 'cancelled'];

router.get('/:id', async (req, res, next) => {
  try {
    const file = await getFile(processPath(req.params.id));
    if (!file) return res.status(404).json({ error: 'Process not found' });
    // status lives on the index entry — merge it in so the diagram view has it
    const idx = await readIndex();
    const entry = idx.processes.find(p => Number(p.id) === Number(req.params.id));
    res.json({ ...file.content, status: entry?.status ?? null });
  } catch (e) { next(e); }
});

// Set (or clear) a diagram's status. body: { status: 'progress'|'done'|'notdone'|null }
router.put('/:id/status', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const raw = req.body?.status;
    const status = raw == null || raw === '' ? null : String(raw);
    if (status !== null && !ALLOWED_STATUS.includes(status)) {
      return res.status(400).json({ error: 'Yanlış status' });
    }
    const idx = await readIndex();
    const entry = idx.processes.find(p => Number(p.id) === id);
    if (!entry) return res.status(404).json({ error: 'Process not found' });
    if (status === null) delete entry.status; else entry.status = status;
    await writeIndex(idx, `Set status for process ${id}`, req.user);
    const gName = idx.groups.find(g => Number(g.id) === Number(entry.groupId))?.name || '';
    await syncFromProcess({
      processId: id,
      title: entry.title,
      subtitle: entry.subtitle || '',
      status,
      strukturAdi: gName
    }, req.user).catch((e) => console.error('[sheets sync status]', e.message));
    res.json({ id, status });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const idx = await readIndex();
    const groupId = Number(req.body.groupId);
    if (!groupId || !idx.groups.some(g => Number(g.id) === groupId)) {
      return res.status(400).json({ error: 'Diaqram bir qrupa aid olmalidir' });
    }
    const newId = req.body.id || nextId(idx.processes);
    const title = req.body.title || `Yeni proses ${newId}`;
    const subtitle = req.body.subtitle ? String(req.body.subtitle) : '';
    const sheetId = req.body.sheetId != null ? Number(req.body.sheetId) : null;
    const statusRaw = req.body.status;
    const status = statusRaw == null || statusRaw === '' ? null : String(statusRaw);
    if (status !== null && !ALLOWED_STATUS.includes(status)) {
      return res.status(400).json({ error: 'Yanlış status' });
    }
    const gName = idx.groups.find(g => Number(g.id) === groupId)?.name || '';

    const process = {
      id: newId, title, subtitle,
      width: req.body.width || 1600,
      height: req.body.height || 600,
      lanes: req.body.lanes || [],
      nodes: req.body.nodes || [],
      edges: req.body.edges || []
    };
    if (req.body.theme && typeof req.body.theme === 'object') process.theme = req.body.theme;
    await putFile(processPath(newId), process, attribution(req.user, `Create process ${newId}`));
    const indexEntry = { id: newId, title, subtitle, groupId };
    if (status) indexEntry.status = status;
    idx.processes = [...idx.processes, indexEntry];
    await writeIndex(idx, `Add process ${newId} to index`, req.user);
    await syncFromProcess({
      processId: newId,
      title,
      subtitle,
      status,
      sheetId: Number.isFinite(sheetId) ? sheetId : undefined,
      strukturAdi: gName
    }, req.user).catch((e) => console.error('[sheets sync create]', e.message));
    res.status(201).json({ ...process, status: status || null });
  } catch (e) { next(e); }
});

router.put('/:id/meta', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const idx = await readIndex();
    const entry = idx.processes.find(p => Number(p.id) === id);
    if (!entry) return res.status(404).json({ error: 'Process not found' });

    if (typeof req.body.title === 'string') entry.title = req.body.title;
    if (typeof req.body.subtitle === 'string') entry.subtitle = req.body.subtitle;
    if (req.body.groupId !== undefined) {
      const gid = Number(req.body.groupId);
      if (idx.groups.some(g => Number(g.id) === gid)) entry.groupId = gid;
    }
    await writeIndex(idx, `Update meta for process ${id}`, req.user);

    const file = await getFile(processPath(id));
    if (file) {
      const body = { ...file.content, title: entry.title, subtitle: entry.subtitle };
      await putFile(processPath(id), body, attribution(req.user, `Sync meta for process ${id}`));
    }
    await syncFromProcess({
      processId: id,
      title: entry.title,
      subtitle: entry.subtitle || '',
      status: entry.status ?? null,
      strukturAdi: idx.groups.find(g => Number(g.id) === Number(entry.groupId))?.name || ''
    }, req.user).catch((e) => console.error('[sheets sync meta]', e.message));
    res.json(entry);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Process body required' });
    }
    body.id = Number(id);
    await putFile(processPath(id), body, attribution(req.user, `Update process ${id}`));

    const idx = await readIndex();
    const i = idx.processes.findIndex(p => Number(p.id) === Number(id));
    if (i >= 0) {
      let changed = false;
      if (typeof body.title === 'string' && idx.processes[i].title !== body.title) {
        idx.processes[i].title = body.title; changed = true;
      }
      if (typeof body.subtitle === 'string' && idx.processes[i].subtitle !== body.subtitle) {
        idx.processes[i].subtitle = body.subtitle; changed = true;
      }
      if (changed) {
        await writeIndex(idx, `Sync title for process ${id}`, req.user);
        await syncFromProcess({
          processId: Number(id),
          title: idx.processes[i].title,
          subtitle: idx.processes[i].subtitle || '',
          status: idx.processes[i].status ?? null,
          strukturAdi: idx.groups.find(g => Number(g.id) === Number(idx.processes[i].groupId))?.name || ''
        }, req.user).catch((e) => console.error('[sheets sync put]', e.message));
      }
    }
    res.json(body);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    await deleteFile(processPath(id), attribution(req.user, `Delete process ${id}`));
    const idx = await readIndex();
    const existing = idx.processes.find(p => Number(p.id) === Number(id));
    const existingGroupName = idx.groups.find(g => Number(g.id) === Number(existing?.groupId))?.name || '';
    idx.processes = idx.processes.filter(p => Number(p.id) !== Number(id));
    await writeIndex(idx, `Remove process ${id} from index`, req.user);
    await removeSheetRowsForDeletedItems('diagrams', [id], [], req.user, existing ? [{ ...existing, strukturAdi: existingGroupName }] : []).catch((e) =>
      console.error('[process delete -> sheets]', e.message)
    );
    // also drop it from the archive, in case it was archived
    const archive = await readArchive();
    if (archive.items.some(a => Number(a.id) === Number(id))) {
      archive.items = archive.items.filter(a => Number(a.id) !== Number(id));
      await writeArchive(archive, `Remove process ${id} from archive`, req.user);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
