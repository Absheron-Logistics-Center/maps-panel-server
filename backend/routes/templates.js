import { Router } from 'express';
import {
  getFile, putFileQueued as putFile, deleteFile, getBinary,
  putBinaryQueued as putBinary, deleteBinaryQueued as deleteBinary, attribution
} from '../services/store.js';
import { linkRowToItem, autoLinkNewItem } from '../services/sheetsStore.js';
import { homePath, homeArchivePath } from '../services/paths.js';
import { keepHomeDeleted, homeDeletedIds } from '../services/homeTrash.js';

const router = Router();
const dataPath = () => (process.env.DATA_PATH || 'data').replace(/^\/|\/$/g, '');

// Same rule as pdfs.js — uploads work on Vercel too, but capped at 3MB there.
const isVercel = !!(process.env.VERCEL === '1' || process.env.VERCEL_ENV || process.env.NOW_REGION);
function blockUploadOnVercel(req, res, next) {
  // Uploads work everywhere now (stored in MongoDB, mirrored to the server's
  // disk). Vercel just can't accept request bodies over ~4.5MB, so on Vercel
  // the practical cap is 3MB (base64 inflates by a third) — bigger files must
  // be uploaded from the self-hosted server.
  if (isVercel && req.body?.dataBase64) {
    const approxBytes = Math.floor(String(req.body.dataBase64).length * 3 / 4);
    if (approxBytes > VERCEL_MAX_BYTES) {
      return res.status(413).json({ error: 'Vercel-də fayl maks. 3MB ola bilər. Böyük faylı daxili serverdən yükləyin.' });
    }
  }
  next();
}
const VERCEL_MAX_BYTES = 3 * 1024 * 1024;

// Uploads used to be accepted with no server-side check at all — any file
// type, any size (bounded only by the raw express.json body limit, which
// just produced an ugly generic error). Enforce an allowed-type + sane max
// size here so bad uploads get a clear 400 instead of silently going
// through or blowing up further down the line.
const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20MB
const ALLOWED_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx'];
const MIME_BY_EXT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
function extOf(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}
function validateUpload(filename, buf) {
  const ext = extOf(filename);
  if (!ext || !ALLOWED_EXT.includes(ext)) {
    return 'Yalnız PDF, Word (doc/docx) və ya Excel (xls/xlsx) fayl qəbul olunur';
  }
  if (buf.length > MAX_PDF_BYTES) {
    return `Fayl çox böyükdür (maks. ${MAX_PDF_BYTES / (1024 * 1024)}MB)`;
  }
  return null;
}

const pdfIndexPath     = () => homePath('templates');
const pdfArchivePath   = () => homeArchivePath('templates');
const pdfFilePathFiles = (id, ext = 'pdf') => `${dataPath()}/templates/pdf/pdf-${id}.${ext}`;
const pdfFilePathLegacy  = (id) => `${dataPath()}/pdfs/files/pdf-${id}.pdf`;
const pdfFilePathLegacy2 = (id) => `${dataPath()}/files/files/pdf-${id}.pdf`;

/* ---------- archive helpers (archived PDFs live in archive.json) ---------- */
async function readArchive() {
  const file = await getFile(pdfArchivePath());
  const c = file ? file.content : null;
  return (c && Array.isArray(c.items)) ? { ...c, items: c.items.filter(Boolean) } : { items: [] };
}
// `user` is the logged-in panel admin (req.user) — gets stamped onto the commit
// so GitHub shows who made the change instead of just the token owner.
async function writeArchive(content, message, user) {
  return putFile(pdfArchivePath(), content, attribution(user, message));
}

function ensureGroups(idx) {
  let changed = false;
  if (!idx || typeof idx !== 'object') idx = {};
  if (!Array.isArray(idx.pdfs)) { idx.pdfs = []; changed = true; }
  if (!Array.isArray(idx.groups)) { idx.groups = []; changed = true; }

  const orphans = idx.pdfs.filter(p => !p.groupId);
  if (orphans.length && idx.groups.length === 0) {
    idx.groups.push({ id: 1, name: 'Ümumi' });
    changed = true;
  }
  if (orphans.length && idx.groups.length) {
    const gid = idx.groups[0].id;
    idx.pdfs.forEach(p => { if (!p.groupId) { p.groupId = gid; changed = true; } });
  }
  return { idx, changed };
}

async function readIndex() {
  const file = await getFile(pdfIndexPath());
  const { idx } = ensureGroups(file ? file.content : null);
  return idx;
}

async function writeIndex(content, message, user) {
  return putFile(pdfIndexPath(), content, attribution(user, message));
}

function nextId(list) {
  const ids = (list || []).map(x => Number(x.id)).filter(Number.isFinite);
  return ids.length ? Math.max(...ids) + 1 : 1;
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

/* =========================== LIST + GROUPS =========================== */
router.get('/', async (req, res, next) => {
  try {
    const file = await getFile(pdfIndexPath());
    const { idx, changed } = ensureGroups(file ? file.content : null);
    if (changed) await writeIndex(idx, 'Migrate pdfs to groups', req.user).catch(() => {});
    const archive = await readArchive();
    res.json({ groups: idx.groups || [], pdfs: idx.pdfs || [], archived: archive.items || [] });
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
    await writeIndex(idx, `Create pdf group ${group.id}`, req.user);
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
    // subgroups/PDFs stay attached to this group's id, so they move along
    // with it automatically — nothing else needs to change.
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

    await writeIndex(idx, `Update pdf group ${gid}`, req.user);
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

    const inGroup = idx.pdfs.filter(p => allGroupIds.includes(Number(p.groupId)));
    const deletedGroupNames = idx.groups
      .filter(g => allGroupIds.includes(Number(g.id)))
      .map(g => String(g.name || '').trim())
      .filter(Boolean);
    const groupNameById = new Map(idx.groups.map(g => [Number(g.id), String(g.name || '').trim()]));
    const deletedItemIds = inGroup.map(p => Number(p.id));
    // Folder removed -> its documents go to the archive (files are kept).
    if (inGroup.length) {
      const archive = await readArchive();
      const ids = new Set(inGroup.map(p => Number(p.id)));
      const now = new Date().toISOString();
      archive.items = [
        ...archive.items.filter(a => !ids.has(Number(a.id))),
        ...inGroup.map(p => ({ ...p, groupName: groupNameById.get(Number(p.groupId)) || '', archivedAt: now }))
      ];
      await writeArchive(archive, `Archive items of group ${gid}`, req.user);
    }
    idx.pdfs = idx.pdfs.filter(p => !allGroupIds.includes(Number(p.groupId)));
    idx.groups = idx.groups.filter(g => !allGroupIds.includes(Number(g.id)));
    await writeIndex(idx, `Delete pdf group ${gid} (+ subgroups)`, req.user);
    res.json({ ok: true, deletedPdfs: inGroup.length, deletedGroups: allGroupIds.length });
  } catch (e) { next(e); }
});

/* =========================== REORDER =========================== */
// Reorder the folders (groups). body: { order: [gid, ...] }
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
    for (const g of byId.values()) reordered.push(g);
    idx.groups = reordered;
    await writeIndex(idx, 'Reorder pdf groups', req.user);
    res.json({ groups: idx.groups });
  } catch (e) { next(e); }
});

// Reorder PDFs inside one folder. body: { groupId, order: [pid, ...] }
// Must be declared before '/:id' so "reorder" isn't read as an id.
router.put('/reorder', requireAdmin, async (req, res, next) => {
  try {
    const groupId = Number(req.body?.groupId);
    const order = Array.isArray(req.body?.order) ? req.body.order.map(Number) : null;
    if (!groupId || !order) return res.status(400).json({ error: 'groupId and order required' });
    const idx = await readIndex();
    const groupItems = idx.pdfs.filter(p => Number(p.groupId) === groupId);
    const byId = new Map(groupItems.map(p => [Number(p.id), p]));
    const seq = [];
    for (const id of order) {
      if (byId.has(id)) { seq.push(byId.get(id)); byId.delete(id); }
    }
    for (const p of byId.values()) seq.push(p);
    let k = 0;
    idx.pdfs = idx.pdfs.map(p => Number(p.groupId) === groupId ? seq[k++] : p);
    await writeIndex(idx, `Reorder pdfs in group ${groupId}`, req.user);
    res.json({ pdfs: idx.pdfs });
  } catch (e) { next(e); }
});

/* =========================== ARCHIVE =========================== */
// Move a PDF out of the index into archive.json (the file itself stays).
router.post('/:id/archive', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const idx = await readIndex();
    const entry = idx.pdfs.find(p => Number(p.id) === id);
    if (!entry) return res.status(404).json({ error: 'PDF not found' });

    idx.pdfs = idx.pdfs.filter(p => Number(p.id) !== id);
    const archive = await readArchive();
    const group = idx.groups.find(g => Number(g.id) === Number(entry.groupId));
    archive.items = [
      ...archive.items.filter(a => Number(a.id) !== id),
      { ...entry, groupName: group?.name || '', archivedAt: new Date().toISOString() }
    ];
    await writeArchive(archive, `Archive pdf ${id}`, req.user);
    await writeIndex(idx, `Remove pdf ${id} from index (archived)`, req.user);
    res.json({ ok: true, archived: archive.items });
  } catch (e) { next(e); }
});

// Restore an archived PDF back into the index.
router.post('/:id/unarchive', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const archive = await readArchive();
    const entry = archive.items.find(a => Number(a.id) === id);
    if (!entry) return res.status(404).json({ error: 'Archived PDF not found' });

    const idx = await readIndex();
    // Folder: the one picked in the restore dialog, a new one by name, the
    // old folder, a folder with the old name, or (last resort) the first one.
    let gid = null;
    const newName = String(req.body?.newGroupName || '').trim();
    if (newName) {
      const ex = idx.groups.find(g => String(g.name).trim() === newName);
      if (ex) gid = Number(ex.id);
      else { const g = { id: nextId(idx.groups), name: newName, parentId: null }; idx.groups.push(g); gid = g.id; }
    }
    if (gid == null && req.body?.groupId != null && idx.groups.some(g => Number(g.id) === Number(req.body.groupId))) gid = Number(req.body.groupId);
    if (gid == null && idx.groups.some(g => Number(g.id) === Number(entry.groupId))) gid = Number(entry.groupId);
    if (gid == null && entry.groupName) gid = Number(idx.groups.find(g => String(g.name).trim() === String(entry.groupName).trim())?.id) || null;
    if (gid == null) {
      if (!idx.groups.length) idx.groups.push({ id: 1, name: 'Ümumi', parentId: null });
      gid = Number(idx.groups[0].id);
    }
    const { groupName, archivedAt, note, ...meta } = entry;
    idx.pdfs = [...idx.pdfs.filter(p => Number(p.id) !== id), { ...meta, groupId: gid }];
    archive.items = archive.items.filter(a => Number(a.id) !== id);
    await writeIndex(idx, `Restore pdf ${id} from archive`, req.user);
    await writeArchive(archive, `Unarchive pdf ${id}`, req.user);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* =========================== STATUS =========================== */
const ALLOWED_STATUS = ['progress', 'prep', 'notdone', 'sign', 'done', 'cancelled', 'renew'];

// Set (or clear) a template's status. body: { status: '...'|null }
router.put('/:id/status', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const raw = req.body?.status;
    const status = raw == null || raw === '' ? null : String(raw);
    if (status !== null && !ALLOWED_STATUS.includes(status)) {
      return res.status(400).json({ error: 'Yanlış status' });
    }
    const idx = await readIndex();
    const entry = idx.pdfs.find(p => Number(p.id) === id);
    if (!entry) return res.status(404).json({ error: 'Template not found' });
    if (status === null) delete entry.status; else entry.status = status;
    await writeIndex(idx, `Set status for template ${id}`, req.user);
    res.json({ id, status });
  } catch (e) { next(e); }
});

/* =========================== PDF FILE STREAM =========================== */
router.get('/:id/file', async (req, res, next) => {
  try {
    const id = req.params.id;
    const idx = await readIndex();
    let meta = (idx.pdfs || []).find(p => Number(p.id) === Number(id));
    if (!meta) {
      // archived PDFs can still be viewed/downloaded
      const archive = await readArchive();
      meta = archive.items.find(a => Number(a.id) === Number(id));
    }
    if (!meta) return res.status(404).json({ error: 'PDF not found' });

    const ext = extOf(meta.filename) || 'pdf';
    let bin = await getBinary(pdfFilePathFiles(id, ext));
    if (!bin) bin = await getBinary(pdfFilePathLegacy(id));
    if (!bin) bin = await getBinary(pdfFilePathLegacy2(id));
    if (!bin) return res.status(404).json({ error: 'PDF file missing' });

    res.setHeader('Content-Type', MIME_BY_EXT[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(meta.filename || `pdf-${id}.pdf`)}"`);
    res.setHeader('Content-Length', bin.length);
    res.send(bin);
  } catch (e) { next(e); }
});

/* =========================== PDF CRUD =========================== */
// Create — MUST belong to a group
router.post('/', requireAdmin, blockUploadOnVercel, async (req, res, next) => {
  try {
    const { title, subtitle, filename, dataBase64, groupId } = req.body || {};
    if (!title || !dataBase64) {
      return res.status(400).json({ error: 'title and dataBase64 are required' });
    }
    const idx = await readIndex();
    const gid = Number(groupId);
    if (!gid || !idx.groups.some(g => Number(g.id) === gid)) {
      return res.status(400).json({ error: 'PDF bir qrupa aid olmalidir' });
    }

    const newId = nextId([...idx.pdfs, ...(await readArchive()).items, ...(await homeDeletedIds('templates')).map(id => ({ id }))]); // never reuse an old id
    const buf = Buffer.from(dataBase64, 'base64');
    const uploadError = validateUpload(filename, buf);
    if (uploadError) return res.status(400).json({ error: uploadError });
    await putBinary(pdfFilePathFiles(newId, extOf(filename)), buf, attribution(req.user, `Add pdf ${newId}`));

    const entry = {
      id: newId,
      title: String(title),
      subtitle: subtitle ? String(subtitle) : '',
      filename: filename || `pdf-${newId}.pdf`,
      size: buf.length,
      groupId: gid,
      uploadedAt: new Date().toISOString()
    };
    idx.pdfs = [...idx.pdfs, entry];
    await writeIndex(idx, `Add pdf ${newId} to index`, req.user);
    if (req.body?.sheetId != null) await linkRowToItem('templates', req.body.sheetId, newId).catch(() => {});
    else await autoLinkNewItem('templates', newId, entry.title, idx.groups.find(g => Number(g.id) === gid)?.name || '').catch(() => {});
    res.status(201).json(entry);
  } catch (e) { next(e); }
});

router.put('/:id', requireAdmin, blockUploadOnVercel, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { title, subtitle, filename, dataBase64, groupId } = req.body || {};
    const idx = await readIndex();
    const i = idx.pdfs.findIndex(p => Number(p.id) === id);
    if (i < 0) return res.status(404).json({ error: 'PDF not found' });

    const updated = { ...idx.pdfs[i] };
    if (typeof title === 'string') updated.title = title;
    if (typeof subtitle === 'string') updated.subtitle = subtitle;
    if (typeof filename === 'string' && filename.trim()) {
      if (dataBase64) updated.filename = filename;
      else {
        // rename only (no new file): keep the stored file's extension
        const oldExt = extOf(idx.pdfs[i].filename);
        const base = filename.trim().replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim();
        if (base) updated.filename = oldExt ? `${base}.${oldExt}` : base;
      }
    }
    if (groupId !== undefined) {
      const gid = Number(groupId);
      if (idx.groups.some(g => Number(g.id) === gid)) updated.groupId = gid;
    }
    if (dataBase64) {
      const buf = Buffer.from(dataBase64, 'base64');
      const uploadError = validateUpload(filename, buf);
      if (uploadError) return res.status(400).json({ error: uploadError });
      const oldExt = extOf(idx.pdfs[i].filename);
      const newExt = extOf(filename) || oldExt;
      await putBinary(pdfFilePathFiles(id, newExt), buf, attribution(req.user, `Replace pdf ${id}`));
      if (newExt !== oldExt) await deleteBinary(pdfFilePathFiles(id, oldExt)).catch(() => {});
      updated.size = buf.length;
      updated.uploadedAt = new Date().toISOString();
    }
    idx.pdfs[i] = updated;
    await writeIndex(idx, `Update pdf ${id}`, req.user);
    res.json(updated);
  } catch (e) { next(e); }
});

// No hard delete: the entry leaves the list/archive, a copy goes to
// home-deleted.json, and the uploaded file stays in data/ + Mongo.
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const idx = await readIndex();
    const archive = await readArchive();
    const inIdx = (idx.pdfs || []).find(p => Number(p.id) === id);
    const inArch = archive.items.find(a => Number(a.id) === id);
    const entry = inIdx
      ? { ...inIdx, groupName: idx.groups.find(g => Number(g.id) === Number(inIdx.groupId))?.name || '' }
      : inArch;
    if (!entry) return res.json({ ok: true, alreadyGone: true });
    await keepHomeDeleted('templates', [entry]);
    if (inIdx) { idx.pdfs = idx.pdfs.filter(p => Number(p.id) !== id); await writeIndex(idx, `Delete ${id}`, req.user); }
    if (inArch) { archive.items = archive.items.filter(a => Number(a.id) !== id); await writeArchive(archive, `Delete ${id}`, req.user); }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
