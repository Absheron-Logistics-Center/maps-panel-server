// infoModel.js
// Normalises a node's popup content into an ordered list of sections while
// staying fully backward-compatible with the legacy { general:[], risks:[] } shape.
//
// A section: { id, icon, title, type: 'text' | 'list', items: string[], color? }
//
// The two legacy fields are surfaced as sections with fixed ids 'general' and
// 'risks' so old diagrams render unchanged. Custom sections live in info.sections.

let SEQ = 0;
export function newSectionId() {
  SEQ += 1;
  return `sec-${Date.now()}-${SEQ}`;
}

export function makeSection(partial = {}) {
  return {
    id: partial.id || newSectionId(),
    icon: partial.icon || 'FileText',
    title: partial.title || 'Yeni bölmə',
    type: partial.type === 'list' ? 'list' : 'text',
    items: Array.isArray(partial.items) ? partial.items : [''],
    color: partial.color || ''
  };
}

// Build the ordered render list from a node.
// Order: general -> custom sections -> risks (matches the classic popup layout,
// with any custom sections slotted in the middle).
export function getSections(node) {
  const info = node?.info || {};
  const out = [];

  const general = Array.isArray(info.general) ? info.general.filter(x => x && String(x).trim()) : [];
  out.push({
    id: 'general',
    icon: info.generalIcon || 'FileText',
    title: info.generalTitle || 'Ümumi məlumat',
    type: 'text',
    items: general,
    color: info.generalColor || '',
    fixed: true
  });

  (info.sections || []).forEach(s => {
    const items = Array.isArray(s.items) ? s.items.filter(x => x && String(x).trim()) : [];
    out.push({ ...makeSection(s), items });
  });

  const risks = Array.isArray(info.risks) ? info.risks.filter(x => x && String(x).trim()) : [];
  out.push({
    id: 'risks',
    icon: info.risksIcon || 'AlertTriangle',
    title: info.risksTitle || 'Mümkün risklər',
    type: 'list',
    items: risks,
    color: info.risksColor || '',
    fixed: true,
    risky: true
  });

  return out;
}
