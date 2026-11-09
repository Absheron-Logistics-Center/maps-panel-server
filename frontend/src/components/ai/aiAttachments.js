// aiAttachments.js
// Everything the admin drops, pastes or picks into the AI panel goes through
// here and comes out as one plain object the chat can show and send:
//
//   { id, kind:'image'|'pdf'|'text', name, mime, size, thumb, ...payload }
//     image : data (base64, already downscaled), width, height
//     pdf   : data (original PDF, base64), pageCount, pages:[{ n, text, image }]
//     text  : text (Word / Excel / CSV / TXT / JSON contents)
//
// PDFs are opened with pdf.js (bundled in public/vendor/pdfjs, so it works on
// the offline company server too). Gemini gets the original PDF — it reads
// every page as an image AND as text — while OpenAI-style models get the
// rendered page images plus the text layer. If pdf.js can't load for some
// reason the original PDF is still sent; only the page previews are missing.

import JSZip from 'jszip';

export const ACCEPT = [
  'image/*', '.pdf', '.docx', '.xlsx', '.xls', '.csv', '.txt', '.md', '.json', '.xml', '.html', '.htm', '.log'
].join(',');

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const IMAGE_LONG_SIDE = 2400;     // keeps screenshot text readable
const PAGE_RENDER_WIDTH = 1600;   // PDF page → image for non-Gemini models
const MAX_PDF_PAGES = 40;
const MAX_TEXT_CHARS = 180000;

// FNV-1a over the bytes — works on plain http (the company server), where
// crypto.subtle is not available. Good enough to spot "same file again".
export function fingerprint(buf) {
  const bytes = new Uint8Array(buf);
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i]; h1 = Math.imul(h1, 0x01000193);
    if ((i & 7) === 0) { h2 ^= bytes[i]; h2 = Math.imul(h2, 0x5bd1e995); }
  }
  return `${bytes.length.toString(36)}-${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

/* Which files were already used to build which diagrams (per browser). */
const SOURCES_KEY = 'alm-ai-sources-v1';
function readSources() {
  try { return JSON.parse(localStorage.getItem(SOURCES_KEY) || '{}') || {}; } catch { return {}; }
}
export function sourceUses(hash) {
  if (!hash) return [];
  return readSources()[hash]?.uses || [];
}
export function recordSourceUse(att, title) {
  if (!att?.hash) return;
  try {
    const all = readSources();
    const entry = all[att.hash] || { name: att.name, uses: [] };
    entry.uses = [{ title: title || '', at: Date.now() }, ...entry.uses.filter(u => u.title !== title)].slice(0, 5);
    all[att.hash] = entry;
    const keys = Object.keys(all);
    if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(k => delete all[k]);
    localStorage.setItem(SOURCES_KEY, JSON.stringify(all));
  } catch { /* storage off — not essential */ }
}

let seq = 0;
const newId = () => `att-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function b64Bytes(b64) {
  return b64 ? Math.floor((b64.length * 3) / 4) : 0;
}

export function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

const stripDataUrl = url => String(url).replace(/^data:[^;]+;base64,/, '');

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Şəkil açılmadı'));
    img.src = src;
  });
}

function canvasFor(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function thumbFrom(source, sw, sh, size = 220) {
  const scale = Math.min(1, size / Math.max(sw, sh));
  const c = canvasFor(sw * scale, sh * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

/* ------------------------------------------------------------------ */
/* images                                                              */
/* ------------------------------------------------------------------ */

async function processImage(file, opts = {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth, h = img.naturalHeight;
    const scale = Math.min(1, IMAGE_LONG_SIDE / Math.max(w, h));
    const tw = Math.round(w * scale), th = Math.round(h * scale);

    let mime = file.type || 'image/png';
    let data;
    const hash = fingerprint(await file.arrayBuffer());
    const passThrough = scale === 1 && file.size < 1.2 * 1024 * 1024 && /png|jpe?g|webp/.test(mime);
    if (passThrough) {
      data = arrayBufferToBase64(await file.arrayBuffer());
    } else {
      const c = canvasFor(tw, th);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(img, 0, 0, tw, th);
      // PNG keeps flat screenshots crisp; switch to JPEG only when PNG is heavy.
      let out = c.toDataURL('image/png');
      mime = 'image/png';
      if (b64Bytes(stripDataUrl(out)) > 1.4 * 1024 * 1024) {
        out = c.toDataURL('image/jpeg', 0.88);
        mime = 'image/jpeg';
      }
      data = stripDataUrl(out);
    }
    return {
      id: newId(),
      kind: 'image',
      source: opts.source || (opts.pasted ? 'paste' : 'file'),
      name: file.name || (opts.pasted ? `ekran-görüntüsü-${new Date().toLocaleTimeString('az-AZ').replace(/:/g, '-')}.png` : 'şəkil.png'),
      mime,
      size: b64Bytes(data),
      width: tw,
      height: th,
      data,
      hash,
      usedBefore: sourceUses(hash),
      thumb: thumbFrom(img, w, h)
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

let pdfjsPromise = null;
function vendorBase() {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
  return `${base}vendor/pdfjs/`;
}
function loadPdfjs() {
  if (!pdfjsPromise) {
    const base = vendorBase();
    pdfjsPromise = import(/* @vite-ignore */ `${base}pdf.min.mjs`)
      .then(lib => {
        lib.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
        return lib;
      })
      .catch(e => {
        pdfjsPromise = null;
        throw e;
      });
  }
  return pdfjsPromise;
}

/** Text layer of one page, with line breaks where the PDF has them. */
async function pageText(page) {
  const tc = await page.getTextContent();
  let out = '';
  let lastY = null;
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    const y = it.transform ? Math.round(it.transform[5]) : null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 4 && !out.endsWith('\n')) out += '\n';
    out += it.str;
    if (it.hasEOL) out += '\n';
    else if (it.str && !/\s$/.test(it.str)) out += ' ';
    lastY = y;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function renderPage(page, width) {
  const vp1 = page.getViewport({ scale: 1 });
  const scale = width / vp1.width;
  const vp = page.getViewport({ scale });
  const c = canvasFor(vp.width, vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
  return c;
}

async function processPdf(file, onProgress) {
  const buf = await file.arrayBuffer();
  const data = arrayBufferToBase64(buf);
  const hash = fingerprint(buf);
  const att = {
    hash,
    usedBefore: sourceUses(hash),
    id: newId(),
    kind: 'pdf',
    name: file.name || 'sənəd.pdf',
    mime: 'application/pdf',
    size: file.size,
    data,
    pageCount: 0,
    pages: [],
    thumb: null,
    previewError: null
  };

  try {
    const pdfjs = await loadPdfjs();
    const base = vendorBase();
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf.slice(0)),
      standardFontDataUrl: `${base}standard_fonts/`,
      wasmUrl: `${base}wasm/`,
      isEvalSupported: false
    }).promise;
    att.pageCount = doc.numPages;
    const n = Math.min(doc.numPages, MAX_PDF_PAGES);
    for (let i = 1; i <= n; i++) {
      onProgress?.(`${i}/${n} səhifə oxunur…`);
      const page = await doc.getPage(i);
      const text = await pageText(page).catch(() => '');
      const canvas = await renderPage(page, PAGE_RENDER_WIDTH);
      const image = stripDataUrl(canvas.toDataURL('image/jpeg', 0.82));
      const thumb = thumbFrom(canvas, canvas.width, canvas.height, 360);
      if (i === 1) att.thumb = thumbFrom(canvas, canvas.width, canvas.height, 220);
      att.pages.push({ n: i, text, image, thumb });
      page.cleanup?.();
    }
    doc.destroy?.();
  } catch (e) {
    console.warn('[ai] pdf.js preview failed:', e);
    att.previewError = 'Səhifə önizləməsi alınmadı — PDF olduğu kimi göndəriləcək.';
  }
  return att;
}

/* ------------------------------------------------------------------ */
/* Office / text                                                       */
/* ------------------------------------------------------------------ */

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

async function docxText(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const doc = zip.file('word/document.xml');
  if (!doc) throw new Error('Word faylı oxunmadı');
  const xml = await doc.async('string');
  const text = xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:tc>/g, ' | ')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeXmlEntities(text).replace(/\n{3,}/g, '\n\n').trim();
}

async function sheetText(file) {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  return wb.SheetNames.map(name => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
    return `### Vərəq: ${name}\n${csv}`;
  }).join('\n\n');
}

async function processText(file) {
  const ext = extOf(file.name);
  const hash = fingerprint(await file.arrayBuffer());
  let text;
  if (ext === 'docx') text = await docxText(file);
  else if (ext === 'xlsx' || ext === 'xls') text = await sheetText(file);
  else text = await file.text();
  const truncated = text.length > MAX_TEXT_CHARS;
  if (truncated) text = text.slice(0, MAX_TEXT_CHARS) + '\n…(fayl qısaldıldı)';
  return {
    id: newId(),
    kind: 'text',
    name: file.name,
    mime: file.type || 'text/plain',
    size: file.size,
    text,
    ext,
    hash,
    usedBefore: sourceUses(hash),
    truncated,
    thumb: null
  };
}

/* ------------------------------------------------------------------ */
/* entry points                                                        */
/* ------------------------------------------------------------------ */

export function isSupported(file) {
  if (!file) return false;
  if (file.type?.startsWith('image/')) return true;
  return ['pdf', 'docx', 'xlsx', 'xls', 'csv', 'txt', 'md', 'json', 'xml', 'html', 'htm', 'log'].includes(extOf(file.name))
    || /^text\//.test(file.type || '');
}

/** File → attachment. Throws with an Azerbaijani message on failure. */
export async function processFile(file, { pasted = false, onProgress } = {}) {
  if (!isSupported(file)) throw new Error(`"${file.name}" — bu fayl növü dəstəklənmir`);
  if (file.size > MAX_FILE_BYTES) throw new Error(`"${file.name}" çox böyükdür (${formatBytes(file.size)}). Maksimum ${formatBytes(MAX_FILE_BYTES)}.`);
  if (file.type?.startsWith('image/')) return processImage(file, { pasted });
  if (extOf(file.name) === 'pdf' || file.type === 'application/pdf') return processPdf(file, onProgress);
  return processText(file);
}

/** Live picture of the open diagram (built from the same SVG the PDF export uses). */
export async function svgToAttachment(svg, { width, height, name = 'diaqram.png', source = 'diagram' } = {}) {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const w = width || img.naturalWidth || 1600;
    const h = height || img.naturalHeight || 900;
    const scale = Math.min(2, 3000 / Math.max(w, h));
    const c = canvasFor(w * scale, h * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    let out = c.toDataURL('image/png');
    let mime = 'image/png';
    if (b64Bytes(stripDataUrl(out)) > 1.6 * 1024 * 1024) {
      out = c.toDataURL('image/jpeg', 0.9);
      mime = 'image/jpeg';
    }
    const data = stripDataUrl(out);
    return {
      id: newId(), kind: 'image', source, name, mime,
      size: b64Bytes(data), width: c.width, height: c.height, data,
      thumb: thumbFrom(c, c.width, c.height)
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ------------------------------------------------------------------ */
/* What actually goes over the wire                                    */
/* ------------------------------------------------------------------ */

function noteFor(att, digest) {
  let text = digest || '';
  if (!text && att.kind === 'pdf') {
    text = (att.pages || []).map(p => `--- Səhifə ${p.n} ---\n${p.text || ''}`).join('\n').slice(0, 30000);
  }
  if (!text && att.kind === 'text') text = String(att.text || '').slice(0, 30000);
  if (!text) text = '(məzmun burada yoxdur)';
  // hash + fileKind let the server load the original from data/ai/files/
  const note = { kind: 'note', name: att.name, text };
  if (att.hash && (att.kind === 'pdf' || att.kind === 'image') && att.source !== 'preview') {
    note.hash = att.hash;
    note.fileKind = att.kind;
    if (att.mime) note.mime = att.mime;
  }
  return note;
}

function fullWire(att, provider) {
  if (att.kind === 'image') {
    return att.data ? { kind: 'image', name: att.name, mime: att.mime, data: att.data, source: att.source, hash: att.hash } : null;
  }
  if (att.kind === 'pdf') {
    const pages = (att.pages || []).map(p => ({ n: p.n, text: p.text || '' }));
    if (provider === 'gemini' && att.data) {
      return { kind: 'pdf', name: att.name, data: att.data, pageCount: att.pageCount, pages, hash: att.hash };
    }
    // Avtomatik: the answering model isn't known yet — send the original PDF
    // (Gemini) AND the page images (other models); lighterWire trims if too big.
    if (provider === 'auto' && att.data) {
      return {
        kind: 'pdf', name: att.name, data: att.data, pageCount: att.pageCount, hash: att.hash,
        pages: (att.pages || []).map(p => ({ n: p.n, text: p.text || '', image: p.image }))
      };
    }
    const withImages = (att.pages || []).map(p => ({ n: p.n, text: p.text || '', image: p.image }));
    if (withImages.some(p => p.image)) return { kind: 'pdf', name: att.name, pageCount: att.pageCount, pages: withImages };
    // pdf.js couldn't render — the server still has the raw PDF to work with.
    return att.data ? { kind: 'pdf', name: att.name, data: att.data, pageCount: att.pageCount, pages } : null;
  }
  if (att.kind === 'text') return { kind: 'text', name: att.name, text: att.text };
  return null;
}

/** Smaller fallback when the full payload doesn't fit (Vercel ~4MB). */
function lighterWire(att, provider) {
  if (att.kind === 'pdf' && provider === 'auto' && att.data) {
    return { kind: 'pdf', name: att.name, data: att.data, pageCount: att.pageCount, hash: att.hash, pages: (att.pages || []).map(p => ({ n: p.n, text: p.text || '' })) };
  }
  if (att.kind === 'pdf') {
    const pages = att.pages || [];
    if (pages.some(p => p.image)) {
      return { kind: 'pdf', name: att.name, pageCount: att.pageCount, pages: pages.map(p => ({ n: p.n, text: p.text || '', image: p.image })) };
    }
  }
  return null;
}

const wireBytes = w => JSON.stringify(w || '').length;

/**
 * Chat messages → the array /api/ai/chat expects.
 * The newest attachment-bearing turns are sent in full while they fit in the
 * request budget; older ones are replaced by the model's own reading of them
 * (attachmentNotes from the reply that followed), so long chats stay cheap.
 */
export function toWireMessages(messages, { provider = 'gemini', maxBytes = 4 * 1024 * 1024 } = {}) {
  const convo = messages.filter(m => (m.role === 'user' || m.role === 'assistant') && !m.hidden);
  const out = convo.map(m => ({ role: m.role, content: m.content || '' }));

  // digest that followed each user message
  const digestAfter = new Map();
  convo.forEach((m, i) => {
    if (m.role !== 'user') return;
    const next = convo.slice(i + 1).find(x => x.role === 'assistant');
    if (next?.attachmentNotes) digestAfter.set(i, next.attachmentNotes);
  });

  let budget = maxBytes - 400 * 1024 - wireBytes(out); // room for the context snapshot
  let fullTurns = 0;
  for (let i = convo.length - 1; i >= 0; i--) {
    const m = convo[i];
    if (m.role !== 'user' || !m.attachments?.length) continue;
    const wired = [];
    const isLatest = i === convo.length - 1;
    const allowFull = isLatest || fullTurns < 2;
    for (const att of m.attachments) {
      let w = allowFull ? fullWire(att, provider) : null;
      let size = wireBytes(w);
      if (w && size > budget) {
        w = lighterWire(att, provider);
        size = wireBytes(w);
      }
      if (!w || size > budget) {
        w = noteFor(att, digestAfter.get(i));
        size = wireBytes(w);
      }
      budget -= size;
      wired.push(w);
    }
    if (wired.some(w => w.kind !== 'note')) fullTurns++;
    out[i].attachments = wired;
  }
  return out;
}

/** Strip heavy fields before saving a chat to localStorage. */
export function slimForStorage(att) {
  const keep = {
    id: att.id, kind: att.kind, name: att.name, mime: att.mime, size: att.size,
    source: att.source, pageCount: att.pageCount, width: att.width, height: att.height, hash: att.hash,
    thumb: att.thumb && att.thumb.length < 40000 ? att.thumb : null
  };
  if (att.kind === 'pdf') keep.pages = (att.pages || []).map(p => ({ n: p.n, text: String(p.text || '').slice(0, 6000) }));
  if (att.kind === 'text') keep.text = String(att.text || '').slice(0, 20000);
  keep.stale = true;
  return keep;
}
