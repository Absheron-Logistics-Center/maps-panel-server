/*
  ONE storage layer for the whole app (Vercel + self-hosted server).

  MongoDB is the single source of truth:
    - JSON documents (diagrams, sheets/hesabat, pdf + template indexes,
      archives, settings, labels)  -> collection `diagrams`, _id = path
    - Binary files (PDF/Word/Excel) -> GridFS bucket `files`, filename = path

  Vercel:  reads/writes Mongo only (no disk, no GitHub => no redeploys).
  Server:  reads/writes Mongo AND mirrors every change to the local data/
           folder. If Mongo is unreachable the server keeps working from
           disk, remembers what changed (data/.mongo-outbox.json) and pushes
           it to Mongo as soon as the connection is back. A background job
           also pulls everything that changed in Mongo (e.g. edits made on
           Vercel) down into data/, so the server's disk is a full backup.

  GitHub is NOT used for data any more. Pushing code to GitHub is only for
  code; data never creates commits.
*/
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { encodeStatuses, decodeStatuses } from './statusNames.js';
import { homePath } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..'); // project root (holds data/)

const isVercel = !!(process.env.VERCEL === '1' || process.env.VERCEL_ENV || process.env.NOW_REGION);
const URI = () => process.env.MONGODB_URI || '';
const DB_NAME = () => process.env.MONGODB_DB || 'mappanel';
const COLLECTION = () => process.env.MONGODB_COLLECTION || 'diagrams';
const dataDir = () => (process.env.DATA_PATH || 'data').replace(/^\/|\/$/g, '');
const hasMongo = () => !!URI();

const BINARY_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx']);
const SKIP_TOP = new Set(['rt', 'auth']); // runtime presence/locks + user list: never synced

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
const notConfigured = () =>
  httpErr(500, 'MONGODB_URI is not set — data would be lost. Add it in the environment settings.');

/* ------------------------------ status ------------------------------ */
const state = { ok: null, lastError: null, lastOkAt: null, lastSyncAt: null };
const markOk = () => { state.ok = true; state.lastOkAt = new Date().toISOString(); state.lastError = null; };
const markDown = (e) => { state.ok = false; state.lastError = e?.message || String(e); };

/* ------------------------------ connection ------------------------------ */
// Cached across warm serverless invocations. A FAILED connect is NOT cached
// (the old code cached the rejected promise forever, so one network blip
// broke the process until restart).
async function client() {
  if (!globalThis.__mpMongoP) {
    const { MongoClient } = await import('mongodb');
    const c = new MongoClient(URI(), {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000
    });
    globalThis.__mpMongoP = c.connect().catch((e) => { globalThis.__mpMongoP = null; throw e; });
  }
  return globalThis.__mpMongoP;
}
const db = async () => (await client()).db(DB_NAME());
const col = async () => (await db()).collection(COLLECTION());
async function bucket() {
  const { GridFSBucket } = await import('mongodb');
  return new GridFSBucket(await db(), { bucketName: 'files' });
}

/* ------------------------------ local disk (server only) ------------------------------ */
function localFull(p) {
  const full = path.resolve(REPO_ROOT, p);
  if (!full.startsWith(REPO_ROOT + path.sep)) throw httpErr(400, 'Bad path');
  return full;
}
async function localGet(p) {
  try {
    return { content: JSON.parse(await fs.readFile(localFull(p), 'utf8')), sha: 'local' };
  } catch { return null; }
}
async function localPut(p, obj) {
  const full = localFull(p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const tmp = full + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, full); // atomic: never leaves a half-written json
}
async function localDelete(p) { try { await fs.unlink(localFull(p)); } catch { /* already gone */ } }
async function localGetBinary(p) { try { return await fs.readFile(localFull(p)); } catch { return null; } }
async function localPutBinary(p, buf) {
  const full = localFull(p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buf);
}

/* ------------------------------ outbox (server: changes Mongo hasn't got yet) ------------------------------ */
const outboxFile = () => path.join(REPO_ROOT, dataDir(), '.mongo-outbox.json');
let dirty = null; // Map path -> 'json' | 'bin'
async function loadDirty() {
  if (dirty) return dirty;
  dirty = new Map();
  try {
    const o = JSON.parse(await fs.readFile(outboxFile(), 'utf8'));
    for (const [p, k] of Object.entries(o)) dirty.set(p, k);
  } catch { /* none yet */ }
  return dirty;
}
async function saveDirty() {
  if (isVercel || !dirty) return;
  try {
    await fs.mkdir(path.dirname(outboxFile()), { recursive: true });
    await fs.writeFile(outboxFile(), JSON.stringify(Object.fromEntries(dirty)));
  } catch { /* best effort */ }
}
async function markDirty(p, kind) { (await loadDirty()).set(p, kind); await saveDirty(); }
async function clearDirty(p) { if ((await loadDirty()).delete(p)) await saveDirty(); }
export function pendingQueueSize() { return dirty ? dirty.size : 0; }

/* ------------------------------ GridFS helpers ------------------------------ */
async function gridRead(p) {
  const b = await bucket();
  const f = await b.find({ filename: p }).sort({ uploadDate: -1 }).limit(1).toArray();
  if (!f.length) return null;
  const chunks = [];
  for await (const ch of b.openDownloadStream(f[0]._id)) chunks.push(ch);
  return Buffer.concat(chunks);
}
async function gridWrite(p, buf) {
  const b = await bucket();
  // upload the new version first, then drop older ones: a crash in between
  // leaves two copies, never zero.
  const id = await new Promise((resolve, reject) => {
    const s = b.openUploadStream(p);
    s.on('error', reject);
    s.on('finish', () => resolve(s.id));
    s.end(buf);
  });
  const olds = await b.find({ filename: p, _id: { $ne: id } }).toArray();
  for (const o of olds) await b.delete(o._id).catch(() => {});
}
async function gridDelete(p) {
  const b = await bucket();
  for (const o of await b.find({ filename: p }).toArray()) await b.delete(o._id).catch(() => {});
}

/* ------------------------------ attribution (kept so routes don't change) ------------------------------ */
export function attribution(user, message) {
  const username = user?.username;
  if (!username) return { message };
  return { message: `${message} (by ${username})`, author: { name: username, email: `${username}@map-panel.local` } };
}

/* =============================== JSON =============================== */
async function getFileRaw(p) {
  if (!hasMongo()) {
    if (isVercel) throw notConfigured();
    return localGet(p);
  }
  // Server only: a path whose last write hasn't reached Mongo yet — disk is newer.
  if (!isVercel && (await loadDirty()).has(p)) {
    const l = await localGet(p);
    if (l) return l;
  }
  try {
    const doc = await (await col()).findOne({ _id: p });
    markOk();
    if (doc) return doc.deleted ? null : { content: doc.content, sha: 'mongo' };
    if (isVercel) return null;
    // Server, first time this path is read: adopt the server's existing file
    // into Mongo (never overwrites, $setOnInsert) so Vercel sees it too.
    const l = await localGet(p);
    if (l) {
      await (await col()).updateOne(
        { _id: p },
        { $setOnInsert: { content: l.content, updatedAt: new Date() } },
        { upsert: true }
      ).catch(() => {});
    }
    return l;
  } catch (e) {
    markDown(e);
    console.error('[store.getFile] mongo read failed:', p, e.message);
    if (isVercel) throw httpErr(503, `Mongo read failed: ${e.message}`);
    return localGet(p); // server keeps working from its disk copy
  }
}

async function putFileRaw(p, obj) {
  if (!hasMongo()) {
    if (isVercel) throw notConfigured();
    await localPut(p, obj);
    return { ok: true };
  }
  if (!isVercel) await localPut(p, obj).catch((e) => console.error('[store] local write failed', p, e.message));
  try {
    await (await col()).updateOne(
      { _id: p },
      { $set: { content: obj, updatedAt: new Date() }, $unset: { deleted: '' } },
      { upsert: true }
    );
    markOk();
    if (!isVercel) await clearDirty(p);
    return { ok: true };
  } catch (e) {
    markDown(e);
    console.error('[store.putFile] mongo write failed:', p, e.message);
    if (isVercel) throw httpErr(502, `Mongo write failed: ${e.message}`);
    await markDirty(p, 'json'); // saved on disk, will be pushed when Mongo is back
    return { ok: true, mongoSynced: false };
  }
}

export async function deleteFile(p) {
  if (!hasMongo()) {
    if (isVercel) return { ok: true };
    await localDelete(p);
    return { ok: true };
  }
  if (!isVercel) await localDelete(p);
  try {
    // tombstone (not deleteOne) so the server's disk copy can't be re-adopted
    // into Mongo and "undelete" the file.
    await (await col()).updateOne(
      { _id: p },
      { $set: { deleted: true, content: null, updatedAt: new Date() } },
      { upsert: true }
    );
    markOk();
    if (!isVercel) await clearDirty(p);
    return { ok: true };
  } catch (e) {
    markDown(e);
    if (isVercel) throw httpErr(502, `Mongo delete failed: ${e.message}`);
    await markDirty(p, 'json');
    return { ok: true, mongoSynced: false };
  }
}

// Public JSON API: statuses are stored by name, handed out as keys.
export async function getFile(p) {
  const r = await getFileRaw(p);
  return r ? { ...r, content: decodeStatuses(p, r.content) } : r;
}
export async function putFile(p, obj /* , { message, author } ignored */) {
  return putFileRaw(p, encodeStatuses(p, obj));
}

/* --------- helpers for the one-time layout migration --------- */
// Read this machine's own disk copy (server only), ignoring Mongo.
export async function readLocal(p) {
  if (isVercel) return null;
  const r = await localGet(p);
  return r ? { ...r, content: decodeStatuses(p, r.content) } : null;
}
// Drop an emptied legacy folder from this server's disk (no-op elsewhere).
export async function removeLocalDirIfEmpty(prefix) {
  if (isVercel) return;
  try { await fs.rmdir(localFull(prefix.replace(/\/$/, ''))); } catch { /* not empty / missing */ }
}
// Every live JSON path under a prefix (Mongo + this server's disk).
export async function listJson(prefix) {
  const out = new Set();
  if (hasMongo()) {
    try {
      const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const docs = await (await col()).find(
        { _id: { $regex: '^' + esc }, deleted: { $ne: true } },
        { projection: { _id: 1 } }
      ).toArray();
      docs.forEach((d) => out.add(String(d._id)));
    } catch (e) { markDown(e); }
  }
  if (!isVercel) {
    const base = localFull(prefix.replace(/\/$/, ''));
    try {
      for (const n of await fs.readdir(base)) if (n.endsWith('.json')) out.add(prefix.replace(/\/?$/, '/') + n);
    } catch { /* no folder */ }
  }
  return [...out];
}
// Every stored binary path under a prefix -> size (GridFS + this server's disk).
export async function listBinary(prefix) {
  const out = new Map();
  if (hasMongo()) {
    try {
      const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const f of await (await bucket()).find({ filename: { $regex: '^' + esc } }).toArray()) out.set(f.filename, f.length);
    } catch (e) { markDown(e); }
  }
  if (!isVercel) {
    const base = localFull(prefix.replace(/\/$/, ''));
    try {
      for (const n of await fs.readdir(base)) {
        if (n.startsWith('.')) continue;
        const st = await fs.stat(path.join(base, n));
        if (st.isFile()) out.set(prefix.replace(/\/?$/, '/') + n, st.size);
      }
    } catch { /* no folder */ }
  }
  return out;
}

/* =============================== BINARY =============================== */
export async function getBinary(p) {
  if (!hasMongo()) {
    if (isVercel) throw notConfigured();
    return localGetBinary(p);
  }
  if (!isVercel) {
    const l = await localGetBinary(p); // server's own disk: fastest, and only the server uploads
    if (l) return l;
  }
  try {
    const buf = await gridRead(p);
    markOk();
    if (buf && !isVercel) await localPutBinary(p, buf).catch(() => {}); // cache for next time
    return buf;
  } catch (e) {
    markDown(e);
    if (isVercel) throw httpErr(503, `Mongo read failed: ${e.message}`);
    return null;
  }
}

export async function putBinary(p, buf) {
  if (!hasMongo()) {
    if (isVercel) throw notConfigured();
    await localPutBinary(p, buf);
    return { ok: true };
  }
  if (!isVercel) await localPutBinary(p, buf);
  try {
    await gridWrite(p, buf);
    markOk();
    if (!isVercel) await clearDirty(p);
    return { ok: true };
  } catch (e) {
    markDown(e);
    if (isVercel) throw httpErr(502, `Mongo write failed: ${e.message}`);
    await markDirty(p, 'bin');
    return { ok: true, mongoSynced: false };
  }
}

export async function deleteBinary(p) {
  if (!hasMongo()) {
    if (!isVercel) await localDelete(p);
    return { ok: true };
  }
  if (!isVercel) await localDelete(p);
  try {
    await gridDelete(p);
    markOk();
    if (!isVercel) await clearDirty(p);
    return { ok: true };
  } catch (e) {
    markDown(e);
    if (isVercel) throw httpErr(502, `Mongo delete failed: ${e.message}`);
    await markDirty(p, 'bin');
    return { ok: true, mongoSynced: false };
  }
}

// Old names used by the routes (they used to mean "debounced GitHub commit").
// Now every write is immediate and goes straight to Mongo.
export const putFileQueued = putFile;
export const deleteFileQueued = deleteFile;
export const putBinaryQueued = putBinary;
export const deleteBinaryQueued = deleteBinary;
export async function flushGithubQueue() { return flushOutbox(); }

/* =============================== SERVER-ONLY BACKGROUND SYNC =============================== */
async function walk(dir, rel = '') {
  let out = [];
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.endsWith('.tmp')) continue;
    if (!rel && SKIP_TOP.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(await walk(path.join(dir, e.name), r));
    else out.push(r);
  }
  return out;
}
const extOf = (n) => (/\.([a-z0-9]+)$/i.exec(n || '') || [])[1]?.toLowerCase() || '';

// Push what changed on disk while Mongo was unreachable.
export async function flushOutbox() {
  if (isVercel || !hasMongo()) return { flushed: 0, failed: 0 };
  const d = await loadDirty();
  let flushed = 0, failed = 0;
  for (const [p, kind] of [...d.entries()]) {
    try {
      if (kind === 'json') {
        const l = await localGet(p);
        await (await col()).updateOne(
          { _id: p },
          l
            ? { $set: { content: l.content, updatedAt: new Date() }, $unset: { deleted: '' } }
            : { $set: { deleted: true, content: null, updatedAt: new Date() } },
          { upsert: true }
        );
      } else {
        const buf = await localGetBinary(p);
        if (buf) await gridWrite(p, buf); else await gridDelete(p);
      }
      d.delete(p);
      flushed++;
      markOk();
    } catch (e) { failed++; markDown(e); }
  }
  if (flushed) await saveDirty();
  return { flushed, failed };
}

// Default: insert-only — copies local files Mongo doesn't know yet and never
// overwrites Mongo (so it can't clobber edits made on Vercel).
// { overwrite: true } (used by scripts/push-data-to-mongo.mjs) replaces Mongo's
// copy with this machine's data/ folder.
export async function pushLocalToMongo({ overwrite = false } = {}) {
  if (isVercel || !hasMongo()) return { json: 0, binary: 0 };
  const base = path.join(REPO_ROOT, dataDir());
  const files = (await walk(base)).map((r) => `${dataDir()}/${r}`);
  const jsons = files.filter((f) => f.endsWith('.json'));
  const bins = files.filter((f) => BINARY_EXT.has(extOf(f)));
  const c = await col();
  let nj = 0, nb = 0;

  const have = new Set((await c.find({ _id: { $in: jsons } }, { projection: { _id: 1 } }).toArray()).map((d) => d._id));
  for (const p of jsons) {
    if (have.has(p) && !overwrite) continue;
    const l = await localGet(p);
    if (!l) continue;
    await c.updateOne(
      { _id: p },
      overwrite
        ? { $set: { content: l.content, updatedAt: new Date() }, $unset: { deleted: '' } }
        : { $setOnInsert: { content: l.content, updatedAt: new Date() } },
      { upsert: true }
    );
    nj++;
  }

  const b = await bucket();
  const haveBin = new Set((await b.find({ filename: { $in: bins } }).toArray()).map((f) => f.filename));
  for (const p of bins) {
    if (haveBin.has(p) && !overwrite) continue;
    const buf = await localGetBinary(p);
    if (buf) { await gridWrite(p, buf); nb++; }
  }
  markOk();
  return { json: nj, binary: nb };
}

// Pull what changed in Mongo (edits made on Vercel) down to the server's disk.
let lastMirror = 0;
export async function pullMongoToLocal() {
  if (isVercel || !hasMongo()) return { json: 0, binary: 0 };
  const started = Date.now();
  const d = await loadDirty();
  const prefix = dataDir() + '/';
  let nj = 0, nb = 0;

  const c = await col();
  const docs = await c.find({ updatedAt: { $gt: new Date(lastMirror) } }).toArray();
  for (const doc of docs) {
    const p = String(doc._id);
    if (!p.startsWith(prefix) || p.split('/')[1] === 'rt' || d.has(p) || p.includes('.write-probe')) continue;
    if (doc.deleted) { await localDelete(p); continue; }
    const cur = await localGet(p);
    if (cur && JSON.stringify(cur.content) === JSON.stringify(doc.content)) continue;
    await localPut(p, doc.content);
    nj++;
  }

  const b = await bucket();
  const latest = new Map();
  for (const f of await b.find({}).sort({ uploadDate: 1 }).toArray()) latest.set(f.filename, f);
  for (const [p, f] of latest) {
    if (!p.startsWith(prefix) || d.has(p)) continue;
    let size = -1;
    try { size = (await fs.stat(localFull(p))).size; } catch { /* missing */ }
    if (size === f.length) continue;
    const buf = await gridRead(p);
    if (buf) { await localPutBinary(p, buf); nb++; }
  }

  lastMirror = started - 120_000; // 2 min overlap to tolerate clock skew between machines
  state.lastSyncAt = new Date().toISOString();
  markOk();
  return { json: nj, binary: nb };
}

let bgStarted = false;
export function startBackgroundSync() {
  if (isVercel || bgStarted || !hasMongo()) return;
  bgStarted = true;
  const tick = async () => {
    try {
      await flushOutbox();
      await pullMongoToLocal();
    } catch (e) { markDown(e); console.error('[sync] failed:', e.message); }
  };
  (async () => {
    try {
      const r = await pushLocalToMongo();
      console.log(`[sync] server -> Mongo (new only): ${r.json} json, ${r.binary} files`);
    } catch (e) { markDown(e); console.error('[sync] initial push failed:', e.message); }
    await tick();
    const t = setInterval(tick, 60_000);
    if (t.unref) t.unref();
  })();
}

/* =============================== STATUS / DIAGNOSE =============================== */
export function status() {
  return {
    mongoConfigured: hasMongo(),
    mongoOk: state.ok,
    pendingSync: pendingQueueSize(),
    lastError: state.lastError,
    lastSyncAt: state.lastSyncAt
  };
}

export async function diagnose() {
  const out = { isVercel, mongoConfigured: hasMongo(), db: DB_NAME(), collection: COLLECTION(), ...status() };
  if (!hasMongo()) {
    out.note = 'MONGODB_URI is not set for this deployment. Server: put it in Map-Panel/.env and restart. Vercel: Project Settings > Environment Variables, then redeploy.';
    return out;
  }
  try {
    const c = await col();
    out.documents = await c.estimatedDocumentCount();
    out.mongoConnection = 'ok';
  } catch (e) {
    out.mongoConnection = 'ERROR: ' + e.message;
    return out;
  }
  try {
    out.diagramsResolved = (await getFile(homePath('diagrams')))?.content?.processes?.length ?? 'NOT FOUND';
    out.pdfsResolved = (await getFile(homePath('pdfs')))?.content?.pdfs?.length ?? 'NOT FOUND';
    out.templatesResolved = (await getFile(homePath('templates')))?.content?.pdfs?.length ?? 'NOT FOUND';
  } catch (e) { out.resolveError = e.message; }
  try {
    const b = await bucket();
    out.storedFiles = (await b.find({}).toArray()).length;
  } catch (e) { out.storedFiles = 'ERR: ' + e.message; }
  try {
    const probe = `${dataDir()}/.write-probe.json`;
    await putFile(probe, { ok: true, ts: Date.now() });
    out.writeProbe = (await getFile(probe)) ? 'ok' : 'wrote but read-back failed';
    await deleteFile(probe);
  } catch (e) { out.writeProbe = 'ERROR: ' + e.message; }
  return out;
}
