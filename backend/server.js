// server.js — the process the Windows service runs (`node server.js`).
//
// On the own server it is a small SUPERVISOR: it starts the real app
// (app.js) as a child "worker" and keeps it alive.
//   * An update installed from the panel asks for a restart → only the worker
//     is replaced, in about 2 seconds. The service itself never stops, so
//     `net stop / net start MapsPanel` is no longer needed after updates.
//   * If the worker crashes it is started again (with a short back-off).
//
// This file is kept deliberately tiny and does not change between updates.
// (An update that does change it says "full restart needed" in the panel.)
//
// On Vercel, or with MP_NO_SUPERVISOR=1, it simply loads the app in-process.
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const isVercel = !!(process.env.VERCEL === '1' || process.env.VERCEL_ENV || process.env.NOW_REGION);
const SELF = fileURLToPath(import.meta.url);

let app = null;

if (isVercel || process.env.MP_WORKER === '1' || process.env.MP_NO_SUPERVISOR === '1') {
  app = (await import('./app.js')).default;
} else {
  supervise();
}

function supervise() {
  let child = null;
  let stopping = false;
  let planned = false;          // the current exit was asked for (update)
  let crashes = [];             // timestamps of unplanned exits
  let killTimer = null;

  const log = (...a) => console.log('[supervisor]', ...a);

  function start() {
    child = fork(SELF, process.argv.slice(2), {
      env: { ...process.env, MP_WORKER: '1', MP_SUPERVISED: '1' },
      stdio: 'inherit'
    });
    log(`worker started (pid ${child.pid})`);

    child.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'restart') {
        log(`restart requested${m.reason ? `: ${m.reason}` : ''}`);
        restart();
      }
    });

    child.on('exit', (code, signal) => {
      clearTimeout(killTimer);
      child = null;
      if (stopping) return process.exit(0);
      if (planned) {
        planned = false;
        log('worker stopped for update, starting the new version');
        return start();
      }
      const now = Date.now();
      crashes = crashes.filter(t => now - t < 60000);
      crashes.push(now);
      // A freshly installed version that keeps crashing on start → put the
      // previous files back so the panel comes up again.
      if (crashes.length >= 2 && undoBrokenUpdate()) crashes = [];
      const delay = Math.min(30000, 1000 * 2 ** (crashes.length - 1));
      log(`worker exited (code ${code}${signal ? `, ${signal}` : ''}) — starting again in ${Math.round(delay / 1000)} s`);
      setTimeout(() => { if (!stopping) start(); }, delay);
    });
  }

  function undoBrokenUpdate() {
    const root = path.resolve(path.dirname(SELF), '..');
    const statusFile = path.join(root, '.updates', 'status.json');
    let st;
    try { st = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { return false; }
    if (st.state !== 'restarting' || !st.backup) return false;
    const dir = path.join(root, '.updates', 'backups', st.backup);
    try {
      const b = JSON.parse(fs.readFileSync(path.join(dir, 'backup.json'), 'utf8'));
      for (const p of b.restore || []) {
        fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
        fs.copyFileSync(path.join(dir, 'files', p), path.join(root, p));
      }
      for (const p of b.created || []) fs.rmSync(path.join(root, p), { force: true });
      if (b.versionFile != null) fs.writeFileSync(path.join(root, 'version.json'), b.versionFile);
      if (st.frontendSwapped) {
        const fe = path.join(root, 'frontend');
        if (fs.existsSync(path.join(fe, 'dist-prev', 'index.html'))) {
          fs.rmSync(path.join(fe, 'dist-broken'), { recursive: true, force: true });
          try { fs.renameSync(path.join(fe, 'dist'), path.join(fe, 'dist-broken')); fs.renameSync(path.join(fe, 'dist-prev'), path.join(fe, 'dist')); } catch { /* keep new ui */ }
        }
      }
      st.state = 'failed';
      st.rolledBack = true;
      st.error = `Yeni versiya (${st.to}) işə düşmədi. Əvvəlki versiya (${st.from}) avtomatik bərpa edildi.`;
      st.finishedAt = new Date().toISOString();
      st.steps = (st.steps || []).map(s => (s.key === 'restart' ? { ...s, state: 'failed' } : s));
      fs.writeFileSync(statusFile, JSON.stringify(st, null, 2));
      log('new version keeps crashing — previous files restored');
      return true;
    } catch (e) {
      log('could not restore previous version:', e.message);
      return false;
    }
  }

  function restart() {
    if (!child) return start();
    planned = true;
    try { child.kill(); } catch { /* already gone */ }
    // hard stop if it does not exit by itself
    killTimer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* ignore */ } }, 8000);
  }

  function shutdown() {
    stopping = true;
    if (!child) return process.exit(0);
    try { child.kill(); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGBREAK', shutdown); // Windows console close / service stop

  start();
}

// Vercel's legacy backend/vercel.json points at this file.
export default app;
