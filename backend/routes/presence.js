// routes/presence.js — live cursors: who is on which page and where their
// mouse is, Figma-style. Works on the own server (one process holds every
// connection). On Vercel each request can land on a different instance, so
// the panel does not start it there.
//
//   GET  /api/presence/stream?token=…&cid=…   Server-Sent Events
//        event: hello   { cid, color, roster }
//        event: roster  [ { cid, username, name, color, page, title } ]   who is online, where
//        event: cur     { cid, x, y, m, v }                               a cursor moved
//        event: bye     { cid }
//   POST /api/presence   { cid, page, title, x, y, m, v }
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { isDisabled } from '../services/accounts.js';

const router = Router();
const clients = new Map(); // cid -> { res, username, name, color, page, title, last }

const COLORS = ['#F7CF5B', '#6B7A99', '#7DD3FC', '#F7900A', '#4CAF6A', '#E0218A', '#1A73E8', '#8B5CF6', '#14B8A6', '#EF4444'];
function colorFor(username) {
  let h = 0;
  for (const c of String(username)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

const validCid = c => /^[a-z0-9-]{6,40}$/i.test(String(c || ''));

function write(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function roster() {
  return [...clients.entries()].map(([cid, c]) => ({
    cid, username: c.username, name: c.name, color: c.color, page: c.page, title: c.title, since: c.since
  }));
}
let rosterTimer = null;
function broadcastRoster() {
  // many joins/leaves at once (a restart) → one message
  if (rosterTimer) return;
  rosterTimer = setTimeout(() => {
    rosterTimer = null;
    const r = roster();
    for (const c of clients.values()) write(c.res, 'roster', r);
  }, 120);
}

export async function presenceStream(req, res) {
  const token = String(req.query.token || '');
  const cid = String(req.query.cid || '');
  let user;
  try { user = jwt.verify(token, process.env.JWT_SECRET || 'absheron-secret'); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }
  if (!validCid(cid)) return res.status(400).json({ error: 'cid' });
  if (await isDisabled(user.username, !!user.builtin).catch(() => false)) return res.status(401).json({ error: 'Hesab deaktiv edilib' });

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 2000\n\n');

  const old = clients.get(cid);
  if (old) { try { old.res.end(); } catch { /* ignore */ } }
  const c = {
    res, username: user.username, name: user.name || user.username, color: colorFor(user.username),
    page: String(req.query.page || ''), title: String(req.query.title || '').slice(0, 120), since: Date.now(), last: Date.now()
  };
  clients.set(cid, c);
  write(res, 'hello', { cid, color: c.color, roster: roster() });
  broadcastRoster();

  const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20000);
  req.on('close', () => {
    clearInterval(ping);
    if (clients.get(cid)?.res === res) {
      clients.delete(cid);
      for (const o of clients.values()) write(o.res, 'bye', { cid });
      broadcastRoster();
    }
  });
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);

router.post('/', (req, res) => {
  const b = req.body || {};
  const c = clients.get(String(b.cid || ''));
  if (!c || c.username !== req.user.username) return res.status(204).end();
  c.last = Date.now();
  const page = typeof b.page === 'string' ? b.page.slice(0, 200) : c.page;
  const title = typeof b.title === 'string' ? b.title.slice(0, 120) : c.title;
  if (page !== c.page || title !== c.title) {
    c.page = page; c.title = title;
    broadcastRoster();
  }
  const msg = {
    cid: b.cid,
    x: num(b.x), y: num(b.y),
    m: b.m === 'f' ? 'f' : 'p',          // f = both axes are fractions of the page area, p = x fraction + y pixels
    v: b.v !== false
  };
  for (const [cid, o] of clients) {
    if (cid !== b.cid && o.page === c.page) write(o.res, 'cur', msg);
  }
  res.status(204).end();
});

// drop connections that went silent (laptop closed without a clean close)
setInterval(() => {
  const now = Date.now();
  for (const [cid, c] of clients) {
    if (now - c.last > 10 * 60 * 1000 && c.res.writableEnded) clients.delete(cid);
  }
}, 60000).unref();

export default router;
