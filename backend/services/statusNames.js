/*
  Statuses are STORED by their real names ("Planlaşdırılır", "Təsdiqlənmiş"…)
  so the JSON in Mongo and in data/ reads the same as the screen. The API and
  the frontend keep using short keys (progress, done…) — store.js converts on
  every read/write, so nothing else has to know.

  Must stay in step with frontend/src/components/Status.jsx (default labels).
*/
import { kindOfPath } from './paths.js';

const PROCESS = {
  progress: 'Planlaşdırılır',
  prep: 'Hazırlıq prosesindədir',
  notdone: 'Müzakirədədir',
  done: 'Təsdiqlənmiş',
  cancelled: 'Ləğv edilmiş'
};
const DOC = {
  progress: 'Planlaşdırılır',
  prep: 'Hazırlıq prosesində',
  notdone: 'Müzakirədədir',
  sign: 'İmza prosesindədir',
  done: 'Təsdiq edildi',
  cancelled: 'Ləğv edildi',
  renew: 'Yeniləcək'
};

const JOB = {
  exists: 'Mövcuddur',
  missing: 'Mövcud deyil'
};

const byKind = (kind) => (kind === 'diagrams' ? PROCESS : kind === 'jobs' ? JOB : DOC);
const fold = (s) => String(s || '').trim().toLocaleLowerCase('az');

export function statusName(kind, key) {
  if (key == null || key === '') return null;
  return byKind(kind)[key] || null;
}

// Accepts a key OR a name (either section's spelling) and returns the key.
export function statusKey(kind, value) {
  if (value == null || value === '') return null;
  const map = byKind(kind);
  if (map[value]) return value;
  const f = fold(value);
  for (const [k, name] of Object.entries(map)) if (fold(name) === f) return k;
  for (const [k, name] of Object.entries({ ...PROCESS, ...DOC, ...JOB })) if (fold(name) === f) return k;
  return null;
}

const LIST_KEYS = ['processes', 'pdfs', 'templates', 'items'];

function mapDoc(content, fn) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
  let out = content;
  if ('status' in content) out = { ...out, status: fn(content.status) };
  for (const k of LIST_KEYS) {
    if (!Array.isArray(content[k])) continue;
    out = out === content ? { ...content } : out;
    out[k] = content[k].map((row) =>
      row && typeof row === 'object' && 'status' in row ? { ...row, status: fn(row.status) } : row
    );
  }
  return out;
}

const clean = (v) => (v == null ? undefined : v);

// Before writing: keys -> names. Unknown values are left as they are.
export function encodeStatuses(path, content) {
  const kind = kindOfPath(path);
  if (!kind) return content;
  const out = mapDoc(content, (v) => clean(statusName(kind, statusKey(kind, v)) ?? v));
  return stripUndefined(out);
}

// After reading: names (or old keys) -> keys.
export function decodeStatuses(path, content) {
  const kind = kindOfPath(path);
  if (!kind) return content;
  return stripUndefined(mapDoc(content, (v) => clean(statusKey(kind, v))));
}

function stripUndefined(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  if ('status' in doc && doc.status === undefined) { const { status, ...rest } = doc; doc = rest; }
  for (const k of LIST_KEYS) {
    if (Array.isArray(doc[k])) {
      doc[k] = doc[k].map((r) => {
        if (r && typeof r === 'object' && 'status' in r && r.status === undefined) {
          const { status, ...rest } = r;
          return rest;
        }
        return r;
      });
    }
  }
  return doc;
}
