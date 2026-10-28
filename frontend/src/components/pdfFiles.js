// pdfFiles.js
// Real PDF files from diagrams, made in the browser with no extra library:
// each diagram SVG is drawn on a canvas (title on top), saved as JPEG, and
// placed on its own A4 page of a small hand-written PDF.
//   - diagramsToPdfBlob(list, { orientation })  -> one PDF, one page per diagram
//   - diagramsToZip(list, { orientation })       -> ZIP with one PDF per diagram
import JSZip from 'jszip';
import { buildDiagramSvg } from './diagramExport.js';

const A4 = { w: 595.28, h: 841.89 };   // points
const MARGIN = 28;

export function safeFileName(s) {
  return (String(s || 'diaqram').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'diaqram').slice(0, 80);
}

/* ---------- diagram -> JPEG (with its title drawn above) ---------- */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Diaqram şəklə çevrilmədi'));
    img.src = url;
  });
}

async function diagramToJpeg(process) {
  const { svg, width, height } = buildDiagramSvg(process, { padding: 24 });
  const scale = Math.min(2, 4800 / Math.max(width, 1));          // sharp, but not huge
  const head = 64;                                                // title band (px, before scale)
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round((height + head) * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.scale(scale, scale);
  ctx.fillStyle = '#243f4f';
  ctx.font = "700 22px 'Segoe UI', Arial, sans-serif";
  ctx.textBaseline = 'top';
  ctx.fillText(String(process.title || 'Diaqram'), 24, 14, width - 48);
  if (process.subtitle) {
    ctx.fillStyle = '#5b7280';
    ctx.font = "500 14px 'Segoe UI', Arial, sans-serif";
    ctx.fillText(String(process.subtitle), 24, 42, width - 48);
  }

  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = await loadImage(url);
    ctx.drawImage(img, 0, head, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height };
}

/* ---------- minimal PDF writer (one JPEG per page) ---------- */
function buildPdf(images, orientation) {
  const pageW = orientation === 'portrait' ? A4.w : A4.h;
  const pageH = orientation === 'portrait' ? A4.h : A4.w;
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const b = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(b);
    length += b.length;
  };
  const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };

  push('%PDF-1.4\n%âãÏÓ\n');
  const pageIds = images.map((_, i) => 3 + i * 3);
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${images.length} >>`));

  images.forEach((im, i) => {
    const pageId = 3 + i * 3, contentId = pageId + 1, imgId = pageId + 2;
    // fit the image inside the margins, keep its ratio, centre horizontally, stick to the top
    const boxW = pageW - MARGIN * 2, boxH = pageH - MARGIN * 2;
    const k = Math.min(boxW / im.w, boxH / im.h);
    const dw = im.w * k, dh = im.h * k;
    const x = (pageW - dw) / 2, y = pageH - MARGIN - dh;
    const content = `q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im${i} Do Q`;

    obj(pageId, () => push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] ` +
      `/Resources << /XObject << /Im${i} ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`
    ));
    obj(contentId, () => { push(`<< /Length ${content.length} >>\nstream\n`); push(content); push('\nendstream'); });
    obj(imgId, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`);
      push(im.bytes);
      push('\nendstream');
    });
  });

  const count = 3 + images.length * 3;
  const xref = length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(chunks, { type: 'application/pdf' });
}

/* ---------- public ---------- */
export async function diagramsToPdfBlob(list, { orientation = 'landscape', onProgress } = {}) {
  const images = [];
  for (const p of list) { images.push(await diagramToJpeg(p)); onProgress?.(); }
  return buildPdf(images, orientation);
}

export async function diagramsToZip(list, { orientation = 'landscape', onProgress } = {}) {
  const zip = new JSZip();
  const used = new Map();
  for (const p of list) {
    const blob = buildPdf([await diagramToJpeg(p)], orientation);
    let name = safeFileName(p.title);
    const n = (used.get(name) || 0) + 1;
    used.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    zip.file(`${name}.pdf`, blob);
    onProgress?.();
  }
  return zip.generateAsync({ type: 'blob' });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
