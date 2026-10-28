import { Router } from 'express';
import { getFile, putFile } from '../services/store.js';

const router = Router();
const dataPath = () => (process.env.DATA_PATH || 'data').replace(/^\/|\/$/g, '');
const labelsPath = () => `${dataPath()}/labels.json`;

// Only interface-text overrides live here — a sparse { id: "text" } map.
// The canonical default text for every id lives in the frontend registry
// (frontend/src/labels/labelDefs.js); this file only holds the ids that
// editor_2 has actually renamed. Diagram content (nodes, lanes, titles,
// etc.) is never touched by this route — that stays under /api/processes,
// admin-only.
function requireLabelEditor(req, res, next) {
  const role = req.user?.role;
  if (role !== 'editor_2' && role !== 'superadmin') {
    return res.status(403).json({ error: 'Only the interface-text editor can change labels' });
  }
  next();
}

async function readLabels() {
  const file = await getFile(labelsPath());
  return (file && file.content && typeof file.content === 'object') ? file.content : {};
}

// GET /api/labels — anyone logged in (everyone should see editor_2's renames)
router.get('/', async (_req, res, next) => {
  try {
    res.json(await readLabels());
  } catch (e) { next(e); }
});

// PUT /api/labels — editor_2 (or superadmin) only. Body: { id, text }
// Upserts a single label. Sending an empty/whitespace text resets it back
// to the frontend's default (removes the override).
router.put('/', requireLabelEditor, async (req, res, next) => {
  try {
    const { id, text } = req.body || {};
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'id is required' });
    }
    const current = await readLabels();
    const next = { ...current };
    if (typeof text === 'string' && text.trim()) {
      next[id] = text;
    } else {
      delete next[id];
    }
    await putFile(labelsPath(), next, { message: `Update interface label "${id}"` });
    res.json(next);
  } catch (e) { next(e); }
});

// DELETE /api/labels/:id — reset a single label back to its default
router.delete('/:id', requireLabelEditor, async (req, res, next) => {
  try {
    const current = await readLabels();
    const next = { ...current };
    delete next[req.params.id];
    await putFile(labelsPath(), next, { message: `Reset interface label "${req.params.id}"` });
    res.json(next);
  } catch (e) { next(e); }
});

export default router;
