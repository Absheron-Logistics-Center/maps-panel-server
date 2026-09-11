import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    // Self-hosting under a subpath (e.g. http://server/maps-panel alongside
    // other apps on the same box) needs built asset URLs prefixed with it.
    // Leave VITE_BASE unset for the normal root-domain deploy (Vercel) —
    // defaults to '/'. Set it in frontend/.env.production.local, e.g.
    // VITE_BASE=/maps-panel/
    base: env.VITE_BASE || '/',
    plugins: [react()],
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
