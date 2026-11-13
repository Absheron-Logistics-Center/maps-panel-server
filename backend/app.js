import './env.js'; // MUST be first: loads .env before any other module reads process.env
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import express from 'express';
import cors from 'cors';

import authRouter, { requireAuth } from './routes/auth.js';
import processesRouter from './routes/processes.js';
import pdfsRouter from './routes/pdfs.js';
import templatesRouter from './routes/templates.js';
import jobsRouter from './routes/jobs.js';
import settingsRouter from './routes/settings.js';
import labelsRouter from './routes/labels.js';
import sheetsRouter from './routes/sheets.js';
import aiRouter from './routes/ai.js';
import systemRouter, { publicVersion, uiRouter } from './routes/system.js';
import { VERSIONS_DIR, indexFor } from './services/uiVersions.js';
import usersRouter from './routes/users.js';
import presenceRouter, { presenceStream } from './routes/presence.js';
import { markBootDone } from './services/updater.js';
import { diagnose as diagnoseMongo, status as storeStatus, startBackgroundSync } from './services/store.js';
import { ensureLayout } from './services/migrate.js';
import { startBackgroundLearning } from './services/aiLearn.js';

const app = express();
const PORT = process.env.PORT || 4000;
const isVercel = !!(process.env.VERCEL === '1' || process.env.VERCEL_ENV || process.env.NOW_REGION);

// Self-hosting under a path prefix (e.g. behind IIS/Apache at
// http://server/maps-panel alongside other apps on the same box) — set
// BASE_PATH=/maps-panel in .env. Empty by default so Vercel deployments
// (which serve from the domain root) are completely unaffected.
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');
const mount = (p) => (BASE_PATH + p) || '/';
 
// CORS
// Origins are normalized (trailing slash + case) so a small mismatch like
// "https://maps-panel.vercel.app/" vs "https://maps-panel.vercel.app" doesn't
// silently fail — and any rejection is logged so it's visible in Vercel logs
// instead of just showing up as an unexplained CORS error in the browser.
function normalizeOrigin(o) {
  return String(o || '').trim().replace(/\/+$/, '').toLowerCase();
}
const allowed = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map(normalizeOrigin)
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / server-to-server / curl
    if (allowed.includes('*')) return cb(null, true);

    const norm = normalizeOrigin(origin);
    if (allowed.includes(norm)) return cb(null, true);

    console.warn('[CORS] rejected origin:', origin, '| allowed:', allowed);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: false
}));

// JSON
// Uploads are sent as base64 inside JSON, which inflates size by ~33%.
// The app enforces a 20MB PDF cap (see routes/pdfs.js, routes/templates.js);
// this body limit just needs enough headroom above that so a legitimate
// 20MB file isn't rejected by Express before it ever reaches that check.
app.use(express.json({
  limit: '30mb'
}));

// DEBUG
console.log('SERVER LOADED');

// HEALTH
app.get([mount('/api/health'), mount('/health')], (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    // Vercel's serverless functions can't reliably handle large PDF
    // uploads (request size/time limits), so file upload is server-only.
    // Everything else (diagrams, sheets, pdf/template lists, status,
    // rename, delete, viewing files) works the same on both and shares
    // ONE MongoDB.
    uploadsEnabled: true,
    maxUploadBytes: isVercel ? 3 * 1024 * 1024 : 20 * 1024 * 1024,
    where: isVercel ? 'vercel' : 'server',
    storage: storeStatus()
  });
});

// DEBUG — public, no secrets. Tells you why data isn't loading on Vercel,
// or why the frontend isn't being served on your self-hosted server.
app.get([mount('/api/debug'), mount('/debug')], async (_req, res) => {
  const out = {};
  try { out.mongo = await diagnoseMongo(); } catch (e) { out.mongo = { error: e.message }; }
  const distDir = path.join(__dirname, '..', 'frontend', 'dist');
  const indexHtml = path.join(distDir, 'index.html');
  out.frontend = {
    BASE_PATH: BASE_PATH || '(empty — root)',
    SERVE_FRONTEND: process.env.SERVE_FRONTEND || '(not set)',
    distDir,
    distDirExists: fs.existsSync(distDir),
    indexHtmlExists: fs.existsSync(indexHtml),
    distDirContents: fs.existsSync(distDir) ? fs.readdirSync(distDir) : null
  };
  res.json(out);
});

// Data layout migration (old file names -> home/hesabat/…) must finish
// before any data route reads or writes. Runs once per process; cheap after.
app.use(async (req, res, next) => {
  if (/\/(health|debug|login|me|version)$/.test(req.path) || /\/(system|presence|users|ui)(\/|$)/.test(req.path)) return next();
  try { await ensureLayout(); next(); }
  catch (e) { console.error('[migrate] failed:', e.message); res.status(503).json({ error: 'Məlumat hazırlanır, bir az sonra yenidən cəhd edin (' + e.message + ')' }); }
});

// PUBLIC ROUTES
// version check (every logged-in page polls it to offer "reload" after an update)
app.get([mount('/api/system/version'), mount('/system/version')], publicVersion);
// live cursors: EventSource cannot send headers, so the stream checks ?token= itself
app.get([mount('/api/presence/stream'), mount('/presence/stream')], presenceStream);
app.use([mount('/api/presence'), mount('/presence')], requireAuth, presenceRouter);
app.use([mount('/api'), mount('/')], authRouter);

// PROTECTED ROUTES
app.use([mount('/api/processes'), mount('/processes')], requireAuth, processesRouter);
app.use([mount('/api/pdfs'), mount('/pdfs')], requireAuth, pdfsRouter);
app.use([mount('/api/templates'), mount('/templates')], requireAuth, templatesRouter);
app.use([mount('/api/jobs'), mount('/jobs')], requireAuth, jobsRouter);
app.use([mount('/api/settings'), mount('/settings')], requireAuth, settingsRouter);
app.use([mount('/api/labels'), mount('/labels')], requireAuth, labelsRouter);
app.use([mount('/api/sheets'), mount('/sheets')], requireAuth, sheetsRouter);
app.use([mount('/api/ai'), mount('/ai')], requireAuth, aiRouter);
app.use([mount('/api/system'), mount('/system')], requireAuth, systemRouter);
app.use([mount('/api/users'), mount('/users')], requireAuth, usersRouter);
app.use([mount('/api/ui'), mount('/ui-version')], requireAuth, uiRouter);

// SELF-HOSTED FRONTEND — Vercel builds+serves the frontend separately
// (see vercel.json's static-build); that never sets SERVE_FRONTEND, so
// this whole block is a no-op there. On your own server, set
// SERVE_FRONTEND=1 and this Express app serves the built frontend
// (frontend/dist, built with `npm run build` after setting
// VITE_API_URL=<BASE_PATH>/api and vite's `base` to <BASE_PATH>/) plus
// the API, both under BASE_PATH, from this one process.
if (process.env.SERVE_FRONTEND === '1') {
  const distDir = path.join(__dirname, '..', 'frontend', 'dist');
  const apiPrefix = mount('/api');
  // every installed interface version: <BASE_PATH>/ui/<version>/…
  app.use(mount('/ui'), express.static(VERSIONS_DIR, { index: false, fallthrough: true, maxAge: '30d', immutable: true }));
  // the build from before versions existed (its files sit at the root)
  app.use(mount('/'), express.static(distDir, { index: false }));
  app.get(mount('/*'), (req, res, next) => {
    if (req.path.startsWith(apiPrefix)) return next(); // let it fall through to the 404 JSON handler
    if (req.path.startsWith(mount('/ui/'))) return res.status(404).end();
    // which interface this browser runs: the mp_ui cookie (set by the page
    // from the user's own choice); without it, the newest one
    const m = /(?:^|;\s*)mp_ui=([^;]+)/.exec(req.headers.cookie || '');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(indexFor(m ? decodeURIComponent(m[1]) : null));
  });
}

// 404 — show the URL Express actually saw, so we can debug from Vercel logs
app.use((req, res) => {
  console.warn('[404]', req.method, req.url);
  res.status(404).json({
    error: 'Route not found',
    method: req.method,
    url: req.url
  });
});

// ERROR HANDLER
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);

  res.status(err.status || 500).json({
    error: err.message || 'Server error'
  });
});


if (!isVercel) {
  // Started by server.js (the supervisor) as a worker: if the supervisor goes
  // away (service stopped), go with it — never keep port 4000 as an orphan.
  if (process.send) process.on('disconnect', () => process.exit(0));
  // ALM-AI studies the team's diagrams in the background, 24/7 (own server only)
  try { startBackgroundLearning(); } catch (e) { console.warn('[ai-learn] not started:', e.message); }
  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend running on port ${PORT}${BASE_PATH ? ` (base path ${BASE_PATH})` : ''}${process.send ? ' [worker]' : ''}`);
    markBootDone().catch(e => console.warn('[update] boot status:', e.message));
    // server only: move data to the new layout first, then keep data/ and
    // MongoDB in step (see services/store.js)
    ensureLayout()
      .catch((e) => console.error('[migrate] failed at start:', e.message))
      .finally(() => startBackgroundSync());
  });
  httpServer.on('error', (e) => {
    // e.g. the previous worker still holds the port for a moment after an update
    console.error('[listen]', e.code || e.message);
    if (e.code === 'EADDRINUSE') setTimeout(() => process.exit(1), 1500);
  });
  app.locals.httpServer = httpServer;
}

// VERCEL EXPORT (api/index.js imports this file)
export default app;