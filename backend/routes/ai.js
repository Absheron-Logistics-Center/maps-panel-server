import { Router } from 'express';
import {
  askLLM, pickProvider, providerInfo, allProviders, getUsage, allModels, parseModelId
} from '../services/aiProvider.js';
import { buildSystemPrompt, parseModelJson } from '../services/aiSchema.js';
import {
  recordUsage, readUsage, listChats, readChat, saveChat, hideChat,
  saveChatFile, loadChatFile, validHash, validId, extFor
} from '../services/aiStore.js';
import {
  promptKnowledge, findExamples, readDiagramCompact, addLesson, listLessons, removeLesson,
  getKnowledge, learnAll, readLog
} from '../services/aiLearn.js';

const router = Router();
const isVercel = !!process.env.VERCEL;

// Same guard style as processes.js / settings.js — requireAuth already ran in
// server.js, so req.user is populated here.
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

router.use(requireAdmin);

/**
 * GET /api/ai/limits
 * Which provider is live, its published free-tier limits, and how much this
 * server instance has used. (Kept for the usage panel.)
 */
router.get('/limits', async (_req, res) => {
  const name = pickProvider();
  let stored = null;
  try { stored = await readUsage(); } catch { /* storage down */ }
  res.json({
    enabled: !!name,
    active: name ? providerInfo(name) : null,
    providers: allProviders(),
    usage: getUsage(),          // this server instance only
    stored,                     // saved in data/ai/usage.json — all PCs, survives restarts
    usageNote: 'Sayğaclar data/ai/usage.json faylında saxlanılır — bütün kompüterlərdə eynidir. Bir model cavab verməsə, növbəti model avtomatik sınanır.'
  });
});

/* ---------------- chat history (data/ai/) ---------------- */
router.get('/chats', async (_req, res, next) => {
  try { res.json(await listChats()); } catch (e) { next(e); }
});
router.get('/chats/:id', async (req, res, next) => {
  try {
    const c = await readChat(req.params.id);
    if (!c) return res.status(404).json({ error: 'Söhbət tapılmadı' });
    res.json(c);
  } catch (e) { next(e); }
});
router.put('/chats/:id', async (req, res, next) => {
  try { res.json(await saveChat(req.params.id, req.body || {}, req.user?.username)); }
  catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});
router.delete('/chats/:id', async (req, res, next) => {
  try { res.json(await hideChat(req.params.id, req.user?.username)); }
  catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});
// An original file from an earlier chat (preview on another PC).
router.get('/files/:hash', async (req, res, next) => {
  try {
    const kind = req.query.kind === 'pdf' ? 'pdf' : 'image';
    const mime = kind === 'pdf' ? 'application/pdf' : String(req.query.mime || 'image/png');
    if (!validHash(req.params.hash)) return res.status(400).json({ error: 'Yanlış fayl' });
    const buf = await loadChatFile(req.params.hash, kind, mime);
    if (!buf) return res.status(404).json({ error: 'Fayl tapılmadı' });
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(buf);
  } catch (e) { next(e); }
});

/**
 * GET /api/ai/models[?fresh=1]
 * Every model the configured keys can use, fetched live from the providers.
 */
router.get('/models', async (req, res, next) => {
  try {
    const name = pickProvider();
    const groups = name ? await allModels({ fresh: req.query.fresh === '1' }) : [];
    const def = name ? parseModelId('') : null;
    res.json({
      enabled: !!name,
      // "auto" = try every model in turn until one answers (see aiProvider.js)
      defaultModel: name ? 'auto' : null,
      autoFirst: def ? `${def.provider}:${def.model}` : null,
      groups,
      // Vercel functions reject request bodies over ~4.5MB; the own server
      // takes 30MB (express.json limit in server.js).
      maxRequestBytes: isVercel ? 4 * 1024 * 1024 : 28 * 1024 * 1024,
      where: isVercel ? 'vercel' : 'server'
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */

const KINDS = new Set(['image', 'pdf', 'text', 'note']);
const MAX_ATT_PER_MSG = 12;
const MAX_TEXT = 200000;

function cleanAttachment(a) {
  if (!a || !KINDS.has(a.kind)) return null;
  const out = { kind: a.kind, name: String(a.name || 'fayl').slice(0, 200) };
  if (a.source) out.source = String(a.source).slice(0, 20);
  if (validHash(a.hash)) out.hash = a.hash;
  if (a.kind === 'image') {
    if (typeof a.data !== 'string' || !a.data) return null;
    out.mime = /^image\/(png|jpe?g|webp|gif|heic|heif)$/i.test(a.mime || '') ? a.mime : 'image/png';
    out.data = a.data;
  } else if (a.kind === 'pdf') {
    if (typeof a.data === 'string' && a.data) out.data = a.data;
    out.pageCount = Number(a.pageCount) || (Array.isArray(a.pages) ? a.pages.length : 0);
    out.pages = (Array.isArray(a.pages) ? a.pages : []).slice(0, 60).map((p, i) => ({
      n: Number(p?.n) || i + 1,
      text: String(p?.text || '').slice(0, 20000),
      ...(typeof p?.image === 'string' && p.image ? { image: p.image } : {})
    }));
    if (!out.data && !out.pages.length) return null;
  } else {
    out.text = String(a.text || '').slice(0, MAX_TEXT);
    if (a.kind === 'note' && (a.fileKind === 'pdf' || a.fileKind === 'image')) {
      out.fileKind = a.fileKind;
      if (a.mime) out.mime = String(a.mime).slice(0, 40);
    }
    if (!out.text.trim() && !out.hash) return null;
  }
  return out;
}

// Keep every original file the admin sends (data/ai/files/), so the chat
// still works from another PC or after a refresh.
async function storeFiles(messages) {
  const jobs = [];
  for (const m of messages) {
    for (const a of m.attachments || []) {
      if (a.hash && a.data && (a.kind === 'pdf' || a.kind === 'image') && a.source !== 'preview') {
        jobs.push(saveChatFile(a.hash, a.kind, a.mime || (a.kind === 'pdf' ? 'application/pdf' : 'image/png'), a.data));
      }
    }
  }
  await Promise.allSettled(jobs);
}

// A file that came back only as a note (old chat, other PC, too big for the
// request) is loaded from data/ai/files/ for the two newest turns that had
// files, so the model really sees it again.
async function rehydrate(messages) {
  let turns = 0;
  for (let i = messages.length - 1; i >= 0 && turns < 2; i--) {
    const m = messages[i];
    if (m.role !== 'user' || !m.attachments?.length) continue;
    turns++;
    m.attachments = await Promise.all(m.attachments.map(async a => {
      if (a.kind !== 'note' || !a.hash || !a.fileKind) return a;
      const mime = a.fileKind === 'pdf' ? 'application/pdf' : (a.mime || 'image/png');
      const buf = await loadChatFile(a.hash, a.fileKind, mime);
      if (!buf) return a;
      const data = buf.toString('base64');
      return a.fileKind === 'pdf'
        ? { kind: 'pdf', name: a.name, hash: a.hash, data, pageCount: 0, pages: a.text ? [{ n: 1, text: a.text }] : [] }
        : { kind: 'image', name: a.name, hash: a.hash, mime, data };
    }));
  }
}

function cleanMessages(messages) {
  return messages
    .filter(m => m && (typeof m.content === 'string' || Array.isArray(m.attachments)))
    .slice(-40)
    .map(m => {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const out = { role, content: String(m.content || '').slice(0, 120000) };
      if (role === 'user' && Array.isArray(m.attachments)) {
        const atts = m.attachments.slice(0, MAX_ATT_PER_MSG).map(cleanAttachment).filter(Boolean);
        if (atts.length) out.attachments = atts;
      }
      return out;
    })
    .filter(m => m.content.trim() || m.attachments?.length)
    // Providers want user/assistant turns to alternate and to start with the
    // user — merge neighbours of the same role (e.g. after a failed turn).
    .reduce((acc, m) => {
      const prev = acc[acc.length - 1];
      if (!prev && m.role === 'assistant') return acc;
      if (prev && prev.role === m.role) {
        prev.content = [prev.content, m.content].filter(Boolean).join('\n\n');
        if (m.attachments) prev.attachments = [...(prev.attachments || []), ...m.attachments];
        return acc;
      }
      acc.push(m);
      return acc;
    }, []);
}

/**
 * POST /api/ai/chat
 * body: { messages:[{role, content, attachments?}], context, model?, thinking?, stream? }
 *   stream=false -> JSON { reply, ask, actions, attachmentNotes, title, meta }
 *   stream=true  -> text/event-stream:
 *       event: delta    {t}            raw model text (JSON being written)
 *       event: thought  {t}            reasoning summary (Gemini / reasoning models)
 *       event: status   {type,...}     e.g. failover to another model
 *       event: reset    {}             discard streamed text (failover mid-stream)
 *       event: done     {reply, ask, actions, attachmentNotes, title, meta}
 *       event: error    {error}
 */
router.post('/chat', async (req, res, next) => {
  const { messages, context, model, thinking, stream, chatId } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages tələb olunur' });
  }
  const clean = cleanMessages(messages);
  if (!clean.length || clean[clean.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Son mesaj istifadəçidən olmalıdır' });
  }

  await storeFiles(clean);
  try { await rehydrate(clean); } catch (e) { console.warn('[ai] rehydrate failed:', e.message); }

  const level = thinking === 'high' ? 'high' : 'low';
  const user = req.user?.username || null;
  const track = (out, ok, err) => recordUsage({
    user, ok,
    provider: out?.provider, model: out?.model,
    tokensIn: out?.tokensIn, tokensOut: out?.tokensOut,
    attempts: out?.attempts || err?.attempts || []
  });
  const ctl = new AbortController();
  // Client hit "Dayandır" or closed the panel → stop paying for tokens.
  res.on('close', () => { if (!res.writableFinished) ctl.abort(); });

  // ---- what the assistant has learned + the most similar team diagrams ----
  const last = clean[clean.length - 1];
  const query = [
    last.content,
    context?.diagram?.title,
    ...(last.attachments || []).map(a => (a.kind === 'pdf' ? (a.pages || []).map(p => p.text).join(' ') : a.text || '')).map(t => String(t || '').slice(0, 4000))
  ].filter(Boolean).join(' ');
  let knowledge = '', examples = [];
  try { knowledge = await promptKnowledge(); } catch (e) { console.warn('[ai] knowledge:', e.message); }
  // worked examples only when a diagram is being built / converted — not for small talk
  const building = (last.attachments || []).some(a => a.kind === 'pdf' || a.kind === 'image')
    || /(qur|yarat|köçür|çevir)(?!ma|mə)|bənzər diaqram|oxşar diaqram|nümunə götür|build|create|generate|convert/i.test(last.content || "");
  if (building) {
    try { examples = await findExamples(query, { limit: 2, exclude: context?.diagram?.id != null ? [context.diagram.id] : [] }); } catch { examples = []; }
  }

  // ---- SSE plumbing (no-op in JSON mode) ----
  if (stream) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
  }
  const send = (event, data) => {
    if (!stream || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Keep proxies (IIS/nginx) from closing an idle stream while the model thinks.
  const ping = stream ? setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 10000) : null;

  const ask = (system, msgs) => askLLM({
    system, messages: msgs, model, thinking: level, signal: ctl.signal,
    ...(stream ? {
      onDelta: t => send('delta', { t }),
      onThought: t => send('thought', { t }),
      onReset: () => send('reset', {}),
      onStatus: st => send('status', st)
    } : {})
  });

  try {
    if (stream) send('status', { type: 'start', model: model || null });
    let msgs = clean;
    let toolResults = '';
    let parsed = null, out = null;
    let tokensIn = 0, tokensOut = 0;
    const attempts = [];
    const readIds = new Set();

    for (let round = 0; round < 4; round++) {
      const system = buildSystemPrompt(context, { knowledge, examples, toolResults });
      out = await ask(system, msgs);
      tokensIn += out.tokensIn || 0; tokensOut += out.tokensOut || 0;
      attempts.push(...(out.attempts || []));
      await track(out, true);
      try {
        parsed = parseModelJson(out.text);
      } catch {
        // Not valid JSON → never show it; ask once more for the same answer as JSON.
        if (round >= 2) throw Object.assign(new Error('AI cavabı oxuna bilmədi (format xətası). Yenidən cəhd edin.'), { status: 502 });
        send('reset', {});
        send('status', { type: 'retry', reason: 'json' });
        msgs = [...clean, { role: 'assistant', content: String(out.text).slice(0, 20000) },
          { role: 'user', content: '[Sistem: əvvəlki cavabın etibarlı JSON deyildi. Eyni cavabı YALNIZ bir etibarlı JSON obyekti kimi yenidən yaz — başqa heç nə.]' }];
        continue;
      }

      // read_diagram tool: open the requested diagrams and continue
      const reads = (parsed.actions || []).filter(a => a.type === 'read_diagram' && a.processId != null && !readIds.has(String(a.processId))).slice(0, 3);
      if (reads.length && round < 3) {
        const got = [];
        for (const r of reads) {
          readIds.add(String(r.processId));
          const d = await readDiagramCompact(r.processId).catch(() => null);
          got.push(d ? `#${r.processId} "${d.title}":\n${JSON.stringify(d).slice(0, 12000)}` : `#${r.processId}: tapılmadı`);
          send('status', { type: 'read', id: r.processId, title: d?.title || null });
        }
        toolResults += `\n=== OXUDUĞUN DİAQRAMLAR (read_diagram nəticəsi) ===\n${got.join('\n\n')}\n`;
        send('reset', {});
        msgs = clean;
        continue;
      }
      break;
    }

    parsed.actions = (parsed.actions || []).filter(a => a.type !== 'read_diagram');
    let lessonSaved = null;
    if (parsed.lesson) {
      try { lessonSaved = await addLesson(parsed.lesson, { user, chatId }); } catch { lessonSaved = null; }
    }
    const done = {
      ...parsed,
      meta: {
        provider: out.provider,
        model: out.model,
        tokensIn, tokensOut,
        truncated: !!out.truncated,
        attempts,
        usage: getUsage(),
        limits: providerInfo(out.provider)?.limits || null,
        read: [...readIds],
        examples: examples.map(e => ({ id: e.id, title: e.title })),
        lessonSaved: lessonSaved ? lessonSaved.text : null
      }
    };
    if (stream) send('done', done);
    else res.json(done);
  } catch (e) {
    if (!ctl.signal.aborted) await track(null, false, e);
    if (stream) {
      if (!ctl.signal.aborted) send('error', { error: e.message || 'AI cavab vermədi', status: e.status || 500 });
    } else if (e.status) {
      res.status(e.status >= 400 && e.status < 600 ? e.status : 502).json({ error: e.message });
    } else {
      next(e);
    }
  } finally {
    if (ping) clearInterval(ping);
    if (stream) res.end();
  }
});

/* ---------------- what it learned (data/ai/) ---------------- */
router.get('/learn', async (_req, res, next) => {
  try {
    const [k, lessons, log] = await Promise.all([getKnowledge().catch(() => null), listLessons(), readLog(40)]);
    res.json({
      learnedAt: k?.learnedAt || null,
      stats: k?.stats || null,
      rules: k?.rules || [],
      diagrams: (k?.index || []).length,
      lessons,
      log,
      background: !isVercel
    });
  } catch (e) { next(e); }
});
router.post('/learn', async (_req, res, next) => {
  try {
    const k = await learnAll({ reason: 'manual' });
    res.json({ ok: true, learnedAt: k.learnedAt, stats: k.stats, rules: k.rules });
  } catch (e) { next(e); }
});
router.post('/lessons', async (req, res, next) => {
  try { res.json(await addLesson(req.body?.text, { user: req.user?.username })); } catch (e) { next(e); }
});
router.delete('/lessons/:id', async (req, res, next) => {
  try { res.json(await removeLesson(req.params.id, req.user?.username)); } catch (e) { next(e); }
});

export default router;
