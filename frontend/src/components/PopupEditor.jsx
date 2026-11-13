// PopupEditor.jsx — what a viewer sees when they click a node.
//
// Two tabs:
//   Redaktə   — the sections in the exact order the popup shows them. Each
//               section is one row; only the open one shows its fields, so
//               the panel stays short and it is clear what belongs to what.
//   Önizləmə  — the real popup (same component NodeModal renders), on a
//               canvas-like stage.
import { useState, useEffect, useRef } from 'react';
import { ChevronDown, Plus, Trash2 } from './icons.jsx';
import { ArrowUp, ArrowDown, Type, ListOrdered, Eye, PencilLine, Pipette, RotateCcw } from 'lucide-react';
import { IconPicker, Icon } from './iconLibrary.jsx';
import { makeSection } from './infoModel.js';
import { PopupContent } from './NodeModal.jsx';

const DOTS = [
  '#3a7894', '#1f4456', '#2563eb', '#7c3aed', '#db2777', '#dc2626',
  '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#475569'
];

const sep = type => (type === 'list' ? '\n' : '\n\n');
const toItems = (text, type) => text.split(sep(type)).map(x => x.trim()).filter(Boolean);

/* Textarea that keeps what you type (empty lines, a fresh Enter at the end)
   and only hands the parsed items up. The old one re-joined the items on
   every key press, which swallowed the Enter that starts a new paragraph. */
function DraftArea({ items, type, placeholder, autoFocus }) {
  const [text, setText] = useState(() => (items.value || []).join(sep(type)));
  const ref = useRef(null);
  const sig = JSON.stringify(items.value || []);
  useEffect(() => {
    // outside change (undo, AI, other tab) → show it; own typing → leave it
    if (JSON.stringify(toItems(text, type)) !== sig) setText((items.value || []).join(sep(type)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, type]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(320, Math.max(84, el.scrollHeight + 2)) + 'px';
  }, [text]);
  return (
    <textarea
      ref={ref}
      className="pe-text"
      value={text}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={e => { setText(e.target.value); items.set(toItems(e.target.value, type)); }}
    />
  );
}

function ColorDots({ value, onChange }) {
  const v = (value || '').toLowerCase();
  const custom = v && !DOTS.includes(v);
  return (
    <div className="pe-dots" role="radiogroup" aria-label="Başlıq rəngi">
      <button type="button" role="radio" aria-checked={!v}
        className={`pe-dot std ${!v ? 'on' : ''}`} title="Standart rəng" onClick={() => onChange('')}>
        <RotateCcw size={11} />
      </button>
      {DOTS.map(c => (
        <button key={c} type="button" role="radio" aria-checked={v === c}
          className={`pe-dot ${v === c ? 'on' : ''}`} style={{ '--dot': c }} title={c} onClick={() => onChange(c)} />
      ))}
      <label className={`pe-dot pick ${custom ? 'on' : ''}`} style={custom ? { '--dot': v } : undefined} title="Başqa rəng">
        <input type="color" value={custom ? v : '#3a7894'} onChange={e => onChange(e.target.value)} />
        {!custom && <Pipette size={11} />}
      </label>
    </div>
  );
}

function countLabel(sec) {
  const n = sec.items.length;
  if (!n) return null;
  return sec.type === 'list' ? `${n} bənd` : `${n} abzas`;
}

function SectionRow({ sec, open, onToggle, index, total }) {
  const count = countLabel(sec);
  const excerpt = sec.items[0] || '';
  const accent = sec.color || (sec.risky ? 'var(--warn)' : 'var(--primary)');
  return (
    <div className={`pe-sec ${open ? 'open' : ''} ${count ? '' : 'empty'} ${sec.risky ? 'risky' : ''}`} style={{ '--accent': accent }}>
      <button type="button" className="pe-sec-head" onClick={onToggle} aria-expanded={open}>
        <span className="pe-sec-icon"><Icon name={sec.icon} size={15} /></span>
        <span className="pe-sec-text">
          <span className="pe-sec-title">{sec.title || 'Adsız bölmə'}</span>
          <span className="pe-sec-sub">{count ? excerpt : 'Boşdur, popupda görünmür'}</span>
        </span>
        {count && <span className="pe-sec-count">{count}</span>}
        <ChevronDown size={14} className="pe-sec-chev" />
      </button>

      {open && (
        <div className="pe-sec-body">
          <div className="pe-field-row">
            <IconPicker value={sec.icon} color={sec.color} onChange={v => sec.set({ icon: v })} />
            <input
              className="pe-title-input"
              value={sec.title}
              placeholder="Bölmənin adı"
              onChange={e => sec.set({ title: e.target.value })}
            />
          </div>

          {!sec.fixed && (
            <div className="pe-kind" role="radiogroup" aria-label="Bölmənin növü">
              <button type="button" role="radio" aria-checked={sec.type !== 'list'}
                className={sec.type !== 'list' ? 'on' : ''} onClick={() => sec.set({ type: 'text' })}>
                <Type size={13} /> Abzaslar
              </button>
              <button type="button" role="radio" aria-checked={sec.type === 'list'}
                className={sec.type === 'list' ? 'on' : ''} onClick={() => sec.set({ type: 'list' })}>
                <ListOrdered size={13} /> Siyahı
              </button>
            </div>
          )}

          <DraftArea
            key={sec.type}
            items={{ value: sec.items, set: v => sec.set({ items: v }) }}
            type={sec.type}
            autoFocus={!sec.items.length}
            placeholder={sec.type === 'list'
              ? (sec.risky ? 'Hər sətrə bir risk yazın' : 'Hər sətrə bir bənd yazın')
              : 'Mətni yazın. Yeni abzas üçün bir boş sətir buraxın.'}
          />

          <div className="pe-color">
            <span>Başlıq rəngi</span>
            <ColorDots value={sec.color} onChange={c => sec.set({ color: c })} />
          </div>

          <div className="pe-sec-foot">
            {!sec.fixed ? (
              <span className="pe-move">
                <button type="button" className="icon-btn ghost" title="Yuxarı" disabled={index <= 1} onClick={() => sec.move(-1)}><ArrowUp size={13} /></button>
                <button type="button" className="icon-btn ghost" title="Aşağı" disabled={index >= total - 2} onClick={() => sec.move(1)}><ArrowDown size={13} /></button>
              </span>
            ) : <span className="pe-fixed-note">{sec.risky ? 'Həmişə sonda, xəbərdarlıq qutusunda görünür' : 'Həmişə ilk bölmədir'}</span>}
            {sec.fixed ? (
              sec.items.length > 0 && (
                <button type="button" className="pe-danger" onClick={() => sec.set({ items: [] })}>
                  <Trash2 size={13} /> Mətni təmizlə
                </button>
              )
            ) : (
              <button type="button" className="pe-danger" onClick={sec.remove}>
                <Trash2 size={13} /> Bölməni sil
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PopupEditor({ node, patchInfo }) {
  const info = node.info || {};
  const custom = info.sections || [];
  const [tab, setTab] = useState('edit');
  const [openKey, setOpenKey] = useState(() => {
    if ((info.general || []).length) return 'general';
    const first = custom.find(s => (s.items || []).some(Boolean));
    if (first) return first.id;
    return 'general';
  });

  const setCustom = next => patchInfo({ sections: next });

  const rows = [
    {
      key: 'general', fixed: true,
      icon: info.generalIcon || 'FileText',
      title: info.generalTitle ?? 'Ümumi məlumat',
      color: info.generalColor || '',
      type: 'text',
      items: (info.general || []).filter(Boolean),
      set: f => patchInfo({
        ...(f.icon !== undefined ? { generalIcon: f.icon } : {}),
        ...(f.title !== undefined ? { generalTitle: f.title } : {}),
        ...(f.color !== undefined ? { generalColor: f.color } : {}),
        ...(f.items !== undefined ? { general: f.items } : {})
      })
    },
    ...custom.map((s, i) => ({
      key: s.id || `sec-${i}`, fixed: false,
      icon: s.icon || 'FileText', title: s.title ?? '', color: s.color || '',
      type: s.type === 'list' ? 'list' : 'text',
      items: (s.items || []).filter(Boolean),
      set: f => setCustom(custom.map((x, k) => (k === i ? { ...x, ...f } : x))),
      move: dir => {
        const j = i + dir;
        if (j < 0 || j >= custom.length) return;
        const next = [...custom];
        [next[i], next[j]] = [next[j], next[i]];
        setCustom(next);
      },
      remove: () => {
        const hasText = (s.items || []).some(Boolean);
        if (hasText && !confirm(`"${s.title || 'Bölmə'}" bölməsi silinsin?`)) return;
        setCustom(custom.filter((_, k) => k !== i));
      }
    })),
    {
      key: 'risks', fixed: true, risky: true,
      icon: info.risksIcon || 'AlertTriangle',
      title: info.risksTitle ?? 'Mümkün risklər',
      color: info.risksColor || '',
      type: 'list',
      items: (info.risks || []).filter(Boolean),
      set: f => patchInfo({
        ...(f.icon !== undefined ? { risksIcon: f.icon } : {}),
        ...(f.title !== undefined ? { risksTitle: f.title } : {}),
        ...(f.color !== undefined ? { risksColor: f.color } : {}),
        ...(f.items !== undefined ? { risks: f.items } : {})
      })
    }
  ];

  function addSection() {
    const s = makeSection({ items: [] });
    setCustom([...custom, s]);
    setOpenKey(s.id);
    setTab('edit');
  }

  const filled = rows.filter(r => r.items.length).length;

  return (
    <div className="pe">
      <div className="pe-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'edit'} className={tab === 'edit' ? 'on' : ''} onClick={() => setTab('edit')}>
          <PencilLine size={14} /> Redaktə
        </button>
        <button type="button" role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'on' : ''} onClick={() => setTab('preview')}>
          <Eye size={14} /> Önizləmə
        </button>
      </div>

      {tab === 'edit' ? (
        <>
          <p className="pe-lead">
            Node-a klikləyəndə bu bölmələr yuxarıdan aşağı göstərilir.
            {filled ? ` Doldurulub: ${filled} / ${rows.length}.` : ' Hələ heç biri doldurulmayıb.'}
          </p>
          <div className="pe-list">
            {rows.map((sec, i) => (
              <SectionRow
                key={sec.key}
                sec={sec}
                index={i}
                total={rows.length}
                open={openKey === sec.key}
                onToggle={() => setOpenKey(k => (k === sec.key ? null : sec.key))}
              />
            ))}
          </div>
          <button type="button" className="pe-add" onClick={addSection}>
            <Plus size={14} /> Bölmə əlavə et
          </button>
        </>
      ) : (
        <div className="pe-stage">
          <div className="modal-card pe-card">
            <PopupContent node={node} />
          </div>
          <p className="pe-stage-note">İstifadəçi node-a kliklədikdə popup belə görünəcək.</p>
        </div>
      )}
    </div>
  );
}
