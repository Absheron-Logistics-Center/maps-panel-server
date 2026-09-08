/*
  Per-section Sheets catalogs (Mongo via store.js — never GitHub).

  Kinds:
    diagrams  → data/diagrams/sheets.json   (İş Axışları)
    pdfs      → data/files/sheets.json      (Normativ Sənədlər)
    templates → data/templates/sheets.json  (Şablonlar)

  Sync with the section's own catalog (diagrams / pdfs / templates) is
  deliberately one-way for *creation* — only manual, chevron-driven linking
  creates the other side:
    - item → sheet: syncFromItem() upserts the sheet row whenever an item's
      title/subtitle/status/struktur changes (called from processes.js /
      pdfs.js / templates.js). Creating a diagram/pdf/template in Home
      always keeps its hesabat row in step.
    - sheet → item: syncRowToTarget() runs whenever a sheet row is created
      or edited (routes/sheets.js). It matches an existing item by the
      triple (title + strukturAdi + subtitle/nömrə) or an explicit link,
      and only pushes a status change across — it never auto-creates a new
      diagram/pdf/template just because someone typed a row into hesabat.
      A hesabat-only row becomes a real item only when a user in
      Home/Sənədlər/Şablonlar explicitly picks it via the "Sheets-dən seç"
      chevron.
    - deleting a hesabat row (deleteSheetRow) also removes its linked item
      from the section's own list via deleteLinkedItem() — the two stay in
      sync in both directions for deletes, even though creates are one-way.
*/

import { getFile as mongoGet, putFile as mongoPut, deleteFile as mongoDelete, attribution } from './store.js';
import {
  getFile as githubGet, putFile as githubPut,
  deleteBinaryQueued as githubDeleteBinary
} from './github.js';

const dataPath = () => (process.env.DATA_PATH || 'data').replace(/^\/|\/$/g, '');

// Status sets differ per kind — İş Axışları dropped "sign" and gained an
// explicit terminal "cancelled"; Normativ Sənədlər / Şablonlar additionally
// have "prep" and "renew". Keep in sync with frontend Status.jsx.
export const ALLOWED_STATUS_BY_KIND = {
  diagrams: ['progress', 'prep', 'notdone', 'done', 'cancelled'],
  pdfs: ['progress', 'prep', 'notdone', 'sign', 'done', 'cancelled', 'renew'],
  templates: ['progress', 'prep', 'notdone', 'sign', 'done', 'cancelled', 'renew']
};
// Back-compat flat list (used by a couple of older call sites / legacy routes).
export const ALLOWED_STATUS = ['progress', 'prep', 'notdone', 'sign', 'done', 'cancelled', 'renew'];

// Extra hand-typed fields shown only for the pdfs / templates sheets
// (Normativ Sənədlər / Şablonlar): sənədin növü, nəşr, təsdiq tarixi,
// qərar/protokol, səhifə sayı.
export const EXTRA_FIELDS = ['docType', 'edition', 'approvalDate', 'protocol', 'pageCount'];
// (kept as a single flat list — SheetsPage.jsx decides per-kind order/labels)

export const SHEET_KINDS = {
  diagrams: {
    sheetsRel: 'diagrams/sheets.json',
    indexRel: 'diagrams/index.json',
    indexKey: 'processes',
    indexVia: 'mongo',
    label: 'diagrams'
  },
  pdfs: {
    sheetsRel: 'files/sheets.json',
    indexRel: 'files/index.json',
    indexKey: 'pdfs',
    indexVia: 'github',
    label: 'pdfs'
  },
  templates: {
    sheetsRel: 'templates/sheets.json',
    indexRel: 'templates/index.json',
    // templates index reuses the same shape as pdfs ({ groups, pdfs })
    indexKey: 'pdfs',
    indexVia: 'github',
    label: 'templates'
  }
};

// Sheets ↔ section sync is ON in both directions — see file header.
const AUTO_SYNC_ENABLED = true;

export function assertKind(kind) {
  if (!SHEET_KINDS[kind]) {
    const err = new Error('Yanlış sheets kind');
    err.status = 400;
    throw err;
  }
  return SHEET_KINDS[kind];
}

function sheetsPath(kind) {
  return `${dataPath()}/${assertKind(kind).sheetsRel}`;
}
function indexPath(kind) {
  return `${dataPath()}/${assertKind(kind).indexRel}`;
}
function processBodyPath(id) {
  return `${dataPath()}/diagrams/processes/process-${id}.json`;
}
// Section (Home / Sənədlər / Şablonlar) archive.json lives next to that
// section's own index.json — same folder either way.
function archivePath(kind) {
  const rel = kind === 'templates' ? 'templates' : (kind === 'diagrams' ? 'diagrams' : 'files');
  return `${dataPath()}/${rel}/archive.json`;
}
// pdfs/templates binary files can live under a couple of legacy paths —
// mirrors pdfFilePathFiles/Legacy/Legacy2 in routes/pdfs.js & templates.js.
function pdfBinaryPaths(kind, id, ext) {
  const rel = kind === 'templates' ? 'templates' : 'files';
  return [
    `${dataPath()}/${rel}/pdf/pdf-${id}.${ext || 'pdf'}`,
    `${dataPath()}/pdfs/files/pdf-${id}.pdf`,
    `${dataPath()}/files/files/pdf-${id}.pdf`
  ];
}
function extOf(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

function nextId(list) {
  const ids = (list || []).map(x => Number(x.id)).filter(Number.isFinite);
  return ids.length ? Math.max(...ids) + 1 : 1;
}

export function normalizeStatus(kind, raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  const allowed = ALLOWED_STATUS_BY_KIND[kind] || ALLOWED_STATUS;
  return allowed.includes(s) ? s : null;
}

/** Normalize legacy processId → itemId */
function normalizeRow(row) {
  if (!row || typeof row !== 'object') return row;
  const itemId = row.itemId != null
    ? row.itemId
    : (row.processId != null ? row.processId : null);
  const extras = {};
  for (const f of EXTRA_FIELDS) extras[f] = typeof row[f] === 'string' ? row[f] : (row[f] || '');
  const order = Number.isFinite(Number(row.order)) ? Number(row.order) : null;
  return { ...row, ...extras, itemId, processId: itemId, order };
}

export async function readSheets(kind) {
  assertKind(kind);
  const file = await mongoGet(sheetsPath(kind));
  const c = file ? file.content : null;
  let items = (c && Array.isArray(c.items)) ? c.items.map(normalizeRow) : [];
  // itemIds an admin explicitly deleted the (auto-synced) sheet row for —
  // backfillMissingFromIndex() must never recreate these, or "delete" would
  // just silently undo itself on the next page load.
  const deletedItemIds = (c && Array.isArray(c.deletedItemIds))
    ? c.deletedItemIds.map(Number).filter(Number.isFinite)
    : [];

  // Migration: rows created before the `order` field existed don't have a
  // stable position — backfill using their stored (creation) order once,
  // so old rows keep their spot instead of colliding with new order numbers.
  if (items.some(x => x.order == null)) {
    items = items.map((x, i) => (x.order == null ? { ...x, order: i + 1 } : x));
    await writeSheets(kind, { items, deletedItemIds }, `Backfill order for ${kind} sheets`, null);
  }

  items.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  return { items, deletedItemIds };
}

export async function writeSheets(kind, content, message, user) {
  assertKind(kind);
  return mongoPut(sheetsPath(kind), content, attribution(user, message));
}

async function readIndexFile(kind) {
  const meta = assertKind(kind);
  const p = indexPath(kind);
  if (meta.indexVia === 'github') return githubGet(p);
  return mongoGet(p);
}

async function writeIndexFile(kind, content, message, user) {
  const meta = assertKind(kind);
  const p = indexPath(kind);
  if (meta.indexVia === 'github') return githubPut(p, content, attribution(user, message));
  return mongoPut(p, content, attribution(user, message));
}

/** One-time seed from the section index when sheets is empty. */
export async function backfillFromIndex(kind, user) {
  const meta = assertKind(kind);
  let sheets = await readSheets(kind);

  const idxFile = await readIndexFile(kind);
  const content = idxFile?.content || {};
  const list = Array.isArray(content[meta.indexKey]) ? content[meta.indexKey] : [];
  const groups = Array.isArray(content.groups) ? content.groups : [];

  function strukturFor(entry) {
    const g = groups.find(x => Number(x.id) === Number(entry?.groupId));
    return g?.name ? String(g.name) : '';
  }

  if (!sheets.items.length && list.length) {
    const now = new Date().toISOString();
    sheets.items = list.map((p, i) => {
      const id = Number(p.id);
      return {
        id: i + 1,
        order: i + 1,
        title: String(p.title || ''),
        subtitle: String(p.subtitle || ''),
        strukturAdi: strukturFor(p),
        status: normalizeStatus(kind, p.status),
        date: now,
        itemId: id,
        processId: id
      };
    });
    await writeSheets(kind, sheets, `Backfill ${kind} sheets from index`, user);
    return sheets;
  }

  // Repair: fill missing strukturAdi from group name for linked rows
  let changed = false;
  for (const row of sheets.items) {
    if ((row.strukturAdi || '').trim()) continue;
    const iid = row.itemId ?? row.processId;
    if (iid == null) continue;
    const entry = list.find(p => Number(p.id) === Number(iid));
    const name = strukturFor(entry || {});
    if (name) {
      row.strukturAdi = name;
      changed = true;
    }
  }
  if (changed) {
    await writeSheets(kind, sheets, `Fill strukturAdi on ${kind} sheets`, user);
  }
  return sheets;
}

/**
 * Fill in any item from the section index (diagrams/pdfs/templates) that
 * doesn't have a linked sheet row yet — e.g. the 5 real workflows inside a
 * folder that only had a couple of hand-typed sheet rows. Unlike
 * backfillFromIndex() above (one-time seed of a *completely empty* sheet),
 * this tops up an existing sheet incrementally and is safe to call on every
 * GET: it's a no-op (no write) once every item already has a row.
 */
export async function backfillMissingFromIndex(kind, user) {
  const meta = assertKind(kind);
  const sheets = await readSheets(kind);

  const idxFile = await readIndexFile(kind);
  const content = idxFile?.content || {};
  const list = Array.isArray(content[meta.indexKey]) ? content[meta.indexKey] : [];
  const groups = Array.isArray(content.groups) ? content.groups : [];
  if (!list.length) return sheets;

  const linkedIds = new Set(
    sheets.items
      .map(x => (x.itemId != null ? x.itemId : x.processId))
      .filter(v => v != null)
      .map(Number)
  );
  const deletedIds = new Set(sheets.deletedItemIds || []);
  const missing = list.filter(p => !linkedIds.has(Number(p.id)) && !deletedIds.has(Number(p.id)));
  if (!missing.length) return sheets;

  function strukturFor(entry) {
    const g = groups.find(x => Number(x.id) === Number(entry?.groupId));
    return g?.name ? String(g.name) : '';
  }

  let order = sheets.items.reduce((m, x) => Math.max(m, Number(x.order) || 0), 0);
  let id = nextId(sheets.items);
  const now = new Date().toISOString();
  const added = missing.map((p) => {
    order += 1;
    const row = {
      id: id++,
      order,
      title: String(p.title || ''),
      subtitle: String(p.subtitle || ''),
      strukturAdi: strukturFor(p),
      status: normalizeStatus(kind, p.status),
      date: now,
      itemId: Number(p.id),
      processId: Number(p.id)
    };
    if (row.status == null) delete row.status;
    return row;
  });

  sheets.items = [...sheets.items, ...added];
  await writeSheets(kind, sheets, `Backfill ${added.length} missing ${kind} sheet row(s) from index`, user);
  return sheets;
}

/**
 * Upsert a sheet row from a section item (diagram / pdf / template).
 * Item → Sheet direction.
 */
export async function syncFromItem(kind, { itemId, title, subtitle, status, sheetId, strukturAdi }, user) {
  assertKind(kind);
  if (!AUTO_SYNC_ENABLED) return null;
  const iid = Number(itemId);
  if (!Number.isFinite(iid)) return null;

  const sheets = await readSheets(kind);
  const now = new Date().toISOString();
  const st = status === undefined ? undefined : normalizeStatus(kind, status);
  const struktur = strukturAdi != null ? String(strukturAdi) : undefined;

  let row = null;
  if (sheetId != null && Number.isFinite(Number(sheetId))) {
    row = sheets.items.find(x => Number(x.id) === Number(sheetId)) || null;
  }
  if (!row) {
    row = sheets.items.find(x => Number(x.itemId ?? x.processId) === iid) || null;
  }

  if (row) {
    if (typeof title === 'string') row.title = title;
    if (typeof subtitle === 'string') row.subtitle = subtitle;
    if (st !== undefined) {
      if (st === null) delete row.status;
      else row.status = st;
    }
    // Keep existing custom struktur; only fill when blank
    if (struktur !== undefined && !(row.strukturAdi || '').trim()) {
      row.strukturAdi = struktur;
    }
    row.itemId = iid;
    row.processId = iid;
    await writeSheets(kind, sheets, `Sync ${kind} sheet ${row.id} from item ${iid}`, user);
    return normalizeRow(row);
  }

  const item = {
    id: nextId(sheets.items),
    title: typeof title === 'string' ? title : '',
    subtitle: typeof subtitle === 'string' ? subtitle : '',
    strukturAdi: struktur || '',
    status: st === undefined ? null : st,
    date: now,
    itemId: iid,
    processId: iid
  };
  if (item.status == null) delete item.status;
  sheets.items = [...sheets.items, item];
  await writeSheets(kind, sheets, `Add ${kind} sheet for item ${iid}`, user);
  return normalizeRow(item);
}

/** @deprecated use syncFromItem('diagrams', …) */
export async function syncFromProcess(opts, user) {
  return syncFromItem('diagrams', {
    itemId: opts.processId,
    title: opts.title,
    subtitle: opts.subtitle,
    status: opts.status,
    sheetId: opts.sheetId,
    strukturAdi: opts.strukturAdi
  }, user);
}

/** @deprecated use backfillFromIndex('diagrams', …) */
export async function backfillFromProcesses(user) {
  return backfillFromIndex('diagrams', user);
}

/* ============================================================
   Sheet → Item sync (the reverse direction)
   ============================================================ */

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

function groupNameOf(entry, groups) {
  const g = groups.find(x => Number(x.id) === Number(entry?.groupId));
  return g?.name ? String(g.name) : '';
}

/**
 * Called whenever a Sheets row (diagrams / pdfs / templates) is created or
 * edited. Matches an existing item by (title + strukturAdi + subtitle) —
 * or by an explicit link (itemId/processId) — and pushes a status change
 * across when matched. Deliberately does NOT create a new diagram/pdf/
 * template when nothing matches: typing a fresh row straight into Sheets
 * (hesabat) must stay a plain row. A real item only gets linked to it when
 * someone in Home/Sənədlər/Şablonlar explicitly picks that row via the
 * "Sheets-dən seç" chevron (or creates one with that sheetId) — manual,
 * never automatic.
 *
 * Returns { itemId, created: false, status } when an existing item was
 * matched/updated, or null when nothing matched, the row is blank, or sync
 * is disabled.
 */
export async function syncRowToTarget(kind, row, user) {
  assertKind(kind);
  if (!AUTO_SYNC_ENABLED) return null;
  const title = (row.title || '').trim();
  const strukturAdi = (row.strukturAdi || '').trim();
  const subtitle = (row.subtitle || '').trim();
  if (!title) return null; // nothing worth syncing for a blank row

  const meta = SHEET_KINDS[kind];
  const idxFile = await readIndexFile(kind);
  const idx = (idxFile && idxFile.content && typeof idxFile.content === 'object') ? idxFile.content : {};
  const list = Array.isArray(idx[meta.indexKey]) ? idx[meta.indexKey] : [];
  const groups = Array.isArray(idx.groups) ? idx.groups : [];
  idx[meta.indexKey] = list;
  idx.groups = groups;

  const targetStatus = normalizeStatus(kind, row.status);

  // 1) Already linked to an item? Prefer that — never re-match by text once linked.
  let entry = null;
  const linkedId = row.itemId ?? row.processId;
  if (linkedId != null) {
    entry = list.find(p => Number(p.id) === Number(linkedId)) || null;
  }
  // 2) Otherwise match by the triple: name + struktur adı + nömrə.
  if (!entry) {
    entry = list.find(p =>
      norm(p.title) === norm(title) &&
      norm(groupNameOf(p, groups)) === norm(strukturAdi) &&
      norm(p.subtitle) === norm(subtitle)
    ) || null;
  }

  if (entry) {
    let changed = false;
    if (targetStatus !== (entry.status ?? null)) {
      if (targetStatus === null) delete entry.status; else entry.status = targetStatus;
      changed = true;
    }
    if (changed) {
      await writeIndexFile(kind, idx, `Sync ${kind} item ${entry.id} status from sheet`, user);
    }
    return { itemId: Number(entry.id), created: false, status: entry.status ?? null };
  }

  // Nothing matched — leave it as a plain hesabat row. No auto-create.
  return null;
}

export async function createSheetRow(kind, { title, subtitle, status, strukturAdi, order, ...rest }, user) {
  assertKind(kind);
  // Empty title allowed — plus button must work even when fields are blank.
  const name = title != null ? String(title).trim() : '';
  const sheets = await readSheets(kind);
  // `order` is the row's fixed visual position (the blank slot it was typed
  // into). Rows keep this position forever — filling row 5 while rows 2/3
  // stay empty must never bump row 5 up to fill the gap. Falls back to
  // appending after the highest known position when not provided.
  const maxOrder = sheets.items.reduce((m, x) => Math.max(m, Number(x.order) || 0), 0);
  const ord = Number.isFinite(Number(order)) && Number(order) > 0 ? Number(order) : maxOrder + 1;
  const item = {
    id: nextId(sheets.items),
    order: ord,
    title: name,
    subtitle: subtitle != null ? String(subtitle) : '',
    strukturAdi: strukturAdi != null ? String(strukturAdi).trim() : '',
    status: normalizeStatus(kind, status),
    date: new Date().toISOString(),
    itemId: null,
    processId: null
  };
  for (const f of EXTRA_FIELDS) {
    if (typeof rest[f] === 'string') item[f] = rest[f];
  }
  if (item.status == null) delete item.status;

  // Sheet → item sync: match-or-create in the section's own list.
  try {
    const sync = await syncRowToTarget(kind, item, user);
    if (sync?.itemId != null) {
      item.itemId = sync.itemId;
      item.processId = sync.itemId;
      if (sync.created && sync.status && item.status == null) item.status = sync.status;
    }
  } catch (e) { console.error(`[sheets->${kind} sync create]`, e.message); }

  sheets.items = [...sheets.items, item];
  await writeSheets(kind, sheets, `Create ${kind} sheet row ${item.id}`, user);
  return normalizeRow(item);
}

export async function updateSheetRow(kind, id, patch, user) {
  assertKind(kind);
  const sheets = await readSheets(kind);
  const row = sheets.items.find(x => Number(x.id) === Number(id));
  if (!row) {
    const err = new Error('Sheet row not found');
    err.status = 404;
    throw err;
  }
  if (typeof patch.title === 'string') row.title = patch.title; // allow empty
  if (typeof patch.subtitle === 'string') row.subtitle = patch.subtitle;
  if (typeof patch.strukturAdi === 'string') row.strukturAdi = patch.strukturAdi;
  if (patch.order !== undefined && Number.isFinite(Number(patch.order))) row.order = Number(patch.order);
  for (const f of EXTRA_FIELDS) {
    if (typeof patch[f] === 'string') row[f] = patch[f];
  }
  if (patch.status !== undefined) {
    const st = normalizeStatus(kind, patch.status);
    if (st === null) delete row.status;
    else row.status = st;
  }
  if (patch.itemId !== undefined || patch.processId !== undefined) {
    const raw = patch.itemId !== undefined ? patch.itemId : patch.processId;
    const v = raw == null || raw === '' ? null : Number(raw);
    row.itemId = v;
    row.processId = v;
  }

  // Sheet → item sync: title/strukturAdi/subtitle/status edits all flow
  // through here — match-or-create, then push the status across.
  try {
    const sync = await syncRowToTarget(kind, row, user);
    if (sync?.itemId != null) {
      row.itemId = sync.itemId;
      row.processId = sync.itemId;
    }
  } catch (e) { console.error(`[sheets->${kind} sync update]`, e.message); }

  await writeSheets(kind, sheets, `Update ${kind} sheet row ${id}`, user);
  return normalizeRow(row);
}

/**
 * Remove the item (diagram / pdf / template) a sheet row was linked to —
 * called from deleteSheetRow() so that deleting a row in Sheets (hesabat)
 * also removes it from the section's own list (Home / Normativ Sənədlər /
 * Şablonlar) instead of leaving an orphaned entry sitting there. Best
 * effort: index removal is what actually matters for the UI; file/archive
 * cleanup is attempted but never allowed to fail the whole operation.
 */
export async function deleteLinkedItem(kind, itemId, user) {
  const meta = assertKind(kind);
  const id = Number(itemId);
  if (!Number.isFinite(id)) return { removed: false };

  const idxFile = await readIndexFile(kind);
  const idx = (idxFile && idxFile.content && typeof idxFile.content === 'object') ? idxFile.content : null;
  if (!idx) return { removed: false };
  const list = Array.isArray(idx[meta.indexKey]) ? idx[meta.indexKey] : [];
  const entry = list.find(p => Number(p.id) === id);
  if (!entry) return { removed: false };

  idx[meta.indexKey] = list.filter(p => Number(p.id) !== id);
  await writeIndexFile(kind, idx, `Remove ${kind} item ${id} (deleted from sheets)`, user);

  if (kind === 'diagrams') {
    await mongoDelete(processBodyPath(id)).catch(() => {});
  } else {
    for (const p of pdfBinaryPaths(kind, id, extOf(entry.filename))) {
      await githubDeleteBinary(p, attribution(user, `Remove ${kind} item ${id} file`)).catch(() => {});
    }
  }

  // also drop it from the archive, in case it was archived
  try {
    const arcPath = archivePath(kind);
    const arcFile = kind === 'diagrams' ? await mongoGet(arcPath) : await githubGet(arcPath);
    const arc = (arcFile && arcFile.content && Array.isArray(arcFile.content.items)) ? arcFile.content : null;
    if (arc && arc.items.some(a => Number(a.id) === id)) {
      arc.items = arc.items.filter(a => Number(a.id) !== id);
      const msg = `Remove ${kind} item ${id} from archive`;
      if (kind === 'diagrams') await mongoPut(arcPath, arc, attribution(user, msg));
      else await githubPut(arcPath, arc, attribution(user, msg));
    }
  } catch (e) { console.error(`[sheets delete -> ${kind} archive]`, e.message); }

  return { removed: true };
}

export async function deleteSheetRow(kind, id, user) {
  assertKind(kind);
  const sheets = await readSheets(kind);
  const before = sheets.items.length;
  const row = sheets.items.find(x => Number(x.id) === Number(id));
  const linkedItemId = row ? (row.itemId != null ? row.itemId : row.processId) : null;
  sheets.items = sheets.items.filter(x => Number(x.id) !== Number(id));
  if (sheets.items.length === before) {
    const err = new Error('Sheet row not found');
    err.status = 404;
    throw err;
  }
  // Remember this so the next auto-backfill doesn't silently bring the row
  // right back — an explicit delete needs to stay deleted.
  if (linkedItemId != null && !sheets.deletedItemIds.includes(Number(linkedItemId))) {
    sheets.deletedItemIds = [...sheets.deletedItemIds, Number(linkedItemId)];
  }
  await writeSheets(kind, sheets, `Delete ${kind} sheet row ${id}`, user);

  // A row linked to a real diagram/pdf/template must take that item down
  // with it — otherwise Home/Sənədlər/Şablonlar keeps showing something
  // that was just deleted from the report (hesabat).
  if (linkedItemId != null) {
    await deleteLinkedItem(kind, linkedItemId, user).catch((e) => {
      console.error(`[sheets delete -> ${kind} item]`, e.message);
    });
  }

  return { ok: true };
}

/**
 * Bulk-remove every row that was auto-populated from an item (itemId set) —
 * i.e. rows created by the old GET-time backfill or by the per-item auto-sync.
 * Hand-typed blank rows (itemId=null) are never touched.
 */
export async function clearLinkedRows(kind, user) {
  assertKind(kind);
  const sheets = await readSheets(kind);
  const before = sheets.items.length;
  sheets.items = sheets.items.filter(x => x.itemId == null && x.processId == null);
  const removed = before - sheets.items.length;
  if (removed > 0) {
    await writeSheets(kind, sheets, `Clear ${removed} auto-synced ${kind} sheet rows`, user);
  }
  return { removed, items: sheets.items };
}

/** Remove every sheet row for this kind (Sheets checklist wipe). */
export async function clearAllRows(kind, user) {
  assertKind(kind);
  const sheets = await readSheets(kind);
  const removed = sheets.items.length;
  if (removed === 0) return { removed: 0, items: [] };
  sheets.items = [];
  await writeSheets(kind, sheets, `Clear all ${removed} ${kind} sheet rows`, user);
  return { removed, items: [] };
}