// AiMarkdown.jsx
// Small Markdown → React renderer for assistant replies. Builds elements (no
// innerHTML), so nothing the model writes can inject markup into the app.
// Covers what the assistant actually uses: headings, paragraphs, lists (one
// nesting level), tables, code, quotes, rules, bold/italic/inline code, links.

import { Fragment } from 'react';

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(__[^_\n]+?__)|(\*[^*\s][^*\n]*?\*)|(_[^_\s][^_\n]*?_)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function inline(text, keyBase = 'i') {
  const out = [];
  let last = 0;
  let k = 0;
  const s = String(text);
  s.replace(INLINE, (match, code, b1, b2, i1, i2, link, href, bare, offset) => {
    if (offset > last) out.push(s.slice(last, offset));
    const key = `${keyBase}-${k++}`;
    if (code) out.push(<code key={key} className="aimd-code">{code.slice(1, -1)}</code>);
    else if (b1 || b2) out.push(<strong key={key}>{inline((b1 || b2).slice(2, -2), key)}</strong>);
    else if (i1 || i2) out.push(<em key={key}>{inline((i1 || i2).slice(1, -1), key)}</em>);
    else if (link) {
      const label = link.slice(1, link.indexOf(']('));
      out.push(<a key={key} href={href} target="_blank" rel="noreferrer noopener">{label}</a>);
    } else if (bare) out.push(<a key={key} href={bare} target="_blank" rel="noreferrer noopener">{bare}</a>);
    last = offset + match.length;
    return match;
  });
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function withBreaks(text, keyBase) {
  const lines = String(text).split('\n');
  return lines.map((ln, i) => (
    <Fragment key={`${keyBase}-l${i}`}>
      {inline(ln, `${keyBase}-l${i}`)}
      {i < lines.length - 1 && <br />}
    </Fragment>
  ));
}

const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const splitRow = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const LIST_RE = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/;

function parseBlocks(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ t: 'code', lang: fence[1], text: body.join('\n') });
      continue;
    }
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) { blocks.push({ t: 'h', level: Math.min(h[1].length, 4), text: h[2].replace(/\s*#+\s*$/, '') }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }

    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ t: 'quote', text: body.join('\n') });
      continue;
    }
    if (LIST_RE.test(line)) {
      const items = [];
      const baseIndent = line.match(LIST_RE)[1].length;
      const ordered = /\d/.test(line.match(LIST_RE)[2]);
      while (i < lines.length) {
        const l = lines[i];
        const m = l.match(LIST_RE);
        if (m && m[1].length <= baseIndent + 1) {
          items.push({ text: m[3], sub: [] });
          i++;
        } else if (m && items.length) {
          items[items.length - 1].sub.push({ text: m[3], ordered: /\d/.test(m[2]) });
          i++;
        } else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
          items[items.length - 1].text += '\n' + l.trim();
          i++;
        } else break;
      }
      const start = ordered ? parseInt(line.match(LIST_RE)[2], 10) || 1 : undefined;
      blocks.push({ t: 'list', ordered, start, items });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim()
      && !/^\s*```/.test(lines[i]) && !/^\s*#{1,6}\s/.test(lines[i])
      && !LIST_RE.test(lines[i]) && !/^\s*>/.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      para.push(lines[i++]);
    }
    blocks.push({ t: 'p', text: para.join('\n') });
  }
  return blocks;
}

export default function AiMarkdown({ text, className = '' }) {
  const blocks = parseBlocks(text);
  return (
    <div className={`aimd ${className}`}>
      {blocks.map((b, bi) => {
        const key = `b${bi}`;
        switch (b.t) {
          case 'h': {
            const Tag = `h${b.level + 2 > 6 ? 6 : b.level + 2}`;
            return <Tag key={key} className={`aimd-h aimd-h${b.level}`}>{inline(b.text, key)}</Tag>;
          }
          case 'code':
            return <pre key={key} className="aimd-pre"><code>{b.text}</code></pre>;
          case 'hr':
            return <hr key={key} className="aimd-hr" />;
          case 'quote':
            return <blockquote key={key} className="aimd-quote">{withBreaks(b.text, key)}</blockquote>;
          case 'table':
            return (
              <div key={key} className="aimd-table-wrap">
                <table className="aimd-table">
                  <thead><tr>{b.head.map((c, ci) => <th key={ci}>{inline(c, `${key}-h${ci}`)}</th>)}</tr></thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>{b.head.map((_, ci) => <td key={ci}>{inline(r[ci] ?? '', `${key}-${ri}-${ci}`)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul';
            return (
              <Tag key={key} className="aimd-list" start={b.start}>
                {b.items.map((it, ii) => (
                  <li key={ii}>
                    {withBreaks(it.text, `${key}-${ii}`)}
                    {it.sub.length > 0 && (
                      it.sub[0].ordered
                        ? <ol className="aimd-list">{it.sub.map((s, si) => <li key={si}>{inline(s.text, `${key}-${ii}-${si}`)}</li>)}</ol>
                        : <ul className="aimd-list">{it.sub.map((s, si) => <li key={si}>{inline(s.text, `${key}-${ii}-${si}`)}</li>)}</ul>
                    )}
                  </li>
                ))}
              </Tag>
            );
          }
          default:
            return <p key={key} className="aimd-p">{withBreaks(b.text, key)}</p>;
        }
      })}
    </div>
  );
}
