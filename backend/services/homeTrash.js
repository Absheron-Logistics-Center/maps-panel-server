import { getFile, putFile } from './store.js';
import { homeDeletedPath } from './paths.js';

// Keep a copy of Home items the admin deleted (from the archive). The item's
// data file / PDF stays where it is; this list just isn't shown anywhere.
export async function keepHomeDeleted(kind, entries) {
  if (!entries.length) return;
  const c = (await getFile(homeDeletedPath(kind)))?.content;
  const kept = (Array.isArray(c?.items) ? c.items : []).filter(Boolean);
  const now = new Date().toISOString();
  kept.push(...entries.map((e) => ({ ...e, deletedAt: now })));
  await putFile(homeDeletedPath(kind), { items: kept });
}
export async function homeDeletedIds(kind) {
  const c = (await getFile(homeDeletedPath(kind)))?.content;
  return (Array.isArray(c?.items) ? c.items : []).map((x) => Number(x?.id) || 0);
}
