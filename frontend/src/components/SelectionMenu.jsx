// SelectionMenu.jsx — Windows-style right-click context menu for whatever
// is currently selected on the canvas (node / lane / edge). It appears
// exactly where you clicked, as a compact vertical menu; each row expands
// a flyout submenu to the side (like Explorer's "Sort by" flyout), instead
// of a bar docked to the toolbar.
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Trash2, Square, Eye, ChevronRight, X, Plus } from './icons.jsx';
import {
  Palette, Waypoints, LayoutList, ArrowRightLeft, ArrowUp, ArrowDown,
  Type, ListOrdered, Maximize2, FileText as PopupIcon
} from 'lucide-react';
import { SHAPES, STYLES, SHAPE_LABEL, STYLE_LABEL, nodeView, nodeDefaults } from './nodeStyle.js';
import { IconPicker, Icon } from './iconLibrary.jsx';
import { makeSection } from './infoModel.js';
import { ColorField } from './AdminPanel.jsx';
import { repackLanes } from './laneRepack.js';
import { autoNodeHeight } from './nodeMeasure.js';
import { useLabels } from '../labels/LabelsContext.jsx';

const MENU_W = 230;
const FLYOUT_W = 400;
const MARGIN = 10;

function clampMenuPos(anchorRect) {
  const vw = window.innerWidth, vh = window.innerHeight;
  if (!anchorRect) {
    return { left: Math.max(MARGIN, vw / 2 - MENU_W / 2), top: 140 };
  }
  let left = anchorRect.right + 10;
  if (left + MENU_W + MARGIN > vw) left = anchorRect.left - MENU_W - 10;
  left = Math.max(MARGIN, Math.min(left, vw - MENU_W - MARGIN));
  const top = Math.max(MARGIN, Math.min(anchorRect.top, vh - MARGIN - 60));
  return { left, top };
}

/* a single row; if it has children it expands a flyout to the side on click.
 * The flyout measures its own rendered size (which can change as the user
 * types/adds sections) and repositions itself with fixed viewport
 * coordinates so it can never be pushed off-screen — top, bottom, left
 * and right are all clamped, not just the left/right "side" flip. */
function MenuItem({ pid, icon, label, danger, action, openItem, setOpenItem, side, children }) {
  const btnRef = useRef(null);
  const flyoutRef = useRef(null);
  const [flyoutPos, setFlyoutPos] = useState(null);

  const isOpen = openItem === pid;

  useLayoutEffect(() => {
    if (!isOpen) { setFlyoutPos(null); return; }

    function place() {
      if (!btnRef.current || !flyoutRef.current) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      const btnRect = btnRef.current.getBoundingClientRect();
      const fh = Math.min(flyoutRef.current.scrollHeight, vh - MARGIN * 2);

      let left = side === 'right' ? btnRect.right + 6 : btnRect.left - FLYOUT_W - 6;
      left = Math.max(MARGIN, Math.min(left, vw - FLYOUT_W - MARGIN));

      let top = btnRect.top - 6;
      top = Math.max(MARGIN, Math.min(top, vh - MARGIN - fh));

      setFlyoutPos({ left, top, maxHeight: vh - MARGIN * 2 });
    }

    place();
    const ro = new ResizeObserver(place);
    if (flyoutRef.current) ro.observe(flyoutRef.current);
    window.addEventListener('resize', place);
    return () => { ro.disconnect(); window.removeEventListener('resize', place); };
  }, [isOpen, side]);

  if (action) {
    return (
      <button type="button" className={`sel-ctx-item ${danger ? 'danger' : ''}`} onClick={action}>
        {icon}<span>{label}</span>
      </button>
    );
  }
  return (
    <div className="sel-ctx-item-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`sel-ctx-item ${isOpen ? 'open' : ''}`}
        onClick={() => setOpenItem(isOpen ? null : pid)}
      >
        {icon}<span>{label}</span>
        <ChevronRight size={13} className="sel-ctx-chevron" />
      </button>
      {isOpen && (
        <div
          ref={flyoutRef}
          className="sel-ctx-flyout"
          style={flyoutPos ? { left: flyoutPos.left, top: flyoutPos.top, maxHeight: flyoutPos.maxHeight } : undefined}
          onClick={e => e.stopPropagation()}
        >
          <div className="sel-ctx-flyout-inner">{children}</div>
        </div>
      )}
    </div>
  );
}

export default function SelectionMenu({ selection, process, updateProcess, setSelection, anchorRect }) {
  const [openItem, setOpenItem] = useState(null);
  const rootRef = useRef(null);
  const [side, setSide] = useState('right');
  const [pos, setPos] = useState(() => clampMenuPos(anchorRect));

  // Re-clamp against the menu's actual rendered height (not a guess), and
  // keep re-checking if that height changes (e.g. a taller selection kind),
  // so the whole panel — not just its flyouts — can never sit half off-screen.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    function place() {
      const vw = window.innerWidth, vh = window.innerHeight;
      const base = clampMenuPos(anchorRect);
      const h = el.offsetHeight || 60;
      const top = Math.max(MARGIN, Math.min(base.top, vh - MARGIN - h));
      setPos({ left: base.left, top });
      setSide(base.left + MENU_W + FLYOUT_W + MARGIN <= vw ? 'right' : 'left');
    }
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener('resize', place);
    return () => { ro.disconnect(); window.removeEventListener('resize', place); };
  }, [anchorRect]);

  // switching to a different selected item closes whatever flyout was open
  const prevSelKey = useRef(null);
  useEffect(() => {
    const key = selection ? `${selection.kind}-${selection.id}` : null;
    if (prevSelKey.current !== key) setOpenItem(null);
    prevSelKey.current = key;
  }, [selection?.kind, selection?.id]);

  // click outside the menu (and its flyout) closes it and deselects
  useEffect(() => {
    if (!selection) return;
    function onDocDown(e) {
      // Grabbing an edge's endpoint circle (to drag/reconnect it) must NOT
      // deselect the edge — otherwise the handles vanish mid-drag.
      if (e.target.closest && e.target.closest('.edge-endpoint')) return;
      if (rootRef.current && !rootRef.current.contains(e.target)) setSelection(null);
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [selection, setSelection]);

  if (!selection) return null;

  const title = selection.kind === 'lane'
    ? `Panel: ${process.lanes[selection.id]?.label || ''}`
    : selection.kind === 'edge' ? `Ox #${selection.id + 1}`
    : `Node #${selection.id}`;

  return (
    <div className="sel-ctx-menu" ref={rootRef} style={{ left: pos.left, top: pos.top }}>
      <div className="sel-ctx-header">
        <span>{title}</span>
        <button className="sel-ctx-close" onClick={() => setSelection(null)} title="Bağla">
          <X size={13} />
        </button>
      </div>
      <div className="sel-ctx-list">
        {selection.kind === 'node' && (
          <NodeMenu
            node={process.nodes.find(n => String(n.id) === String(selection.id))}
            process={process} updateProcess={updateProcess}
            openItem={openItem} setOpenItem={setOpenItem} side={side}
            onDelete={() => setSelection(null)}
          />
        )}
        {selection.kind === 'lane' && (
          <LaneMenu
            lane={process.lanes[selection.id]} laneIndex={selection.id}
            process={process} updateProcess={updateProcess}
            openItem={openItem} setOpenItem={setOpenItem} side={side}
            onDelete={() => setSelection(null)}
          />
        )}
        {selection.kind === 'edge' && (
          <EdgeMenu
            index={selection.id} process={process} updateProcess={updateProcess}
            openItem={openItem} setOpenItem={setOpenItem} side={side}
            setSelection={setSelection}
          />
        )}
      </div>
    </div>
  );
}

/* ===================== Panel (lane) ===================== */
function LaneMenu({ lane, laneIndex, process, updateProcess, openItem, setOpenItem, side, onDelete }) {
  const { t } = useLabels();
  if (!lane) return <div className="sel-ctx-empty">Panel tapılmadı.</div>;
  function patch(field, value) {
    updateProcess(p => {
      const newLanes = p.lanes.map((l, i) => i === laneIndex ? { ...l, [field]: value } : l);
      const r = repackLanes(newLanes, p.nodes);
      return { ...p, lanes: r.lanes, nodes: r.nodes };
    }, `lane-${laneIndex}-${field}`);
  }
  const nodeCount = process.nodes.filter(n => n.laneId === lane.id).length;

  return (
    <>
      <MenuItem pid="lane" icon={<LayoutList size={14} />} label="Panel ad/ölçü" openItem={openItem} setOpenItem={setOpenItem} side={side}>
        <div className="field-row col">
          <label>Ad</label>
          <textarea rows={2} value={lane.label} onChange={e => patch('label', e.target.value)} />
        </div>
        <div className="field-row two">
          <div><label>Y (top)</label><input type="number" value={lane.y} onChange={e => patch('y', Number(e.target.value))} /></div>
          <div><label>Min hündürlük</label><input type="number" value={lane.h} onChange={e => patch('h', Number(e.target.value))} /></div>
        </div>
        <div className="hint">Panel daxilində {nodeCount} node var. Hündürlük avtomatik tənzimlənir.</div>
      </MenuItem>
      <MenuItem pid="lane-del" icon={<Trash2 size={14} />} label={t('nodemenu.delete', 'Sil')} danger action={() => {
        if (!confirm('Bu paneli silmək istəyirsiniz?')) return;
        updateProcess(p => {
          const remainingNodes = p.nodes.filter(n => n.laneId !== lane.id);
          const remainingLanes = p.lanes.filter((_, i) => i !== laneIndex);
          const r = repackLanes(remainingLanes, remainingNodes);
          return { ...p, lanes: r.lanes, nodes: r.nodes };
        });
        onDelete();
      }} />
    </>
  );
}

/* ===================== Ox (edge) ===================== */
const SIDE_OPTS = [['top', 'üst'], ['right', 'sağ'], ['bottom', 'alt'], ['left', 'sol']];
// Which ends of an edge carry an arrowhead.
const ARROW_OPTS = [['end', 'Son'], ['start', 'Başlanğıc'], ['both', 'Hər ikisi'], ['none', 'Yoxdur']];
function castId(v) { return /^\d+$/.test(v) ? Number(v) : v; }

function EdgeMenu({ index, process, updateProcess, openItem, setOpenItem, side, setSelection }) {
  const { t } = useLabels();
  const edge = process.edges[index];
  if (!edge) return <div className="sel-ctx-empty">Ox tapılmadı.</div>;

  const fromNode = process.nodes.find(n => String(n.id) === String(edge.from));
  const toNode = process.nodes.find(n => String(n.id) === String(edge.to));

  function patch(fields) {
    updateProcess(p => ({ ...p, edges: p.edges.map((e, i) => i === index ? { ...e, ...fields } : e) }));
  }
  function swap() {
    updateProcess(p => ({
      ...p, edges: p.edges.map((e, i) => i === index
        ? { ...e, from: e.to, to: e.from, s: e.e || 'left', e: e.s || 'right' } : e)
    }));
  }
  function del() {
    if (!confirm('Bu oxu silmək istəyirsiniz?')) return;
    updateProcess(p => ({ ...p, edges: p.edges.filter((_, i) => i !== index) }));
    setSelection(null);
  }

  return (
    <>
      <MenuItem pid="edge-conn" icon={<Waypoints size={14} />} label="Bağlantı" openItem={openItem} setOpenItem={setOpenItem} side={side}>
        <div className="edge-summary">
          <span className="chip">#{edge.from} {fromNode?.text ? '· ' + fromNode.text.slice(0, 18) : ''}</span>
          <ArrowRightLeft size={13} />
          <span className="chip">#{edge.to} {toNode?.text ? '· ' + toNode.text.slice(0, 18) : ''}</span>
        </div>
        <div className="field-row col">
          <label>Ox üstü mətn</label>
          <input value={edge.label || ''} placeholder="məs. Bəli / Xeyr"
            onChange={e => patch({ label: e.target.value })} />
        </div>
        <div className="field-row col">
          <label>Başlanğıc node</label>
          <select value={String(edge.from)} onChange={e => patch({ from: castId(e.target.value) })}>
            {process.nodes.map(n => <option key={n.id} value={String(n.id)}>#{n.id} — {String(n.text || '').slice(0, 28)}</option>)}
          </select>
        </div>
        <div className="field-row col">
          <label>Hədəf node</label>
          <select value={String(edge.to)} onChange={e => patch({ to: castId(e.target.value) })}>
            {process.nodes.map(n => <option key={n.id} value={String(n.id)}>#{n.id} — {String(n.text || '').slice(0, 28)}</option>)}
          </select>
        </div>
        <div className="field-row two">
          <div>
            <label>Başlanğıc tərəf</label>
            <select value={edge.s || 'right'} onChange={e => patch({ s: e.target.value })}>
              {SIDE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label>Hədəf tərəf</label>
            <select value={edge.e || 'left'} onChange={e => patch({ e: e.target.value })}>
              {SIDE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          Canvas-da oxun uc dairələrini sürükləyərək başqa node-a birləşdirə bilərsiniz.
        </div>
        <button className="btn" style={{ marginTop: 8 }} onClick={swap}>
          <ArrowRightLeft size={14} /> İstiqaməti dəyiş
        </button>
      </MenuItem>
      <MenuItem pid="edge-look" icon={<Palette size={14} />} label="Görünüş" openItem={openItem} setOpenItem={setOpenItem} side={side}>
        <div className="field-row col">
          <label>Ox ucları</label>
          <div className="seg-toggle">
            {ARROW_OPTS.map(([v, l]) => (
              <button key={v} type="button" className={(edge.arrow || 'end') === v ? 'on' : ''}
                onClick={() => patch({ arrow: v })}>{l}</button>
            ))}
          </div>
        </div>
        <div className="field-row col" style={{ marginTop: 10 }}>
          <label>Ox üstü mətn</label>
          <input value={edge.label || ''} placeholder="məs. Bəli / Xeyr"
            onChange={e => patch({ label: e.target.value })} />
        </div>
        <div className="hint" style={{ margin: '6px 0 10px' }}>
          Canvas-da oxa iki dəfə klikləyərək mətni birbaşa yaza bilərsiniz.
        </div>
        <label className="check" style={{ marginBottom: 10 }}>
          <input type="checkbox" checked={!!edge.dashed} onChange={e => patch({ dashed: e.target.checked })} />
          <span>Kəsik xətt</span>
        </label>
        <ColorField label="Ox rəngi" value={edge.color || ''}
          onChange={v => patch({ color: v })} onClear={() => patch({ color: '' })} />
      </MenuItem>
      <MenuItem pid="edge-del" icon={<Trash2 size={14} />} label={t('nodemenu.delete', 'Sil')} danger action={del} />
    </>
  );
}

/* ===================== Node ===================== */
function NodeMenu({ node, process, updateProcess, openItem, setOpenItem, side, onDelete }) {
  const { t } = useLabels();
  const [showPreview, setShowPreview] = useState(false);
  if (!node) return <div className="sel-ctx-empty">Node tapılmadı.</div>;
  const { shape, style } = nodeView(node);

  function patch(field, value) {
    updateProcess(p => {
      const newNodes = p.nodes.map(n => String(n.id) === String(node.id) ? { ...n, [field]: value } : n);
      const r = repackLanes(p.lanes, newNodes);
      return { ...p, nodes: r.nodes, lanes: r.lanes };
    }, `node-${node.id}-${field}`);
  }
  function setShapeStyle(nextShape, nextStyle) {
    updateProcess(p => {
      const newNodes = p.nodes.map(n => {
        if (String(n.id) !== String(node.id)) return n;
        // Re-fit height to the new shape so the lane/columns don't jump.
        const next = { ...n, type: nextShape, style: nextStyle, dash: undefined };
        const def = nodeDefaults(nextShape);
        next.h = Math.max(def.h, autoNodeHeight(next, next.text));
        return next;
      });
      const r = repackLanes(p.lanes, newNodes);
      return { ...p, nodes: r.nodes, lanes: r.lanes };
    }, `node-${node.id}-shapestyle`);
  }
  function patchInfo(field, value) { patch('info', { ...(node.info || {}), [field]: value }); }

  /** Text edits keep the width fixed and grow the height to fit. */
  function patchText(value) {
    updateProcess(p => {
      const newNodes = p.nodes.map(n => String(n.id) === String(node.id)
        ? { ...n, text: value, h: autoNodeHeight(n, value) } : n);
      const r = repackLanes(p.lanes, newNodes);
      return { ...p, nodes: r.nodes, lanes: r.lanes };
    }, `node-${node.id}-text`);
  }

  /** Uniform sizing: apply this node's width to every node of the same
   * shape; each one's height re-fits its own text. */
  function applyWidthToAll() {
    updateProcess(p => {
      const newNodes = p.nodes.map(n => {
        if (nodeView(n).shape !== shape) return n;
        const resized = { ...n, w: node.w };
        resized.h = Math.max(n.h || 0, autoNodeHeight(resized, resized.text));
        return resized;
      });
      const r = repackLanes(p.lanes, newNodes);
      return { ...p, nodes: r.nodes, lanes: r.lanes };
    });
  }

  function changeId(newId) {
    if (newId === String(node.id)) return;
    if (process.nodes.some(n => String(n.id) === newId)) { alert('Bu ID artıq istifadə olunur.'); return; }
    const parsed = /^\d+$/.test(newId) ? Number(newId) : newId;
    updateProcess(p => ({
      ...p,
      nodes: p.nodes.map(n => String(n.id) === String(node.id) ? { ...n, id: parsed } : n),
      edges: p.edges.map(e => ({
        ...e,
        from: String(e.from) === String(node.id) ? parsed : e.from,
        to: String(e.to) === String(node.id) ? parsed : e.to
      }))
    }));
  }
  function deleteNode() {
    if (!confirm('Bu node-u silmək istəyirsiniz?')) return;
    updateProcess(p => {
      const newNodes = p.nodes.filter(n => String(n.id) !== String(node.id));
      const newEdges = p.edges.filter(e => String(e.from) !== String(node.id) && String(e.to) !== String(node.id));
      const r = repackLanes(p.lanes, newNodes);
      return { ...p, nodes: r.nodes, edges: newEdges, lanes: r.lanes };
    });
    onDelete();
  }

  const info = node.info || {};
  const sections = info.sections || [];
  function setSections(next) { patchInfo('sections', next); }
  function addSection() { setSections([...sections, makeSection()]); }
  function patchSection(i, fields) { setSections(sections.map((s, idx) => idx === i ? { ...s, ...fields } : s)); }
  function removeSection(i) { setSections(sections.filter((_, idx) => idx !== i)); }
  function moveSection(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    setSections(next);
  }

  return (
    <>
      <MenuItem pid="shape" icon={<Square size={14} />} label={t('nodemenu.shape_tab', 'Forma/Stil')} openItem={openItem} setOpenItem={setOpenItem} side={side}>
        <h4 className="editor-title">
          <Icon name={node.icon || 'Square'} size={15} /> Node #{node.id}
          <span className={`type-badge ${shape} s-${style}`}>{t(`shape.${shape}`, SHAPE_LABEL[shape])} · {t(`style.${style}`, STYLE_LABEL[style])}</span>
        </h4>
        <div className="field-row two">
          <div><label>ID</label><input defaultValue={node.id} onBlur={e => changeId(e.target.value)} /></div>
          <div>
            <label>Forma</label>
            <select value={shape} onChange={e => setShapeStyle(e.target.value, style)}>
              {SHAPES.map(s => <option key={s} value={s}>{t(`shape.${s}`, SHAPE_LABEL[s])}</option>)}
            </select>
          </div>
        </div>
        <div className="field-row col">
          <label>Sərhəd stili</label>
          <div className="seg-toggle">
            {STYLES.map(s => (
              <button key={s} type="button" className={style === s ? 'on' : ''} onClick={() => setShapeStyle(shape, s)}>
                {t(`style.${s}`, STYLE_LABEL[s])}
              </button>
            ))}
          </div>
        </div>
      </MenuItem>

      <MenuItem pid="size" icon={<Maximize2 size={14} />} label={t('nodemenu.size_tab', 'Ölçü/Panel')} openItem={openItem} setOpenItem={setOpenItem} side={side}>
        <div className="field-row four">
          <div><label>X</label><input type="number" value={node.x} onChange={e => patch('x', Number(e.target.value))} /></div>
          <div><label>Y</label><input type="number" value={node.y} onChange={e => patch('y', Number(e.target.value))} /></div>
          <div><label>En</label><input type="number" value={node.w} onChange={e => patch('w', Number(e.target.value))} /></div>
          <div><label>Hün.</label><input type="number" value={node.h} onChange={e => patch('h', Number(e.target.value))} /></div>
        </div>
        <div className="hint" style={{ margin: '8px 0' }}>
          Canvas-da node-un künclərindəki tutacaqları sürükləyərək ölçünü birbaşa dəyişə bilərsiniz.
        </div>
        <button className="btn" style={{ marginBottom: 10 }} onClick={applyWidthToAll}>
          <Maximize2 size={14} /> <span>Bu eni bütün "{t(`shape.${shape}`, SHAPE_LABEL[shape])}" node-lara tətbiq et</span>
        </button>
        <div className="field-row col">
          <label>Panel</label>
          <select value={node.laneId || ''} onChange={e => patch('laneId', e.target.value)}>
            <option value="">— Seç —</option>
            {process.lanes.map(lane => <option key={lane.id} value={lane.id}>{lane.label}</option>)}
          </select>
        </div>
      </MenuItem>

      <MenuItem pid="color" icon={<Palette size={14} />} label={t('nodemenu.color_tab', 'Rəng')} openItem={openItem} setOpenItem={setOpenItem} side={side}>
        <ColorField label="Node rəngi (fərdi)" value={node.color || ''}
          onChange={v => patch('color', v)} onClear={() => patch('color', '')} />
        <div className="hint" style={{ marginTop: 8 }}>Bu rəng yalnız bu node-a tətbiq olunur.</div>
      </MenuItem>

      <MenuItem pid="text" icon={<Type size={14} />} label={t('nodemenu.text_tab', 'Mətn')} openItem={openItem} setOpenItem={setOpenItem} side={side}>
        <div className="field-row col">
          <label>Mətn</label>
          <textarea rows={3} value={node.text} onChange={e => patchText(e.target.value)} />
        </div>
        <div className="hint">En sabit qalır, hündürlük mətnə görə avtomatik artır. Canvas-da mətnə iki dəfə klikləyərək birbaşa da redaktə edə bilərsiniz.</div>
      </MenuItem>

      <MenuItem pid="popup" icon={<PopupIcon size={14} />} label={t('nodemenu.popup_tab', 'Popup')} openItem={openItem} setOpenItem={setOpenItem} side={side}>
        {/* General — no longer a mandatory/fixed block: it has a colour and can
            be emptied like any other section. */}
        <div className="sec-editor">
          <div className="sec-editor-head">
            <IconPicker value={info.generalIcon || 'FileText'} color={info.generalColor} onChange={v => patchInfo('generalIcon', v)} />
            <input className="sec-title" value={info.generalTitle || 'Ümumi məlumat'}
              onChange={e => patchInfo('generalTitle', e.target.value)} placeholder="Bölmə adı" />
            <div className="sec-actions">
              <button className="icon-btn ghost danger" title="Boşalt"
                onClick={() => patchInfo('general', [])}><Trash2 size={13} /></button>
            </div>
          </div>
          <div className="sec-editor-row">
            <ColorField label="" value={info.generalColor || ''}
              onChange={v => patchInfo('generalColor', v)} onClear={() => patchInfo('generalColor', '')} />
          </div>
          <textarea rows={4} placeholder="Hər abzas boş sətirlə ayrılır"
            value={(info.general || []).join('\n\n')}
            onChange={e => patchInfo('general', e.target.value.split('\n\n').filter(Boolean))} />
        </div>

        {/* Custom sections */}
        {sections.map((s, i) => (
          <div className="sec-editor" key={s.id || i}>
            <div className="sec-editor-head">
              <IconPicker value={s.icon} color={s.color} onChange={v => patchSection(i, { icon: v })} />
              <input className="sec-title" value={s.title}
                onChange={e => patchSection(i, { title: e.target.value })} placeholder="Bölmə adı" />
              <div className="sec-actions">
                <button className="icon-btn ghost" title="Yuxarı" onClick={() => moveSection(i, -1)}><ArrowUp size={13} /></button>
                <button className="icon-btn ghost" title="Aşağı" onClick={() => moveSection(i, 1)}><ArrowDown size={13} /></button>
                <button className="icon-btn ghost danger" title="Sil" onClick={() => removeSection(i)}><Trash2 size={13} /></button>
              </div>
            </div>
            <div className="sec-editor-row">
              <div className="seg-toggle sm">
                <button type="button" className={s.type !== 'list' ? 'on' : ''} onClick={() => patchSection(i, { type: 'text' })}>
                  <Type size={12} /> Mətn
                </button>
                <button type="button" className={s.type === 'list' ? 'on' : ''} onClick={() => patchSection(i, { type: 'list' })}>
                  <ListOrdered size={12} /> Siyahı
                </button>
              </div>
              <ColorField label="" value={s.color || ''}
                onChange={v => patchSection(i, { color: v })} onClear={() => patchSection(i, { color: '' })} />
            </div>
            <textarea rows={3}
              placeholder={s.type === 'list' ? 'Hər sətir ayrı bənd' : 'Hər abzas boş sətirlə ayrılır'}
              value={(s.items || []).join(s.type === 'list' ? '\n' : '\n\n')}
              onChange={e => patchSection(i, {
                items: e.target.value.split(s.type === 'list' ? '\n' : '\n\n').filter(Boolean)
              })} />
          </div>
        ))}

        {/* Risks — also optional now; leave empty to hide it entirely. */}
        <div className="sec-editor">
          <div className="sec-editor-head">
            <IconPicker value={info.risksIcon || 'AlertTriangle'} color={info.risksColor} onChange={v => patchInfo('risksIcon', v)} />
            <input className="sec-title" value={info.risksTitle || 'Mümkün risklər'}
              onChange={e => patchInfo('risksTitle', e.target.value)} placeholder="Bölmə adı (məcburi deyil)" />
            <div className="sec-actions">
              <button className="icon-btn ghost danger" title="Boşalt"
                onClick={() => patchInfo('risks', [])}><Trash2 size={13} /></button>
            </div>
          </div>
          <div className="sec-editor-row">
            <ColorField label="" value={info.risksColor || ''}
              onChange={v => patchInfo('risksColor', v)} onClear={() => patchInfo('risksColor', '')} />
          </div>
          <textarea rows={3} placeholder="Hər sətir ayrı risk (boş buraxsanız görünməyəcək)"
            value={(info.risks || []).join('\n')}
            onChange={e => patchInfo('risks', e.target.value.split('\n').filter(Boolean))} />
        </div>

        <button className="btn" onClick={addSection}><Plus size={14} /> Yeni bölmə əlavə et</button>
        <button className="btn preview-btn" style={{ marginTop: 8 }} onClick={() => setShowPreview(v => !v)}>
          <Eye size={14} /><span>{showPreview ? 'Önizləməni bağla' : 'Popup önizləməsi'}</span>
        </button>
        {showPreview && <PopupPreview node={node} />}
      </MenuItem>

      <MenuItem pid="node-del" icon={<Trash2 size={14} />} label={t('nodemenu.delete', 'Sil')} danger action={deleteNode} />
    </>
  );
}

/* live popup preview inside the editor */
function PopupPreview({ node }) {
  const info = node.info || {};
  const general = (info.general || []).filter(Boolean);
  const risks = (info.risks || []).filter(Boolean);
  const sections = (info.sections || []);
  return (
    <div className="popup-preview-card">
      <div className="popup-preview-title">
        <Icon name={node.icon || 'Square'} size={15} style={node.color ? { color: node.color } : undefined} /> {node.text}
      </div>
      {general.length > 0 && (
        <>
          <div className="popup-preview-heading" style={info.generalColor ? { color: info.generalColor } : undefined}><Icon name={info.generalIcon || 'FileText'} size={13} /> {info.generalTitle || 'Ümumi məlumat'}</div>
          {general.map((p, i) => <p key={i} className="popup-preview-p">{p}</p>)}
        </>
      )}
      {sections.map((s, i) => {
        const items = (s.items || []).filter(Boolean);
        if (!items.length) return null;
        return (
          <div key={s.id || i}>
            <div className="popup-preview-heading" style={s.color ? { color: s.color } : undefined}>
              <Icon name={s.icon} size={13} /> {s.title}
            </div>
            {s.type === 'list'
              ? <ul className="popup-preview-list">{items.map((r, j) => <li key={j}>{r}</li>)}</ul>
              : items.map((p, j) => <p key={j} className="popup-preview-p">{p}</p>)}
          </div>
        );
      })}
      {risks.length > 0 && (
        <div className="popup-preview-risk-box">
          <div className="popup-preview-heading preview-risks" style={info.risksColor ? { color: info.risksColor } : undefined}><Icon name={info.risksIcon || 'AlertTriangle'} size={13} /> {info.risksTitle || 'Mümkün risklər'}</div>
          <ul className="popup-preview-list">{risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      )}
    </div>
  );
}