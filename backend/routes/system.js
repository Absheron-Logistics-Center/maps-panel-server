// routes/system.js — version + "install an update" for the own server.
//   GET    /api/system/version          (public) current version, for the reload toast
//   GET    /api/system/update           developer: version, pending update, status, history
//   POST   /api/system/update/upload    developer: body = the .zip (application/octet-stream)
//   DELETE /api/system/update/pending   developer: forget the uploaded file
//   POST   /api/system/update/install   developer: install the uploaded version
//   GET    /api/system/update/status    developer: progress of the install
//   POST   /api/system/update/rollback  developer: back to the version before the last update
import express, { Router } from 'express';
import {
  readVersion, makePlan, savePending, readPending, discardPending, readStatus, readHistory,
  startInstall, startRollback, isVercel, supervised, isRunning
} from '../services/updater.js';
import { forUser, switchUser, setAuto, listUi, enabled as uiEnabled } from '../services/uiVersions.js';

const router = Router();
const bootedAt = new Date().toISOString();

export function publicVersion(_req, res) {
  const v = readVersion();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: v.version, date: v.date, title: v.title, where: isVercel ? 'vercel' : 'server', bootedAt });
}

// Installing versions is developer work: admins do not see or change it.
// Reading the progress stays open to admins, so a window opened before this
// rule existed can still see its install finish.
// Installing versions is developer work. Reading the progress stays open to
// admins, so a window opened by an older version can still see it finish.
function requireDev(req, res, next) {
  if (req.user?.dev) return next();
  if (req.method === 'GET' && req.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'Yalnız developer' });
}
router.use(requireDev);

const wrap = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
};

router.get('/update', wrap(async (_req, res) => {
  const [pending, status, history] = await Promise.all([
    isVercel ? null : readPending(),
    isVercel ? { state: 'idle' } : readStatus(),
    isVercel ? [] : readHistory()
  ]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    current: readVersion(),
    where: isVercel ? 'vercel' : 'server',
    canUpdate: !isVercel,
    supervised: supervised(),
    bootedAt,
    pid: process.pid,
    pending, status, history,
    running: isRunning(),
    interfaces: uiEnabled() ? listUi().map(v => ({ version: v.version, date: v.date, legacy: !!v.legacy })) : []
  });
}));

router.post('/update/upload',
  express.raw({ type: () => true, limit: '250mb' }),
  wrap(async (req, res) => {
    if (isVercel) return res.status(400).json({ error: 'Vercel-də yeniləmə GitHub push ilə olur. Bu düymə yalnız öz serverdə işləyir.' });
    if (isRunning()) return res.status(409).json({ error: 'Yeniləmə gedir, bitməsini gözləyin.' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Fayl göndərilmədi.' });
    const { plan } = await makePlan(buf);
    plan.fileName = String(req.headers['x-file-name'] || '').slice(0, 200) || null;
    plan.size = buf.length;
    plan.uploadedBy = req.user?.username || null;
    await savePending(buf, plan);
    res.json(plan);
  })
);

router.delete('/update/pending', wrap(async (_req, res) => {
  if (isRunning()) return res.status(409).json({ error: 'Yeniləmə gedir.' });
  await discardPending();
  res.json({ ok: true });
}));

router.post('/update/install', wrap(async (req, res) => {
  res.json(await startInstall(req.user?.name || req.user?.username));
}));

router.get('/update/status', wrap(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...(await readStatus()), running: isRunning(), current: readVersion().version, bootedAt });
}));

router.post('/update/rollback', wrap(async (req, res) => {
  res.json(await startRollback(req.user?.username));
}));

export default router;

/* ------------------------------------------------------------------ *
 * Each user's own interface version (every role, like a phone update).
 *   GET  /api/ui            { enabled, mine, latest, newer:[{version,date,notes}] }
 *   POST /api/ui {version}  switch me to that version
 *   POST /api/ui {auto}     my "update by itself" switch
 * ------------------------------------------------------------------ */
export const uiRouter = Router();
uiRouter.get('/', wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!uiEnabled()) return res.json({ enabled: false });
  res.json(await forUser(req.user.username));
}));
uiRouter.post('/', wrap(async (req, res) => {
  if (!uiEnabled()) return res.status(400).json({ error: 'Bu serverdə interfeys versiyaları yoxdur.' });
  const b = req.body || {};
  if (b.version === undefined && b.auto !== undefined) return res.json(await setAuto(req.user.username, b.auto));
  if (b.auto !== undefined) await setAuto(req.user.username, b.auto);
  res.json(await switchUser(req.user.username, String(b.version || '')));
}));
