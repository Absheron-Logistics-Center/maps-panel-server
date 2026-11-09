// aiStore.js
// Everything ALM-AI keeps, stored the same way as the rest of the app
// (store.js → MongoDB + the server's data/ folder), so every PC sees the same
// chats and the token counters survive refreshes, restarts and cold starts.
//
//   data/ai/chats.json              list of chats (title, who, when, tokens)
//   data/ai/chats/chat-<id>.json    one chat: its messages
//   data/ai/usage.json              requests / tokens per day, model and user
//   data/ai/files/<hash>.<ext>      original PDFs / images sent in chats
//
// Nothing is hard-deleted: deleting a chat only hides it in chats.json
// (deleted: true); its file stays.

import { getFile, putFile, getBinary, putBinary } from './store.js';

const dataPath = () => (process.env.DATA_PATH || 'data').replace(/^\/|\/$/g, '');
const base = () => `${dataPath()}/ai`;
const indexPath = () => `${base()}/chats.json`;
const chatPath = id => `${base()}/chats/${String(id).startsWith("chat-") ? id : `chat-${id}`}.json`;
const usagePath = () => `${base()}/usage.json`;
const filePath = (hash, ext) => `${base()}/files/${hash}.${ext}`;

const ID_RE = /^[a-z0-9-]{4,80}$/i;
const HASH_RE = /^[a-z0-9-]{4,60}$/i;
export const validId = id => ID_RE.test(String(id || ''));
export const validHash = h => HASH_RE.test(String(h || ''));

// One writer at a time per file inside this process, so two requests that
// finish together don't overwrite each other's counters.
const locks = new Map();
function serial(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next.finally(() => { if (locks.get(key) === next) locks.delete(key); }));
  return next;
}

async function readJson(p, fallback) {
  try {
    const f = await getFile(p);
    return f?.content ?? fallback;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* usage                                                               */
/* ------------------------------------------------------------------ */
const today = () => new Date().toISOString().slice(0, 10);
const blank = () => ({ requests: 0, tokensIn: 0, tokensOut: 0, errors: 0, failovers: 0 });
function add(bucket, d) {
  bucket.requests += d.requests || 0;
  bucket.tokensIn += d.tokensIn || 0;
  bucket.tokensOut += d.tokensOut || 0;
  bucket.errors += d.errors || 0;
  bucket.failovers += d.failovers || 0;
}

/**
 * One finished chat request. `attempts` = every model tried for it.
 * { user, provider, model, tokensIn, tokensOut, attempts, ok }
 */
export function recordUsage(u) {
  return serial('usage', async () => {
    const cur = await readJson(usagePath(), null);
    const usage = cur && typeof cur === 'object' ? cur : {};
    usage.total = { ...blank(), ...(usage.total || {}) };
    usage.days = usage.days || {};
    usage.byModel = usage.byModel || {};
    usage.byUser = usage.byUser || {};

    const failed = (u.attempts || []).filter(a => !a.ok).length;
    const delta = {
      requests: 1,
      tokensIn: u.tokensIn || 0,
      tokensOut: u.tokensOut || 0,
      errors: u.ok ? 0 : 1,
      failovers: failed
    };
    const day = today();
    add(usage.total, delta);
    usage.days[day] = { ...blank(), ...(usage.days[day] || {}) };
    add(usage.days[day], delta);
    if (u.provider && u.model) {
      const k = `${u.provider}:${u.model}`;
      usage.byModel[k] = { ...blank(), ...(usage.byModel[k] || {}) };
      add(usage.byModel[k], delta);
    }
    const who = String(u.user || 'naməlum');
    usage.byUser[who] = { ...blank(), ...(usage.byUser[who] || {}) };
    add(usage.byUser[who], delta);

    // keep ~4 months of daily rows
    const days = Object.keys(usage.days).sort();
    days.slice(0, Math.max(0, days.length - 120)).forEach(d => delete usage.days[d]);
    usage.updatedAt = Date.now();
    await putFile(usagePath(), usage);
    return usage;
  }).catch(e => { console.warn('[ai] usage save failed:', e.message); return null; });
}

export async function readUsage() {
  const u = await readJson(usagePath(), null);
  const day = today();
  return {
    total: { ...blank(), ...(u?.total || {}) },
    today: { ...blank(), ...(u?.days?.[day] || {}) },
    days: u?.days || {},
    byModel: u?.byModel || {},
    byUser: u?.byUser || {},
    updatedAt: u?.updatedAt || null
  };
}

/* ------------------------------------------------------------------ */
/* chats                                                               */
/* ------------------------------------------------------------------ */
const MAX_CHAT_BYTES = 3 * 1024 * 1024;

function tokensOf(messages) {
  let tin = 0, tout = 0;
  for (const m of messages) {
    if (m?.meta) { tin += Number(m.meta.tokensIn) || 0; tout += Number(m.meta.tokensOut) || 0; }
  }
  return { tokensIn: tin, tokensOut: tout };
}

// Never store base64 payloads in a chat (they live in data/ai/files/).
function slimMessages(messages) {
  let list = (Array.isArray(messages) ? messages : []).slice(-300).map(m => {
    if (!m || typeof m !== 'object') return null;
    const out = { ...m };
    delete out.streaming;
    if (Array.isArray(m.attachments)) {
      out.attachments = m.attachments.map(a => {
        const { data, image, ...rest } = a || {};
        if (Array.isArray(rest.pages)) rest.pages = rest.pages.map(({ image: _i, thumb: _t, ...p }) => p);
        return rest;
      });
    }
    return out;
  }).filter(Boolean);
  // still too big → drop thumbnails, oldest first
  let size = JSON.stringify(list).length;
  for (let i = 0; i < list.length && size > MAX_CHAT_BYTES; i++) {
    if (!list[i].attachments) continue;
    list[i] = { ...list[i], attachments: list[i].attachments.map(a => ({ ...a, thumb: null })) };
    size = JSON.stringify(list).length;
  }
  return list;
}

export async function listChats() {
  const idx = await readJson(indexPath(), []);
  return (Array.isArray(idx) ? idx : [])
    .filter(c => c && !c.deleted)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function readChat(id) {
  if (!validId(id)) return null;
  return readJson(chatPath(id), null);
}

export function saveChat(id, body, user) {
  if (!validId(id)) throw Object.assign(new Error('Yanlış söhbət id'), { status: 400 });
  return serial(`chat:${id}`, async () => {
    const prev = await readJson(chatPath(id), null);
    const messages = slimMessages(body?.messages);
    const now = Date.now();
    const chat = {
      id,
      title: String(body?.title || prev?.title || 'Söhbət').slice(0, 120),
      view: String(body?.view || prev?.view || '').slice(0, 120),
      createdAt: prev?.createdAt || now,
      createdBy: prev?.createdBy || user || null,
      updatedAt: now,
      updatedBy: user || null,
      ...tokensOf(messages),
      messages
    };
    await putFile(chatPath(id), chat);
    await serial('index', async () => {
      const idx = await readJson(indexPath(), []);
      const list = (Array.isArray(idx) ? idx : []).filter(c => c && c.id !== id);
      const { messages: _m, ...meta } = chat;
      list.unshift({ ...meta, messageCount: messages.length });
      await putFile(indexPath(), list.slice(0, 2000));
    });
    const { messages: _m, ...meta } = chat;
    return meta;
  });
}

export function hideChat(id, user) {
  if (!validId(id)) throw Object.assign(new Error('Yanlış söhbət id'), { status: 400 });
  return serial('index', async () => {
    const idx = await readJson(indexPath(), []);
    const list = (Array.isArray(idx) ? idx : []).map(c =>
      c && c.id === id ? { ...c, deleted: true, deletedAt: Date.now(), deletedBy: user || null } : c);
    await putFile(indexPath(), list);
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ */
/* files sent in chats                                                 */
/* ------------------------------------------------------------------ */
const EXT = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export const extFor = (kind, mime) => (kind === 'pdf' ? 'pdf' : EXT[String(mime || '').toLowerCase()] || 'png');

const saved = new Set(); // already written by this instance
export async function saveChatFile(hash, kind, mime, base64) {
  if (!validHash(hash) || !base64) return;
  const p = filePath(hash, extFor(kind, mime));
  if (saved.has(p)) return;
  saved.add(p);
  try {
    await putBinary(p, Buffer.from(base64, 'base64'));
  } catch (e) {
    saved.delete(p);
    console.warn('[ai] file save failed:', e.message);
  }
}

export async function loadChatFile(hash, kind, mime) {
  if (!validHash(hash)) return null;
  try {
    const buf = await getBinary(filePath(hash, extFor(kind, mime)));
    return buf ? Buffer.from(buf) : null;
  } catch {
    return null;
  }
}
