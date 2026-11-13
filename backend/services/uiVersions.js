// uiVersions.js — every user moves to a new interface when THEY want,
// like a phone update. There is one server and one set of data; only the
// screens differ:
//
//   frontend/versions/<version>/   one built interface per installed version
//   frontend/dist/                 the build from before this system (fallback)
//   data/auth/ui-versions.json     { users: { <username>: { version, at } } }
//
// Which interface a browser gets is decided per request from the mp_ui
// cookie (set by the page from the user's record). A user with no record
// yet is pinned to the newest interface the first time they are seen, and
// stays on it until they press "Yenilə" in their own bell.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getFile, putFile } from './store.js';
import { compareVersions } from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
export const VERSIONS_DIR = path.join(ROOT, 'frontend', 'versions');
export const DIST_DIR = path.join(ROOT, 'frontend', 'dist');
const KEEP = 8;
const RECORDS = () => `${(process.env.DATA_PATH || 'data').replace(/^\/|\/$/g, '')}/auth/ui-versions.json`;

const validVersion = v => /^\d+(\.\d+){0,3}([.-][a-z0-9]+)?$/i.test(String(v || ''));

function readInfo(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'ui-version.json'), 'utf8')); } catch { return null; }
}

/** installed interfaces, newest first: [{ version, date, notes, legacy? }] */
export function listUi() {
  const out = [];
  try {
    for (const name of fs.readdirSync(VERSIONS_DIR)) {
      const dir = path.join(VERSIONS_DIR, name);
      if (!validVersion(name) || !fs.existsSync(path.join(dir, 'index.html'))) continue;
      const info = readInfo(dir) || {};
      out.push({ version: name, date: info.date || null, notes: Array.isArray(info.notes) ? info.notes : [], builtAt: info.builtAt || null });
    }
  } catch { /* no versions yet */ }
  // the build in dist/ (made before this system, or by an older updater)
  const legacy = readInfo(DIST_DIR);
  if (fs.existsSync(path.join(DIST_DIR, 'index.html')) && legacy?.version && !out.some(v => v.version === legacy.version)) {
    out.push({ version: legacy.version, date: legacy.date || null, notes: legacy.notes || [], legacy: true });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

export function enabled() {
  return process.env.SERVE_FRONTEND === '1' && !process.env.VERCEL;
}

/** index.html for a version (falls back to the newest one) */
export function indexFor(version) {
  const list = listUi();
  const hit = version && list.find(v => v.version === version);
  const pick = hit || list[0];
  if (pick && !pick.legacy) return path.join(VERSIONS_DIR, pick.version, 'index.html');
  return path.join(DIST_DIR, 'index.html');
}

/* ---------------- per-user records ---------------- */
let cache = null, cacheAt = 0, chain = Promise.resolve();
async function readRecords() {
  if (cache && Date.now() - cacheAt < 10000) return cache;
  let doc = null;
  try { doc = (await getFile(RECORDS()))?.content || null; } catch { doc = cache; }
  cache = { users: doc?.users && typeof doc.users === 'object' ? doc.users : {} };
  cacheAt = Date.now();
  return cache;
}
function writeRecord(username, patch) {
  chain = chain.catch(() => {}).then(async () => {
    cacheAt = 0;
    const cur = await readRecords();
    cur.users[username] = { ...(cur.users[username] || {}), ...patch, at: new Date().toISOString() };
    await putFile(RECORDS(), { users: cur.users, updatedAt: new Date().toISOString() });
    cache = cur; cacheAt = Date.now();
  });
  return chain;
}

/** What this user runs and what is newer for them. */
export async function forUser(username) {
  const list = listUi();
  if (!list.length) return { enabled: false };
  const rec = (await readRecords()).users[username];
  let mine = rec?.version;
  if (!mine || !list.some(v => v.version === mine)) {
    // first time seen, or their version was removed: pin to the newest
    mine = list[0].version;
    await writeRecord(username, { version: mine }).catch(() => {});
  }
  const newer = list.filter(v => compareVersions(v.version, mine) > 0);
  return {
    enabled: true,
    mine,
    auto: !!rec?.auto,                 // this user's "update by itself" switch
    latest: list[0].version,
    newer: newer.map(v => ({ version: v.version, date: v.date, notes: v.notes }))
  };
}

export async function switchUser(username, version) {
  const list = listUi();
  if (!list.some(v => v.version === version)) {
    const e = new Error('Bu versiya serverdə yoxdur.'); e.status = 400; throw e;
  }
  await writeRecord(username, { version });
  return forUser(username);
}

/* ---------------- used by the installer ---------------- */
export function versionDir(version) { return path.join(VERSIONS_DIR, version); }

/** keep the newest KEEP builds (and any still in someone's record is fine to lose: they move to the newest) */
export function pruneUi() {
  const list = listUi().filter(v => !v.legacy);
  for (const v of list.slice(KEEP)) {
    try { fs.rmSync(path.join(VERSIONS_DIR, v.version), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function removeUi(version) {
  if (!validVersion(version)) return;
  try { fs.rmSync(path.join(VERSIONS_DIR, version), { recursive: true, force: true }); } catch { /* ignore */ }
}

/** the user's own "update by itself" switch (off by default) */
export async function setAuto(username, auto) {
  await writeRecord(username, { auto: !!auto });
  return forUser(username);
}
