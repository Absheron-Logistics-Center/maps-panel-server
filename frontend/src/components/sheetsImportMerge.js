// sheetsImportMerge.js
// Pure (no React, no network) merge planner for the Sheets Excel import.
// Used for ALL kinds: İş Axışları, Normativ Sənədlər, Şablonlar.
//
// Matching key = the row's NAME (title). Then:
//   • no row with that name exists            → NEW row
//   • same name, nothing differs              → silently combined (no duplicate)
//   • same name, existing cell blank / Excel
//     cell blank                              → silently combined, blank filled
//   • same name, both sides filled but
//     different (status, struktur adı, code…) → CONFLICT: the user decides
//                                               "combine (pick which value per
//                                               field)" or "add as separate row"
// Rows repeated inside the Excel file with the same name + struktur adı are
// merged first (later non-empty values win).

// Case / diacritic / spacing-insensitive text key (Azerbaijani aware).
export function foldText(v) {
  return String(v == null ? '' : v)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('az')
    .replace(/\u0131/g, 'i').replace(/\u0259/g, 'e')            // dotless ı → i, ə → e
    .replace(/[^a-z0-9\u0430-\u044f\u0451]+/gi, ' ')
    .trim();
}

const sameValue = (a, b) => foldText(a) === foldText(b);

/**
 * @param rows        parsed Excel rows [{ title, strukturAdi, …, status? }]
 * @param items       current sheet rows
 * @param fields      comparable field names for this kind (columns' fields)
 * @param withStatus  whether this kind has a Status column
 * @param getStruktur (row) => effective Struktur adı of an existing row
 */
// keyFields (optional): match a row only when ALL these fields are equal —
// e.g. Vəzifə Təlimatları, where "Şöbə müdiri" exists in dozens of bölmələr.
export function buildImportPlan({ rows, items, fields, withStatus, getStruktur, keyFields = null }) {
  const compositeKey = keyFields ? (r) => (foldText(r.title) ? keyFields.map(f => foldText(r[f])).join('|') : '') : null;
  const cmpFields = [...fields, ...(withStatus ? ['status'] : [])];

  // 1) merge exact (title + struktur) repeats inside the file
  const uniq = [];
  const byKey = new Map();
  let mergedInFile = 0;
  for (const r of rows) {
    const t = foldText(r.title);
    const k = compositeKey ? compositeKey(r) : (t ? `${t}|${foldText(r.strukturAdi)}` : '');
    const hit = k ? byKey.get(k) : null;
    if (hit) {
      mergedInFile += 1;
      for (const f of cmpFields) if (r[f]) hit[f] = r[f];
    } else {
      const copy = { ...r };
      uniq.push(copy);
      if (k) byKey.set(k, copy);
    }
  }

  // 2) index existing rows by name
  const byTitle = new Map();
  for (const it of items) {
    const t = compositeKey ? compositeKey(it) : foldText(it.title);
    if (!t) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(it);
  }

  const plan = { toCreate: [], autoMerge: [], conflicts: [], unchanged: 0, mergedInFile };
  const claimed = new Set(); // existing ids already matched by an earlier file row

  for (const r of uniq) {
    const t = compositeKey ? compositeKey(r) : foldText(r.title);
    const cands = t ? (byTitle.get(t) || []).filter(c => !claimed.has(Number(c.id))) : [];
    if (!cands.length) { plan.toCreate.push(r); continue; }

    // best candidate: same struktur → blank struktur → first
    const rk = foldText(r.strukturAdi);
    const cand =
      cands.find(c => foldText(getStruktur(c)) === rk) ||
      cands.find(c => !foldText(getStruktur(c))) ||
      cands[0];
    claimed.add(Number(cand.id));

    const diffs = [];
    const fill = {};
    for (const f of cmpFields) {
      const incoming = r[f] ? String(r[f]) : '';
      if (!incoming) continue;                       // blank Excel cell never overwrites
      const current = f === 'strukturAdi' ? (getStruktur(cand) || '')
        : f === 'status' ? (cand.status || '')
        : (cand[f] || '');
      if (!String(current).trim()) fill[f] = incoming;           // existing blank → fill
      else if (f === 'status' ? current !== incoming : !sameValue(current, incoming)) {
        diffs.push({ field: f, current: String(current), incoming });
      }
    }

    if (diffs.length) {
      plan.conflicts.push({ id: `c${plan.conflicts.length}`, row: r, existing: cand, diffs, fill });
    } else if (Object.keys(fill).length) {
      plan.autoMerge.push({ existing: cand, patch: fill });
    } else {
      plan.unchanged += 1;
    }
  }
  return plan;
}

// Default decision: combine, keep the current value for every differing field.
export function defaultDecisions(plan) {
  const d = {};
  for (const c of plan.conflicts) {
    const pick = {};
    for (const x of c.diffs) pick[x.field] = 'current';
    d[c.id] = { action: 'combine', pick };
  }
  return d;
}

// Turn the plan + the user's decisions into concrete work for the API.
export function resolvePlan(plan, decisions) {
  const creates = [...plan.toCreate];
  const updates = plan.autoMerge.map(m => ({ id: m.existing.id, patch: { ...m.patch } }));
  let combined = 0, separate = 0;

  for (const c of plan.conflicts) {
    const dec = decisions?.[c.id] || { action: 'combine', pick: {} };
    if (dec.action === 'separate') {
      creates.push(c.row);
      separate += 1;
      continue;
    }
    const patch = { ...c.fill };
    for (const x of c.diffs) {
      if ((dec.pick?.[x.field] || 'current') === 'incoming') patch[x.field] = x.incoming;
    }
    combined += 1;
    if (Object.keys(patch).length) updates.push({ id: c.existing.id, patch });
  }
  return { creates, updates, combined, separate };
}
