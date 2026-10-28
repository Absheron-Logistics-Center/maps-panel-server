/*
  One-time migration: copy your existing diagrams into MongoDB.

  Source of truth = whatever is currently live. Because the deployed panel
  writes to GitHub, this script pulls straight from GitHub when a token is
  configured (so it grabs the latest live data, even if your local copy is a
  bit behind). If no GitHub token is set, it falls back to reading the local
  data/diagrams folder instead.

  Keys are the same path strings the app uses, so the data lands exactly where
  the app looks for it. Only touches data/diagrams/** — PDFs are left alone.
  Safe to re-run: every document is upserted by _id.

  Run once:
      cd backend
      node scripts/seed-diagrams.mjs
*/

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import { config as loadEnv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DIAGRAMS_DIR = path.join(REPO_ROOT, 'data', 'diagrams');

// .env can live at the project root (Map-Panel/.env) or inside backend/ —
// load whichever exists, root takes priority since that's where yours is.
loadEnv({ path: path.join(REPO_ROOT, '.env') });
loadEnv({ path: path.join(REPO_ROOT, 'backend', '.env') });

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'mappanel';
const COLLECTION = process.env.MONGODB_COLLECTION || 'diagrams';

const {
  GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH = 'main'
} = process.env;
const useGithub = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Aborting.');
  process.exit(1);
}

const API_BASE = 'https://api.github.com';
function ghHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${GITHUB_TOKEN}`
  };
}
function ghUrl(p) {
  const enc = p.split('/').map(encodeURIComponent).join('/');
  return `${API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${enc}`;
}
async function ghGetJson(p) {
  const res = await fetch(`${ghUrl(p)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${p}: ${await res.text()}`);
  const data = await res.json();
  const text = Buffer.from((data.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
  return JSON.parse(text);
}
async function ghList(dir) {
  const res = await fetch(`${ghUrl(dir)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers: ghHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub ${res.status} listing ${dir}: ${await res.text()}`);
  return res.json(); // array of { name, path, type, ... }
}

// Returns [{ key, content }] for index.json, archive.json, and every process file.
async function collectFromGithub() {
  const out = [];
  for (const name of ['index.json', 'archive.json']) {
    const content = await ghGetJson(`data/diagrams/${name}`);
    if (content) out.push({ key: `data/diagrams/${name}`, content });
  }
  const entries = await ghList('data/diagrams/processes');
  for (const e of entries) {
    if (e.type !== 'file' || !e.name.endsWith('.json')) continue;
    const content = await ghGetJson(e.path);
    if (content) out.push({ key: e.path, content });
  }
  return out;
}

async function collectFromLocal() {
  const out = [];
  for (const name of ['index.json', 'archive.json']) {
    try {
      const text = await fs.readFile(path.join(DIAGRAMS_DIR, name), 'utf8');
      out.push({ key: `data/diagrams/${name}`, content: JSON.parse(text) });
    } catch {}
  }
  try {
    const files = await fs.readdir(path.join(DIAGRAMS_DIR, 'processes'));
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const text = await fs.readFile(path.join(DIAGRAMS_DIR, 'processes', f), 'utf8');
      out.push({ key: `data/diagrams/processes/${f}`, content: JSON.parse(text) });
    }
  } catch {}
  return out;
}

async function main() {
  console.log(useGithub
    ? `Reading live diagrams from GitHub (${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH})...`
    : 'No GitHub token found — reading local data/diagrams folder...');

  const docs = useGithub ? await collectFromGithub() : await collectFromLocal();
  if (!docs.length) {
    console.log('No diagram files found — nothing to seed.');
    return;
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const col = client.db(DB_NAME).collection(COLLECTION);

  let n = 0;
  for (const { key, content } of docs) {
    await col.updateOne(
      { _id: key },
      { $set: { content, updatedAt: new Date() } },
      { upsert: true }
    );
    n++;
    console.log('  seeded', key);
  }

  await client.close();
  console.log(`\nDone. ${n} diagram document(s) written to ${DB_NAME}.${COLLECTION}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
