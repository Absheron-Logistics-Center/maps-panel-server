// routes/users.js — accounts, developer only.
//   GET  /api/users                 every account (built-in + made here), no passwords
//   POST /api/users                 { username, name, role, password }
//   PUT  /api/users/:username       { name?, role?, password?, disabled? }   (built-in: name, disabled)
// No hard delete: switching an account off (disabled) keeps it in the file.
import { Router } from 'express';
import {
  readAccounts, updateAccounts, hashPassword, publicUser, validUsername, developerOf, ROLES, DEV_USERNAME
} from '../services/accounts.js';
import { BUILTIN_USERS } from './auth.js';

const router = Router();

export function requireDev(req, res, next) {
  if (!req.user?.dev) return res.status(403).json({ error: 'Yalnız developer' });
  next();
}
router.use(requireDev);

const err = (res, status, error) => res.status(status).json({ error });

router.get('/', async (_req, res, next) => {
  try {
    const acc = await readAccounts({ fresh: true });
    const dev = developerOf(acc);
    res.json({
      roles: ROLES,
      developer: { username: DEV_USERNAME, name: dev.name || 'Developer', mustChange: !!dev.mustChange },
      users: acc.users.filter(u => u.username !== DEV_USERNAME).map(u => ({ ...publicUser(u), builtin: false })),
      builtins: BUILTIN_USERS.map(b => ({
        username: b.username,
        name: acc.builtins?.[b.username]?.name || b.username,
        role: b.role,
        disabled: !!acc.builtins?.[b.username]?.disabled,
        builtin: true
      }))
    });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim();
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const role = String(req.body?.role || 'admin');
    const password = String(req.body?.password || '');
    if (!validUsername(username)) return err(res, 400, 'İstifadəçi adı 3-32 simvol olmalıdır: hərf, rəqəm, nöqtə, tire.');
    if (!name) return err(res, 400, 'Ad yazın (kursorun yanında bu ad görünəcək).');
    if (!ROLES.includes(role)) return err(res, 400, 'Rol düz deyil.');
    if (password.length < 8) return err(res, 400, 'Şifrə ən azı 8 simvol olmalıdır.');
    const lower = username.toLowerCase();
    if (lower === DEV_USERNAME || BUILTIN_USERS.some(b => b.username.toLowerCase() === lower)) return err(res, 409, 'Bu istifadəçi adı artıq var.');
    let made = null;
    await updateAccounts(acc => {
      if (acc.users.some(u => u.username.toLowerCase() === lower)) {
        const e = new Error('Bu istifadəçi adı artıq var.'); e.status = 409; throw e;
      }
      made = {
        username, name, role, hash: hashPassword(password),
        mustChange: !!req.body?.mustChange,
        disabled: false, createdAt: new Date().toISOString(), createdBy: req.user.username
      };
      acc.users.push(made);
      return acc;
    });
    res.status(201).json({ ...publicUser(made), builtin: false });
  } catch (e) { if (e.status) return err(res, e.status, e.message); next(e); }
});

router.put('/:username', async (req, res, next) => {
  try {
    const target = String(req.params.username);
    if (target === DEV_USERNAME) return err(res, 400, 'Developer hesabı burada dəyişmir; öz şifrənizi "Şifrəni dəyiş" ilə yeniləyin.');
    const b = BUILTIN_USERS.find(x => x.username === target);
    const body = req.body || {};
    let out = null;
    await updateAccounts(acc => {
      if (b) {
        const cur = acc.builtins[target] || {};
        if (body.name !== undefined) cur.name = String(body.name).trim().slice(0, 60) || undefined;
        if (body.disabled !== undefined) cur.disabled = !!body.disabled;
        acc.builtins[target] = cur;
        out = { username: target, name: cur.name || target, role: b.role, disabled: !!cur.disabled, builtin: true };
        return acc;
      }
      const u = acc.users.find(x => x.username === target);
      if (!u) { const e = new Error('Hesab tapılmadı.'); e.status = 404; throw e; }
      if (body.name !== undefined) {
        const n = String(body.name).trim().slice(0, 60);
        if (!n) { const e = new Error('Ad boş ola bilməz.'); e.status = 400; throw e; }
        u.name = n;
      }
      if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) { const e = new Error('Rol düz deyil.'); e.status = 400; throw e; }
        u.role = body.role;
      }
      if (body.password !== undefined && body.password !== '') {
        if (String(body.password).length < 8) { const e = new Error('Şifrə ən azı 8 simvol olmalıdır.'); e.status = 400; throw e; }
        u.hash = hashPassword(body.password);
        u.mustChange = !!body.mustChange;
      }
      if (body.disabled !== undefined) u.disabled = !!body.disabled;
      u.updatedAt = new Date().toISOString();
      u.updatedBy = req.user.username;
      out = { ...publicUser(u), builtin: false };
      return acc;
    });
    res.json(out);
  } catch (e) { if (e.status) return err(res, e.status, e.message); next(e); }
});

export default router;
