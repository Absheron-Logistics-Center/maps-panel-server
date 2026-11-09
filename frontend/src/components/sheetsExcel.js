// sheetsExcel.js
// Export / import the Sheets catalog TABLE (title, struktur, status, extra
// fields…) to/from a plain .xlsx workbook. This is separate from excel.js,
// which exports/imports a diagram's canvas (lanes/nodes/edges).
//
// Both export and import are COLUMN-DRIVEN: the caller (SheetsPage) passes
// the exact ordered list of columns for the current kind (İş Axışları /
// Normativ Sənədlər / Şablonlar each have their own order + labels), so
// this file has no hardcoded assumptions about which fields exist.
//
// Import only PARSES: rows are handed back to the caller as plain objects.
// The page (SheetsPage.handleImportFile) then merges them by title +
// struktur adı — matching rows are updated (incl. status), new ones added.
// Rows are never removed.
//
// Export is styled to look like a normal Excel sheet (bold dark-blue
// header with a blue underline, thin gridlines on every cell, white
// background) — done with exceljs since plain 'xlsx' (SheetJS community)
// can't write cell styling. Import still uses 'xlsx' — it only needs to
// read values, not styles.
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';

function safeName(s) {
  return (s || 'sheets').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
}

function norm(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    // strip spaces, underscores, punctuation — keep letters/digits so
    // "Diaqram adı", "İş axışının adı", "İkinci ad (qısa)" all match.
    .replace(/[^a-z0-9à-öø-ÿā-ſа-яёəığöüşç]/gi, '');
}

const GRID_BORDER = { style: 'thin', color: { argb: 'FFB7C6D9' } };
const HEADER_FONT = { bold: true, color: { argb: 'FF1F4E78' }, size: 11 };
const HEADER_BOTTOM_BORDER = { style: 'medium', color: { argb: 'FF2F6FA8' } };

// Excel column width ≈ character count. Cap so long titles wrap a little
// instead of blowing past one landscape A4 page; floor so short headers
// don't leave unused page space when printing / Save as PDF.
function measureColWidth(headerLabel, colIndex, dataRows) {
  let maxLen = String(headerLabel || '').length;
  for (const r of dataRows) {
    const v = r[colIndex];
    if (v == null || v === '') continue;
    maxLen = Math.max(maxLen, String(v).length);
  }
  // № is tiny; "Ad" (title) gets the most room; other fields mid-range.
  const isNo = colIndex === 0;
  const isTitle = colIndex === 1;
  const minW = isNo ? 5 : isTitle ? 28 : 14;
  const maxW = isNo ? 6 : isTitle ? 72 : 36;
  return Math.max(minW, Math.min(maxW, maxLen + 2));
}

function colLetter(n) {
  // 1-based → A, B, … Z, AA…
  let s = '';
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function cellStr(v) {
  if (v == null) return '';
  let s;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // A real date cell (cellDates:true above turns Excel date serials into
    // JS Date objects) — format it plainly instead of letting the caller
    // fall through to String(v), which is Date.prototype.toString() and
    // dumps things like "Wed Nov 12 2025 23:59:36 GMT+0400 (Azerbaijan
    // Standard Time)" straight into the cell.
    const hh = v.getHours().toString().padStart(2, '0');
    const mi = v.getMinutes().toString().padStart(2, '0');
    s = (hh === '00' && mi === '00')
      ? `${MONTH_SHORT[v.getMonth()]} ${v.getDate()} ${v.getFullYear()}`
      : `${MONTH_SHORT[v.getMonth()]} ${v.getDate()} ${v.getFullYear()}, ${hh}:${mi}`;
  } else if (typeof v === 'number' && Number.isFinite(v)) {
    // Excel date serials (e.g. 46260) — leave as plain number string; caller
    // decides whether to treat as date. Titles/codes stay numeric-as-text.
    s = String(v);
  } else {
    s = String(v).trim();
  }
  // Treat Excel placeholders as empty — don't import "N / A" into cells.
  if (/^n\s*\/\s*a$/i.test(s) || /^n\/?a$/i.test(s) || s.toLowerCase() === 'na') return '';
  return s;
}

/* ============================ EXPORT ============================ */
// columns: [{ label, get: (row, i) => string|number }] — includes № only if
// you want it (SheetsPage always adds it as the first column itself).
export async function exportSheetToExcel({ fileTitle, sheetName, items, columns }) {
  const header = columns.map(c => c.label);
  const rows = (items || []).map((row, i) => columns.map(c => c.get(row, i)));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet((sheetName || 'Sheets').slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: true }]
  });

  ws.columns = header.map((h, i) => ({ width: measureColWidth(h, i, rows) }));

  // Landscape + fit-to-width so Save as PDF uses the page instead of a
  // skinny table with a huge empty margin on the right.
  const lastCol = colLetter(header.length);
  const lastRow = 1 + rows.length;
  ws.pageSetup = {
    paperSize: 9, // A4
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
  };
  ws.pageSetup.printArea = `A1:${lastCol}${Math.max(lastRow, 1)}`;

  const headerRow = ws.addRow(header);
  headerRow.height = 22;
  headerRow.eachCell(cell => {
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = {
      top: GRID_BORDER, left: GRID_BORDER, right: GRID_BORDER, bottom: HEADER_BOTTOM_BORDER
    };
  });

  for (const r of rows) {
    const row = ws.addRow(r);
    row.eachCell((cell, colNumber) => {
      cell.font = { color: { argb: 'FF1F2937' }, size: 11 };
      // Wrap only when the cell is long enough to need it — short cells
      // stay single-line so rows don't balloon with empty vertical space.
      const text = String(cell.value ?? '');
      const colW = ws.getColumn(colNumber).width || 14;
      const needsWrap = text.length > colW;
      cell.alignment = colNumber === 1
        ? { vertical: 'middle', horizontal: 'center', wrapText: false }
        : { vertical: 'middle', horizontal: 'left', wrapText: needsWrap };
      cell.border = { top: GRID_BORDER, left: GRID_BORDER, right: GRID_BORDER, bottom: GRID_BORDER };
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName(fileTitle)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ============================ IMPORT ============================ */
// columns: [{ field, label, aliases: [...] }] in the same order as the
// on-screen table for this kind.
// Returns an array of plain row objects: { [field]: value, status? }.
// One object per Excel data row (duplicates kept here — the caller merges).
export async function importSheetRowsFromExcel(file, { columns, withStatus, statusKeyFromLabel, extraColumns = [] }) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];

  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  if (!aoa.length) return [];

  // The header row is not always the first one (e.g. a title + summary block
  // above the table): use the first row in the top 20 that matches at least
  // two known column names.
  const known = new Set();
  for (const c of [...columns, ...extraColumns]) { known.add(norm(c.label)); (c.aliases || []).forEach((a) => known.add(norm(a))); }
  ['status', 'vəziyyət', 'tarix', 'date'].forEach((x) => known.add(norm(x)));
  let headIdx = 0;
  for (let i = 0; i < Math.min(aoa.length, 20); i++) {
    const hits = (aoa[i] || []).filter((h) => {
      const n = norm(h);
      return n && (known.has(n) || [...known].some((k) => k.length > 4 && n.startsWith(k)));
    }).length;
    if (hits >= 2) { headIdx = i; break; }
  }
  const rawHeaders = (aoa[headIdx] || []).map((h) => String(h ?? ''));
  const headers = rawHeaders.map(norm);
  const findIdx = (names) => {
    for (const n of names) {
      const i = headers.indexOf(norm(n));
      if (i !== -1) return i;
    }
    return -1;
  };

  const fieldIdx = {}; // field -> column index in the sheet (-1 = not found yet)
  for (const c of columns) fieldIdx[c.field] = -1;

  // Pass 1 — exact label match only (this kind's own export headers), so a
  // field's own configured label always wins over another field's alias
  // (e.g. templates' "Sənədin adı" subtitle vs pdfs' generic title aliases).
  for (const c of columns) fieldIdx[c.field] = findIdx([c.label]);

  // Pass 2 — fall back to the broader alias list for anything still unmatched.
  for (const c of columns) {
    if (fieldIdx[c.field] === -1 && c.aliases?.length) {
      fieldIdx[c.field] = findIdx(c.aliases);
    }
  }

  // Optional columns (e.g. the linked Home item) — matched by header only,
  // never by position, so an old file without them imports exactly as before.
  const extraIdx = {};
  for (const c of extraColumns) extraIdx[c.field] = findIdx([c.label, ...(c.aliases || [])]);

  let iStatus = withStatus ? findIdx(['status', 'vəziyyət', 'veziyyet', 'Status (Mövcuddur, Mövcud deyil)']) : -1;
  if (withStatus && iStatus < 0) iStatus = headers.findIndex((h) => h.startsWith('status'));
  let iDate = findIdx(['tarix', 'date', 'tarixi']);

  // Positional fallback for anything headers didn't match, in the same
  // order as `columns` (which mirrors the on-screen table): № | col1 | col2 | … | status | date
  const used = new Set([...Object.values(fieldIdx), ...Object.values(extraIdx), iStatus, iDate].filter((i) => i >= 0));
  const looksLikeNo = (h) => /^(№|no|n|#)$/i.test(String(h || '').trim()) || norm(h) === 'n';
  let col = 0;
  if (looksLikeNo(rawHeaders[0]) || headers[0] === 'n' || headers[0] === '') col = 1;

  for (const c of columns) {
    if (fieldIdx[c.field] < 0) {
      while (used.has(col)) col += 1;
      fieldIdx[c.field] = col;
      used.add(col);
      col += 1;
    }
  }
  if (withStatus && iStatus < 0) { while (used.has(col)) col += 1; iStatus = col; used.add(col); col += 1; }
  if (iDate < 0) { while (used.has(col)) col += 1; iDate = col; used.add(col); }

  const out = [];
  for (const r of aoa.slice(headIdx + 1)) {
    if (!r || r.every(v => v == null || String(v).trim() === '')) continue;

    const row = {};
    let anyValue = false;
    for (const c of columns) {
      const i = fieldIdx[c.field];
      const v = i >= 0 ? cellStr(r[i]) : '';
      row[c.field] = v;
      if (v) anyValue = true;
    }
    for (const c of extraColumns) row[c.field] = extraIdx[c.field] >= 0 ? cellStr(r[extraIdx[c.field]]) : '';
    const stRaw = iStatus >= 0 ? cellStr(r[iStatus]) : '';
    if (!anyValue && !stRaw) continue; // fully empty row (besides date) — skip

    if (withStatus && stRaw && statusKeyFromLabel) {
      const key = statusKeyFromLabel(stRaw);
      if (key) row.status = key;
    }
    out.push(row);
  }
  return out;
}
