
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const API_BASE = 'https://api.github.com';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Project root (…/backend/services -> …/)  — the real `data/` folder lives here.
const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_DATA_DIR = REPO_ROOT;
const isVercel = !!(process.env.VERCEL === '1' || process.env.VERCEL_ENV || process.env.NOW_REGION);
const LOCAL_DATA_DIR = process.env.LOCAL_DATA_DIR ||
  (isVercel
    ? path.join(os.tmpdir(), 'mappanel-data')
    : REPO_ROOT);

function cfg() {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH = 'main' } = process.env;
  return { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH };
}

function hasGithubConfig() {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = cfg();
  return !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);
}

// Builds { message, author } for a commit made by a specific panel admin.
// The GitHub push always happens under the GITHUB_TOKEN's identity (that's
// who "committed" it), but we can additionally set a custom "author" on the
// commit so the panel username shows up next to the change — e.g. the
// commit message becomes "Update process 3 (by admin_2)" and the commit's
// author name/email is set to that admin. GitHub will only link it to a
// profile picture if the email matches a real GitHub account; otherwise it
// just shows as plain text, which is still enough to tell who did it.
// Usage: putFile(path, content, attribution(req.user, 'Update process 3'))
export function attribution(user, message) {
  const username = user?.username;
  if (!username) return { message };
  return {
    message: `${message} (by ${username})`,
    author: {
      name: username,
      email: `${username}@map-panel.local`
    }
  };
}

function headers() {
  const { GITHUB_TOKEN } = cfg();
  return {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

function urlFor(p) {
  const { GITHUB_OWNER, GITHUB_REPO } = cfg();
  const encodedPath = p.split('/').map(encodeURIComponent).join('/');
  return `${API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}`;
}

async function localPath(p) {
  const full = path.join(LOCAL_DATA_DIR, p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  return full;
}

async function localGet(p) {
  try {
    const full = await localPath(p);
    const text = await fs.readFile(full, 'utf8');
    return {
      content: JSON.parse(text),
      sha: 'local'
    };
  } catch {
    try {
      const full = path.join(DEFAULT_DATA_DIR, p);
      const text = await fs.readFile(full, 'utf8');
      return {
        content: JSON.parse(text),
        sha: 'local'
      };
    } catch {
      return null;
    }
  }
}

async function localPut(p, contentObject) {
  const full = await localPath(p);
  await fs.writeFile(full, JSON.stringify(contentObject, null, 2));
  return { ok: true };
}

async function localDelete(p) {
  try {
    const full = await localPath(p);
    await fs.unlink(full);
    return true;
  } catch {
    return false;
  }
}

export async function getFile(p) {
  // A path with a not-yet-pushed queued write (see the debounce queue below)
  // means THIS process just changed it locally and hasn't committed it to
  // GitHub yet — trust the local copy instead of re-fetching the pre-change
  // version from GitHub, or a just-saved item would vanish from the very
  // next list/read until the debounce timer fires.
  if (pendingWrites.has(p)) {
    const local = await localGet(p);
    if (local) return local;
  }

  // No GitHub credentials configured at all — e.g. a fully standalone local
  // deployment with GITHUB_TOKEN left blank on purpose. The local `data/`
  // folder is the only copy that exists, so it's the source of truth by
  // necessity. Once GitHub IS configured (on Vercel or on your own server),
  // GitHub is always the source of truth and local is just a write-through
  // mirror/offline fallback below — this used to also trust the local copy
  // first on a non-Vercel deploy even when GitHub was configured, which is
  // why the self-hosted server and Vercel could silently drift apart: the
  // server kept re-serving its own stale local cache instead of ever
  // re-checking GitHub for a path it already had.
  if (!hasGithubConfig()) return localGet(p);

  try {
    const { GITHUB_BRANCH } = cfg();
    const res = await fetch(`${urlFor(p)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
      headers: headers()
    });

    if (res.status === 404) return localGet(p);
    if (!res.ok) throw new Error(await res.text());

    const data = await res.json();
    const text = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');

    return {
      content: JSON.parse(text),
      sha: data.sha
    };
  } catch {
    return localGet(p);
  }
}

export async function putFile(p, contentObject, { message, sha, author } = {}) {
  // Always keep the local `data/` folder in sync
  await localPut(p, contentObject).catch(() => {});

  if (!hasGithubConfig()) return { ok: true };

  try {
    return await withPathLock(p, async () => {
      const { GITHUB_BRANCH } = cfg();

      let effectiveSha = sha;
      if (effectiveSha === undefined) {
        effectiveSha = await ghGetBinarySha(p).catch(() => null);
      }

      const content = Buffer.from(
        JSON.stringify(contentObject, null, 2) + '\n',
        'utf8'
      ).toString('base64');

      const body = {
        message: message || `Update ${p}`,
        content,
        branch: GITHUB_BRANCH
      };

      if (author) {
        body.author = author;
        body.committer = author;
      }

      if (effectiveSha && effectiveSha !== 'local') body.sha = effectiveSha;

      return putToGithub(p, body);
    });
  } catch (e) {
    console.error('[putFile] GitHub sync failed:', e.message);
    // On Vercel the local mirror lives in /tmp and is wiped between cold
    // starts, so a failed GitHub write means the edit is effectively lost —
    // pretending success here is what made writes silently vanish. Surface
    // it instead so the admin UI shows a real error.
    if (isVercel) {
      const err = new Error(`GitHub sync failed: ${e.message}`);
      err.status = 502;
      throw err;
    }
    return { ok: true, githubSynced: false };
  }
}

export async function deleteFile(p, { message, author } = {}) {
  // Always remove the local mirror first
  await localDelete(p);

  if (!hasGithubConfig()) return { ok: true };

  try {
    return await withPathLock(p, async () => {
      const sha = await ghGetBinarySha(p).catch(() => null);
      if (!sha) return { ok: true };

      const { GITHUB_BRANCH } = cfg();
      const res = await fetch(urlFor(p), {
        method: 'DELETE',
        headers: headers(),
        body: JSON.stringify({
          message: message || `Delete ${p}`,
          sha,
          branch: GITHUB_BRANCH,
          ...(author ? { author, committer: author } : {})
        })
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    });
  } catch (e) {
    console.error('[deleteFile] GitHub sync failed:', e.message);
    if (isVercel) {
      const err = new Error(`GitHub sync failed: ${e.message}`);
      err.status = 502;
      throw err;
    }
    return { ok: true, githubSynced: false };
  }
}

/* ============================================================
   BINARY FILE HELPERS (for PDFs, images, etc.)
   Separate from the JSON helpers above so each path is clean.
   ============================================================ */

async function localGetBinary(p) {
  try {
    const full = path.join(LOCAL_DATA_DIR, p);
    return await fs.readFile(full);
  } catch {
    try {
      const full = path.join(DEFAULT_DATA_DIR, p);
      return await fs.readFile(full);
    } catch {
      return null;
    }
  }
}

async function localPutBinary(p, buffer) {
  const full = path.join(LOCAL_DATA_DIR, p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer);
  return { ok: true };
}

async function localDeleteBinary(p) {
  try {
    const full = path.join(LOCAL_DATA_DIR, p);
    await fs.unlink(full);
    return true;
  } catch {
    return false;
  }
}

async function ghGetBinarySha(p) {
  const { GITHUB_BRANCH } = cfg();
  const res = await fetch(`${urlFor(p)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
    headers: headers()
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.sha || null;
}

/* ============================================================
   PER-PATH WRITE SERIALIZATION + 409 (SHA CONFLICT) RETRY
   ------------------------------------------------------------
   Two things were causing "does not match <sha>" 409 errors:
   1) Two writes to the same path (e.g. index.json + archive.json
      saves fired back-to-back from a batch save) could race: both
      read the same starting sha before either PUT completed, so the
      second PUT always got rejected.
   2) Even a single write could lose a sha race against itself if the
      sha was fetched slightly before a concurrent request updated it.
   withPathLock() forces every write to a given repo path to run one
   at a time (within this server process). putToGithub() additionally
   retries once on a 409 by re-fetching the latest sha and re-sending
   the PUT — this recovers automatically instead of surfacing an
   error to the admin for what's usually just a timing hiccup.
   ============================================================ */
const pathLocks = new Map();
function withPathLock(p, fn) {
  const prev = pathLocks.get(p) || Promise.resolve();
  const run = prev.then(fn, fn);
  pathLocks.set(p, run.catch(() => {}));
  return run;
}

async function putToGithub(p, body, attempt = 0) {
  const res = await fetch(urlFor(p), {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(body)
  });

  if (res.status === 409 && attempt < 2) {
    // Someone else's write landed between our sha read and our PUT.
    // Re-fetch the current sha and try again with it.
    const freshSha = await ghGetBinarySha(p).catch(() => null);
    if (freshSha) {
      return putToGithub(p, { ...body, sha: freshSha }, attempt + 1);
    }
  }

  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getBinary(p) {
  if (pendingWrites.has(p)) {
    const local = await localGetBinary(p);
    if (local) return local;
  }

  if (!hasGithubConfig()) return localGetBinary(p);

  try {
    const { GITHUB_BRANCH } = cfg();
    const res = await fetch(`${urlFor(p)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
      headers: headers()
    });
    if (res.status === 404) return localGetBinary(p);
    if (!res.ok) throw new Error(await res.text());

    const data = await res.json();
    // If file is large (>1MB) GitHub returns empty content + download_url
    if (data.content) {
      return Buffer.from(data.content.replace(/\n/g, ''), 'base64');
    }
    if (data.download_url) {
      const raw = await fetch(data.download_url, { headers: { Authorization: `Bearer ${cfg().GITHUB_TOKEN}` } });
      if (!raw.ok) throw new Error('download_url fetch failed');
      const ab = await raw.arrayBuffer();
      return Buffer.from(ab);
    }
    return null;
  } catch {
    return localGetBinary(p);
  }
}

export async function putBinary(p, buffer, { message, author } = {}) {
  // Always mirror to local store too — keeps things working offline / on token error
  await localPutBinary(p, buffer);

  if (!hasGithubConfig()) return { ok: true };

  try {
    return await withPathLock(p, async () => {
      const { GITHUB_BRANCH } = cfg();
      const sha = await ghGetBinarySha(p).catch(() => null);
      const body = {
        message: message || `Update ${p}`,
        content: buffer.toString('base64'),
        branch: GITHUB_BRANCH
      };
      if (sha) body.sha = sha;
      if (author) { body.author = author; body.committer = author; }

      return putToGithub(p, body);
    });
  } catch (e) {
    console.error('[putBinary] GitHub sync failed:', e.message);
    if (isVercel) {
      const err = new Error(`GitHub sync failed: ${e.message}`);
      err.status = 502;
      throw err;
    }
    return { ok: true, githubSynced: false };
  }
}

export async function deleteBinary(p, { message, author } = {}) {
  await localDeleteBinary(p);

  if (!hasGithubConfig()) return { ok: true };

  try {
    return await withPathLock(p, async () => {
      const sha = await ghGetBinarySha(p);
      if (!sha) return { ok: true };

      const { GITHUB_BRANCH } = cfg();
      const res = await fetch(urlFor(p), {
        method: 'DELETE',
        headers: headers(),
        body: JSON.stringify({
          message: message || `Delete ${p}`,
          sha,
          branch: GITHUB_BRANCH,
          ...(author ? { author, committer: author } : {})
        })
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    });
  } catch (e) {
    console.error('[deleteBinary] GitHub sync failed:', e.message);
    if (isVercel) {
      const err = new Error(`GitHub sync failed: ${e.message}`);
      err.status = 502;
      throw err;
    }
    return { ok: true, githubSynced: false };
  }
}

/* ============================================================
   DEBOUNCED / BATCHED GITHUB PUSH QUEUE
   ------------------------------------------------------------
   putFileQueued / putBinaryQueued / deleteFileQueued / deleteBinaryQueued
   write to the local mirror IMMEDIATELY (so the request returns fast and
   getFile/getBinary above see the change right away), but hold off on the
   actual GitHub commit. Every further queued write resets a single shared
   15s timer; only once nothing new comes in for 15s does everything queued
   up get pushed, one commit per path. Uploading several files back-to-back
   (e.g. one PDF per line item in a group) collapses into far fewer commits
   than the old "commit on every request" behaviour.
   A path written twice before the flush only keeps the LAST write (Map
   overwrite) — no point committing an intermediate version nobody sees.
   If GitHub isn't configured this degrades to local-only, same as before.

   CAVEAT — this app is deployed on Vercel serverless functions, which are
   not guaranteed to stay warm for the full 15s: if the instance handling
   an upload is recycled before the timer fires, that queued push is lost
   from THIS process's memory (the local mirror it wrote to is `/tmp`,
   which doesn't survive a cold start either). Two things bound the damage:
     1) MAX_PENDING below forces an early flush once enough changes have
        piled up, so the exposure window shrinks under heavy activity
        instead of growing.
     2) flushGithubQueue() is exported so it can be called from an admin
        "sync now" action or a periodic cron hitting a small route — worth
        wiring up if silent data loss on an unlucky cold start is a
        concern (Vercel Cron on the Hobby tier only fires once a day, so a
        real safety net needs a Pro plan cron, or an external pinger).
   ============================================================ */
const pendingWrites = new Map(); // path -> { kind, ...write-specific fields }
let flushTimer = null;
const DEBOUNCE_MS = 15_000;
const MAX_PENDING = 25;

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  if (pendingWrites.size >= MAX_PENDING) {
    flushTimer = null;
    flushGithubQueue().catch(e => console.error('[githubQueue] forced flush failed:', e.message));
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushGithubQueue().catch(e => console.error('[githubQueue] flush failed:', e.message));
  }, DEBOUNCE_MS);
  // Don't let this pending timer keep a local `node server.js` process
  // alive on its own if everything else has finished.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

export async function putFileQueued(p, contentObject, { message, author } = {}) {
  await localPut(p, contentObject).catch(() => {});
  if (!hasGithubConfig()) return { ok: true };
  pendingWrites.set(p, { kind: 'file', contentObject, message, author });
  scheduleFlush();
  return { ok: true, queued: true };
}

export async function putBinaryQueued(p, buffer, { message, author } = {}) {
  await localPutBinary(p, buffer).catch(() => {});
  if (!hasGithubConfig()) return { ok: true };
  pendingWrites.set(p, { kind: 'binary', buffer, message, author });
  scheduleFlush();
  return { ok: true, queued: true };
}

export async function deleteFileQueued(p, { message, author } = {}) {
  await localDelete(p);
  if (!hasGithubConfig()) return { ok: true };
  pendingWrites.set(p, { kind: 'delete-file', message, author });
  scheduleFlush();
  return { ok: true, queued: true };
}

export async function deleteBinaryQueued(p, { message, author } = {}) {
  await localDeleteBinary(p);
  if (!hasGithubConfig()) return { ok: true };
  pendingWrites.set(p, { kind: 'delete-binary', message, author });
  scheduleFlush();
  return { ok: true, queued: true };
}

// Pushes everything currently queued, one commit per path. A path whose
// push fails (network blip, 409 exhausted, etc.) is put back on the queue
// and re-scheduled instead of being silently dropped.
export async function flushGithubQueue() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!pendingWrites.size) return { flushed: 0, failed: 0 };

  const entries = Array.from(pendingWrites.entries());
  pendingWrites.clear();

  let flushed = 0;
  const failures = [];
  for (const [p, entry] of entries) {
    try {
      if (entry.kind === 'file') {
        await putFile(p, entry.contentObject, { message: entry.message, author: entry.author });
      } else if (entry.kind === 'binary') {
        await putBinary(p, entry.buffer, { message: entry.message, author: entry.author });
      } else if (entry.kind === 'delete-file') {
        await deleteFile(p, { message: entry.message, author: entry.author });
      } else if (entry.kind === 'delete-binary') {
        await deleteBinary(p, { message: entry.message, author: entry.author });
      }
      flushed++;
    } catch (e) {
      console.error(`[githubQueue] push failed for ${p}:`, e.message);
      failures.push([p, entry]);
    }
  }

  if (failures.length) {
    for (const [p, entry] of failures) pendingWrites.set(p, entry);
    scheduleFlush();
  }
  return { flushed, failed: failures.length };
}

export function pendingQueueSize() {
  return pendingWrites.size;
}

/* ============================================================
   DIAGNOSTICS — safe to expose (no token, no secrets)
   ============================================================ */
export async function diagnose() {
  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } = cfg();
  const out = {
    isVercel,
    githubConfigured: hasGithubConfig(),
    owner: GITHUB_OWNER || null,
    repo: GITHUB_REPO || null,
    branch: GITHUB_BRANCH || null
  };

  // Probe GitHub directly (surfaces the real HTTP status: 200 ok, 401 bad token, 404 wrong path/branch)
  if (hasGithubConfig()) {
    for (const p of ['data/diagrams/index.json', 'data/files/index.json']) {
      try {
        const res = await fetch(`${urlFor(p)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers: headers() });
        out[p] = { githubStatus: res.status };
      } catch (e) {
        out[p] = { githubError: e.message };
      }
    }
  }

  // What the app actually resolves (after local + GitHub fallback)
  try {
    const d = await getFile('data/diagrams/index.json');
    out.diagramsResolved = d ? (d.content?.processes?.length ?? 0) : 'NOT FOUND';
  } catch (e) { out.diagramsResolved = 'ERR: ' + e.message; }
  try {
    const f = await getFile('data/files/index.json');
    out.pdfsResolved = f ? (f.content?.pdfs?.length ?? 0) : 'NOT FOUND';
  } catch (e) { out.pdfsResolved = 'ERR: ' + e.message; }

  // Read access alone isn't enough — a token can list/read a repo's contents
  // while still lacking write permission, which is exactly the failure mode
  // that made admin edits silently vanish. Actually attempt a write+delete
  // against a throwaway path so this shows up here instead of only failing
  // invisibly the next time someone edits something.
  if (hasGithubConfig()) {
    const probePath = 'data/.write-probe.json';
    try {
      const { GITHUB_BRANCH } = cfg();
      const putRes = await fetch(urlFor(probePath), {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({
          message: 'diagnostic write probe (auto-deleted)',
          content: Buffer.from(JSON.stringify({ probe: true, ts: Date.now() })).toString('base64'),
          branch: GITHUB_BRANCH
        })
      });
      if (!putRes.ok) {
        out.githubWriteAccess = { ok: false, status: putRes.status, error: await putRes.text() };
      } else {
        const putData = await putRes.json();
        out.githubWriteAccess = { ok: true };
        // clean up immediately
        await fetch(urlFor(probePath), {
          method: 'DELETE',
          headers: headers(),
          body: JSON.stringify({ message: 'cleanup write probe', sha: putData.content.sha, branch: GITHUB_BRANCH })
        }).catch(() => {});
      }
    } catch (e) {
      out.githubWriteAccess = { ok: false, error: e.message };
    }
  }

  return out;
}
