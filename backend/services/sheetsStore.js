/*
  Hesabat (report table) for each section — data/<section>/hesabat.json.

  Hesabat and Home are SEPARATE lists. Nothing is copied between them
  automatically: creating, renaming, changing status, archiving or deleting on
  one side never touches the other.

  A row can optionally be LINKED to a Home item (`itemId`). The link only lets
  the admin open the item and compare the two: GET …/link shows where the
  name / number / struktur / status differ, and POST …/link/apply copies the
  value the admin picks (Hesabat -> Home, or Home -> Hesabat), field by field.

  Rows are never lost: "archive" moves a row to hesabat-archive.json (can be
  restored on the page), the trash icon moves it to hesabat-deleted.json (kept
  in Mongo + data/, not shown). Remaining rows are renumbered 1..n — no gaps.
*/
import { getFile, putFile } from './store.js';
import { autoLinkOn } from './flags.js';
import {
  SECTIONS, homePath, homeArchivePath, hesabatPath, hesabatArchivePath, hesabatDeletedPath, diagramPath
} from './paths.js';

export const ALLOWED_STATUS_BY_KIND = {
  diagrams: ['progress', 'prep', 'notdone', 'done', 'cancelled'],
  pdfs: ['progress', 'prep', 'notdone', 'sign', 'done', 'cancelled', 'renew'],
  templates: ['progress', 'prep', 'notdone', 'sign', 'done', 'cancelled', 'renew'],
  jobs: ['exists', 'missing']
};
export const ALLOWED_STATUS = ['progress', 'prep', 'notdone', 'sign', 'done', 'cancelled', 'renew', 'exists', 'missing'];
export const EXTRA_FIELDS = ['docType', 'edition', 'approvalDate', 'protocol', 'pageCount'];
// bolme = Struktur bölməsi (Vəzifə Təlimatları)
const TEXT_FIELDS = ['title', 'subtitle', 'strukturAdi', 'bolme', ...EXTRA_FIELDS];
export const SHEET_KINDS = SECTIONS;

// Fields a linked row can be compared on.
const LINK_FIELDS = ['title', 'subtitle', 'strukturAdi', 'status'];

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
export function assertKind(kind) {
  if (!SECTIONS[kind]) throw httpErr(400, 'Yanlış hesabat növü');
  return SECTIONS[kind];
}
export function normalizeStatus(kind, raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  return (ALLOWED_STATUS_BY_KIND[kind] || ALLOWED_STATUS).includes(s) ? s : null;
}
const nextId = (list) => list.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;
const str = (v) => (v == null ? '' : String(v));
const same = (a, b) => str(a).trim() === str(b).trim();

function cleanRow(r) {
  const { processId, ...rest } = r || {};
  const itemId = rest.itemId ?? processId ?? null;
  const out = { ...rest, itemId: itemId == null || itemId === '' ? null : Number(itemId) };
  for (const f of TEXT_FIELDS) out[f] = str(out[f]);
  if (!out.status) delete out.status;
  return out;
}

/* ---------------- read / write ---------------- */
export async function readSheets(kind) {
  assertKind(kind);
  const c = (await getFile(hesabatPath(kind)))?.content;
  const items = (Array.isArray(c?.items) ? c.items : []).filter(Boolean).map(cleanRow);
  items.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  // Positions are always 1..n — repair once if an older build left gaps.
  const gap = items.some((r, i) => Number(r.order) !== i + 1);
  if (gap) {
    items.forEach((r, i) => { r.order = i + 1; });
    await putFile(hesabatPath(kind), { items });
  }
  return { items };
}
async function writeSheets(kind, items) {
  items.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  items.forEach((r, i) => { r.order = i + 1; });
  await putFile(hesabatPath(kind), { items });
}
async function readArchive(kind) {
  const c = (await getFile(hesabatArchivePath(kind)))?.content;
  return (Array.isArray(c?.items) ? c.items : []).filter(Boolean).map(cleanRow);
}
async function writeArchive(kind, items) {
  await putFile(hesabatArchivePath(kind), { items });
}

/* ---------------- rows ---------------- */
export async function createSheetRow(kind, body) {
  const { items } = await readSheets(kind);
  const row = {
    id: nextId([...items, ...(await readArchive(kind)), ...(((await getFile(hesabatDeletedPath(kind)))?.content?.items) || [])]),
    order: items.length + 1,
    date: new Date().toISOString(),
    itemId: null
  };
  for (const f of TEXT_FIELDS) row[f] = str(body?.[f]).trim();
  const st = normalizeStatus(kind, body?.status);
  if (st) row.status = st;
  if (body?.itemId != null && body.itemId !== '') row.itemId = await validItemId(kind, body.itemId);
  // Optional: insert at a position (1-based) instead of the end.
  const at = Number(body?.order);
  if (Number.isFinite(at) && at >= 1 && at <= items.length) {
    items.forEach((r) => { if (r.order >= at) r.order += 1; });
    row.order = at;
  }
  items.push(row);
  await autoLinkRows(kind, [row]);
  await writeSheets(kind, items);
  return row;
}

// Many new rows in ONE write (Excel import) — appended at the end.
export async function createSheetRows(kind, bodies) {
  const { items } = await readSheets(kind);
  const archived = await readArchive(kind);
  const deleted = ((await getFile(hesabatDeletedPath(kind)))?.content?.items) || [];
  let id = nextId([...items, ...archived, ...deleted]);
  const now = new Date().toISOString();
  const created = [];
  for (const body of (Array.isArray(bodies) ? bodies : [])) {
    const row = { id: id++, order: items.length + 1, date: now, itemId: null };
    for (const f of TEXT_FIELDS) row[f] = str(body?.[f]).trim();
    const st = normalizeStatus(kind, body?.status);
    if (st) row.status = st;
    if (body?.itemId != null && body.itemId !== '') row.itemId = await validItemId(kind, body.itemId);
    items.push(row);
    created.push(row);
  }
  if (created.length) {
    await autoLinkRows(kind, created);
    await writeSheets(kind, items);
  }
  return { ok: true, created };
}

export async function updateSheetRow(kind, id, patch) {
  const { items } = await readSheets(kind);
  const row = items.find((x) => Number(x.id) === Number(id));
  if (!row) throw httpErr(404, 'Sətir tapılmadı');
  const before = { title: row.title, strukturAdi: row.strukturAdi, bolme: row.bolme };
  for (const f of TEXT_FIELDS) if (typeof patch?.[f] === 'string') row[f] = patch[f];
  if (patch?.status !== undefined) {
    const st = normalizeStatus(kind, patch.status);
    if (st) row.status = st; else delete row.status;
  }
  if (patch?.itemId !== undefined) row.itemId = patch.itemId == null || patch.itemId === '' ? null : await validItemId(kind, patch.itemId);
  if (patch?.date !== undefined && !Number.isNaN(new Date(patch.date).getTime())) row.date = new Date(patch.date).toISOString();
  await writeSheets(kind, items);
  // Vəzifə Təlimatları: a row and its Home item are ONE position sharing one
  // file — renaming the Vəzifə here renames the LINKED item and its file on Home.
  // An unlinked row never changes Home.
  if (kind === 'jobs' && typeof patch?.title === 'string' && row.title.trim() && !patch.__fromHome) {
    const { home, key } = await readHome(kind);
    let entry = row.itemId != null ? home[key].find((e) => Number(e.id) === Number(row.itemId)) : null;
    // Not linked -> Home is not touched (unless "Avtomatik bağla" is on, which links it first)
    if (!entry && row.itemId == null && await autoLinkOn(kind)) {
      const g = jobFolder(home, before.strukturAdi, before.bolme);
      if (g) entry = home[key].find((e) => Number(e.groupId) === Number(g.id) && same(e.title, before.title)) || null;
    }
    if (entry && entry.title !== row.title.trim()) {
      entry.title = row.title.trim();
      if (entry.filename) {
        const ext = (/\.([a-z0-9]+)$/i.exec(entry.filename) || [])[1] || 'pdf';
        entry.filename = `${entry.title.replace(/[\\/:*?"<>|]+/g, '_')}.${ext}`;
      }
      await putFile(homePath(kind), home);
    }
    if (entry && row.itemId == null) { row.itemId = Number(entry.id); await writeSheets(kind, items); }
  }
  return row;
}

// Move a row to the Hesabat archive. Home is not touched.
export async function archiveSheetRow(kind, id) {
  const { items } = await readSheets(kind);
  const row = items.find((x) => Number(x.id) === Number(id));
  if (!row) return { ok: true, alreadyGone: true };
  const archive = await readArchive(kind);
  archive.push({ ...row, archivedFromOrder: row.order, archivedAt: new Date().toISOString() });
  await writeArchive(kind, archive);
  await writeSheets(kind, items.filter((x) => x !== row));
  return { ok: true };
}

// Whole table -> Hesabat archive (one call). Home is not touched.
export async function archiveAllRows(kind) {
  const { items } = await readSheets(kind);
  if (!items.length) return { ok: true, archived: 0 };
  const archive = await readArchive(kind);
  const now = new Date().toISOString();
  archive.push(...items.map((r) => ({ ...r, archivedFromOrder: r.order, archivedAt: now })));
  await writeArchive(kind, archive);
  await putFile(hesabatPath(kind), { items: [] });
  return { ok: true, archived: items.length };
}
/* ---------- trash: removed from the page, KEPT in hesabat-deleted.json ---------- */
async function keepDeleted(kind, rows) {
  const c = (await getFile(hesabatDeletedPath(kind)))?.content;
  const kept = (Array.isArray(c?.items) ? c.items : []).filter(Boolean);
  const now = new Date().toISOString();
  kept.push(...rows.map((r) => ({ ...r, deletedFromOrder: r.order, deletedAt: now })));
  await putFile(hesabatDeletedPath(kind), { items: kept });
}
export async function deleteSheetRow(kind, id) {
  const { items } = await readSheets(kind);
  const row = items.find((x) => Number(x.id) === Number(id));
  if (!row) return { ok: true, alreadyGone: true };
  await keepDeleted(kind, [row]); // copy first, then remove: never lost
  await writeSheets(kind, items.filter((x) => x !== row));
  return { ok: true };
}
// Delete a row from the Hesabat ARCHIVE (copy kept in hesabat-deleted.json).
export async function deleteArchivedRow(kind, id) {
  const archive = await readArchive(kind);
  const row = archive.find((x) => Number(x.id) === Number(id));
  if (!row) return { ok: true, alreadyGone: true };
  const { archivedAt, archivedFromOrder, ...rest } = row;
  await keepDeleted(kind, [{ ...rest, order: archivedFromOrder ?? rest.order, archivedAt }]);
  await writeArchive(kind, archive.filter((x) => x !== row));
  return { ok: true };
}
// Remove every link (rows stay, Home stays).
export async function unlinkAllRows(kind) {
  const { items } = await readSheets(kind);
  const n = items.filter((r) => r.itemId != null).length;
  if (n) await writeSheets(kind, items.map((r) => ({ ...r, itemId: null })));
  return { ok: true, unlinked: n };
}

// Whole table deleted (copies kept in hesabat-deleted.json). Home is not touched.
export async function deleteAllRows(kind) {
  const { items } = await readSheets(kind);
  if (items.length) await keepDeleted(kind, items);
  await putFile(hesabatPath(kind), { items: [] });
  return { ok: true, deleted: items.length };
}

export async function listSheetArchive(kind) {
  assertKind(kind);
  const list = await readArchive(kind);
  return list.sort((a, b) => str(b.archivedAt).localeCompare(str(a.archivedAt)));
}

// Back from the archive — appended at the end of the table.
export async function restoreSheetRow(kind, id) {
  const archive = await readArchive(kind);
  const row = archive.find((x) => Number(x.id) === Number(id));
  if (!row) throw httpErr(404, 'Arxivdə tapılmadı');
  const { items } = await readSheets(kind);
  const { archivedAt, archivedFromOrder, ...back } = row;
  items.push({ ...back, order: items.length + 1 });
  await writeSheets(kind, items);
  await writeArchive(kind, archive.filter((x) => x !== row));
  return back;
}

/* ---------------- optional link to a Home item ---------------- */
// Only ids that exist in the Home list can be linked; anything else -> null.
async function validItemId(kind, raw) {
  const id = Number(raw);
  if (!Number.isFinite(id)) return null;
  const c = (await getFile(homePath(kind)))?.content || {};
  const list = c[SECTIONS[kind].listKey] || [];
  return list.some((e) => Number(e.id) === id) ? id : null;
}
async function readHome(kind) {
  const c = (await getFile(homePath(kind)))?.content || {};
  const key = SECTIONS[kind].listKey;
  return { home: { ...c, groups: Array.isArray(c.groups) ? c.groups : [], [key]: Array.isArray(c[key]) ? c[key] : [] }, key };
}
const groupNameOf = (home, gid) => str(home.groups.find((g) => Number(g.id) === Number(gid))?.name);

function homeView(kind, home, key, entry) {
  const view = {
    id: Number(entry.id),
    title: str(entry.title),
    subtitle: str(entry.subtitle),
    strukturAdi: groupNameOf(home, entry.groupId),
    status: kind === 'templates' ? null : (entry.status || null)
  };
  if (kind === 'jobs') {
    // Vəzifə Təlimatları: folder = Struktur bölməsi, its parent = Struktur vahidi
    // (a top-level folder is both, when vahid and bölmə have the same name)
    const g = home.groups.find((x) => Number(x.id) === Number(entry.groupId));
    const parent = g && g.parentId != null ? home.groups.find((x) => Number(x.id) === Number(g.parentId)) : null;
    view.bolme = str(g?.name);
    view.strukturAdi = str(parent ? parent.name : g?.name);
  }
  return view;
}
// Folder for a (vahid, bölmə) pair in the jobs tree.
function jobFolder(home, vahid, bolme) {
  const top = home.groups.find((x) => x.parentId == null && same(x.name, vahid));
  if (!top) return null;
  if (!bolme || same(bolme, vahid)) return top;
  return home.groups.find((x) => Number(x.parentId) === Number(top.id) && same(x.name, bolme)) || null;
}

export async function linkInfo(kind, id) {
  const { items } = await readSheets(kind);
  const row = items.find((x) => Number(x.id) === Number(id));
  if (!row) throw httpErr(404, 'Sətir tapılmadı');
  const { home, key } = await readHome(kind);
  // every Home item + what helps choose: its file, and which row already links to it
  const linkedBy = new Map(items.filter((r) => r.itemId != null && Number(r.id) !== Number(id)).map((r) => [Number(r.itemId), r.order ?? null]));
  const options = home[key].map((e) => ({
    ...homeView(kind, home, key, e),
    filename: e.noFile ? '' : str(e.filename),
    linkedRow: linkedBy.has(Number(e.id)) ? (linkedBy.get(Number(e.id)) ?? true) : null
  }));

  let item = null;
  let archived = false;
  if (row.itemId != null) {
    const entry = home[key].find((e) => Number(e.id) === Number(row.itemId));
    if (entry) item = homeView(kind, home, key, entry);
    else {
      const arch = (await getFile(homeArchivePath(kind)))?.content?.items || [];
      const a = arch.find((e) => Number(e.id) === Number(row.itemId));
      if (a) { archived = true; item = { ...homeView(kind, home, key, a), strukturAdi: str(a.groupName) }; }
    }
  }
  const fields = kind === 'jobs' ? ['title', 'strukturAdi', 'bolme', 'status']
    : kind === 'templates' ? LINK_FIELDS.filter((f) => f !== 'status') : LINK_FIELDS;
  const diffs = item
    ? fields.map((f) => ({ field: f, hesabat: f === 'status' ? (row.status || null) : str(row[f]), home: item[f] ?? null }))
        .map((d) => ({ ...d, same: same(d.hesabat ?? '', d.home ?? '') }))
    : [];
  return {
    row,
    item,
    archived,
    diffs,
    groups: home.groups.map((g) => str(g.name)).filter(Boolean),
    options
  };
}

export async function setLink(kind, id, itemId) {
  const { items } = await readSheets(kind);
  const row = items.find((x) => Number(x.id) === Number(id));
  if (!row) throw httpErr(404, 'Sətir tapılmadı');
  if (itemId == null || itemId === '') {
    row.itemId = null;
  } else {
    const { home, key } = await readHome(kind);
    if (!home[key].some((e) => Number(e.id) === Number(itemId))) throw httpErr(404, 'Əsas səhifədə belə element yoxdur');
    row.itemId = Number(itemId);
  }
  await writeSheets(kind, items);
  return linkInfo(kind, id);
}

// choices: { title: 'home'|'hesabat', subtitle: …, strukturAdi: …, status: … }
//   'home'    -> copy the Home value into the Hesabat row
//   'hesabat' -> copy the Hesabat value onto the Home item
export async function applyLink(kind, id, choices) {
  const { items } = await readSheets(kind);
  const row = items.find((x) => Number(x.id) === Number(id));
  if (!row) throw httpErr(404, 'Sətir tapılmadı');
  if (row.itemId == null) throw httpErr(400, 'Sətir heç bir elementə bağlı deyil');
  const { home, key } = await readHome(kind);
  const entry = home[key].find((e) => Number(e.id) === Number(row.itemId));
  if (!entry) throw httpErr(404, 'Bağlı element əsas siyahıda yoxdur (arxivdə ola bilər)');

  let rowChanged = false;
  let homeChanged = false;
  for (const [field, use] of Object.entries(choices || {})) {
    if (!LINK_FIELDS.includes(field) && !(kind === 'jobs' && field === 'bolme')) continue;
    if (field === 'status' && kind === 'templates') continue;
    const current = homeView(kind, home, key, entry);
    if (use === 'home') {
      if (field === 'status') {
        const st = normalizeStatus(kind, current.status);
        if (st) row.status = st; else delete row.status;
      } else row[field] = current[field];
      rowChanged = true;
    } else if (use === 'hesabat') {
      if (kind === 'jobs' && (field === 'strukturAdi' || field === 'bolme')) {
        const vahid = field === 'strukturAdi' ? row.strukturAdi : current.strukturAdi;
        const bolme = field === 'bolme' ? row.bolme : current.bolme;
        const g = jobFolder(home, vahid, bolme);
        if (!g) throw httpErr(400, `"${vahid}${bolme && !same(bolme, vahid) ? ' / ' + bolme : ''}" qovluğu əsas səhifədə yoxdur`);
        entry.groupId = g.id;
      } else if (field === 'strukturAdi') {
        const g = home.groups.find((x) => same(x.name, row.strukturAdi));
        if (!g) throw httpErr(400, `"${row.strukturAdi}" adlı qovluq əsas səhifədə yoxdur`);
        entry.groupId = g.id;
      } else if (field === 'status') {
        const st = normalizeStatus(kind, row.status);
        if (st) entry.status = st; else delete entry.status;
      } else entry[field] = row[field];
      homeChanged = true;
    }
  }
  if (homeChanged) {
    await putFile(homePath(kind), home);
    if (kind === 'diagrams') {
      const body = (await getFile(diagramPath(entry.id)))?.content;
      if (body && (body.title !== entry.title || body.subtitle !== entry.subtitle)) {
        await putFile(diagramPath(entry.id), { ...body, title: entry.title, subtitle: entry.subtitle || '' });
      }
    }
  }
  if (rowChanged) await writeSheets(kind, items);
  return linkInfo(kind, id);
}

// Vəzifə Təlimatları, Home -> Hesabat: an item was renamed on Home; rename the
// matching row(s) — by link, or by (vahid, bölmə, old Vəzifə).
export async function renameJobRows(itemId, oldTitle, newTitle, vahid, bolme) {
  const { items } = await readSheets('jobs');
  const link = await autoLinkOn('jobs');
  let changed = false;
  for (const r of items) {
    const byLink = r.itemId != null && Number(r.itemId) === Number(itemId);
    // Not linked -> the row is left alone. Only "Avtomatik bağla" links a same-name row (and then it follows).
    const byName = link && r.itemId == null && same(r.title, oldTitle) && same(r.strukturAdi, vahid) && same(r.bolme || vahid, bolme || vahid);
    if (byLink || byName) {
      if (byName) { r.itemId = Number(itemId); changed = true; }
      if (r.title !== newTitle) { r.title = newTitle; changed = true; }
    }
  }
  if (changed) await writeSheets('jobs', items);
  return changed;
}

/* ---------- "Avtomatik bağla" (per section, off by default) ---------- */
// A new Home item -> link the first UNLINKED row with the same name (and the
// same struktur, when the row has one).
export async function autoLinkNewItem(kind, itemId, title, struktur, bolme) {
  if (!(await autoLinkOn(kind))) return null;
  const { items } = await readSheets(kind);
  const row = items.find((r) => r.itemId == null && same(r.title, title)
    && (!str(r.strukturAdi).trim() || same(r.strukturAdi, struktur))
    && (kind !== 'jobs' || same(r.bolme || r.strukturAdi, bolme || struktur)));
  if (!row) return null;
  row.itemId = Number(itemId);
  await writeSheets(kind, items);
  return row;
}
// Pair UNLINKED rows with a Home item of the same name (+ folder); each Home
// item is used once and never one that another row already links to.
function matchRows(kind, home, key, rows, allRows) {
  const used = new Set(allRows.filter((r) => r.itemId != null).map((r) => Number(r.itemId)));
  const pairs = [];
  for (const r of rows) {
    if (r.itemId != null || !str(r.title).trim()) continue;
    const hit = home[key].find((e) => {
      if (used.has(Number(e.id))) return false;
      const v = homeView(kind, home, key, e);
      if (!same(v.title, r.title)) return false;
      if (kind === 'jobs') return same(v.strukturAdi, r.strukturAdi) && same(v.bolme, r.bolme || r.strukturAdi);
      return !str(r.strukturAdi).trim() || same(v.strukturAdi, r.strukturAdi);
    });
    if (hit) { used.add(Number(hit.id)); pairs.push({ row: r, entry: hit, view: homeView(kind, home, key, hit) }); }
  }
  return pairs;
}
// New Hesabat rows -> link (only with "Avtomatik bağla").
async function autoLinkRows(kind, rows) {
  if (!rows.length || !(await autoLinkOn(kind))) return false;
  const { home, key } = await readHome(kind);
  const { items } = await readSheets(kind);
  const pairs = matchRows(kind, home, key, rows, items);
  for (const p of pairs) p.row.itemId = Number(p.entry.id);
  return pairs.length > 0;
}
// ⋯ menu: what "Hamısını bağla" would link (for "Seçərək bağla").
export async function linkCandidates(kind) {
  const { home, key } = await readHome(kind);
  const { items } = await readSheets(kind);
  return {
    items: matchRows(kind, home, key, items, items).map(({ row, entry, view }) => ({
      rowId: row.id, title: str(row.title), strukturAdi: str(row.strukturAdi), bolme: str(row.bolme),
      itemId: Number(entry.id), itemTitle: str(view.title),
      folder: [view.strukturAdi, kind === 'jobs' && !same(view.bolme, view.strukturAdi) ? view.bolme : ''].filter(Boolean).join(' / ')
    }))
  };
}
// ⋯ menu: "Hamısını bağla" (no ids) or "Seçərək bağla" (ids).
export async function linkAllRows(kind, ids) {
  const { home, key } = await readHome(kind);
  const { items } = await readSheets(kind);
  const pick = Array.isArray(ids) ? new Set(ids.map(String)) : null;
  const rows = pick ? items.filter((r) => pick.has(String(r.id))) : items;
  const pairs = matchRows(kind, home, key, rows, items);
  for (const p of pairs) p.row.itemId = Number(p.entry.id);
  if (pairs.length) await writeSheets(kind, items);
  return { ok: true, linked: pairs.length, items };
}

// Used by "Yeni diaqram"/upload when the admin picked a Hesabat row: links
// the row to the new item. Only the link is stored — no values are copied.
export async function linkRowToItem(kind, sheetId, itemId) {
  if (sheetId == null || !Number.isFinite(Number(sheetId))) return null;
  const { items } = await readSheets(kind);
  const row = items.find((x) => Number(x.id) === Number(sheetId));
  if (!row) return null;
  row.itemId = Number(itemId);
  await writeSheets(kind, items);
  return row;
}
