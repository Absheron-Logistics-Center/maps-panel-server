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
  hub_tmpl_sub: 'Sənəd şablonları',
  jobs_page_title: 'Vəzifə Təlimatları',
  hub_jobs_title: 'Vəzifə Təlimatları',
  hub_jobs_sub: 'Struktur bölmələri üzrə vəzifələr'
};
// On/off switches. autolink_<kind>: link Hesabat rows and Home items with the
// same name automatically (off by default — linking is manual).
const FLAGS = {
  autolink_diagrams: false,
  autolink_pdfs: false,
  autolink_templates: false,
  autolink_jobs: false
};

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

async function readSettings() {
  const file = await getFile(settingsPath());
  return { ...DEFAULTS, ...FLAGS, ...(file?.content || {}) };
}
export async function autoLinkOn(kind) {
  try { return (await readSettings())[`autolink_${kind}`] === true; } catch { return false; }
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
    for (const k of Object.keys(FLAGS)) {
      if (typeof incoming[k] === 'boolean') next[k] = incoming[k];
    }
    await putFile(settingsPath(), next, { message: 'Update settings' });
    res.json(next);
  } catch (e) { next(e); }
});

export default router;
