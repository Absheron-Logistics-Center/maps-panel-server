import { Router } from 'express';
import {
  SHEET_KINDS, readSheets, createSheetRow, updateSheetRow, archiveSheetRow,
  listSheetArchive, restoreSheetRow, linkInfo, setLink, applyLink, archiveAllRows, deleteAllRows, deleteSheetRow, deleteArchivedRow, unlinkAllRows, linkAllRows, linkCandidates, createSheetRows
} from '../services/sheetsStore.js';

/*
  Hesabat API — /api/sheets/:kind/…   (kind = diagrams | pdfs | templates | jobs)

  GET    /:kind                    rows (always numbered 1..n)
  POST   /:kind                    new row
  POST   /:kind/bulk               { rows: [...] } many new rows at once (Excel import)
  PUT    /:kind/:id                edit a row
  POST   /:kind/:id/archive        move row to the Hesabat archive
  DELETE /:kind/:id                trash: off the page, kept in hesabat-deleted.json
  GET    /:kind/archive            archived rows
  POST   /:kind/all/archive        whole table -> archive
  DELETE /:kind/all                whole table -> hesabat-deleted.json
  POST   /:kind/archive/:id/restore
  DELETE /:kind/archive/:id        delete from the archive (kept in hesabat-deleted.json)
  GET    /:kind/all/link           rows that can be linked by name (+ folder)
  POST   /:kind/all/link           { ids? }  link all / only the chosen rows
  POST   /:kind/all/unlink         remove every link (rows and Home untouched)
  GET    /:kind/:id/link           linked Home item + differences
  PUT    /:kind/:id/link           { itemId | null }  link / unlink
  POST   /:kind/:id/link/apply     { choices: { field: 'home' | 'hesabat' } }
*/
const router = Router();

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}
const kindOk = (req, _res, next) => (SHEET_KINDS[req.params.kind] ? next() : next('route'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((r) => res.json(r)).catch(next);

router.get('/:kind', kindOk, wrap(async (req) => ({ kind: req.params.kind, items: (await readSheets(req.params.kind)).items })));
router.get('/:kind/archive', kindOk, wrap(async (req) => ({ kind: req.params.kind, items: await listSheetArchive(req.params.kind) })));

router.post('/:kind', kindOk, requireAdmin, async (req, res, next) => {
  try { res.status(201).json(await createSheetRow(req.params.kind, req.body || {})); } catch (e) { next(e); }
});
router.post('/:kind/bulk', kindOk, requireAdmin, wrap((req) => createSheetRows(req.params.kind, req.body?.rows || [])));
router.post('/:kind/all/archive', kindOk, requireAdmin, wrap((req) => archiveAllRows(req.params.kind)));
router.delete('/:kind/all', kindOk, requireAdmin, wrap((req) => deleteAllRows(req.params.kind)));
router.get('/:kind/all/link', kindOk, wrap((req) => linkCandidates(req.params.kind)));
router.post('/:kind/all/link', kindOk, requireAdmin, wrap((req) => linkAllRows(req.params.kind, req.body?.ids)));
router.post('/:kind/all/unlink', kindOk, requireAdmin, wrap((req) => unlinkAllRows(req.params.kind)));
router.delete('/:kind/archive/:id', kindOk, requireAdmin, wrap((req) => deleteArchivedRow(req.params.kind, req.params.id)));
router.post('/:kind/archive/:id/restore', kindOk, requireAdmin, wrap((req) => restoreSheetRow(req.params.kind, req.params.id)));

router.get('/:kind/:id/link', kindOk, wrap((req) => linkInfo(req.params.kind, req.params.id)));
router.put('/:kind/:id/link', kindOk, requireAdmin, wrap((req) => setLink(req.params.kind, req.params.id, req.body?.itemId ?? null)));
router.post('/:kind/:id/link/apply', kindOk, requireAdmin, wrap((req) => applyLink(req.params.kind, req.params.id, req.body?.choices || {})));

router.post('/:kind/:id/archive', kindOk, requireAdmin, wrap((req) => archiveSheetRow(req.params.kind, req.params.id)));
router.put('/:kind/:id', kindOk, requireAdmin, wrap((req) => updateSheetRow(req.params.kind, req.params.id, req.body || {})));
router.delete('/:kind/:id', kindOk, requireAdmin, wrap((req) => deleteSheetRow(req.params.kind, req.params.id)));

export default router;
