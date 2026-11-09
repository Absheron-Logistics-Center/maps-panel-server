/*
  One-time move to the clearly named layout (see services/paths.js), plus a
  small "lost files" scan that runs on every server start.

  Old                                   New
  <section>/index.json            ->    <section>/home.json
  <section>/archive.json          ->    <section>/home-archive.json
  <section>/sheets.json           ->    <section>/hesabat.json   (rows renumbered 1..n)
  (none)                          ->    <section>/hesabat-archive.json
  diagrams/processes/process-N    ->    diagrams/items/diagram-N.json

  Works the same on Vercel (Mongo only) and on the server (Mongo + data/).
  Every step is "copy only if the new file doesn't exist yet", so running it
  twice, or on both machines at once, is safe. The old file is removed after
  its copy is written.

  Lost files: a diagram file, PDF or template that exists in data/Mongo but is
  in neither the Home list nor its archive (deleted from the list while the
  file stayed behind) is put into that section's Home archive, so it shows up
  under "Arxiv" and can be restored.
*/
import {
  getFile, putFile, deleteFile, readLocal, listJson, listBinary, removeLocalDirIfEmpty, putBinary
} from './store.js';
import {
  SECTIONS, dataDir, homePath, homeArchivePath, hesabatPath, hesabatArchivePath,
  diagramPath, layoutMarkerPath, LAYOUT_VERSION, LEGACY, restoreMarkerPath, hesabatDeletedPath
} from './paths.js';

const isVercel = !!(process.env.VERCEL === '1' || process.env.VERCEL_ENV || process.env.NOW_REGION);
const KINDS = Object.keys(SECTIONS);
const RESTORED_NOTE = 'Datadan bərpa edildi';

// Known details for files that were found without a list entry (from git history).
const RESTORE_HINTS = {
  pdfs: {
    4: { title: 'Anbar idarəetmә prosesi', subtitle: 'PS/İMS/BD/02', filename: '01.02.2020_PR.İMS.02 - Anbarın idarəedilməsi  proseduru.pdf', groupName: 'Anbar logistikası şöbəsi' },
    9: { title: 'Grapefruit', subtitle: 'fruit', filename: 'grapefruit.pdf', groupName: 'Anbar logistikası şöbəsi' }
  }
};

async function read(p) {
  return (await getFile(p)) || (await readLocal(p));
}

/* ---------------- shape normalizers ---------------- */
function normHome(kind, c) {
  const key = SECTIONS[kind].listKey;
  const out = c && typeof c === 'object' ? { ...c } : {};
  out.groups = Array.isArray(out.groups) ? out.groups : [];
  out[key] = (Array.isArray(out[key]) ? out[key] : []).filter(Boolean);
  return out;
}
function normArchive(kind, c) {
  const key = SECTIONS[kind].listKey;
  const list = Array.isArray(c?.items) ? c.items : (Array.isArray(c?.[key]) ? c[key] : []);
  return { items: list.filter(Boolean) };
}
export function normHesabat(c) {
  const rows = (Array.isArray(c?.items) ? c.items : []).filter(Boolean);
  rows.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  return {
    items: rows.map((r, i) => {
      const { processId, ...rest } = r;
      const itemId = r.itemId ?? processId ?? null;
      return { ...rest, order: i + 1, itemId: itemId == null || itemId === '' ? null : Number(itemId) };
    })
  };
}

async function moveJson(oldP, newP, normalize) {
  if (await getFile(newP)) return false;
  const old = await read(oldP);
  await putFile(newP, normalize(old?.content ?? null));
  if (old) await deleteFile(oldP).catch(() => {});
  return true;
}

async function moveDiagramBodies(log) {
  const prefix = LEGACY.processPrefix();
  for (const p of await listJson(prefix)) {
    const m = /process-(\d+)\.json$/.exec(p);
    if (!m) continue;
    const id = Number(m[1]);
    if (!(await getFile(diagramPath(id)))) {
      const old = await read(p);
      if (!old?.content) continue;
      const { status, ...body } = old.content; // status lives on the Home list only
      await putFile(diagramPath(id), { ...body, id });
      log.push(`diagram ${id} moved`);
    }
    await deleteFile(p).catch(() => {});
  }
  await removeLocalDirIfEmpty(prefix);
}

/* ---------------- lost files -> archive ---------------- */
async function restoreLostDiagrams(log) {
  const home = normHome('diagrams', (await getFile(homePath('diagrams')))?.content);
  const arch = normArchive('diagrams', (await getFile(homeArchivePath('diagrams')))?.content);
  const known = new Set([...home.processes, ...arch.items].map((x) => Number(x.id)));
  const add = [];
  for (const p of await listJson(`${dataDir()}/diagrams/items/`)) {
    const m = /diagram-(\d+)\.json$/.exec(p);
    if (!m || known.has(Number(m[1]))) continue;
    const body = (await read(p))?.content;
    if (!body) continue;
    add.push({
      id: Number(m[1]),
      title: String(body.title || `Diaqram ${m[1]}`),
      subtitle: String(body.subtitle || ''),
      groupId: null,
      groupName: '',
      archivedAt: new Date().toISOString(),
      note: RESTORED_NOTE
    });
  }
  if (add.length) {
    arch.items = [...arch.items, ...add];
    await putFile(homeArchivePath('diagrams'), arch);
    log.push(`diagrams restored to archive: ${add.map((x) => x.id).join(', ')}`);
  }
}

async function restoreLostFiles(kind, log) {
  const dir = SECTIONS[kind].dir;
  const home = normHome(kind, (await getFile(homePath(kind)))?.content);
  const arch = normArchive(kind, (await getFile(homeArchivePath(kind)))?.content);
  const known = new Set([...home.pdfs, ...arch.items].map((x) => Number(x.id)));
  const rows = (await getFile(hesabatPath(kind)))?.content?.items || [];
  const groups = home.groups || [];
  const add = [];
  for (const [p, size] of await listBinary(`${dataDir()}/${dir}/pdf/`)) {
    const m = /pdf-(\d+)\.([a-z0-9]+)$/i.exec(p);
    if (!m) continue;
    const id = Number(m[1]);
    if (known.has(id) || add.some((a) => a.id === id)) continue;
    const hint = RESTORE_HINTS[kind]?.[id] || {};
    const row = rows.find((r) => Number(r.itemId) === id) || {};
    const groupName = hint.groupName || row.strukturAdi || '';
    add.push({
      id,
      title: hint.title || row.title || `Sənəd ${id}`,
      subtitle: hint.subtitle ?? row.subtitle ?? '',
      filename: hint.filename || `pdf-${id}.${m[2].toLowerCase()}`,
      size,
      groupId: groups.find((g) => g.name === groupName)?.id ?? null,
      groupName,
      uploadedAt: new Date().toISOString(),
      archivedAt: new Date().toISOString(),
      note: RESTORED_NOTE
    });
  }
  if (add.length) {
    arch.items = [...arch.items, ...add];
    await putFile(homeArchivePath(kind), arch);
    log.push(`${kind} restored to archive: ${add.map((x) => x.id).join(', ')}`);
  }
}

/* ---------------- items deleted in the past (from git history) ----------------
  backend/restore/history.json (+ files/) holds every diagram, document,
  template and hesabat row that was deleted before archiving existed. Each is
  added ONCE to its section's archive (new id, so nothing current is touched).
  Server only, tracked in data/restore-applied.json. */
const fold = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('az');
const maxId = (...lists) => lists.flat().reduce((m, x) => Math.max(m, Number(x?.id ?? x) || 0), 0);

async function applyHistoryRestore(log) {
  if (isVercel) return;
  let pack;
  try {
    const fsMod = await import('fs/promises');
    pack = JSON.parse(await fsMod.readFile(new URL('../restore/history.json', import.meta.url), 'utf8'));
  } catch { return; }
  const fsMod = await import('fs/promises');
  const marker = (await getFile(restoreMarkerPath()))?.content || { keys: [] };
  const applied = new Set(marker.keys || []);
  const now = new Date().toISOString();
  let added = 0;

  // diagrams
  {
    const home = normHome('diagrams', (await getFile(homePath('diagrams')))?.content);
    const arch = normArchive('diagrams', (await getFile(homeArchivePath('diagrams')))?.content);
    const bodyIds = (await listJson(`${dataDir()}/diagrams/items/`)).map((p) => Number(/diagram-(\d+)/.exec(p)?.[1]) || 0);
    let next = maxId(home.processes, arch.items, bodyIds) + 1;
    let changed = false;
    for (const d of pack.diagrams || []) {
      if (applied.has(d.key)) continue;
      const id = next++;
      await putFile(diagramPath(id), { ...d.body, id, title: d.title, subtitle: d.subtitle || '' });
      arch.items.push({ id, title: d.title, subtitle: d.subtitle || '', groupId: null, groupName: d.groupName || '',
        ...(d.status ? { status: d.status } : {}), archivedAt: now, note: d.note, oldId: d.oldId });
      applied.add(d.key); changed = true; added++;
    }
    if (changed) await putFile(homeArchivePath('diagrams'), arch);
  }

  // documents / templates (+ their files)
  for (const [kind, list] of [['pdfs', pack.pdfs || []], ['templates', pack.templates || []]]) {
    const dir = SECTIONS[kind].dir;
    const home = normHome(kind, (await getFile(homePath(kind)))?.content);
    const arch = normArchive(kind, (await getFile(homeArchivePath(kind)))?.content);
    const have = new Set([...home.pdfs, ...arch.items].map((x) => fold(x.title)));
    const binIds = [...(await listBinary(`${dataDir()}/${dir}/pdf/`)).keys()].map((p) => Number(/pdf-(\d+)/.exec(p)?.[1]) || 0);
    let next = maxId(home.pdfs, arch.items, binIds) + 1;
    let changed = false;
    for (const e of list) {
      if (applied.has(e.key)) continue;
      if (have.has(fold(e.title))) { applied.add(e.key); continue; } // already there
      const id = next++;
      if (e.blob) {
        const buf = await fsMod.readFile(new URL(`../restore/files/${e.blob}`, import.meta.url));
        await putBinary(`${dataDir()}/${dir}/pdf/pdf-${id}.${e.ext || 'pdf'}`, buf);
      }
      arch.items.push({ id, title: e.title, subtitle: e.subtitle || '', filename: e.filename || (e.blob ? `pdf-${id}.${e.ext}` : ''),
        size: e.size || 0, ...(e.noFile ? { noFile: true } : {}), groupId: null, groupName: e.groupName || '',
        ...(e.status ? { status: e.status } : {}), uploadedAt: now, archivedAt: now, note: e.note });
      have.add(fold(e.title)); applied.add(e.key); changed = true; added++;
    }
    if (changed) await putFile(homeArchivePath(kind), arch);
  }

  // hesabat rows
  for (const [kind, list] of Object.entries(pack.hesabat || {})) {
    const rows = (await getFile(hesabatPath(kind)))?.content?.items || [];
    const archC = (await getFile(hesabatArchivePath(kind)))?.content;
    const archived = Array.isArray(archC?.items) ? archC.items : [];
    const deleted = (await getFile(hesabatDeletedPath(kind)))?.content?.items || [];
    const have = new Set([...rows, ...archived].map((r) => fold(r.title)));
    let next = maxId(rows, archived, deleted) + 1;
    let changed = false;
    for (const e of list) {
      if (applied.has(e.key)) continue;
      if (!have.has(fold(e.row.title))) {
        archived.push({ ...e.row, id: next++, itemId: null, archivedAt: now, note: 'Tarixçədən bərpa edildi' });
        have.add(fold(e.row.title)); changed = true; added++;
      }
      applied.add(e.key);
    }
    if (changed) await putFile(hesabatArchivePath(kind), { items: archived });
  }

  await putFile(restoreMarkerPath(), { keys: [...applied], updatedAt: now });
  if (added) log.push(`restored from history: ${added}`);
}

// v3: every Hesabat row starts UNLINKED; linking is done by hand.
async function unlinkAllRows(log) {
  for (const kind of KINDS) {
    if (!(await getFile(hesabatDeletedPath(kind)))) await putFile(hesabatDeletedPath(kind), { items: [] });
    const c = (await getFile(hesabatPath(kind)))?.content;
    if (!Array.isArray(c?.items)) continue;
    const n = c.items.filter((r) => r && r.itemId != null).length;
    if (!n) continue;
    await putFile(hesabatPath(kind), { ...c, items: c.items.map((r) => (r ? { ...r, itemId: null } : r)) });
    log.push(`${kind}: ${n} hesabat rows unlinked`);
  }
}

/* ---------------- entry point ---------------- */
export async function migrateLayout() {
  const log = [];
  const marker = (await getFile(layoutMarkerPath()))?.content;
  const version = Number(marker?.version) || 0;
  const done = version >= LAYOUT_VERSION;

  if (version < 2) {
    for (const kind of KINDS) {
      if (await moveJson(LEGACY.index(kind), homePath(kind), (c) => normHome(kind, c))) log.push(`${kind} home.json`);
      if (await moveJson(LEGACY.archive(kind), homeArchivePath(kind), (c) => normArchive(kind, c))) log.push(`${kind} home-archive.json`);
      if (await moveJson(LEGACY.sheets(kind), hesabatPath(kind), normHesabat)) log.push(`${kind} hesabat.json`);
      if (!(await getFile(hesabatArchivePath(kind)))) await putFile(hesabatArchivePath(kind), { items: [] });
    }
  }
  // Old diagram files can still appear later (e.g. server disk pushed after
  // Vercel already migrated), so the move + lost-file scan run every server start.
  if (!done || !isVercel) {
    await moveDiagramBodies(log);
    await restoreLostDiagrams(log);
    await restoreLostFiles('pdfs', log);
    await restoreLostFiles('templates', log);
  }
  if (version < 3) await unlinkAllRows(log);
  await applyHistoryRestore(log);
  if (!done) await putFile(layoutMarkerPath(), { ...(marker || {}), version: LAYOUT_VERSION, migratedAt: new Date().toISOString() });
  if (log.length) console.log('[migrate]', log.join(' | '));
  return log;
}

let pending = null;
export function ensureLayout() {
  if (!pending) {
    pending = migrateLayout().catch((e) => {
      pending = null; // retry on the next request
      throw e;
    });
  }
  return pending;
}
