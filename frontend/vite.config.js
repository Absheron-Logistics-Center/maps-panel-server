import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

// The version this interface was built from (../version.json). The server
// keeps every installed interface and each user switches when they want, so
// the page must know which one it is.
function appVersion() {
  try { return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), '..', 'version.json'), 'utf8')); }
  catch { return { version: '0.0.0' }; }
}
const uiVersionFile = (v) => ({
  name: 'ui-version-file',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'ui-version.json', source: JSON.stringify({ version: v.version, date: v.date || null, notes: v.notes || [] }, null, 2) });
  }
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const v = appVersion();
  return {
    define: { __APP_VERSION__: JSON.stringify(v.version) },
    // Self-hosting under a subpath (e.g. http://server/maps-panel alongside
    // other apps on the same box) needs built asset URLs prefixed with it.
    // Leave VITE_BASE unset for the normal root-domain deploy (Vercel) —
    // defaults to '/'. Set it in frontend/.env.production.local, e.g.
    // VITE_BASE=/maps-panel/
    base: env.VITE_BASE || '/',
    plugins: [react(), uiVersionFile(v)],
    server: {
      port: 5173,
      proxy: {
        // Keep VITE_API_URL empty in frontend/.env so the browser calls /api/*
        // (same origin). Vite forwards to the deployed backend that has Mongo
        // data — same groups as maps-panel.vercel.app. Avoids CORS and avoids
        // the empty local backend on :4000 (no MONGODB_URI).
        '/api': {
          target: 'https://maps-panel-backend.vercel.app',
          changeOrigin: true,
          secure: true
        }
      }
    }
  };
});
