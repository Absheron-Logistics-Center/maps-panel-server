import { Router } from 'express';
import { askLLM, pickProvider, providerInfo, allProviders, getUsage } from '../services/aiProvider.js';
import { buildSystemPrompt, parseModelJson } from '../services/aiSchema.js';

const router = Router();

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
 * server instance has used.
 */
router.get('/limits', (_req, res) => {
  const name = pickProvider();
  res.json({
    enabled: !!name,
    active: name ? providerInfo(name) : null,
    providers: allProviders(),
    usage: getUsage(),
    // The counters live in the serverless instance's memory, so be honest
    // about it in the UI rather than presenting them as authoritative.
    usageNote: 'Sayğaclar bu server instansiyasının yaddaşındadır və soyuq başlanğıcda sıfırlanır. Provayder limitləri istinad üçündür.'
  });
});

/**
 * POST /api/ai/chat
 * body: { messages: [{role, content}], context: {...} }
 * -> { reply, ask, actions, meta }
 */
router.post('/chat', async (req, res, next) => {
  try {
    const { messages, context } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages tələb olunur' });
    }

    // Keep the window small — the context block is the expensive part and the
    // free tiers are token-limited.
    const trimmed = messages
      .filter(m => m && typeof m.content === 'string' && m.content.trim())
      .slice(-12)
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content).slice(0, 8000)
      }));

    const system = buildSystemPrompt(context);
    const out = await askLLM({ system, messages: trimmed });
    const parsed = parseModelJson(out.text);

    res.json({
      ...parsed,
      meta: {
        provider: out.provider,
        model: out.model,
        tokensIn: out.tokensIn,
        tokensOut: out.tokensOut,
        usage: getUsage(),
        limits: providerInfo(out.provider)?.limits || null
      }
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

export default router;
