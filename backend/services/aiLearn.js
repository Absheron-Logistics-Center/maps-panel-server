// aiLearn.js
// ALM-AI's own memory: it studies the team's diagrams in the background and
// keeps what it learns in data/ai/ (same store as everything else → MongoDB +
// the server's data/ folder, so every PC and every model uses the same
// knowledge).
//
//   data/ai/knowledge.json   conventions learned from ALL diagrams (shapes,
//                            styles, numbering, lanes, arrow labels…) + an
//                            index of every diagram
//   data/ai/examples.json    every diagram converted to the exact spec format
//                            the assistant writes (used as worked examples)
//   data/ai/lessons.json     rules the admin taught it in chat ("page
//                            connector is not a step", …) — editable
//   data/ai/learn-log.json   what it did and when
//
// On the own server it runs 24/7 (startBackgroundLearning: shortly after
// start, then every few hours, and again whenever diagrams changed). On
// Vercel there is no background process — it learns on demand instead.

import { getFile, putFile, listJson } from './store.js';
import { dataDir, homePath, homeArchivePath, diagramPath } from './paths.js';

const base = () => `${dataDir()}/ai`;
const P = {
  knowledge: () => `${base()}/knowledge.json`,
  examples: () => `${base()}/examples.json`,
  lessons: () => `${base()}/lessons.json`,
  log: () => `${base()}/learn-log.json`
};

async function readJson(p, fallback) {
  try { const f = await getFile(p); return f?.content ?? fallback; } catch { return fallback; }
}

/* ------------------------------------------------------------------ */
/* log                                                                 */
/* ------------------------------------------------------------------ */
let logChain = Promise.resolve();
export function learnLog(type, message, extra = {}) {
  logChain = logChain.catch(() => {}).then(async () => {
    const cur = await readJson(P.log(), []);
    const list = Array.isArray(cur) ? cur : [];
    list.unshift({ at: Date.now(), type, message: String(message).slice(0, 400), ...extra });
    await putFile(P.log(), list.slice(0, 300));
  }).catch(e => console.warn('[ai-learn] log failed:', e.message));
  return logChain;
}

/* ------------------------------------------------------------------ */
/* diagram → spec (the format the assistant itself writes)             */
/* ------------------------------------------------------------------ */
function clusters(values, gap) {
  const s = [...new Set(values)].sort((a, b) => a - b);
  const out = [];
  for (const v of s) {
    if (!out.length || v - out[out.length - 1][out[out.length - 1].length - 1] > gap) out.push([v]);
    else out[out.length - 1].push(v);
  }
  return out;
}

export function diagramToSpec(d) {
  const lanes = Array.isArray(d?.lanes) ? d.lanes : [];
  const nodes = Array.isArray(d?.nodes) ? d.nodes : [];
  const edges = Array.isArray(d?.edges) ? d.edges : [];
  const laneNo = new Map(lanes.map((l, i) => [l.id, i + 1]));
  const colGroups = clusters(nodes.map(n => Math.round(n.x || 0)), 120);
  const colOf = x => Math.max(0, colGroups.findIndex(g => x >= g[0] - 1 && x <= g[g.length - 1] + 1));
  const specNodes = nodes
    .filter(n => laneNo.has(n.laneId))
    .map(n => {
      const inLane = nodes.filter(m => m.laneId === n.laneId);
      const rowGroups = clusters(inLane.map(m => Math.round(m.y || 0)), 50);
      const row = Math.max(0, rowGroups.findIndex(g => g.includes(Math.round(n.y || 0))));
      let shape = n.type, style = n.style;
      if (shape === 'stroke') { shape = 'rect'; style = style || 'stroke'; }
      if (shape === 'dashed') { shape = 'rect'; style = style || 'dashed'; }
      return {
        id: String(n.id),
        lane: laneNo.get(n.laneId),
        col: colOf(Math.round(n.x || 0)),
        row,
        shape: shape || 'rect',
        style: style || 'solid',
        text: String(n.text || '').replace(/\s*\n\s*/g, ' ').trim()
      };
    })
    .sort((a, b) => a.lane - b.lane || a.row - b.row || a.col - b.col);
  return {
    title: d?.title || '',
    lanes: lanes.map(l => ({ label: String(l.label || '').replace(/\s*\n\s*/g, ' ').trim() })),
    nodes: specNodes,
    edges: edges.map(e => ({
      from: String(e.from), to: String(e.to), s: e.s || 'right', e: e.e || 'left',
      ...(e.dashed ? { dashed: true } : {}), ...(e.label ? { label: String(e.label) } : {})
    }))
  };
}

/* ------------------------------------------------------------------ */
/* learning                                                            */
/* ------------------------------------------------------------------ */
const words = t => String(t || '').toLocaleLowerCase('az').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length >= 4);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const topN = (map, n) => Object.entries(map).sort((x, y) => y[1] - x[1]).slice(0, n);

let learning = null;
let lastSignature = null;

/** Study every diagram. Returns the new knowledge object. */
export function learnAll({ reason = 'manual' } = {}) {
  if (learning) return learning;
  learning = (async () => {
    const t0 = Date.now();
    const home = await readJson(homePath('diagrams'), { groups: [], processes: [] });
    const archive = await readJson(homeArchivePath('diagrams'), { items: [] });
    const groups = new Map((home.groups || []).map(g => [String(g.id), g.name]));
    const meta = new Map();
    (home.processes || []).forEach(p => meta.set(String(p.id), { ...p, archived: false, group: groups.get(String(p.groupId)) || '' }));
    (archive.items || []).forEach(p => { if (!meta.has(String(p.id))) meta.set(String(p.id), { ...p, archived: true, group: p.groupName || '' }); });

    let paths = [];
    try { paths = await listJson(`${dataDir()}/diagrams/items/`); } catch { paths = []; }
    const ids = new Set([...meta.keys(), ...paths.map(p => (p.match(/diagram-(.+)\.json$/) || [])[1]).filter(Boolean)]);

    const stats = { diagrams: 0, nodes: 0, edges: 0 };
    const shape = {}, styleByShape = {}, laneNames = {}, edgeLabels = {}, idKinds = {};
    let dashedToStroke = 0, dashedTotal = 0, subIdStroke = 0, subIdTotal = 0, startPill = 0, firstNodes = 0;
    let numberInText = 0, sideRight = 0, sideBottom = 0, sides = 0;
    const examples = {};
    const index = [];

    for (const id of ids) {
      const d = await readJson(diagramPath(id), null);
      if (!d || !Array.isArray(d.nodes) || !d.nodes.length) continue;
      const m = meta.get(String(id)) || {};
      const aiMade = (d.edges || []).some(e => e.viaFor);
      stats.diagrams++;
      stats.nodes += d.nodes.length;
      stats.edges += (d.edges || []).length;
      const byId = new Map(d.nodes.map(n => [String(n.id), n]));
      for (const n of d.nodes) {
        let sh = n.type, st = n.style;
        if (sh === 'stroke') { sh = 'rect'; st = st || 'stroke'; }
        st = st || 'solid';
        shape[sh] = (shape[sh] || 0) + 1;
        styleByShape[`${sh}/${st}`] = (styleByShape[`${sh}/${st}`] || 0) + 1;
        const sid = String(n.id);
        const kind = /^\d+$/.test(sid) ? 'N' : /^\d+(\.\d+)+$/.test(sid) ? 'N.N' : /^[A-Z](\.\d+)+$/i.test(sid) ? 'A.N' : 'başqa';
        idKinds[kind] = (idKinds[kind] || 0) + 1;
        if (kind === 'N.N' || kind === 'A.N') { subIdTotal++; if (st !== 'solid') subIdStroke++; }
        if (new RegExp(`^${sid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[.)]?\\s`).test(String(n.text || ''))) numberInText++;
      }
      const first = d.nodes.find(n => String(n.id) === '1');
      if (first) { firstNodes++; if (first.type === 'pill') startPill++; }
      for (const l of d.lanes || []) {
        const k = String(l.label || '').replace(/\s+/g, ' ').trim();
        if (k) laneNames[k] = (laneNames[k] || 0) + 1;
      }
      for (const e of d.edges || []) {
        if (e.label) edgeLabels[String(e.label).trim()] = (edgeLabels[String(e.label).trim()] || 0) + 1;
        if (e.dashed) {
          dashedTotal++;
          const t = byId.get(String(e.to));
          if (t && (t.style === 'stroke' || t.style === 'dashed' || t.type === 'stroke' || t.type === 'subprocess')) dashedToStroke++;
        }
        sides++;
        if ((e.s || 'right') === 'right') sideRight++;
        if (e.s === 'bottom') sideBottom++;
      }
      if (!aiMade && d.nodes.length >= 3) {
        const spec = diagramToSpec(d);
        examples[String(id)] = spec;
      }
      index.push({
        id: /^\d+$/.test(String(id)) ? Number(id) : id,
        title: d.title || m.title || '',
        group: m.group || '',
        archived: !!m.archived,
        aiMade,
        lanes: (d.lanes || []).map(l => String(l.label || '').replace(/\s+/g, ' ').trim()),
        nodes: d.nodes.length,
        edges: (d.edges || []).length,
        keywords: [...new Set(words(`${d.title} ${(d.lanes || []).map(l => l.label).join(' ')} ${d.nodes.map(n => n.text).join(' ')}`))].slice(0, 80)
      });
    }

    const rules = [
      `Komandanın ${stats.diagrams} diaqramından öyrənilib (${stats.nodes} addım, ${stats.edges} ox).`,
      `Addım nömrəsi node id-dir; mətnin əvvəlində nömrə ${pct(numberInText, stats.nodes)}% hallarda yazılır — YAZMA.`,
      `Nömrə növləri: ${topN(idKinds, 4).map(([k, v]) => `${k} ${pct(v, stats.nodes)}%`).join(', ')} (N.N = alt addım "5.1", A.N = qol "A.1").`,
      `Alt addımlar (5.1, A.1…) ${pct(subIdStroke, subIdTotal)}% hallarda ağ fonlu (stroke/dashed) olur.`,
      `Kəsik oxların ${pct(dashedToStroke, dashedTotal)}%-i ağ fonlu alt addıma gedir.`,
      `1-ci addım ${pct(startPill, firstNodes)}% hallarda pill (başlanğıc) formasındadır.`,
      `Oxların ${pct(sideRight, sides)}%-i sağdan, ${pct(sideBottom, sides)}%-i aşağıdan çıxır (axın soldan sağa, sonra aşağı).`,
      `Ən çox işlənən formalar: ${topN(shape, 6).map(([k, v]) => `${k} ${pct(v, stats.nodes)}%`).join(', ')}.`,
      `Forma/stil cütləri: ${topN(styleByShape, 6).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
      `Tez-tez ox etiketləri: ${topN(edgeLabels, 10).map(([k]) => `"${k}"`).join(', ') || '—'}.`,
      `Tez-tez panel adları: ${topN(laneNames, 14).map(([k]) => k).join(' · ')}.`
    ];

    const knowledge = {
      learnedAt: Date.now(),
      reason,
      tookMs: Date.now() - t0,
      stats,
      rules,
      shape, styleByShape, idKinds,
      laneNames: topN(laneNames, 60).map(([name, count]) => ({ name, count })),
      edgeLabels: topN(edgeLabels, 40).map(([label, count]) => ({ label, count })),
      index
    };
    await putFile(P.knowledge(), knowledge);
    await putFile(P.examples(), examples);
    lastSignature = await signature().catch(() => null);
    await learnLog('scan', `${stats.diagrams} diaqram öyrənildi (${Object.keys(examples).length} nümunə), ${knowledge.tookMs} ms`, { reason });
    return knowledge;
  })().finally(() => { learning = null; });
  return learning;
}

// cheap "did anything change" check: the diagram list + its size
async function signature() {
  const home = await readJson(homePath('diagrams'), { processes: [] });
  const paths = await listJson(`${dataDir()}/diagrams/items/`).catch(() => []);
  return `${(home.processes || []).map(p => `${p.id}:${p.title}`).join('|').length}:${paths.length}:${(home.processes || []).length}`;
}

export async function getKnowledge() {
  const k = await readJson(P.knowledge(), null);
  if (k) return k;
  // never learned yet (e.g. fresh Vercel deploy) → learn now
  try { return await learnAll({ reason: 'first-use' }); } catch { return null; }
}

/** The diagrams most similar to what the admin is working on → worked examples. */
export async function findExamples(queryText, { limit = 2, exclude = [] } = {}) {
  const k = await getKnowledge();
  if (!k?.index?.length) return [];
  const q = new Set(words(queryText));
  if (!q.size) return [];
  const ex = await readJson(P.examples(), {});
  const skip = new Set(exclude.map(String));
  return k.index
    .filter(d => !d.aiMade && ex[String(d.id)] && !skip.has(String(d.id)))
    .map(d => {
      const kw = new Set(d.keywords || []);
      let hit = 0;
      q.forEach(w => { if (kw.has(w)) hit++; });
      return { d, score: hit / Math.sqrt(q.size * Math.max(1, kw.size)) };
    })
    .filter(x => x.score > 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => ({ id: x.d.id, title: x.d.title, spec: ex[String(x.d.id)] }));
}

/** Full content of one diagram, compact (for the read_diagram tool). */
export async function readDiagramCompact(id) {
  const d = await readJson(diagramPath(id), null);
  if (!d) return null;
  return { id, ...diagramToSpec(d) };
}

/* ------------------------------------------------------------------ */
/* lessons taught in chat                                              */
/* ------------------------------------------------------------------ */
let lessonChain = Promise.resolve();
export async function listLessons() {
  const l = await readJson(P.lessons(), []);
  return Array.isArray(l) ? l.filter(x => x && !x.removed) : [];
}
export function addLesson(text, { user, chatId } = {}) {
  const t = String(text || '').trim().slice(0, 300);
  if (t.length < 8) return Promise.resolve(null);
  lessonChain = lessonChain.catch(() => {}).then(async () => {
    const cur = await readJson(P.lessons(), []);
    const list = Array.isArray(cur) ? cur : [];
    const norm = s => s.toLocaleLowerCase('az').replace(/\s+/g, ' ').trim();
    const same = list.find(x => !x.removed && norm(x.text) === norm(t));
    if (same) { same.count = (same.count || 1) + 1; same.lastAt = Date.now(); }
    else list.unshift({ id: `l-${Date.now().toString(36)}`, text: t, by: user || null, chatId: chatId || null, at: Date.now(), count: 1 });
    await putFile(P.lessons(), list.slice(0, 200));
    if (!same) await learnLog('lesson', `Yeni qayda öyrənildi: ${t}`, { by: user || null });
    return same || list[0];
  });
  return lessonChain;
}
export function removeLesson(id, user) {
  lessonChain = lessonChain.catch(() => {}).then(async () => {
    const cur = await readJson(P.lessons(), []);
    const list = (Array.isArray(cur) ? cur : []).map(x => (x.id === id ? { ...x, removed: true, removedBy: user || null, removedAt: Date.now() } : x));
    await putFile(P.lessons(), list);
    await learnLog('lesson', `Qayda silindi: ${(list.find(x => x.id === id) || {}).text || id}`, { by: user || null });
    return { ok: true };
  });
  return lessonChain;
}

export async function readLog(limit = 60) {
  const l = await readJson(P.log(), []);
  return (Array.isArray(l) ? l : []).slice(0, limit);
}

/** Short text for the system prompt: rules + taught lessons. */
export async function promptKnowledge() {
  const [k, lessons] = await Promise.all([getKnowledge().catch(() => null), listLessons().catch(() => [])]);
  const parts = [];
  if (k?.rules?.length) parts.push('=== KOMANDANIN DİAQRAMLARINDAN ÖYRƏNDİKLƏRİN ===\n' + k.rules.map(r => `- ${r}`).join('\n'));
  if (lessons.length) {
    parts.push('=== ADMİNİN SƏNƏ ÖYRƏTDİYİ QAYDALAR (mütləq əməl et) ===\n' +
      lessons.slice(0, 60).map(l => `- ${l.text}`).join('\n'));
  }
  if (k?.index?.length) {
    parts.push('=== MÖVCUD DİAQRAMLAR (lazım olsa read_diagram ilə aç) ===\n' +
      k.index.slice(0, 150).map(d => `#${d.id} ${d.title}${d.archived ? ' (arxiv)' : ''}`).join('\n'));
  }
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* 24/7 on the own server                                              */
/* ------------------------------------------------------------------ */
let timer = null;
export function startBackgroundLearning({ everyHours = 6, checkMinutes = 15 } = {}) {
  if (timer || process.env.VERCEL) return;
  const run = (reason) => learnAll({ reason }).catch(e => learnLog('error', `Öyrənmə alınmadı: ${e.message}`));
  setTimeout(() => run('server-start'), 30 * 1000).unref?.();
  let lastFull = Date.now();
  timer = setInterval(async () => {
    try {
      const sig = await signature();
      if (Date.now() - lastFull > everyHours * 3600 * 1000) { lastFull = Date.now(); return run('schedule'); }
      if (lastSignature && sig !== lastSignature) { lastFull = Date.now(); return run('diagrams-changed'); }
    } catch { /* storage hiccup — try next time */ }
  }, checkMinutes * 60 * 1000);
  timer.unref?.();
}
