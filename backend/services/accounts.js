// accounts.js — login accounts made by the developer, plus the developer
// account itself. Stored like everything else (store.js → MongoDB + data/),
// so Vercel and the own server see the same accounts.
//
//   data/auth/accounts.json
//   {
//     users:    [ { username, name, role, hash, createdAt, createdBy, disabled, mustChange } ],
//     builtins: { "<built-in username>": { name, disabled } }   // overrides for routes/auth.js USERS
//   }
//
// Roles: developer | admin | viewer | editor_2.
// The developer is an admin everywhere (the token says role "admin" + dev: true),
// and is the only one who may install versions and manage accounts.
//
// Nothing is hard-deleted: an account is switched off (disabled) instead.

import crypto from 'crypto';
import { getFile, putFile } from './store.js';

const PATH = () => `${(process.env.DATA_PATH || 'data').replace(/^\/|\/$/g, '')}/auth/accounts.json`;

export const ROLES = ['admin', 'viewer', 'editor_2'];
export const DEV_USERNAME = 'developer';
// First login only: the developer must choose a new password right away.
// (Set DEV_PASSWORD in .env to use your own from the start instead.)
const DEV_BOOT_HASH = 'scrypt$xakq62TTY7GlPMymbX7TnQ==$fi2Aa2ShgiVPLMxUYFj/LFNw1U4z8WWmz+g7FTuGeNY=';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('base64');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('base64');
  return `scrypt$${salt}$${h}`;
}
export function checkPassword(pw, stored) {
  const [kind, salt, h] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !h) return false;
  const got = crypto.scryptSync(String(pw), salt, 32);
  const want = Buffer.from(h, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

let cache = null, cacheAt = 0;
let chain = Promise.resolve();

export async function readAccounts({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 15000) return cache;
  let doc = null;
  try { doc = (await getFile(PATH()))?.content || null; } catch { doc = cache; }
  const out = {
    users: Array.isArray(doc?.users) ? doc.users : [],
    builtins: doc?.builtins && typeof doc.builtins === 'object' ? doc.builtins : {}
  };
  cache = out; cacheAt = Date.now();
  return out;
}

/** serialised read-modify-write */
export function updateAccounts(fn) {
  chain = chain.catch(() => {}).then(async () => {
    const cur = await readAccounts({ fresh: true });
    const next = await fn(structuredClone(cur));
    await putFile(PATH(), { ...next, updatedAt: new Date().toISOString() });
    cache = next; cacheAt = Date.now();
    return next;
  });
  return chain;
}

/** The developer account as stored, or the first-run one. */
export function developerOf(acc) {
  const stored = acc.users.find(u => u.username === DEV_USERNAME);
  if (stored) return stored;
  if (process.env.DEV_PASSWORD) {
    return { username: DEV_USERNAME, name: 'Developer', role: 'developer', plain: process.env.DEV_PASSWORD, mustChange: false };
  }
  return { username: DEV_USERNAME, name: 'Developer', role: 'developer', hash: DEV_BOOT_HASH, mustChange: true, boot: true };
}

export function validUsername(u) {
  return /^[a-z0-9._-]{3,32}$/i.test(String(u || ''));
}

/** what the token / UI see */
export function publicUser(u) {
  return {
    username: u.username,
    name: u.name || u.username,
    role: u.role,
    disabled: !!u.disabled,
    createdAt: u.createdAt || null,
    createdBy: u.createdBy || null,
    mustChange: !!u.mustChange
  };
}

/** Is this login still allowed? (checked on every request, cached 15 s) */
export async function isDisabled(username, builtin) {
  const acc = await readAccounts();
  if (builtin) return !!acc.builtins?.[username]?.disabled;
  const u = acc.users.find(x => x.username === username);
  return !!u?.disabled;
}
