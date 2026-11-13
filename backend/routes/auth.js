import express from 'express';
import jwt from 'jsonwebtoken';
import {
  readAccounts, updateAccounts, developerOf, checkPassword, hashPassword, isDisabled, DEV_USERNAME
} from '../services/accounts.js';

const router = express.Router();

const USERS = [
  {
    // Admin accounts — for each one, the password is just the
    // username itself (e.g. "admin_2" logs in with "admin_2" / "admin_2").
    // To add another admin later, copy this pattern with a new username.
    username: 'admin_2',
    password: 'admin_2',
    role: 'admin'
  },
  {
    username: 'admin_123e123',
    password: 'admin_123e123',
    role: 'admin'
  },
  {
    username: 'user',
    password: 'user123',
    role: 'viewer'
  },
  {
    // Interface-text editor. Can only rename static UI labels (button
    // text, panel-tab names, popup headings, etc.) via the label-editor
    // screen — cannot touch diagram content (that stays admin's job).
    username: 'editor_2',
    password: 'editor_2',
    role: 'editor_2'
  }
];

export function requireAuth(req, res, next) {

  try {

    const authHeader =
      req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {

      return res.status(401).json({
        error: 'Unauthorized'
      });
    }

    const token =
      authHeader.replace('Bearer ', '');

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'absheron-secret'
    );

    req.user = decoded;

  } catch (e) {

    return res.status(401).json({
      error: 'Invalid token'
    });
  }

  // an account the developer switched off stops working at once
  isDisabled(req.user.username, !!req.user.builtin)
    .then(off => (off ? res.status(401).json({ error: 'Hesab deaktiv edilib' }) : next()))
    .catch(() => next());
}

const SECRET = () => process.env.JWT_SECRET || 'absheron-secret';

function sign(user, { builtin = false } = {}) {
  const dev = user.role === 'developer';
  const payload = {
    username: user.username,
    // the developer is an admin everywhere; `dev` unlocks the developer-only parts
    role: dev ? 'admin' : user.role,
    name: user.name || user.username,
    ...(dev ? { dev: true } : {}),
    ...(builtin ? { builtin: true } : {})
  };
  return { token: jwt.sign(payload, SECRET()), ...payload };
}

/** username + password -> { user, builtin } or null */
async function findLogin(username, password) {
  const uname = String(username || '').trim();
  const acc = await readAccounts({ fresh: true }).catch(() => ({ users: [], builtins: {} }));

  if (uname.toLowerCase() === DEV_USERNAME) {
    const d = developerOf(acc);
    const ok = d.plain != null ? password === d.plain : checkPassword(password, d.hash);
    return ok && !d.disabled ? { user: { ...d, role: 'developer' }, builtin: false } : null;
  }

  const made = acc.users.find(u => u.username.toLowerCase() === uname.toLowerCase());
  if (made) {
    if (made.disabled || !checkPassword(password, made.hash)) return null;
    return { user: made, builtin: false };
  }

  const b = USERS.find(x => x.username === uname && x.password === password);
  if (!b) return null;
  const over = acc.builtins?.[b.username] || {};
  if (over.disabled) return null;
  return { user: { ...b, name: over.name || b.username }, builtin: true };
}

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const found = await findLogin(username, password);
    if (!found) return res.status(401).json({ error: 'Bad credentials' });
    const t = sign(found.user, { builtin: found.builtin });
    res.json({ ...t, mustChange: !!found.user.mustChange });
  } catch (e) { next(e); }
});

router.get('/me', requireAuth, async (req, res) => {
  let mustChange = false;
  if (req.user.dev) {
    try { mustChange = !!developerOf(await readAccounts()).mustChange; } catch { /* ignore */ }
  } else if (!req.user.builtin) {
    try { mustChange = !!(await readAccounts()).users.find(u => u.username === req.user.username)?.mustChange; } catch { /* ignore */ }
  }
  res.json({
    username: req.user.username,
    role: req.user.role,
    name: req.user.name || req.user.username,
    dev: !!req.user.dev,
    builtin: !!req.user.builtin,
    mustChange
  });
});

// change your own password (developer and accounts the developer made)
router.post('/account/password', requireAuth, async (req, res, next) => {
  try {
    const { current, next: pw } = req.body || {};
    if (req.user.builtin) return res.status(400).json({ error: 'Bu daxili hesabın şifrəsi proqramda yazılıb, burada dəyişmir.' });
    if (String(pw || '').length < 8) return res.status(400).json({ error: 'Yeni şifrə ən azı 8 simvol olmalıdır.' });
    const found = await findLogin(req.user.username, current);
    if (!found) return res.status(400).json({ error: 'Hazırkı şifrə düz deyil.' });
    const hash = hashPassword(pw);
    await updateAccounts(acc => {
      const i = acc.users.findIndex(u => u.username === req.user.username);
      if (i >= 0) acc.users[i] = { ...acc.users[i], hash, mustChange: false, passwordChangedAt: new Date().toISOString() };
      else if (req.user.dev) acc.users.push({ username: DEV_USERNAME, name: 'Developer', role: 'developer', hash, mustChange: false, createdAt: new Date().toISOString(), createdBy: 'system' });
      delete acc.users.find(u => u.username === req.user.username)?.plain;
      return acc;
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export { USERS as BUILTIN_USERS };
export default router;