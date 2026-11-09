// aiClient.js
// Same fetch/token conventions as api/client.js — kept separate so the AI
// feature can be dropped in or out without touching the core client.

import { getToken, setToken } from './client.js';

const API_URL = import.meta.env.VITE_API_URL || '';

function authHeaders(extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function request(method, path, body, { signal } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
    signal
  });

  if (res.status === 401) {
    setToken(null);
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!res.ok) {
    const msg = (data && data.error) || (res.status === 413
      ? 'Əlavələr çox böyükdür — faylların sayını/ölçüsünü azaldın.'
      : `Request failed: ${res.status}`);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Streaming chat. Calls the handlers as Server-Sent Events arrive and resolves
 * with the final { reply, ask, actions, attachmentNotes, title, meta }.
 * Falls back to plain JSON if a proxy in between buffers/strips the stream.
 */
async function chatStream(body, { onDelta, onThought, onStatus, onReset, signal } = {}) {
  const res = await fetch(`${API_URL}/api/ai/chat`, {
    method: 'POST',
    headers: authHeaders({ Accept: 'text/event-stream' }),
    body: JSON.stringify({ ...body, stream: true }),
    signal
  });

  if (res.status === 401) {
    setToken(null);
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }

  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('text/event-stream') || !res.body) {
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(text); } catch { /* not json */ }
    if (res.ok && data && (data.reply !== undefined || data.actions)) return data;
    const err = new Error((data && data.error) || (res.status === 413
      ? 'Əlavələr çox böyükdür — faylların sayını/ölçüsünü azaldın.'
      : `AI xətası (${res.status})`));
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let final = null;
  let failure = null;

  const handle = (event, data) => {
    switch (event) {
      case 'delta': onDelta?.(data.t || ''); break;
      case 'thought': onThought?.(data.t || ''); break;
      case 'status': onStatus?.(data); break;
      case 'reset': onReset?.(); break;
      case 'done': final = data; break;
      case 'error': failure = data; break;
      default: break;
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const lines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
      }
      if (!lines.length) continue;
      let data;
      try { data = JSON.parse(lines.join('\n')); } catch { continue; }
      handle(event, data);
    }
  }

  if (failure) {
    const err = new Error(failure.error || 'AI cavab vermədi');
    err.status = failure.status;
    throw err;
  }
  if (!final) throw new Error('Bağlantı cavab tamamlanmadan kəsildi. Yenidən cəhd edin.');
  return final;
}

/**
 * The reply field while the model is still writing its JSON object:
 * '{"reply":"Salam, bu sə' -> 'Salam, bu sə'. Plain-prose answers pass through.
 */
export function peekReply(raw) {
  const s = String(raw || '');
  const t = s.trimStart();
  if (!t) return '';
  if (!t.startsWith('{') && !t.startsWith('```')) {
    // prose before a JSON object ("Budur: {...") — show only the prose part,
    // never the JSON itself
    const j = t.search(/[{[]\s*"/);
    return j >= 0 ? t.slice(0, j).trim() : t;
  }
  const m = s.match(/"reply"\s*:\s*"/);
  if (!m) return '';
  let out = '';
  for (let i = m.index + m[0].length; i < s.length; i++) {
    const c = s[i];
    if (c === '"') return out;
    if (c !== '\\') { out += c; continue; }
    const n = s[i + 1];
    if (n === undefined) return out;
    i++;
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') { /* skip */ }
    else if (n === 'u') {
      const hex = s.slice(i + 1, i + 5);
      if (hex.length < 4) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += n;
  }
  return out;
}

export const aiApi = {
  // { messages:[{role,content,attachments?}], context, model?, thinking? } -> { reply, ask, actions, meta }
  chat: (messages, context, opts = {}) =>
    request('POST', '/api/ai/chat', { messages, context, model: opts.model, thinking: opts.thinking }, { signal: opts.signal }),
  chatStream: (messages, context, opts = {}) =>
    chatStream({ messages, context, model: opts.model, thinking: opts.thinking, chatId: opts.chatId }, opts),
  limits: () => request('GET', '/api/ai/limits'),
  models: (fresh = false) => request('GET', `/api/ai/models${fresh ? '?fresh=1' : ''}`),
  // what it learned (data/ai/knowledge.json, lessons.json, learn-log.json)
  learn: () => request('GET', '/api/ai/learn'),
  learnNow: () => request('POST', '/api/ai/learn'),
  addLesson: text => request('POST', '/api/ai/lessons', { text }),
  removeLesson: id => request('DELETE', `/api/ai/lessons/${encodeURIComponent(id)}`),
  // chat history — saved in data/ai/ on the server, same on every PC
  chats: () => request('GET', '/api/ai/chats'),
  getChat: id => request('GET', `/api/ai/chats/${encodeURIComponent(id)}`),
  saveChat: (id, body) => request('PUT', `/api/ai/chats/${encodeURIComponent(id)}`, body),
  deleteChat: id => request('DELETE', `/api/ai/chats/${encodeURIComponent(id)}`),
  // original file of an earlier chat attachment -> Blob
  file: async (hash, kind, mime) => {
    const res = await fetch(`${API_URL}/api/ai/files/${encodeURIComponent(hash)}?kind=${kind}&mime=${encodeURIComponent(mime || '')}`, {
      headers: authHeaders()
    });
    if (!res.ok) throw new Error('Fayl tapılmadı');
    return res.blob();
  }
};
