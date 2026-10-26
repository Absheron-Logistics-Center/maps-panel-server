import { Router } from 'express';
import {
  SHEET_KINDS,
  assertKind,
  readSheets,
  createSheetRow,
  updateSheetRow,
  deleteSheetRow,
  clearLinkedRows,
  clearAllRows,
  syncFromItem,
  backfillMissingFromIndex,
  deleteHomeGroupByName,
  ALLOWED_STATUS,
  ALLOWED_STATUS_BY_KIND,
  EXTRA_FIELDS
} from '../services/sheetsStore.js';

const router = Router();

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

function pickExtras(body) {
  const out = {};
  for (const f of EXTRA_FIELDS) {
    if (typeof body?.[f] === 'string') out[f] = body[f];
  }
  return out;
}

// ---- kind-scoped routes: /api/sheets/:kind/... ----

router.get('/:kind', async (req, res, next) => {
  // Avoid treating legacy paths as kinds — only known kinds
  if (!SHEET_KINDS[req.params.kind]) return next();
  try {
    // Any real item (diagram/pdf/template) that doesn't have a sheet row
    // yet gets one added automatically here — e.g. a folder with 5 real
    // workflows shouldn't sit there invisible just because nobody has
    // manually retyped them into the sheet. Once every item has a row this
    // is a no-op (no write) on every subsequent load. Hand-typed rows and
    // ones an admin has already deleted are never touched or recreated.
    const sheets = await backfillMissingFromIndex(req.params.kind, req.user);
    res.json({ kind: req.params.kind, items: sheets.items || [] });
  } catch (e) { next(e); }
});

router.post('/:kind', requireAdmin, async (req, res, next) => {
  if (!SHEET_KINDS[req.params.kind]) return next();
  try {
    const item = await createSheetRow(req.params.kind, {
      title: req.body?.title,
      subtitle: req.body?.subtitle,
      status: req.body?.status,
      strukturAdi: req.body?.strukturAdi,
      order: req.body?.order,
      ...pickExtras(req.body)
    }, req.user);
    res.status(201).json(item);
  } catch (e) { next(e); }
});

router.post('/:kind/sync', requireAdmin, async (req, res, next) => {
  if (!SHEET_KINDS[req.params.kind]) return next();
  try {
    const { itemId, processId, title, subtitle, status, sheetId, strukturAdi } = req.body || {};
    const id = itemId != null ? itemId : processId;
    if (id == null) return res.status(400).json({ error: 'itemId teleb olunur' });
    const allowed = ALLOWED_STATUS_BY_KIND[req.params.kind] || ALLOWED_STATUS;
    if (status != null && status !== '' && !allowed.includes(String(status))) {
      return res.status(400).json({ error: 'Yanlış status' });
    }
    const row = await syncFromItem(req.params.kind, {
      itemId: id, title, subtitle, status, sheetId, strukturAdi
    }, req.user);
    res.json(row);
  } catch (e) { next(e); }
});

// Bulk-remove rows that were auto-populated from diagrams/pdfs/templates
// (itemId set) — leaves hand-typed blank rows untouched.
router.delete('/:kind/linked', requireAdmin, async (req, res, next) => {
  if (!SHEET_KINDS[req.params.kind]) return next();
  try {
    const result = await clearLinkedRows(req.params.kind, req.user);
    res.json(result);
  } catch (e) { next(e); }
});

// Wipe every row in this Sheets catalog.
router.delete('/:kind/all', requireAdmin, async (req, res, next) => {
  if (!SHEET_KINDS[req.params.kind]) return next();
  try {
    const result = await clearAllRows(req.params.kind, req.user);
    res.json(result);
  } catch (e) { next(e); }
});

router.put('/:kind/:id', requireAdmin, async (req, res, next) => {
  if (!SHEET_KINDS[req.params.kind]) return next();
  try {
    const row = await updateSheetRow(req.params.kind, req.params.id, req.body || {}, req.user);
    res.json(row);
  } catch (e) { next(e); }
});

// Delete the Home group represented by a folder-only Sheets row.
router.delete('/:kind/group', requireAdmin, async (req, res, next) => {
  if (!SHEET_KINDS[req.params.kind]) return next();
  try {
    const name = String(req.body?.name || req.query?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Qrup adı tələb olunur' });
    res.json(await deleteHomeGroupByName(req.params.kind, name, req.user));
  } catch (e) { next(e); }
});

router.delete('/:kind/:id', requireAdmin, async (req, res, next) => {
  if (!SHEET_KINDS[req.params.kind]) return next();
  try {
    res.json(await deleteSheetRow(req.params.kind, req.params.id, req.user));
  } catch (e) { next(e); }
});

// ---- backward-compat: /api/sheets → diagrams ----

router.get('/', async (req, res, next) => {
  try {
    const sheets = await backfillMissingFromIndex('diagrams', req.user);
    res.json({ kind: 'diagrams', items: sheets.items || [] });
  } catch (e) { next(e); }
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const item = await createSheetRow('diagrams', {
      title: req.body?.title,
      subtitle: req.body?.subtitle,
      status: req.body?.status,
      strukturAdi: req.body?.strukturAdi
    }, req.user);
    res.status(201).json(item);
  } catch (e) { next(e); }
});

router.post('/sync-from-process', requireAdmin, async (req, res, next) => {
  try {
    const { processId, title, subtitle, status, sheetId } = req.body || {};
    if (processId == null) return res.status(400).json({ error: 'processId teleb olunur' });
    if (status != null && status !== '' && !ALLOWED_STATUS.includes(String(status))) {
      return res.status(400).json({ error: 'Yanlış status' });
    }
    const row = await syncFromItem('diagrams', {
      itemId: processId, title, subtitle, status, sheetId
    }, req.user);
    res.json(row);
  } catch (e) { next(e); }
});

router.put('/:id', requireAdmin, async (req, res, next) => {
  // numeric id only — skip if this was a kind name somehow
  if (SHEET_KINDS[req.params.id]) return next();
  try {
    const row = await updateSheetRow('diagrams', req.params.id, req.body || {}, req.user);
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  if (SHEET_KINDS[req.params.id]) return next();
  try {
    res.json(await deleteSheetRow('diagrams', req.params.id, req.user));
  } catch (e) { next(e); }
});

export default router;
