// excel.js
// Complete Excel (.xlsx) bridge for Map Panel.
//   - exportDiagramToExcel(process)   -> downloads current diagram as a workbook
//   - downloadTemplate()              -> downloads an empty, documented template
//   - importDiagramFromExcel(file)    -> parses a workbook into a { lanes, nodes, edges, ... }
//
// The workbook is a plain data sheet (no UI). Four sheets:
//   Diaqram   – meta (title, subtitle, size, theme colors)
//   Panellər  – swim-lanes (pills):        id, label
//   Node-lar  – boxes / popups:            id, panel, type, style, text, x, y, w, h, color, general, risks, sections(JSON)
//   Oxlar     – arrows / edges:            from, to, from_side, to_side, dashed, color
//
// Import is tolerant: sheets/columns are matched case-insensitively and by
// synonyms; missing x/y are auto-laid-out; missing lane ids are generated.
import * as XLSX from 'xlsx';
import { SHAPES } from './nodeStyle.js';

const LANE_MIN_H = 180;

/* ============================ helpers ============================ */
function safeName(s) {
  return (s || 'diaqram').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
}
function splitLines(v) {
  if (v == null) return [];
  return String(v).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
function joinLines(arr) {
  return (Array.isArray(arr) ? arr : []).filter(x => x && String(x).trim()).join('\n');
}

// normalize header text for matching
function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/[\s_().]+/g, '');
}

// find a sheet by any of the given candidate names, else by index
function pickSheet(wb, candidates, fallbackIdx) {
  const names = wb.SheetNames;
  for (const c of candidates) {
    const hit = names.find(n => norm(n) === norm(c) || norm(n).includes(norm(c)));
    if (hit) return wb.Sheets[hit];
  }
  if (fallbackIdx != null && names[fallbackIdx]) return wb.Sheets[names[fallbackIdx]];
  return null;
}

// sheet -> array of row objects keyed by normalized header
function rows(sheet) {
  if (!sheet) return [];
  const arr = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  if (!arr.length) return [];
  const headers = arr[0].map(norm);
  return arr.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

// pull a value by any of several possible header keys
function val(row, keys) {
  for (const k of keys) {
    const nk = norm(k);
    if (row[nk] !== undefined && row[nk] !== '') return row[nk];
  }
  return undefined;
}

/* ============================ EXPORT ============================ */
export function exportDiagramToExcel(process) {
  const wb = XLSX.utils.book_new();

  // Diaqram (meta)
  const meta = [
    ['sahə', 'dəyər'],
    ['title', process.title || ''],
    ['subtitle', process.subtitle || ''],
    ['width', process.width || 1600],
    ['height', process.height || 600],
    ['theme_node', process.theme?.node || ''],
    ['theme_edge', process.theme?.edge || ''],
    ['theme_lane', process.theme?.lane || '']
  ];
  const wsMeta = XLSX.utils.aoa_to_sheet(meta);
  wsMeta['!cols'] = [{ wch: 16 }, { wch: 48 }];
  XLSX.utils.book_append_sheet(wb, wsMeta, 'Diaqram');

  // Panellər (lanes)
  const laneRows = [['id', 'label']];
  (process.lanes || []).forEach(l => laneRows.push([l.id, l.label || '']));
  const wsLanes = XLSX.utils.aoa_to_sheet(laneRows);
  wsLanes['!cols'] = [{ wch: 18 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, wsLanes, 'Panellər');

  // Node-lar (nodes)
  const nHead = ['id', 'panel', 'type', 'style', 'text', 'x', 'y', 'w', 'h', 'color', 'icon', 'general', 'risks', 'sections'];
  const nodeRows = [nHead];
  (process.nodes || []).forEach(n => {
    const info = n.info || {};
    nodeRows.push([
      n.id,
      laneLabelOf(process, n.laneId) || n.laneId || '',
      n.type || 'rect',
      n.style || 'solid',
      n.text || '',
      n.x ?? '',
      n.y ?? '',
      n.w ?? '',
      n.h ?? '',
      n.color || '',
      n.icon || '',
      joinLines(info.general),
      joinLines(info.risks),
      (info.sections && info.sections.length) ? JSON.stringify(info.sections) : ''
    ]);
  });
  const wsNodes = XLSX.utils.aoa_to_sheet(nodeRows);
  wsNodes['!cols'] = [
    { wch: 6 }, { wch: 22 }, { wch: 12 }, { wch: 8 }, { wch: 34 },
    { wch: 7 }, { wch: 7 }, { wch: 7 }, { wch: 7 }, { wch: 10 }, { wch: 14 },
    { wch: 40 }, { wch: 40 }, { wch: 40 }
  ];
  XLSX.utils.book_append_sheet(wb, wsNodes, 'Node-lar');

  // Oxlar (edges)
  const eHead = ['from', 'to', 'from_side', 'to_side', 'dashed', 'color'];
  const edgeRows = [eHead];
  (process.edges || []).forEach(e => {
    edgeRows.push([e.from, e.to, e.s || 'right', e.e || 'left', e.dashed ? 'yes' : '', e.color || '']);
  });
  const wsEdges = XLSX.utils.aoa_to_sheet(edgeRows);
  wsEdges['!cols'] = [{ wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsEdges, 'Oxlar');

  XLSX.writeFile(wb, `${safeName(process.title)}.xlsx`);
}

function laneLabelOf(process, laneId) {
  const l = (process.lanes || []).find(x => x.id === laneId);
  return l ? l.label : '';
}

/* ============================ TEMPLATE ============================ */
export function downloadTemplate() {
  const demo = {
    title: 'Nümunə diaqram',
    subtitle: 'ALM-XX',
    width: 2000,
    height: 700,
    theme: { node: '', edge: '', lane: '' },
    lanes: [
      { id: 'lane-1', label: 'Müştəri' },
      { id: 'lane-2', label: 'Operator' }
    ],
    nodes: [
      {
        id: 1, laneId: 'lane-1', type: 'pill', style: 'solid', text: 'Başlanğıc',
        x: 90, y: 40, w: 200, h: 50, color: '',
        info: {
          general: ['Prosesin başlanğıc nöqtəsi.'],
          risks: ['Gecikmə riski.'],
          sections: [{ icon: 'Clock', title: 'Vaxt', type: 'text', items: ['Təxmini 5 dəqiqə.'] }]
        }
      },
      {
        id: 2, laneId: 'lane-2', type: 'rect', style: 'solid', text: 'Emal',
        x: 360, y: 40, w: 200, h: 70, color: '',
        info: { general: ['Sənəd emal olunur.'], risks: [] }
      }
    ],
    edges: [{ from: 1, to: 2, s: 'right', e: 'left', dashed: false, color: '' }]
  };
  const wb = buildWorkbook(demo);
  XLSX.writeFile(wb, 'maps-panel-shablon.xlsx');
}

function buildWorkbook(p) {
  const wb = XLSX.utils.book_new();
  const meta = [
    ['sahə', 'dəyər'], ['title', p.title], ['subtitle', p.subtitle],
    ['width', p.width], ['height', p.height],
    ['theme_node', ''], ['theme_edge', ''], ['theme_lane', '']
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(meta), 'Diaqram');
  const lanes = [['id', 'label'], ...p.lanes.map(l => [l.id, l.label])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(lanes), 'Panellər');
  const nHead = ['id', 'panel', 'type', 'style', 'text', 'x', 'y', 'w', 'h', 'color', 'icon', 'general', 'risks', 'sections'];
  const nrows = [nHead, ...p.nodes.map(n => [
    n.id, n.laneId, n.type, n.style, n.text, n.x, n.y, n.w, n.h, n.color || '', n.icon || '',
    joinLines(n.info?.general), joinLines(n.info?.risks),
    n.info?.sections ? JSON.stringify(n.info.sections) : ''
  ])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(nrows), 'Node-lar');
  const eHead = ['from', 'to', 'from_side', 'to_side', 'dashed', 'color'];
  const erows = [eHead, ...p.edges.map(e => [e.from, e.to, e.s, e.e, e.dashed ? 'yes' : '', e.color || ''])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(erows), 'Oxlar');
  return wb;
}

/* ============================ IMPORT ============================ */
export async function importDiagramFromExcel(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });

  // --- meta ---
  const metaSheet = pickSheet(wb, ['Diaqram', 'meta', 'diagram'], null);
  const meta = {};
  if (metaSheet) {
    const aoa = XLSX.utils.sheet_to_json(metaSheet, { header: 1, blankrows: false });
    aoa.forEach(r => { if (r[0] != null) meta[norm(r[0])] = r[1]; });
  }

  // --- lanes ---
  const laneSheet = pickSheet(wb, ['Panellər', 'Paneller', 'lanes', 'panel'], 1);
  const laneRaw = rows(laneSheet);
  const lanes = [];
  const labelToId = {};
  laneRaw.forEach((r, i) => {
    const label = val(r, ['label', 'ad', 'name']) ?? `Panel ${i + 1}`;
    let id = val(r, ['id']) || '';
    if (!id) id = `lane-${i + 1}`;
    id = String(id);
    lanes.push({ id, label: String(label), y: 0, h: LANE_MIN_H });
    labelToId[norm(label)] = id;
    labelToId[norm(id)] = id;
  });
  if (lanes.length === 0) {
    lanes.push({ id: 'lane-1', label: 'Panel 1', y: 0, h: LANE_MIN_H });
  }

  // --- nodes ---
  const nodeSheet = pickSheet(wb, ['Node-lar', 'Nodelar', 'nodes', 'node'], 2);
  const nodeRaw = rows(nodeSheet);
  const nodes = [];
  const perLaneCursor = {};
  nodeRaw.forEach((r, i) => {
    const rawPanel = val(r, ['panel', 'laneid', 'lane', 'panelid']);
    let laneId = lanes[0].id;
    if (rawPanel != null) {
      const key = norm(rawPanel);
      laneId = labelToId[key] || (lanes.find(l => l.id === String(rawPanel))?.id) || lanes[0].id;
    }
    const type = String(val(r, ['type', 'forma', 'shape']) || 'rect').toLowerCase();
    const style = String(val(r, ['style', 'stil', 'sərhəd', 'serhed']) || 'solid').toLowerCase();
    const text = String(val(r, ['text', 'mətn', 'metn', 'ad']) ?? `Addım ${i + 1}`);
    const idRaw = val(r, ['id']);
    const id = idRaw != null && idRaw !== '' ? (/^\d+$/.test(String(idRaw)) ? Number(idRaw) : idRaw) : (i + 1);

    // sizes
    const defW = type === 'diamond' ? 150 : type === 'pill' ? 200 : 210;
    const defH = type === 'diamond' ? 150 : type === 'pill' ? 50 : 70;
    const w = Number(val(r, ['w', 'en', 'width'])) || defW;
    const h = Number(val(r, ['h', 'hün', 'hun', 'height'])) || defH;

    // position — auto-stack per lane if missing
    let x = Number(val(r, ['x']));
    let y = Number(val(r, ['y']));
    if (!Number.isFinite(x) || x === 0 && val(r, ['x']) === undefined) {
      const idx = (perLaneCursor[laneId] = (perLaneCursor[laneId] || 0));
      x = 90 + idx * 260;
    }
    if (!Number.isFinite(y) || (val(r, ['y']) === undefined)) {
      y = 40;
    }
    perLaneCursor[laneId] = (perLaneCursor[laneId] || 0) + 1;

    const color = String(val(r, ['color', 'rəng', 'reng']) || '').trim();
    const icon = String(val(r, ['icon', 'ikon', 'işarə', 'isare']) || '').trim();
    const general = splitLines(val(r, ['general', 'ümumiməlumat', 'umumimelumat', 'məlumat', 'melumat']));
    const risks = splitLines(val(r, ['risks', 'risklər', 'riskler', 'risk']));
    let sections = [];
    const secRaw = val(r, ['sections', 'əlavəbölmələr', 'elavebolmeler', 'bölmələr']);
    if (secRaw) {
      try {
        const parsed = JSON.parse(secRaw);
        if (Array.isArray(parsed)) sections = parsed;
      } catch { /* ignore malformed JSON */ }
    }

    const info = { general, risks };
    if (sections.length) info.sections = sections;

    const node = {
      id, type: SHAPE_OK.has(type) ? type : 'rect',
      style: STYLE_OK.has(style) ? style : 'solid',
      x, y, w, h, laneId, text, info
    };
    if (color) node.color = color;
    if (icon) node.icon = icon;
    nodes.push(node);
  });

  // --- edges ---
  const edgeSheet = pickSheet(wb, ['Oxlar', 'Oxlar (edges)', 'edges', 'ox', 'arrows'], 3);
  const edgeRaw = rows(edgeSheet);
  const edges = [];
  edgeRaw.forEach(r => {
    const from = val(r, ['from', 'başlanğıc', 'baslangic', 'source']);
    const to = val(r, ['to', 'son', 'hədəf', 'hedef', 'target']);
    if (from == null || to == null || from === '' || to === '') return;
    const s = String(val(r, ['fromside', 'from_side', 'sside', 'başlanğıctərəf']) || 'right').toLowerCase();
    const e = String(val(r, ['toside', 'to_side', 'eside', 'sontərəf']) || 'left').toLowerCase();
    const dashedRaw = String(val(r, ['dashed', 'kəsik', 'kesik']) || '').toLowerCase();
    const dashed = ['yes', 'true', '1', 'bəli', 'beli', 'x', 'kəsik'].includes(dashedRaw);
    const color = String(val(r, ['color', 'rəng', 'reng']) || '').trim();
    const edge = {
      from: /^\d+$/.test(String(from)) ? Number(from) : from,
      to: /^\d+$/.test(String(to)) ? Number(to) : to,
      s: SIDE_OK.has(s) ? s : 'right',
      e: SIDE_OK.has(e) ? e : 'left'
    };
    if (dashed) edge.dashed = true;
    if (color) edge.color = color;
    edges.push(edge);
  });

  // --- layout pass: repack lanes so heights fit nodes ---
  const packed = repackLanes(lanes, nodes);

  const theme = {};
  if (meta.themenode) theme.node = String(meta.themenode);
  if (meta.themeedge) theme.edge = String(meta.themeedge);
  if (meta.themelane) theme.lane = String(meta.themelane);

  const contentBottom = packed.lanes.length
    ? Math.max(...packed.lanes.map(l => l.y + l.h))
    : 600;
  const contentRight = packed.nodes.length
    ? Math.max(...packed.nodes.map(n => n.x + n.w))
    : 1600;

  return {
    title: String(meta.title || file.name.replace(/\.xlsx?$/i, '') || 'İdxal edilmiş diaqram'),
    subtitle: String(meta.subtitle || ''),
    width: Number(meta.width) || Math.max(1600, contentRight + 200),
    height: Number(meta.height) || Math.max(600, contentBottom + 60),
    lanes: packed.lanes,
    nodes: packed.nodes,
    edges,
    ...(Object.keys(theme).length ? { theme } : {})
  };
}

const SHAPE_OK = new Set(SHAPES);
const STYLE_OK = new Set(['solid', 'stroke', 'dashed']);
const SIDE_OK = new Set(['top', 'right', 'bottom', 'left']);

// stack lanes top-to-bottom, sizing each to fit its nodes, shifting nodes along.
function repackLanes(lanes, nodes) {
  // ensure each node has a valid laneId
  const tagged = nodes.map(n => {
    if (n.laneId && lanes.some(l => l.id === n.laneId)) return n;
    return { ...n, laneId: lanes[0]?.id };
  });
  let cursorY = 20;
  const shift = {};
  const newLanes = lanes.map(lane => {
    const laneNodes = tagged.filter(n => n.laneId === lane.id);
    let height = LANE_MIN_H;
    if (laneNodes.length > 0) {
      const maxBottomRel = Math.max(...laneNodes.map(n => (n.y || 0) + (n.h || 100) - lane.y));
      height = Math.max(LANE_MIN_H, maxBottomRel + 20);
    }
    const newY = cursorY;
    shift[lane.id] = newY - lane.y;
    cursorY += height;
    return { ...lane, y: newY, h: height };
  });
  const newNodes = tagged.map(n => ({ ...n, y: Math.round((n.y || 0) + (shift[n.laneId] || 0)) }));
  return { lanes: newLanes, nodes: newNodes };
}
