import { Router } from 'express';
import { getFile, putFile } from '../services/store.js';

const router = Router();
const dataPath = () => (process.env.DATA_PATH || 'data').replace(/^\/|\/$/g, '');
const settingsPath = () => `${dataPath()}/settings.json`;

const DEFAULTS = {
  org_title: 'ABŞERON LOGİSTİKA MƏRKƏZİ',
  diagrams_page_title: 'İş Axışları',
  pdf_page_title: 'Normativ Sənədlər',
  tmpl_page_title: 'Şablonlar',
  hub_diagrams_title: 'İş Axışları',
  hub_diagrams_sub: 'Proses xəritələri',
  hub_pdf_title: 'Normativ Sənədlər',
  hub_pdf_sub: 'Prosedurlar, prosesler, əsəsnamələr',
  hub_tmpl_title: 'Şablonlar',
  hub_tmpl_sub: 'Sənəd şablonları'
};

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

async function readSettings() {
  const file = await getFile(settingsPath());
  return { ...DEFAULTS, ...(file?.content || {}) };
}

// GET /api/settings — anyone logged in
router.get('/', async (_req, res, next) => {
  try {
    res.json(await readSettings());
  } catch (e) { next(e); }
});

// PUT /api/settings — admin only; merges provided keys
router.put('/', requireAdmin, async (req, res, next) => {
  try {
    const current = await readSettings();
    const incoming = req.body || {};
    const next = { ...current };
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof incoming[k] === 'string') next[k] = incoming[k];
    }
    await putFile(settingsPath(), next, { message: 'Update settings' });
    res.json(next);
  } catch (e) { next(e); }
});

export default router;
