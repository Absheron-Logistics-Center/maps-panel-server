// Small coloured pill showing what kind of file an item holds: PDF / Word / Excel.
const TYPES = {
  pdf: { label: 'PDF', cls: 'pdf' },
  doc: { label: 'Word', cls: 'word' },
  docx: { label: 'Word', cls: 'word' },
  xls: { label: 'Excel', cls: 'excel' },
  xlsx: { label: 'Excel', cls: 'excel' }
};
export function fileTypeOf(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
  return m ? TYPES[m[1].toLowerCase()] || null : null;
}
export default function FileTypePill({ filename, className = '' }) {
  const t = fileTypeOf(filename);
  if (!t) return null;
  return <span className={`ft-pill ft-${t.cls} ${className}`} title={filename}>{t.label}</span>;
}
