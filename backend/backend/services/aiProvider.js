// aiProvider.js
// Thin adapter over the FREE LLM APIs. Nothing here is Map-Panel specific —
// it just takes a system prompt + messages and returns raw text.
//
// Provider is picked automatically from whichever key is present in the env:
//   GEMINI_API_KEY      -> Google AI Studio (default, best free tier)
//   GROQ_API_KEY        -> Groq
//   OPENROUTER_API_KEY  -> OpenRouter (:free models)
//

const PROVIDERS = {
  gemini: {
    label: 'Google Gemini (AI Studio)',
    envKey: 'GEMINI_API_KEY',
    defaultModel: 'gemini-3.5-flash',
    // Published free-tier limits. They change on Google's side, so this is
    // shown in the UI as a reference, not as a hard guarantee.
    limits: { rpm: 15, rpd: 1500, tpm: 1000000 },
    docs: 'https://ai.google.dev/gemini-api/docs/rate-limits'
  },
  groq: {
    label: 'Groq',
    envKey: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    limits: { rpm: 30, rpd: 1000, tpm: 12000 },
    docs: 'https://console.groq.com/docs/rate-limits'
  },
  openrouter: {
    label: 'OpenRouter (free models)',
    envKey: 'OPENROUTER_API_KEY',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    limits: { rpm: 20, rpd: 50, tpm: null },
    docs: 'https://openrouter.ai/docs/api-reference/limits'
  }
};

export function pickProvider() {
  const forced = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (forced && PROVIDERS[forced]) return forced;
  for (const name of ['gemini', 'groq', 'openrouter']) {
    if (process.env[PROVIDERS[name].envKey]) return name;
  }
  return null;
}

// Gemini generations Google has retired or closed to new API keys. 1.5 and 2.0
// are fully shut down (404); 2.5 still answers for old projects but returns
// "no longer available to new users" for keys created after the cutoff.
// AI_MODEL lives in the Vercel dashboard, so a stale value there used to take
// the whole assistant down — ignore it instead of trusting it blindly.
const RETIRED_GEMINI = /^gemini-(1\.\d|2\.\d)/i;

function resolveModel(name) {
  const p = PROVIDERS[name];
  const want = (process.env.AI_MODEL || '').trim();
  if (!want) return p.defaultModel;
  if (name === 'gemini' && RETIRED_GEMINI.test(want)) return p.defaultModel;
  return want;
}

export function providerInfo(name) {
  const p = PROVIDERS[name];
  if (!p) return null;
  return {
    name,
    label: p.label,
    model: resolveModel(name),
    limits: p.limits,
    docs: p.docs
  };
}

export function allProviders() {
  return Object.keys(PROVIDERS).map(name => ({
    ...providerInfo(name),
    configured: !!process.env[PROVIDERS[name].envKey]
  }));
}

/* ------------------------------------------------------------------ *
 * Usage counters
 * ------------------------------------------------------------------ *
 * In-memory, per warm serverless instance. Enough to show the admin how
 * much of the free quota this session has burned; it resets when Vercel
 * spins up a cold instance, and the UI says so.
 */
const usage = {
  day: new Date().toISOString().slice(0, 10),
  requests: 0,
  minuteBucket: 0,
  minuteCount: 0,
  tokensIn: 0,
  tokensOut: 0,
  errors: 0,
  lastAt: null,
  startedAt: Date.now()
};

function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (usage.day !== today) {
    usage.day = today;
    usage.requests = 0;
    usage.tokensIn = 0;
    usage.tokensOut = 0;
    usage.errors = 0;
  }
}

function noteRequest() {
  rollDay();
  const bucket = Math.floor(Date.now() / 60000);
  if (usage.minuteBucket !== bucket) {
    usage.minuteBucket = bucket;
    usage.minuteCount = 0;
  }
  usage.minuteCount += 1;
  usage.requests += 1;
  usage.lastAt = Date.now();
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
    lastAt: usage.lastAt,
    instanceStartedAt: usage.startedAt
  };
}

/** Throw early instead of burning a call we know the provider will reject. */
function guardLocalLimits(info) {
  const u = getUsage();
  if (info.limits.rpd && u.requestsToday >= info.limits.rpd) {
    const e = new Error(`Günlük limit doldu (${u.requestsToday}/${info.limits.rpd}). Sabah yenilənəcək.`);
    e.status = 429;
    throw e;
  }
  if (info.limits.rpm && u.requestsThisMinute >= info.limits.rpm) {
    const e = new Error(`Dəqiqəlik limit doldu (${u.requestsThisMinute}/${info.limits.rpm}). Bir az gözləyin.`);
    e.status = 429;
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * Calls
 * ------------------------------------------------------------------ */

async function callGemini({ system, messages, model, apiKey }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    generationConfig: {
      // Gemini 3.x is a reasoning model: thinking tokens are billed against the
      // SAME budget as the answer. "medium" (the default) burns thousands of
      // them on this prompt, so the JSON came back truncated (MAX_TOKENS) and
      // unparseable, and every turn took ~10s. "low" is enough for filling in
      // our action schema, and the budget is big enough for a full diagram.
      thinkingConfig: { thinkingLevel: process.env.AI_THINKING_LEVEL || 'low' },
      maxOutputTokens: 16384,
      responseMimeType: 'application/json'
      // temperature/top_p/top_k are no longer recommended on Gemini 3.x —
      // the model is tuned for its defaults.
    }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error?.message || `Gemini ${res.status}`);
  }

  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text || '').join('');
  const reason = cand?.finishReason;

  // Fail loudly instead of handing a half-written JSON object to the parser.
  if (reason === 'MAX_TOKENS') {
    throw new Error('AI cavabı token limitinə çatdı və yarımçıq kəsildi. Tapşırığı kiçik hissələrə bölün.');
  }
  if (!text.trim()) {
    const blocked = data?.promptFeedback?.blockReason;
    throw new Error(blocked
      ? `AI sorğunu blokladı (${blocked}).`
      : `AI boş cavab qaytardı (finishReason: ${reason || 'naməlum'}).`);
  }

  return {
    text,
    tokensIn: data?.usageMetadata?.promptTokenCount || 0,
    // thoughtsTokenCount is billed as output too — count it so the usage panel
    // isn't lying about what a turn cost.
    tokensOut: (data?.usageMetadata?.candidatesTokenCount || 0)
      + (data?.usageMetadata?.thoughtsTokenCount || 0)
  };
}

async function callOpenAICompatible({ system, messages, model, apiKey, baseUrl, extraHeaders }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(extraHeaders || {})
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, ...messages]
    })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error?.message || `${baseUrl} ${res.status}`);
  }
  return {
    text: data?.choices?.[0]?.message?.content || '',
    tokensIn: data?.usage?.prompt_tokens || 0,
    tokensOut: data?.usage?.completion_tokens || 0
  };
}

/**
 * Ask the configured free provider for a completion.
 * `messages` is [{ role: 'user'|'assistant', content }].
 * Returns { text, provider, model, tokensIn, tokensOut }.
 */
export async function askLLM({ system, messages }) {
  const name = pickProvider();
  if (!name) {
    const e = new Error('AI açarı təyin edilməyib. Vercel-də GEMINI_API_KEY əlavə edin.');
    e.status = 503;
    throw e;
  }
  const info = providerInfo(name);
  const apiKey = process.env[PROVIDERS[name].envKey];
  guardLocalLimits(info);
  noteRequest();

  try {
    let out;
    if (name === 'gemini') {
      out = await callGemini({ system, messages, model: info.model, apiKey });
    } else if (name === 'groq') {
      out = await callOpenAICompatible({
        system, messages, model: info.model, apiKey,
        baseUrl: 'https://api.groq.com/openai/v1'
      });
    } else {
      out = await callOpenAICompatible({
        system, messages, model: info.model, apiKey,
        baseUrl: 'https://openrouter.ai/api/v1',
        extraHeaders: {
          'HTTP-Referer': process.env.CORS_ORIGIN || 'https://maps-panel.vercel.app',
          'X-Title': 'Map-Panel'
        }
      });
    }
    usage.tokensIn += out.tokensIn || 0;
    usage.tokensOut += out.tokensOut || 0;
    return { ...out, provider: name, model: info.model };
  } catch (e) {
    usage.errors += 1;
    throw e;
  }
}