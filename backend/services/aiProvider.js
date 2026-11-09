// aiProvider.js
// Adapter over the LLM APIs. Nothing here is Map-Panel specific — it takes a
// system prompt + messages (text AND attachments: images, PDFs, extracted
// text) and returns raw text, optionally streamed.
//
// Providers are enabled by whichever key is present in the env:
//   GEMINI_API_KEY      -> Google AI Studio (default; reads PDFs + images natively)
//   GROQ_API_KEY        -> Groq (fast; Llama 4 models see images)
//   OPENROUTER_API_KEY  -> OpenRouter (free models)
//
// What changed vs. the first version:
//   * The admin picks the model in the chat (any model the key can see — the
//     list is fetched live from the provider, so new models show up by
//     themselves).
//   * No more local "you hit the limit" wall. The old in-memory counter
//     guessed the quota and refused requests the provider would have accepted.
//     Now the real provider answer decides; if a model is rate-limited,
//     overloaded or retired the request FAILS OVER to the next model/provider
//     automatically and the chat says which one answered.
//   * Attachments: Gemini gets the original PDF (it reads every page as image
//     + text). OpenAI-style providers get the rendered page images + text.
//   * Streaming (SSE) with Gemini "thought summaries", so the panel shows the
//     answer as it is written instead of a spinner.

const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    defaultModel: 'gemini-3.5-flash',
    // Aliases Google keeps pointed at the newest Flash models — used as the
    // failover chain when the list can't be fetched.
    backupModels: ['gemini-flash-latest', 'gemini-flash-lite-latest'],
    limits: { rpm: 15, rpd: 1500, tpm: 1000000 },
    docs: 'https://ai.google.dev/gemini-api/docs/rate-limits'
  },
  groq: {
    label: 'Groq',
    envKey: 'GROQ_API_KEY',
    defaultModel: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    backupModels: ['meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.3-70b-versatile'],
    limits: { rpm: 30, rpd: 1000, tpm: 12000 },
    docs: 'https://console.groq.com/docs/rate-limits'
  },
  openrouter: {
    label: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    backupModels: [],
    limits: { rpm: 20, rpd: 50, tpm: null },
    docs: 'https://openrouter.ai/docs/api-reference/limits'
  }
};

const ORDER = ['gemini', 'groq', 'openrouter'];

const isConfigured = name => !!process.env[PROVIDERS[name]?.envKey];

export function pickProvider() {
  const forced = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (forced && PROVIDERS[forced] && isConfigured(forced)) return forced;
  for (const name of ORDER) if (isConfigured(name)) return name;
  return null;
}

// Gemini generations Google has shut down (1.x, 2.0 → 404). A stale AI_MODEL
// in the Vercel dashboard used to take the assistant down — ignore it.
const RETIRED_GEMINI = /^gemini-(1\.\d|2\.0)/i;

function resolveModel(name) {
  const p = PROVIDERS[name];
  const want = (process.env.AI_MODEL || '').trim();
  if (!want || name !== pickProvider()) return p.defaultModel;
  if (name === 'gemini' && RETIRED_GEMINI.test(want)) return p.defaultModel;
  return want;
}

export function providerInfo(name) {
  const p = PROVIDERS[name];
  if (!p) return null;
  return { name, label: p.label, model: resolveModel(name), limits: p.limits, docs: p.docs };
}

export function allProviders() {
  return ORDER.map(name => ({ ...providerInfo(name), configured: isConfigured(name) }));
}

/** "gemini:gemini-3.5-flash" -> { provider, model }. Falls back to the default. */
export function parseModelId(id) {
  const s = String(id || '').trim();
  if (!s || s === 'auto') {
    const provider = pickProvider();
    return provider ? { provider, model: resolveModel(provider), auto: true } : null;
  }
  const i = s.indexOf(':');
  if (i > 0) {
    const provider = s.slice(0, i);
    const model = s.slice(i + 1);
    if (PROVIDERS[provider] && isConfigured(provider) && model) return { provider, model };
  }
  const provider = pickProvider();
  return provider ? { provider, model: resolveModel(provider) } : null;
}

/* ------------------------------------------------------------------ *
 * Model catalogue — fetched live, cached per warm instance
 * ------------------------------------------------------------------ */

const catalogue = new Map(); // provider -> { at, models }
const CATALOGUE_TTL = 15 * 60 * 1000;

const GEMINI_SKIP = /embedding|aqa|tts|image-generation|-image|imagen|veo|live|native-audio|learnlm|gemma|robotics|computer-use|nano-banana/i;
const GROQ_SKIP = /whisper|tts|guard|embed|playai|distil|orpheus|compound/i;

async function fetchJson(url, headers = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function versionScore(id) {
  // "gemini-3.5-flash" -> 3.5 ; used to sort newest first
  const m = String(id).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

async function listGemini() {
  const key = process.env.GEMINI_API_KEY;
  const data = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`
  );
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => ({ ...m, id: String(m.name || '').replace(/^models\//, '') }))
    .filter(m => /^gemini/i.test(m.id) && !GEMINI_SKIP.test(m.id) && !RETIRED_GEMINI.test(m.id))
    .map(m => ({
      id: m.id,
      label: m.displayName || m.id,
      vision: true,
      pdf: true,
      thinking: true,
      context: m.inputTokenLimit || null,
      output: m.outputTokenLimit || null,
      tier: /pro/i.test(m.id) ? 'pro' : /lite/i.test(m.id) ? 'lite' : 'flash'
    }))
    .sort((a, b) => versionScore(b.id) - versionScore(a.id) || a.id.localeCompare(b.id));
}

async function listGroq() {
  const data = await fetchJson('https://api.groq.com/openai/v1/models', {
    Authorization: `Bearer ${process.env.GROQ_API_KEY}`
  });
  return (data.data || [])
    .filter(m => m.active !== false && !GROQ_SKIP.test(m.id))
    .map(m => ({
      id: m.id,
      label: m.id.replace(/^[^/]+\//, ''),
      vision: /llama-4|vision|scout|maverick/i.test(m.id),
      pdf: false,
      thinking: /qwen3|gpt-oss|deepseek-r1|reasoning/i.test(m.id),
      context: m.context_window || null,
      output: m.max_completion_tokens || null,
      tier: 'fast'
    }))
    .sort((a, b) => Number(b.vision) - Number(a.vision) || a.id.localeCompare(b.id));
}

async function listOpenRouter() {
  const data = await fetchJson('https://openrouter.ai/api/v1/models', {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`
  });
  return (data.data || [])
    .filter(m => {
      const p = m.pricing || {};
      return /:free$/.test(m.id) || (Number(p.prompt) === 0 && Number(p.completion) === 0);
    })
    .map(m => {
      const mods = m.architecture?.input_modalities || [];
      return {
        id: m.id,
        label: m.name || m.id,
        vision: mods.includes('image'),
        pdf: false,
        thinking: (m.supported_parameters || []).includes('reasoning'),
        context: m.context_length || null,
        output: m.top_provider?.max_completion_tokens || null,
        tier: 'free'
      };
    })
    .sort((a, b) => Number(b.vision) - Number(a.vision) || (b.context || 0) - (a.context || 0))
    .slice(0, 40);
}

const LISTERS = { gemini: listGemini, groq: listGroq, openrouter: listOpenRouter };

function staticModels(name) {
  const p = PROVIDERS[name];
  const vision = name === 'gemini' || name === 'groq';
  return [p.defaultModel, ...p.backupModels].map(id => ({
    id, label: id, vision: name === 'gemini' || (vision && /llama-4/.test(id)),
    pdf: name === 'gemini', thinking: name === 'gemini', context: null, output: null,
    tier: name === 'gemini' ? 'flash' : 'fast'
  }));
}

export async function listModels(name, { fresh = false } = {}) {
  if (!isConfigured(name)) return [];
  const hit = catalogue.get(name);
  if (!fresh && hit && Date.now() - hit.at < CATALOGUE_TTL) return hit.models;
  try {
    const models = await LISTERS[name]();
    if (models.length) {
      catalogue.set(name, { at: Date.now(), models });
      return models;
    }
  } catch (e) {
    console.warn(`[ai] ${name} model list failed:`, e.message);
  }
  return hit?.models || staticModels(name);
}

export async function allModels({ fresh = false } = {}) {
  const out = [];
  await Promise.all(ORDER.filter(isConfigured).map(async name => {
    const models = await listModels(name, { fresh });
    out.push({ provider: name, label: PROVIDERS[name].label, models });
  }));
  out.sort((a, b) => ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider));
  return out;
}

function modelMeta(provider, model) {
  const list = catalogue.get(provider)?.models || staticModels(provider);
  return list.find(m => m.id === model) || {
    id: model,
    vision: provider === 'gemini' || /llama-4|vision|scout|maverick|vl|gemini|gpt-4o|claude|pixtral|qwen.*vl/i.test(model),
    pdf: provider === 'gemini',
    thinking: provider === 'gemini'
  };
}

/* ------------------------------------------------------------------ *
 * Usage counters (display only — they never block a request)
 * ------------------------------------------------------------------ */
const usage = {
  day: new Date().toISOString().slice(0, 10),
  requests: 0, minuteBucket: 0, minuteCount: 0,
  tokensIn: 0, tokensOut: 0, errors: 0, failovers: 0,
  lastAt: null, startedAt: Date.now(), byModel: {}
};

function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (usage.day !== today) {
    Object.assign(usage, { day: today, requests: 0, tokensIn: 0, tokensOut: 0, errors: 0, failovers: 0, byModel: {} });
  }
}

function noteRequest(key) {
  rollDay();
  const bucket = Math.floor(Date.now() / 60000);
  if (usage.minuteBucket !== bucket) { usage.minuteBucket = bucket; usage.minuteCount = 0; }
  usage.minuteCount += 1;
  usage.requests += 1;
  usage.lastAt = Date.now();
  usage.byModel[key] = (usage.byModel[key] || 0) + 1;
}

export function getUsage() {
  rollDay();
  const bucket = Math.floor(Date.now() / 60000);
  return {
    day: usage.day,
    requestsToday: usage.requests,
    requestsThisMinute: usage.minuteBucket === bucket ? usage.minuteCount : 0,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    errors: usage.errors,
    failovers: usage.failovers,
    byModel: { ...usage.byModel },
    lastAt: usage.lastAt,
    instanceStartedAt: usage.startedAt
  };
}

/* ------------------------------------------------------------------ *
 * Message → provider payload
 * ------------------------------------------------------------------ *
 * A message is { role, content, attachments? }. An attachment is:
 *   { kind:'image', name, mime, data }                 data = base64
 *   { kind:'pdf',   name, mime, data?, pages:[{ n, text, image? }] }
 *   { kind:'text',  name, mime, text }                 docx/xlsx/csv/txt…
 *   { kind:'note',  name, text }                       earlier attachment, now only its digest
 */

function fileHeader(a, extra = '') {
  return `[Əlavə: "${a.name || 'fayl'}"${extra}]`;
}

function imageNote(a) {
  if (a.source === 'diagram') return ' — açıq diaqramın canlı şəkli';
  if (a.source === 'preview') return ' — SƏNİN təklif etdiyin diaqramın proqramda real görünüşü (yoxlama üçün)';
  return ' — şəkil';
}

function pdfText(a) {
  const pages = Array.isArray(a.pages) ? a.pages : [];
  return pages
    .map(p => `--- Səhifə ${p.n} ---\n${String(p.text || '').trim() || '(mətn qatı yoxdur — şəkilə baxın)'}`)
    .join('\n');
}

function geminiParts(m) {
  const parts = [];
  for (const a of m.attachments || []) {
    if (a.kind === 'image' && a.data) {
      parts.push({ text: fileHeader(a, imageNote(a)) });
      parts.push({ inlineData: { mimeType: a.mime || 'image/png', data: a.data } });
    } else if (a.kind === 'pdf') {
      const n = a.pages?.length || a.pageCount || '?';
      parts.push({ text: fileHeader(a, ` — PDF, ${n} səhifə`) });
      if (a.data) {
        parts.push({ inlineData: { mimeType: 'application/pdf', data: a.data } });
      } else {
        for (const p of a.pages || []) {
          if (p.image) parts.push({ inlineData: { mimeType: 'image/jpeg', data: p.image } });
        }
        parts.push({ text: pdfText(a) });
      }
    } else if (a.kind === 'text' || a.kind === 'note') {
      parts.push({ text: `${fileHeader(a, a.kind === 'note' ? ' — əvvəl göndərilib, qısa məzmunu' : '')}\n${String(a.text || '')}` });
    }
  }
  if (m.content) parts.push({ text: m.content });
  if (!parts.length) parts.push({ text: '…' });
  return parts;
}

function openaiContent(m, { vision, maxImages }) {
  const atts = m.attachments || [];
  if (!atts.length) return m.content || '…';
  const content = [];
  let images = 0;
  const pushImage = (mime, data) => {
    if (!vision || images >= maxImages) return false;
    content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } });
    images++;
    return true;
  };
  for (const a of atts) {
    if (a.kind === 'image' && a.data) {
      content.push({ type: 'text', text: fileHeader(a, imageNote(a)) });
      if (!pushImage(a.mime || 'image/png', a.data)) {
        content.push({ type: 'text', text: '(Bu model şəkil görmür — şəkil göndərilmədi.)' });
      }
    } else if (a.kind === 'pdf') {
      const pages = a.pages || [];
      content.push({ type: 'text', text: fileHeader(a, ` — PDF, ${pages.length} səhifə. Hər səhifənin şəkli və mətn qatı aşağıdadır.`) });
      for (const p of pages) {
        if (p.image) pushImage('image/jpeg', p.image);
      }
      content.push({ type: 'text', text: pdfText(a) });
    } else if (a.kind === 'text' || a.kind === 'note') {
      content.push({ type: 'text', text: `${fileHeader(a)}\n${String(a.text || '')}` });
    }
  }
  if (m.content) content.push({ type: 'text', text: m.content });
  return content;
}

/* ------------------------------------------------------------------ *
 * SSE reader shared by both wire formats
 * ------------------------------------------------------------------ */
async function readSSE(res, onData) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/)
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(data); } catch { continue; }
      onData(obj);
    }
  }
}

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ------------------------------------------------------------------ *
 * Gemini
 * ------------------------------------------------------------------ */
function geminiThinking(model, level) {
  const high = level === 'high';
  // 2.5 models take a token budget; 3.x take a level.
  if (/gemini-2\.5/i.test(model)) {
    return { thinkingBudget: high ? 16384 : (/lite/i.test(model) ? 0 : 2048), includeThoughts: true };
  }
  return { thinkingLevel: high ? 'high' : 'low', includeThoughts: true };
}

async function callGemini({ system, messages, model, apiKey, thinking, json, onDelta, onThought, signal, noThinking }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: m.role === 'assistant' ? [{ text: m.content || '…' }] : geminiParts(m)
    })),
    generationConfig: {
      maxOutputTokens: 65536,
      ...(json ? { responseMimeType: 'application/json' } : {}),
      ...(noThinking ? {} : { thinkingConfig: geminiThinking(model, thinking) })
    }
  };
  const stream = !!onDelta;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:` +
    (stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?') + `key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const msg = data?.error?.message || `Gemini ${res.status}`;
    // Some models reject thinkingConfig/includeThoughts — retry once without.
    if (res.status === 400 && !noThinking && /thinking/i.test(msg)) {
      return callGemini({ system, messages, model, apiKey, thinking, json, onDelta, onThought, signal, noThinking: true });
    }
    throw httpError(msg, res.status);
  }

  let text = '';
  let usageMeta = null;
  let reason = null;
  let blocked = null;
  const take = chunk => {
    const cand = chunk?.candidates?.[0];
    for (const p of cand?.content?.parts || []) {
      if (!p.text) continue;
      if (p.thought) { onThought?.(p.text); continue; }
      text += p.text;
      onDelta?.(p.text);
    }
    if (cand?.finishReason) reason = cand.finishReason;
    if (chunk?.usageMetadata) usageMeta = chunk.usageMetadata;
    if (chunk?.promptFeedback?.blockReason) blocked = chunk.promptFeedback.blockReason;
  };

  if (stream) await readSSE(res, take);
  else take(await res.json());

  if (reason === 'MAX_TOKENS' && !text.trim()) {
    throw httpError('AI cavabı token limitinə çatdı. Tapşırığı kiçik hissələrə bölün və ya "Dərin düşünmə"ni söndürün.', 413);
  }
  if (!text.trim()) {
    throw httpError(blocked ? `AI sorğunu blokladı (${blocked}).` : `AI boş cavab qaytardı (${reason || 'naməlum'}).`, 502);
  }
  return {
    text,
    truncated: reason === 'MAX_TOKENS',
    tokensIn: usageMeta?.promptTokenCount || 0,
    tokensOut: (usageMeta?.candidatesTokenCount || 0) + (usageMeta?.thoughtsTokenCount || 0)
  };
}

/* ------------------------------------------------------------------ *
 * OpenAI-compatible (Groq, OpenRouter)
 * ------------------------------------------------------------------ */
async function callOpenAICompatible({ provider, system, messages, model, apiKey, json, thinking, onDelta, onThought, signal }) {
  const meta = modelMeta(provider, model);
  const baseUrl = provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://openrouter.ai/api/v1';
  const extraHeaders = provider === 'openrouter'
    ? { 'HTTP-Referer': process.env.CORS_ORIGIN?.split(',')[0] || 'https://maps-panel.vercel.app', 'X-Title': 'Map-Panel' }
    : {};
  const maxImages = provider === 'groq' ? 5 : 20;

  // Images only on the LAST user turn that has any, newest first — Groq caps
  // a request at 5 images and older turns already have their digest.
  let lastWithAtt = -1;
  messages.forEach((m, i) => { if (m.role === 'user' && m.attachments?.some(a => a.kind !== 'note')) lastWithAtt = i; });

  const wire = [{ role: 'system', content: system }, ...messages.map((m, i) => {
    if (m.role === 'assistant') return { role: 'assistant', content: m.content || '…' };
    const vision = meta.vision && i === lastWithAtt;
    return { role: 'user', content: openaiContent(m, { vision, maxImages }) };
  })];

  const stream = !!onDelta;
  const outCap = provider === 'groq' ? Math.min(meta.output || 8192, 32768) : (meta.output || 16000);
  const body = {
    model,
    temperature: 0.3,
    max_tokens: Math.min(outCap, 32768),
    messages: wire,
    stream,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
    ...(provider === 'openrouter' && meta.thinking ? { reasoning: { effort: thinking === 'high' ? 'high' : 'low' } } : {}),
    ...(stream && provider === 'openrouter' ? { usage: { include: true } } : {})
  };

  let res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...extraHeaders },
    body: JSON.stringify(body),
    signal
  });
  // json_object mode isn't supported by every model — drop it once and retry.
  if (res.status === 400 && json) {
    const data = await res.clone().json().catch(() => null);
    if (/response_format|json/i.test(data?.error?.message || '')) {
      delete body.response_format;
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...extraHeaders },
        body: JSON.stringify(body),
        signal
      });
    }
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const raw = data?.error?.metadata?.raw;
    throw httpError(data?.error?.message || (typeof raw === 'string' ? raw : '') || `${provider} ${res.status}`, res.status);
  }

  let text = '';
  let tokensIn = 0, tokensOut = 0, reason = null;
  if (stream) {
    await readSSE(res, chunk => {
      if (chunk.error) throw httpError(chunk.error.message || 'stream error', chunk.error.code || 502);
      const ch = chunk.choices?.[0];
      const d = ch?.delta || {};
      const thought = d.reasoning || d.reasoning_content;
      if (thought) onThought?.(thought);
      if (d.content) { text += d.content; onDelta(d.content); }
      if (ch?.finish_reason) reason = ch.finish_reason;
      const u = chunk.usage || chunk.x_groq?.usage;
      if (u) { tokensIn = u.prompt_tokens || tokensIn; tokensOut = u.completion_tokens || tokensOut; }
    });
  } else {
    const data = await res.json();
    text = data?.choices?.[0]?.message?.content || '';
    reason = data?.choices?.[0]?.finish_reason;
    tokensIn = data?.usage?.prompt_tokens || 0;
    tokensOut = data?.usage?.completion_tokens || 0;
  }
  // Some reasoning models wrap thinking in <think>…</think> inside content.
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw httpError('AI boş cavab qaytardı.', 502);
  return { text, truncated: reason === 'length', tokensIn, tokensOut };
}

/* ------------------------------------------------------------------ *
 * Failover
 * ------------------------------------------------------------------ */

// Worth trying another model: quota / rate limit / overloaded / retired /
// model can't take images or PDFs / prompt too big for this model.
function retryable(e) {
  if (e?.name === 'AbortError') return false;
  const s = e?.status || 0;
  if ([404, 408, 409, 413, 429, 500, 502, 503, 504].includes(s)) return true;
  const m = String(e?.message || '');
  return /quota|rate.?limit|exhaust|overload|unavailable|no longer available|not found|not supported|does not support|image|vision|modalit|pdf|too large|context|tokens? per|capacity|busy|timeout|fetch failed/i.test(m);
}

async function buildChain(first, attachmentsNeedVision) {
  const chain = [first];
  const seen = new Set([`${first.provider}:${first.model}`]);
  const add = (provider, model) => {
    const k = `${provider}:${model}`;
    if (seen.has(k) || !model) return;
    seen.add(k);
    chain.push({ provider, model });
  };
  // Same provider first (keeps the reading quality), then the others.
  const providers = [first.provider, ...ORDER.filter(p => p !== first.provider)].filter(isConfigured);
  for (const p of providers) {
    let models;
    try { models = await listModels(p); } catch { models = staticModels(p); }
    const pool = models.filter(m => !attachmentsNeedVision || m.vision);
    // Prefer the same "tier" (flash → flash), then the configured default.
    const def = PROVIDERS[p].defaultModel;
    const ordered = [
      ...pool.filter(m => m.id === def),
      ...pool.filter(m => m.tier === 'flash' && m.id !== def),
      ...pool.filter(m => m.tier !== 'flash' && m.id !== def)
    ];
    const take = p === first.provider ? 3 : 2;
    ordered.slice(0, take).forEach(m => add(p, m.id));
    PROVIDERS[p].backupModels.forEach(id => { if (chain.length < 7) add(p, id); });
  }
  return chain.slice(0, 6);
}

// "Avtomatik": every model the keys can use, best first. Gemini reads PDFs
// natively so it leads; then Groq / OpenRouter models that can see images;
// when the request carries files, text-only models come last (they still get
// the PDF text layer). Each one is tried in turn until one answers.
function tierRank(m) {
  if (m.tier === 'flash') return 0;
  if (m.tier === 'pro') return 1;
  if (m.tier === 'lite') return 2;
  return 3;
}
async function buildAutoChain(needsVision) {
  const chain = [];
  const seen = new Set();
  const add = (provider, id) => {
    const k = `${provider}:${id}`;
    if (!id || seen.has(k)) return;
    seen.add(k);
    chain.push({ provider, model: id });
  };
  const lists = {};
  for (const p of ORDER.filter(isConfigured)) {
    try { lists[p] = await listModels(p); } catch { lists[p] = staticModels(p); }
  }
  const capable = (m) => !needsVision || m.vision;
  for (const p of ORDER) {
    const models = lists[p];
    if (!models) continue;
    const def = PROVIDERS[p].defaultModel;
    const sorted = [...models].sort((a, b) => tierRank(a) - tierRank(b));
    if (models.some(m => m.id === def) && capable(models.find(m => m.id === def))) add(p, def);
    sorted.filter(capable).forEach(m => add(p, m.id));
    PROVIDERS[p].backupModels.forEach(id => add(p, id));
  }
  if (needsVision) {
    for (const p of ORDER) (lists[p] || []).forEach(m => add(p, m.id));
  }
  return chain.slice(0, 24);
}

const IS_VERCEL = !!process.env.VERCEL;
// Leave room under the function's maxDuration (vercel.json: 120s).
const DEADLINE_MS = IS_VERCEL ? 105000 : 10 * 60 * 1000;
// One model that hangs must not eat the whole budget.
const ATTEMPT_MS = IS_VERCEL ? 75000 : 180000;

/**
 * Ask a model. `messages` is [{ role, content, attachments? }].
 * opts: { model:"provider:model", thinking:'low'|'high', json:true,
 *         onDelta, onThought, onReset, onStatus, signal, failover:true }
 * Returns { text, provider, model, tokensIn, tokensOut, truncated, attempts:[...] }.
 */
export async function askLLM({ system, messages, model, thinking = 'low', json = true,
  onDelta, onThought, onReset, onStatus, signal, failover = true }) {
  const first = parseModelId(model);
  if (!first) {
    throw httpError('AI açarı təyin edilməyib. Server mühitinə GEMINI_API_KEY (və ya GROQ_API_KEY / OPENROUTER_API_KEY) əlavə edin.', 503);
  }
  const needsVision = messages.some(m => m.attachments?.some(a => a.kind === 'image' || a.kind === 'pdf'));
  const chain = !failover ? [first]
    : first.auto ? await buildAutoChain(needsVision)
    : await buildChain(first, needsVision);
  const attempts = [];
  const started = Date.now();

  for (let i = 0; i < chain.length; i++) {
    const { provider, model: m } = chain[i];
    const apiKey = process.env[PROVIDERS[provider].envKey];
    noteRequest(`${provider}:${m}`);
    let emitted = false;
    const delta = onDelta ? t => { emitted = true; onDelta(t); } : undefined;
    const left = DEADLINE_MS - (Date.now() - started);
    const timeout = AbortSignal.timeout(Math.max(5000, Math.min(ATTEMPT_MS, left)));
    const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const args = { system, messages, model: m, apiKey, thinking, json, onDelta: delta, onThought, signal: attemptSignal };
      const out = provider === 'gemini'
        ? await callGemini(args)
        : await callOpenAICompatible({ ...args, provider });
      usage.tokensIn += out.tokensIn || 0;
      usage.tokensOut += out.tokensOut || 0;
      attempts.push({ provider, model: m, ok: true });
      return { ...out, provider, model: m, attempts };
    } catch (err) {
      let e = err;
      usage.errors += 1;
      attempts.push({ provider, model: m, ok: false, error: String(e.message || e).slice(0, 300), status: e.status || null });
      if (timeout.aborted && !signal?.aborted) {
        e = Object.assign(new Error(`${m}: cavab gecikdi (timeout)`), { status: 504 });
        attempts[attempts.length - 1].error = e.message;
      }
      const outOfTime = Date.now() - started > DEADLINE_MS - 8000;
      const last = i === chain.length - 1 || outOfTime;
      // In auto mode anything except the admin pressing "stop" moves on.
      const moveOn = first.auto ? true : retryable(e);
      if (last || !moveOn || signal?.aborted) {
        if (attempts.length > 1 && !signal?.aborted) {
          const err2 = new Error(`Heç bir model cavab vermədi (${attempts.length} model sınandı). Son xəta: ${e.message}`);
          err2.status = e.status || 502;
          err2.attempts = attempts;
          throw err2;
        }
        throw e;
      }
      usage.failovers += 1;
      if (emitted) onReset?.();
      const next = chain[i + 1];
      onStatus?.({
        type: 'failover',
        from: `${provider}:${m}`,
        to: `${next.provider}:${next.model}`,
        reason: String(e.message || '').slice(0, 160)
      });
    }
  }
  throw httpError('Heç bir model cavab vermədi.', 502);
}
