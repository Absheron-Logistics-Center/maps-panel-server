import app from '../backend/app.js';

// Vercel handler. With the project's vercel.json, /api/(.*) routes to this file.
// Express server routes are mounted under /api, so this hands off cleanly.
export default function handler(req, res) {
  console.log('[api]', req.method, req.url);
  return app(req, res);
}
