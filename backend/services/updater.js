// updater.js — install a new version of Map-Panel from the panel, without
// stopping the Windows service.
//
// A version is a .zip of the project (the same folders: backend/, frontend/,
// api/ …) with an optional update.json at its root:
//   { "version": "1.2.0", "date": "2026-11-20", "title": "…", "notes": ["…", "…"],
//     "remove": ["backend/old-file.js"] }
//
// Flow:  upload → check (what changes, what will happen) → install:
//   1. back up every file that will be overwritten          (.updates/backups/…)
//   2. write the new files
//   3. npm install, only if a package.json changed
//   4. build the frontend into dist-next, then swap it in   (old one stays if the build fails)
//   5. restart only the worker process (server.js supervisor) if backend code changed
// Anything that fails after step 2 puts the old files back automatically.
//
// Never touched by an update: data/, .env files, node_modules, logs, .git,
// frontend/dist (it is rebuilt on the server with the server's own settings).

import fs from 'fs/promises';
import fss from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { versionDir, pruneUi, removeUi } from './uiVersions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');
const UPD = path.join(ROOT, '.updates');
const STATUS = path.join(UPD, 'status.json');
const HISTORY = path.join(UPD, 'history.json');
const PENDING_ZIP = path.join(UPD, 'pending.zip');
const PENDING_PLAN = path.join(UPD, 'pending.json');
const VERSION_FILE = path.join(ROOT, 'version.json');

export const isVercel = !!(process.env.VERCEL === '1' || process.env.VERCEL_ENV || process.env.NOW_REGION);
export const supervised = () => !!process.send && process.env.MP_SUPERVISED === '1';

/* ------------------------------------------------------------------ */
/* version                                                             */
/* ------------------------------------------------------------------ */
export function readVersion() {
  try {
    const v = JSON.parse(fss.readFileSync(VERSION_FILE, 'utf8'));
    return { version: String(v.version || '1.0.0'), date: v.date || null, title: v.title || null, notes: Array.isArray(v.notes) ? v.notes : [] };
  } catch {
    return { version: '1.0.0', date: null, title: null, notes: [] };
  }
}

export function compareVersions(a, b) {
  const pa = String(a || '0').split(/[.-]/).map(x => parseInt(x, 10) || 0);
  const pb = String(b || '0').split(/[.-]/).map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function bump(v) {
  const p = String(v || '1.0.0').split('.').map(x => parseInt(x, 10) || 0);
  while (p.length < 3) p.push(0);
  p[2] += 1;
  return p.join('.');
}

/* ------------------------------------------------------------------ */
/* zip reader (stored + deflate; what Windows, 7-Zip and our tool make) */
/* ------------------------------------------------------------------ */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw httpErr(400, 'Fayl boşdur və ya zip deyil.');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw httpErr(400, 'Bu fayl zip arxivi deyil.');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) throw httpErr(400, 'ZIP64 arxivləri dəstəklənmir.');
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw httpErr(400, 'Zip arxivi zədələnib.');
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const rawName = buf.subarray(off + 46, off + 46 + nlen);
    const name = (flags & 0x800) ? rawName.toString('utf8') : rawName.toString('latin1');
    off += 46 + nlen + elen + clen;
    if (name.endsWith('/') || name.endsWith('\\')) continue;
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw httpErr(400, `Zip arxivi zədələnib (${name}).`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw httpErr(400, `"${name}" faylı dəstəklənməyən üsulla sıxılıb.`);
    if (flags & 0x1) throw httpErr(400, 'Şifrəli zip dəstəklənmir.');
    out.push({ name, data });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* which files an update may touch                                     */
/* ------------------------------------------------------------------ */
const ROOT_FILES = new Set(['package.json', 'package-lock.json', 'vercel.json', 'version.json', '.gitignore']);
const TOP_DIRS = ['backend', 'frontend', 'api'];

function cleanPath(name) {
  let p = String(name).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (!p || p.split('/').some(s => s === '..' || s === '') || /^[a-z]:/i.test(p)) return null;
  return p;
}

function blockedReason(p) {
  const segs = p.split('/');
  const base = segs[segs.length - 1];
  if (segs.includes('node_modules')) return 'node_modules';
  if (segs.includes('.git')) return '.git';
  if (segs[0] === 'data' || segs[0] === '.updates') return 'data';
  if (/^\.env/i.test(base)) return '.env';
  if (/\.log$/i.test(base)) return 'log';
  if (base === '.DS_Store' || base === 'Thumbs.db') return 'junk';
  if (p.startsWith('frontend/dist') ) return 'dist';
  if (p.startsWith('backend/restore/')) return 'data';
  if (segs.length === 1) return ROOT_FILES.has(base) || /\.md$/i.test(base) ? null : 'root';
  if (!TOP_DIRS.includes(segs[0])) return 'outside';
  return null;
}

// "Map-Panel-Server/backend/x.js" -> "backend/x.js"
function stripCommonRoot(entries) {
  for (let pass = 0; pass < 3; pass++) {
    const firsts = new Set(entries.map(e => e.path.split('/')[0]));
    if (firsts.size !== 1) break;
    const only = [...firsts][0];
    if (TOP_DIRS.includes(only) || entries.some(e => !e.path.includes('/'))) break;
    entries.forEach(e => { e.path = e.path.slice(only.length + 1); });
  }
  return entries;
}

const sha1 = b => crypto.createHash('sha1').update(b).digest('hex');

/* ------------------------------------------------------------------ */
/* plan                                                                */
/* ------------------------------------------------------------------ */
export async function makePlan(zipBuf) {
  const entries = stripCommonRoot(readZip(zipBuf).map(e => ({ path: cleanPath(e.name), data: e.data })).filter(e => e.path));
  let manifest = {};
  const man = entries.find(e => e.path === 'update.json');
  if (man) {
    try { manifest = JSON.parse(man.data.toString('utf8').replace(/^﻿/, '')); }
    catch { throw httpErr(400, 'update.json oxuna bilmədi (JSON xətası).'); }
  }
  const cur = readVersion();
  const files = [];
  const skipped = {};
  for (const e of entries) {
    if (e.path === 'update.json') continue;
    const why = blockedReason(e.path);
    if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
    files.push(e);
  }
  if (!files.length) throw httpErr(400, 'Zip-də quraşdırıla bilən fayl tapılmadı (backend/, frontend/, api/ qovluqları gözlənilir).');

  const added = [], changed = [];
  let same = 0;
  for (const f of files) {
    const full = path.join(ROOT, f.path);
    let old = null;
    try { old = await fs.readFile(full); } catch { /* new file */ }
    if (!old) added.push(f.path);
    else if (sha1(old) !== sha1(f.data)) changed.push(f.path);
    else same++;
  }
  const remove = (Array.isArray(manifest.remove) ? manifest.remove : [])
    .map(cleanPath).filter(p => p && !blockedReason(p) && fss.existsSync(path.join(ROOT, p)));

  const touched = [...added, ...changed, ...remove];
  const any = re => touched.some(p => re.test(p));
  const version = String(manifest.version || '').trim() || bump(cur.version);
  const plan = {
    id: crypto.randomBytes(6).toString('hex'),
    version,
    from: cur.version,
    title: manifest.title || null,
    date: manifest.date || new Date().toISOString().slice(0, 10),
    notes: Array.isArray(manifest.notes) ? manifest.notes.map(String).filter(Boolean).slice(0, 60) : [],
    hasManifest: !!man,
    files: { added, changed, remove, same, skipped },
    needs: {
      frontendInstall: any(/^frontend\/package(-lock)?\.json$/),
      frontendBuild: fss.existsSync(path.join(ROOT, 'frontend', 'package.json')),   // every version gets its own interface
      backendInstall: any(/^backend\/package(-lock)?\.json$/),
      workerRestart: any(/^(backend|api)\//),
      fullRestart: any(/^backend\/server\.js$/)
    },
    older: compareVersions(version, cur.version) < 0,
    sameVersion: compareVersions(version, cur.version) === 0,
    nothingChanged: touched.length === 0,
    createdAt: new Date().toISOString()
  };
  return { plan, files };
}

export async function savePending(zipBuf, plan) {
  await fs.mkdir(UPD, { recursive: true });
  await fs.writeFile(PENDING_ZIP, zipBuf);
  await fs.writeFile(PENDING_PLAN, JSON.stringify(plan, null, 2));
}
export async function readPending() {
  try { return JSON.parse(await fs.readFile(PENDING_PLAN, 'utf8')); } catch { return null; }
}
export async function discardPending() {
  await fs.rm(PENDING_ZIP, { force: true });
  await fs.rm(PENDING_PLAN, { force: true });
}

/* ------------------------------------------------------------------ */
/* status + history                                                    */
/* ------------------------------------------------------------------ */
async function readJson(p, fb) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fb; } }
async function writeJson(p, v) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(v, null, 2));
  await fs.rename(tmp, p);
}
export const readStatus = () => readJson(STATUS, { state: 'idle' });
export const readHistory = () => readJson(HISTORY, []);

let running = null;   // the install/rollback in progress (this process)
let status = null;
async function setStatus(patch) {
  status = { ...(status || {}), ...patch, updatedAt: new Date().toISOString() };
  await writeJson(STATUS, status).catch(() => {});
  return status;
}
async function step(key, state, extra = {}) {
  const steps = (status?.steps || []).map(s => (s.key === key ? { ...s, state, ...extra } : s));
  await setStatus({ steps });
}
function appendLog(text) {
  if (!status) return;
  const log = ((status.log || '') + text).slice(-12000);
  status.log = log;
}

/** Called once the (new) worker is listening. Finishes a restart-type update. */
export async function markBootDone() {
  const st = await readStatus();
  if (st?.state === 'failed' && st.rolledBack && st.to && !st.historyFixed) {
    // server.js undid a version that could not start — keep history honest
    const hist = await readHistory();
    const h = hist.find(x => x.version === st.to && !x.rolledBack);
    if (h) { h.rolledBack = true; h.rolledBackAt = st.finishedAt; h.failedToStart = true; await writeJson(HISTORY, hist); }
    await writeJson(STATUS, { ...st, historyFixed: true });
    return;
  }
  if (!st || st.state !== 'restarting') return;
  const v = readVersion().version;
  status = st;
  const steps = (st.steps || []).map(s => (s.key === 'restart' ? { ...s, state: 'done' } : s));
  if (v === st.to) await setStatus({ state: 'done', steps, finishedAt: new Date().toISOString(), bootedVersion: v });
  else await setStatus({ state: 'failed', steps, error: `Server ${v} versiyası ilə açıldı, ${st.to} gözlənilirdi.`, finishedAt: new Date().toISOString() });
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
function run(cmd, args, cwd, label) {
  return new Promise((resolve, reject) => {
    appendLog(`\n$ ${cmd} ${args.join(' ')}   (${path.relative(ROOT, cwd) || '.'})\n`);
    const child = spawn(cmd, args, { cwd, shell: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0' }, windowsHide: true });
    const onData = d => { appendLog(String(d)); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const t = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 10 * 60 * 1000);
    child.on('error', e => { clearTimeout(t); reject(new Error(`${label}: ${e.message}`)); });
    child.on('close', code => {
      clearTimeout(t);
      setStatus({}).catch(() => {});
      if (code === 0) resolve();
      else reject(new Error(`${label} alınmadı (kod ${code}). Jurnala baxın.`));
    });
  });
}

async function renameRetry(a, b) {
  for (let i = 0; i < 8; i++) {
    try { await fs.rename(a, b); return true; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
      await new Promise(r => setTimeout(r, 400));
    }
  }
  return false;
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

/** frontend/dist-next → frontend/dist (old one kept as dist-prev). */
async function swapDist() {
  const fe = path.join(ROOT, 'frontend');
  const next = path.join(fe, 'dist-next'), dist = path.join(fe, 'dist'), prev = path.join(fe, 'dist-prev');
  if (!fss.existsSync(path.join(next, 'index.html'))) throw new Error('Frontend qurulmadı: dist-next/index.html yoxdur.');
  await fs.rm(prev, { recursive: true, force: true });
  if (fss.existsSync(dist)) {
    if (!(await renameRetry(dist, prev))) {
      // Windows keeps a file in dist open → copy over it instead
      appendLog('\n(dist qovluğu məşğuldur, fayllar üzərinə köçürülür)\n');
      await copyDir(next, dist);
      await fs.rm(next, { recursive: true, force: true });
      return;
    }
  }
  if (!(await renameRetry(next, dist))) {
    await copyDir(next, dist);
    await fs.rm(next, { recursive: true, force: true });
  }
}

// A Windows service often has a short PATH; npm sits next to node.exe.
function npmCmd() {
  const win = process.platform === 'win32';
  const local = path.join(path.dirname(process.execPath), win ? 'npm.cmd' : 'npm');
  if (fss.existsSync(local)) return win ? `"${local}"` : local;
  return win ? 'npm.cmd' : 'npm';
}
async function npm(args, cwd, label) {
  await run(npmCmd(), args, cwd, label);
}

/**
 * Builds this version's interface into frontend/versions/<version>/ next to
 * the older ones. Nobody is moved onto it: every user switches from their own
 * bell when they want (services/uiVersions.js).
 */
async function buildFrontend(plan) {
  const fe = path.join(ROOT, 'frontend');
  if (!fss.existsSync(path.join(fe, 'node_modules', 'vite'))) {
    await npm(['install', '--no-audit', '--no-fund'], fe, 'Frontend paketləri');
  }
  const base = `${(process.env.BASE_PATH || '').replace(/\/+$/, '')}/ui/${plan.version}/`;
  const tmp = path.join(fe, 'versions-next', plan.version);
  await fs.rm(path.join(fe, 'versions-next'), { recursive: true, force: true });
  // vite also reads the server's frontend/.env.production.local (VITE_API_URL …)
  await npm(['run', 'build', '--', '--outDir', `versions-next/${plan.version}`, '--emptyOutDir', '--base', base], fe, 'Frontend qurulması');
  if (!fss.existsSync(path.join(tmp, 'index.html'))) throw new Error('Frontend qurulmadı: index.html yoxdur.');
  await writeJson(path.join(tmp, 'ui-version.json'), {
    version: plan.version, date: plan.date, title: plan.title, notes: plan.notes || [], builtAt: new Date().toISOString()
  });
  const dest = versionDir(plan.version);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { recursive: true, force: true });
  if (!(await renameRetry(tmp, dest))) await copyDir(tmp, dest);
  await fs.rm(path.join(fe, 'versions-next'), { recursive: true, force: true });
  pruneUi();
}

function requestRestart(reason) {
  if (!supervised()) return false;
  setTimeout(() => process.send({ type: 'restart', reason }), 900);
  return true;
}

/* ------------------------------------------------------------------ */
/* install                                                             */
/* ------------------------------------------------------------------ */
export async function startInstall(user) {
  if (isVercel) throw httpErr(400, 'Vercel-də yeniləmə GitHub push ilə olur.');
  if (running) throw httpErr(409, 'Yeniləmə artıq gedir.');
  const plan = await readPending();
  if (!plan || !fss.existsSync(PENDING_ZIP)) throw httpErr(400, 'Quraşdırılacaq yeniləmə yoxdur. Əvvəlcə faylı yükləyin.');
  const zip = await fs.readFile(PENDING_ZIP);
  const { plan: fresh, files } = await makePlan(zip);   // re-check against the disk right now
  fresh.notes = plan.notes; fresh.version = plan.version; fresh.title = plan.title; fresh.date = plan.date;

  const steps = [
    { key: 'backup', label: 'Hazırkı fayllar ehtiyata alınır' },
    { key: 'files', label: 'Yeni fayllar yazılır' },
    ...(fresh.needs.backendInstall ? [{ key: 'deps', label: 'Server paketləri yenilənir (npm install)' }] : []),
    ...(fresh.needs.frontendBuild ? [{ key: 'build', label: 'Yeni interfeys versiyası qurulur' }] : []),
    { key: 'restart', label: fresh.needs.workerRestart ? 'Server yenidən başladılır' : 'Tamamlanır' }
  ].map(s => ({ ...s, state: 'waiting' }));

  status = null;
  await setStatus({
    state: 'installing', id: fresh.id, to: fresh.version, from: fresh.from, by: user || null,
    steps, log: '', error: null, startedAt: new Date().toISOString(), finishedAt: null,
    needs: fresh.needs
  });
  running = doInstall(fresh, files, user).finally(() => { running = null; });
  return status;
}

async function doInstall(plan, files, user) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(UPD, 'backups', `${plan.from}-to-${plan.version}-${stamp}`);
  const changedSet = new Set([...plan.files.added, ...plan.files.changed]);
  const toWrite = files.filter(f => changedSet.has(f.path));
  const backup = { from: plan.from, to: plan.version, at: new Date().toISOString(), restore: [], created: [], removed: [], versionFile: null };
  let wrote = false;
  let builtUi = false;

  try {
    // 1. backup
    await step('backup', 'active');
    await fs.mkdir(path.join(backupDir, 'files'), { recursive: true });
    for (const p of [...plan.files.changed, ...plan.files.remove]) {
      const src = path.join(ROOT, p), dst = path.join(backupDir, 'files', p);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
      backup.restore.push(p);
    }
    if (fss.existsSync(VERSION_FILE)) {
      backup.versionFile = await fs.readFile(VERSION_FILE, 'utf8');
    }
    backup.created = [...plan.files.added];
    await writeJson(path.join(backupDir, 'backup.json'), backup);
    await step('backup', 'done', { detail: `${backup.restore.length} fayl` });

    // 2. files
    await step('files', 'active');
    wrote = true;
    for (const f of toWrite) {
      const full = path.join(ROOT, f.path);
      if (!full.startsWith(ROOT + path.sep)) continue;
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, f.data);
    }
    for (const p of plan.files.remove) await fs.rm(path.join(ROOT, p), { force: true });
    await writeJson(VERSION_FILE, {
      version: plan.version, date: plan.date, title: plan.title, notes: plan.notes,
      installedAt: new Date().toISOString(), installedBy: user || null
    });
    await step('files', 'done', { detail: `${toWrite.length} fayl yazıldı${plan.files.remove.length ? `, ${plan.files.remove.length} silindi` : ''}` });

    // 3. deps
    if (plan.needs.backendInstall) {
      await step('deps', 'active');
      await npm(['install', '--omit=dev', '--no-audit', '--no-fund'], path.join(ROOT, 'backend'), 'Server paketləri');
      await step('deps', 'done');
    }

    // 4. build
    if (plan.needs.frontendBuild) {
      await step('build', 'active');
      if (plan.needs.frontendInstall) await npm(['install', '--no-audit', '--no-fund'], path.join(ROOT, 'frontend'), 'Frontend paketləri');
      await buildFrontend(plan);
      builtUi = true;
      await step('build', 'done');
    }

    // history
    const hist = await readHistory();
    hist.unshift({
      version: plan.version, from: plan.from, title: plan.title, notes: plan.notes, date: plan.date,
      at: new Date().toISOString(), by: user || null,
      files: { added: plan.files.added.length, changed: plan.files.changed.length, removed: plan.files.remove.length },
      backup: path.basename(backupDir)
    });
    await writeJson(HISTORY, hist.slice(0, 50));
    await discardPending();

    // 5. restart
    if (plan.needs.workerRestart) {
      if (requestRestart(`update ${plan.version}`)) {
        await step('restart', 'active');
        // if the new version cannot start, server.js puts these files back
        await setStatus({ state: 'restarting', backup: path.basename(backupDir), frontendSwapped: false });
      } else {
        await step('restart', 'done', { detail: 'Əl ilə yenidən başlatmaq lazımdır' });
        await setStatus({ state: 'done', manualRestart: true, finishedAt: new Date().toISOString() });
      }
    } else {
      await step('restart', 'done');
      await setStatus({ state: 'done', finishedAt: new Date().toISOString() });
    }
  } catch (e) {
    appendLog(`\nXƏTA: ${e.message}\n`);
    const cur = (status?.steps || []).find(s => s.state === 'active');
    if (cur) await step(cur.key, 'failed');
    let rolledBack = false;
    if (wrote) {
      try { await restoreBackup(backupDir); rolledBack = true; } catch (re) { appendLog(`\nBərpa alınmadı: ${re.message}\n`); }
      if (builtUi) removeUi(plan.version);
    }
    await setStatus({
      state: 'failed', error: e.message, rolledBack,
      finishedAt: new Date().toISOString()
    });
  }
}

async function restoreBackup(backupDir) {
  const b = await readJson(path.join(backupDir, 'backup.json'), null);
  if (!b) throw new Error('Ehtiyat nüsxə tapılmadı.');
  for (const p of b.restore) {
    const full = path.join(ROOT, p);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.copyFile(path.join(backupDir, 'files', p), full);
  }
  for (const p of b.created) await fs.rm(path.join(ROOT, p), { force: true });
  if (b.versionFile != null) await fs.writeFile(VERSION_FILE, b.versionFile);
  else await fs.rm(VERSION_FILE, { force: true });
  return b;
}

/* ------------------------------------------------------------------ */
/* rollback (the last installed version → the one before it)           */
/* ------------------------------------------------------------------ */
export async function startRollback(user) {
  if (isVercel) throw httpErr(400, 'Vercel-də geri qaytarma GitHub ilə olur.');
  if (running) throw httpErr(409, 'Başqa əməliyyat gedir.');
  const hist = await readHistory();
  const last = hist.find(h => !h.rolledBack && h.backup);
  if (!last) throw httpErr(400, 'Geri qaytarmaq üçün quraşdırılmış yeniləmə yoxdur.');
  const backupDir = path.join(UPD, 'backups', last.backup);
  const b = await readJson(path.join(backupDir, 'backup.json'), null);
  if (!b) throw httpErr(400, 'Bu versiyanın ehtiyat nüsxəsi tapılmadı.');
  const touched = [...b.restore, ...b.created];
  const needs = {
    frontendInstall: touched.some(p => /^frontend\/package(-lock)?\.json$/.test(p)),
    frontendBuild: false,   // the older interface is still there; only the rolled-back one is removed
    backendInstall: touched.some(p => /^backend\/package(-lock)?\.json$/.test(p)),
    workerRestart: touched.some(p => /^(backend|api)\//.test(p))
  };
  const steps = [
    { key: 'files', label: `${last.from} versiyasının faylları qaytarılır` },
    ...(needs.backendInstall ? [{ key: 'deps', label: 'Server paketləri (npm install)' }] : []),
    ...(needs.frontendBuild ? [{ key: 'build', label: 'İnterfeys yenidən qurulur' }] : []),
    { key: 'restart', label: needs.workerRestart ? 'Server yenidən başladılır' : 'Tamamlanır' }
  ].map(s => ({ ...s, state: 'waiting' }));
  status = null;
  await setStatus({ state: 'installing', rollback: true, to: last.from, from: last.version, by: user || null, steps, log: '', error: null, startedAt: new Date().toISOString(), finishedAt: null, needs });

  running = (async () => {
    try {
      await step('files', 'active');
      await restoreBackup(backupDir);
      removeUi(last.version);   // users on it move to the newest one left
      await step('files', 'done');
      if (needs.backendInstall) { await step('deps', 'active'); await npm(['install', '--omit=dev', '--no-audit', '--no-fund'], path.join(ROOT, 'backend'), 'Server paketləri'); await step('deps', 'done'); }
      if (needs.frontendBuild) { await step('build', 'active'); if (needs.frontendInstall) await npm(['install', '--no-audit', '--no-fund'], path.join(ROOT, 'frontend'), 'Frontend paketləri'); await buildFrontend({ version: last.from, date: null, notes: [] }); await step('build', 'done'); }
      last.rolledBack = true; last.rolledBackAt = new Date().toISOString();
      await writeJson(HISTORY, hist);
      if (needs.workerRestart && requestRestart(`rollback to ${last.from}`)) {
        await step('restart', 'active');
        await setStatus({ state: 'restarting' });
      } else {
        await step('restart', 'done');
        await setStatus({ state: 'done', manualRestart: needs.workerRestart && !supervised(), finishedAt: new Date().toISOString() });
      }
    } catch (e) {
      appendLog(`\nXƏTA: ${e.message}\n`);
      const cur = (status?.steps || []).find(s => s.state === 'active');
      if (cur) await step(cur.key, 'failed');
      await setStatus({ state: 'failed', error: e.message, finishedAt: new Date().toISOString() });
    }
  })().finally(() => { running = null; });
  return status;
}

export function isRunning() { return !!running; }

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
