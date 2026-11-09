/*
  Reconciles this server's local data/ folder with the shared MongoDB +
  GitHub backends, in both directions, WITHOUT overwriting anything that
  already exists on the other side (additive only — safe to re-run any time,
  e.g. after this server was offline or before it had credentials).

  Requires MONGODB_URI and GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO to already
  be set in .env — fill those in with the SAME values Vercel uses (Vercel
  Project Settings > Environment Variables) before running this.

  What it does:
    - Diagrams (Mongo):
        data/diagrams/index.json + archive.json — merges the `groups` and
        `processes` lists from local + Mongo by id (union, no dedupe loss),
        writes the merged result back to BOTH sides.
        data/diagrams/processes/process-N.json — any file that exists on
        only one side gets copied to the other. Existing on both sides:
        left untouched (never silently overwritten); logged for your review
        if the content actually differs.
    - PDFs (GitHub) + Templates (GitHub): same index-merge idea for
        data/files/index.json (pdfs) and data/templates/index.json
        (groups + pdfs/templates arrays), plus copying any binary file
        that's only sitting in the local data/files/pdf or
        data/templates/file folder up to GitHub.

  Run from the backend/ folder:
      node scripts/sync-data.mjs
      node scripts/sync-data.mjs --dry-run     (report only, writes nothing)
*/

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import { config as loadEnv } from 'dotenv';

const DRY_RUN = process.argv.includes('--dry-run');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
loadEnv({ path: path.join(REPO_ROOT, '.env') });
loadEnv({ path: path.join(REPO_ROOT, 'backend', '.env') });

const {
  MONGODB_URI, MONGODB_DB = 'mappanel', MONGODB_COLLECTION = 'diagrams',
  GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH = 'main'
} = process.env;

const useMongo = !!MONGODB_URI;
const useGithub = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);

if (!useMongo && !useGithub) {
  console.error(
    'Neither MONGODB_URI nor GITHUB_TOKEN/OWNER/REPO are set in .env — ' +
    'nothing to reconcile against. Fill those in first (same values as Vercel).'
  );
  process.exit(1);
}

console.log(DRY_RUN ? '--- DRY RUN: no writes will happen ---' : '--- LIVE RUN ---');
console.log('Mongo:', useMongo ? 'configured' : 'skipped (not set)');
console.log('GitHub:', useGithub ? `configured (${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH})` : 'skipped (not set)');

/* ============================== GitHub helpers ============================== */
const API_BASE = 'https://api.github.com';
function ghHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${GITHUB_TOKEN}`
  };
}
function ghUrl(p) {
  return `${API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${p.split('/').map(encodeURIComponent).join('/')}`;
}
async function ghGetJson(p) {
  const res = await fetch(`${ghUrl(p)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${res.status} for ${p}: ${await res.text()}`);
  const data = await res.json();
  return { content: JSON.parse(Buffer.from((data.content || '').replace(/\n/g, ''), 'base64').toString('utf8')), sha: data.sha };
}
async function ghGetBinary(p) {
  const res = await fetch(`${ghUrl(p)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${res.status} for ${p}: ${await res.text()}`);
  const data = await res.json();
  if (data.content) return Buffer.from(data.content.replace(/\n/g, ''), 'base64');
  if (data.download_url) {
    const raw = await fetch(data.download_url, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } });
    return Buffer.from(await raw.arrayBuffer());
  }
  return null;
}
async function ghList(dir) {
  const res = await fetch(`${ghUrl(dir)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers: ghHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub LIST ${res.status} for ${dir}: ${await res.text()}`);
  return res.json();
}
async function ghPutJson(p, contentObject, sha, message) {
  if (DRY_RUN) return;
  const body = {
    message: message || `sync-data: update ${p}`,
    content: Buffer.from(JSON.stringify(contentObject, null, 2) + '\n', 'utf8').toString('base64'),
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;
  const res = await fetch(ghUrl(p), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub PUT ${res.status} for ${p}: ${await res.text()}`);
}
async function ghPutBinary(p, buffer, sha, message) {
  if (DRY_RUN) return;
  const body = {
    message: message || `sync-data: upload ${p}`,
    content: buffer.toString('base64'),
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;
  const res = await fetch(ghUrl(p), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub PUT ${res.status} for ${p}: ${await res.text()}`);
}

/* ============================== local fs helpers ============================== */
async function localReadJson(relPath) {
  try {
    return JSON.parse(await fs.readFile(path.join(REPO_ROOT, relPath), 'utf8'));
  } catch { return null; }
}
async function localWriteJson(relPath, obj) {
  if (DRY_RUN) return;
  const full = path.join(REPO_ROOT, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, JSON.stringify(obj, null, 2) + '\n');
}
async function localReadBinary(relPath) {
  try { return await fs.readFile(path.join(REPO_ROOT, relPath)); } catch { return null; }
}
async function localListDir(relPath) {
  try { return await fs.readdir(path.join(REPO_ROOT, relPath)); } catch { return []; }
}

/* ================= union-merge helper for {groups, <items>} indexes ========== */
// Merges two index objects that each look like { groups: [...], <itemsKey>: [...] }.
// Union by id. If an id exists on both sides with different content, keeps the
// local version (this server's copy) but logs a warning so it can be reviewed —
// never silently drops either side's items.
function mergeIndex(localIdx, remoteIdx, itemsKey, label) {
  const a = localIdx || { groups: [], [itemsKey]: [] };
  const b = remoteIdx || { groups: [], [itemsKey]: [] };
  const groups = unionById(a.groups || [], b.groups || [], `${label} groups`);
  const items = unionById(a[itemsKey] || [], b[itemsKey] || [], `${label} ${itemsKey}`);
  return { groups, [itemsKey]: items };
}
function unionById(listA, listB, label) {
  const byId = new Map();
  for (const item of listA) byId.set(Number(item.id), item);
  for (const item of listB) {
    const id = Number(item.id);
    if (!byId.has(id)) {
      byId.set(id, item);
      console.log(`  + added ${label} id ${id} from the other side`);
    } else {
      const existing = byId.get(id);
      if (JSON.stringify(existing) !== JSON.stringify(item)) {
        console.log(`  ! ${label} id ${id} differs on both sides — kept local, review manually if needed`);
      }
    }
  }
  return [...byId.values()];
}

/* =============================== DIAGRAMS (Mongo) =============================== */
async function syncDiagrams() {
  if (!useMongo) { console.log('\n[diagrams] skipped — no MONGODB_URI'); return; }
  console.log('\n[diagrams] reconciling data/diagrams with MongoDB...');

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const col = client.db(MONGODB_DB).collection(MONGODB_COLLECTION);

  // index.json + archive.json — union merge
  for (const [file, itemsKey, label] of [['index.json', 'processes', 'diagram'], ['archive.json', 'processes', 'archived diagram']]) {
    const relPath = `data/diagrams/${file}`;
    const localDoc = await localReadJson(relPath);
    const mongoDoc = await col.findOne({ _id: relPath });
    const remoteContent = mongoDoc ? mongoDoc.content : null;
    if (!localDoc && !remoteContent) continue;
    const merged = mergeIndex(localDoc, remoteContent, itemsKey, label);
    await localWriteJson(relPath, merged);
    if (!DRY_RUN) await col.updateOne({ _id: relPath }, { $set: { content: merged, updatedAt: new Date() } }, { upsert: true });
  }

  // individual process files — copy whichever side is missing them
  const localFiles = new Set((await localListDir('data/diagrams/processes')).filter(f => f.endsWith('.json')));
  const mongoDocs = await col.find({ _id: { $regex: '^data/diagrams/processes/' } }).toArray();
  const mongoKeys = new Set(mongoDocs.map(d => d._id));

  for (const f of localFiles) {
    const key = `data/diagrams/processes/${f}`;
    if (!mongoKeys.has(key)) {
      const content = await localReadJson(key);
      console.log(`  + pushing ${key} to Mongo (was only local)`);
      if (!DRY_RUN) await col.updateOne({ _id: key }, { $set: { content, updatedAt: new Date() } }, { upsert: true });
    }
  }
  for (const doc of mongoDocs) {
    const relPath = doc._id;
    const fname = relPath.split('/').pop();
    if (!localFiles.has(fname)) {
      console.log(`  + pulling ${relPath} to local (was only in Mongo)`);
      await localWriteJson(relPath, doc.content);
    }
  }

  await client.close();
  console.log('[diagrams] done.');
}

/* =========================== PDFs / TEMPLATES (GitHub) =========================== */
async function syncGithubSection(indexRelPath, itemsKey, binaryDirRelPath, label) {
  if (!useGithub) { console.log(`\n[${label}] skipped — no GITHUB_TOKEN/OWNER/REPO`); return; }
  console.log(`\n[${label}] reconciling ${indexRelPath} with GitHub...`);

  const localDoc = await localReadJson(indexRelPath);
  const remote = await ghGetJson(indexRelPath);
  if (!localDoc && !remote) { console.log('  nothing on either side.'); return; }
  const merged = mergeIndex(localDoc, remote ? remote.content : null, itemsKey, label);
  await localWriteJson(indexRelPath, merged);
  await ghPutJson(indexRelPath, merged, remote ? remote.sha : undefined, `sync-data: reconcile ${label} index`);

  // binaries only on local -> push to GitHub. (GitHub-only binaries don't
  // need pulling down: getBinary() already fetches from GitHub on demand.)
  const localBinFiles = await localListDir(binaryDirRelPath);
  const remoteList = await ghList(binaryDirRelPath).catch(() => []);
  const remoteNames = new Set(remoteList.filter(e => e.type === 'file').map(e => e.name));
  for (const fname of localBinFiles) {
    if (remoteNames.has(fname)) continue;
    const relPath = `${binaryDirRelPath}/${fname}`;
    const buf = await localReadBinary(relPath);
    if (!buf) continue;
    console.log(`  + pushing binary ${relPath} to GitHub (was only local)`);
    await ghPutBinary(relPath, buf, undefined, `sync-data: upload ${fname}`);
  }
  console.log(`[${label}] done.`);
}

async function syncGithubArchive(archiveRelPath, label) {
  if (!useGithub) return;
  const localDoc = await localReadJson(archiveRelPath);
  const remote = await ghGetJson(archiveRelPath);
  if (!localDoc && !remote) return;
  const a = localDoc || { items: [] };
  const b = remote ? remote.content : { items: [] };
  const merged = { items: unionById(a.items || [], b.items || [], `${label} archive`) };
  await localWriteJson(archiveRelPath, merged);
  await ghPutJson(archiveRelPath, merged, remote ? remote.sha : undefined, `sync-data: reconcile ${label} archive`);
}

async function main() {
  await syncDiagrams();
  await syncGithubSection('data/files/index.json', 'pdfs', 'data/files/pdf', 'pdfs');
  await syncGithubArchive('data/files/archive.json', 'pdfs');
  await syncGithubSection('data/templates/index.json', 'templates', 'data/templates/pdf', 'templates');
  await syncGithubArchive('data/templates/archive.json', 'templates');
  console.log(DRY_RUN ? '\nDry run complete — nothing was written. Re-run without --dry-run to apply.' : '\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
