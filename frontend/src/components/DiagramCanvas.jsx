// DiagramCanvas.jsx
import { useRef, useState, useMemo, useEffect } from 'react';
import { nodeView, SVG_SHAPES } from './nodeStyle.js';
import { deriveAccentVars } from './colorUtils.js';
import { shapeImage } from './shapeImages.js';
import { useLabels } from '../labels/LabelsContext.jsx';
import { rerouteStale } from './ai/aiRoute.js';

const SNAP_SIZE = 10;
const RAIL_W = 56;
const PAD_RIGHT = 80;
const PAD_BOTTOM = 40;
const MIN_W = 700;
const MIN_H = 300;
const CORNER_R = 10;
const DRAG_THRESHOLD = 3;
const MIN_NODE_W = 70;
const MIN_NODE_H = 40;
const ALIGN_TOL = 6; // px — magnetic alignment threshold while dragging

const SIDES = ['top', 'right', 'bottom', 'left'];
const CORNERS = ['nw', 'ne', 'sw', 'se'];

export default function DiagramCanvas({
  process,
  selectedNodeId,
  selectedEdgeId,          // index of the selected edge
  modalNodeId,
  editMode,
  onNodeClick,
  onLaneClick,
  onEdgeClick,
  onNodeMove,
  onNodeMoveEnd,
  onCreateEdge,
  onNodeTextChange,        // (nodeId, text) => void — inline double-click edit
  onEdgeLabelChange,       // (edgeIndex, text) => void — inline edge label edit
  onNodeResize,            // (nodeId, x, y, w, h) => void — live, while dragging a handle
  onNodeResizeEnd,         // (nodeId) => void — commits history once
  onEdgeReconnect,         // (edgeIndex, end('from'|'to'), targetNodeId, targetSide) => void
  onBackgroundClick,       // () => void — click on empty canvas area (deselect)
  onSelectedRectChange,    // (rect) => void — the selected node's screen rect moved (drag/resize)
  onNodeInteractionStart,  // () => void — user just started actually moving/resizing/editing a node
  onNodeInteractionEnd,    // () => void — that interaction just finished
  onCanvasDropShape,       // (shape, style, canvasX, canvasY) => void — a shape dragged from the sidebar was dropped
  selectedNodeIds = [],    // string[] — multi-selected node ids
  onMarqueeSelect,         // (ids) => void — rubber-band selection result
  onClearMultiSelect,      // () => void
  patchSelectedNodes,      // (patch) => void — apply to all selected
  deleteSelectedNodes,     // () => void
  presentActiveId = null,  // id of the node currently spotlighted in presentation (animates its incoming arrow)
  zoom = 1,                // canvas zoom — scales ONLY the diagram
  extraW = 0,              // room added when the user scrolls to the right edge
  extraH = 0               // …and to the bottom edge
}) {
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom || 1;
  const { t } = useLabels();
  const canvasRef = useRef(null);
  const railLayerRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [resize, setResize] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState('');
  const [editingEdge, setEditingEdge] = useState(null); // { index, x, y, text } inline edge-label editor
  const [hoverNodeId, setHoverNodeId] = useState(null);
  const [link, setLink] = useState(null);
  const [guides, setGuides] = useState(null); // { v: x|null, h: y|null } alignment guide lines
  const [dropPreview, setDropPreview] = useState(null); // { shape, x, y } while dragging a shape from the sidebar
  const [marquee, setMarquee] = useState(null); // { x0,y0,x1,y1 } rubber-band box in canvas coords
  const [multiMenu, setMultiMenu] = useState(null); // { x, y } screen pos of multi-node context menu
  const didLinkRef = useRef(false);
  const didMarqueeRef = useRef(false);
  // Auto-scroll while dragging/resizing a node past the visible edge of the
  // canvas (fix 16) — without this the mouse simply runs out of screen to
  // move into, capping how far a node can grow or move.
  const edgeScrollRafRef = useRef(null);
  const edgeScrollVelRef = useRef(null);
  const multiSel = useMemo(() => new Set((selectedNodeIds || []).map(String)), [selectedNodeIds]);

  // Presentation: nodes that feed the current node via an incoming arrow —
  // kept partly visible so the viewer can see where the active arrow starts.
  const presentSourceIds = useMemo(() => {
    if (presentActiveId == null) return new Set();
    return new Set(
      process.edges
        .filter(e => String(e.to) === String(presentActiveId))
        .map(e => String(e.from))
    );
  }, [presentActiveId, process.edges]);

  const { canvasW, canvasH } = useMemo(() => {
    const contentRight = process.nodes.length
      ? Math.max(...process.nodes.map(n => (n.x || 0) + (n.w || 0)))
      : RAIL_W + 200;
    const contentBottom = process.lanes.length
      ? Math.max(...process.lanes.map(l => (l.y || 0) + (l.h || 0)))
      : 200;
    return {
      canvasW: Math.max(MIN_W, contentRight + PAD_RIGHT) + (extraW || 0),
      canvasH: Math.max(MIN_H, contentBottom + PAD_BOTTOM) + (extraH || 0)
    };
  }, [process.nodes, process.lanes, extraW, extraH]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const scroller = canvas?.parentElement;
    if (!canvas || !scroller) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      const layer = railLayerRef.current;
      if (layer) layer.style.transform = `translateX(${scroller.scrollLeft / zoomRef.current}px)`;
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(apply); };
    apply();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [canvasW, canvasH, zoom]);

  // Screen point → diagram point. With CSS zoom the canvas is drawn bigger /
  // smaller on screen, so divide the screen offset by the zoom.
  function toCanvasPoint(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    const z = zoomRef.current;
    return { x: (e.clientX - rect.left) / z, y: (e.clientY - rect.top) / z };
  }

  // While actively dragging or resizing, keep scrolling the canvas if the
  // cursor sits near the edge of the visible viewport — otherwise a node
  // near the right/bottom edge can't grow or move any further once the
  // mouse hits the edge of the screen (fix 16).
  const EDGE_ZONE = 36, EDGE_MAX_SPEED = 18;
  function updateEdgeAutoScroll(e) {
    const scroller = canvasRef.current?.parentElement;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    let vx = 0, vy = 0;
    if (e.clientX > rect.right - EDGE_ZONE) vx = EDGE_MAX_SPEED * Math.min(1, (e.clientX - (rect.right - EDGE_ZONE)) / EDGE_ZONE);
    else if (e.clientX < rect.left + EDGE_ZONE) vx = -EDGE_MAX_SPEED * Math.min(1, ((rect.left + EDGE_ZONE) - e.clientX) / EDGE_ZONE);
    if (e.clientY > rect.bottom - EDGE_ZONE) vy = EDGE_MAX_SPEED * Math.min(1, (e.clientY - (rect.bottom - EDGE_ZONE)) / EDGE_ZONE);
    else if (e.clientY < rect.top + EDGE_ZONE) vy = -EDGE_MAX_SPEED * Math.min(1, ((rect.top + EDGE_ZONE) - e.clientY) / EDGE_ZONE);

    if (vx === 0 && vy === 0) { stopEdgeAutoScroll(); return; }
    edgeScrollVelRef.current = { vx, vy };
    if (!edgeScrollRafRef.current) {
      const step = () => {
        const vel = edgeScrollVelRef.current;
        if (!vel) { edgeScrollRafRef.current = null; return; }
        scroller.scrollLeft += vel.vx;
        scroller.scrollTop += vel.vy;
        edgeScrollRafRef.current = requestAnimationFrame(step);
      };
      edgeScrollRafRef.current = requestAnimationFrame(step);
    }
  }
  function stopEdgeAutoScroll() {
    edgeScrollVelRef.current = null;
    if (edgeScrollRafRef.current) { cancelAnimationFrame(edgeScrollRafRef.current); edgeScrollRafRef.current = null; }
  }

  /* ---- sidebar shape drag-and-drop onto the canvas ---- */
  function shapeFromEvent(e) {
    const raw = e.dataTransfer.getData('application/x-map-shape');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  function onCanvasDragOver(e) {
    if (!editMode || !onCanvasDropShape) return;
    const types = Array.from(e.dataTransfer.types || []);
    if (!types.includes('application/x-map-shape')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    // The shape name is encoded in a per-shape type ("application/x-map-shape-<shape>")
    // because getData() is blocked during dragover but the type list is readable.
    const shapeType = types.find(t => t.startsWith('application/x-map-shape-'));
    const shape = shapeType
      ? shapeType.slice('application/x-map-shape-'.length)
      : (dropPreview?.shape || 'rect');
    const pt = toCanvasPoint(e);
    setDropPreview({ shape, x: pt.x, y: pt.y });
  }
  function onCanvasDrop(e) {
    if (!editMode || !onCanvasDropShape) return;
    const payload = shapeFromEvent(e);
    setDropPreview(null);
    if (!payload) return;
    e.preventDefault();
    const pt = toCanvasPoint(e);
    onCanvasDropShape(payload.shape, payload.style, pt.x, pt.y);
  }
  function onCanvasDragLeave(e) {
    // only clear if we actually left the canvas (not entering a child)
    if (e.currentTarget === e.target) setDropPreview(null);
  }

  /** While dragging/resizing the currently-selected node, keep its context
   * menu anchored to the node's live on-screen position instead of the
   * stale point where the click first happened. */
  function reportSelectedRect(nodeId, x, y, w, h) {
    if (!onSelectedRectChange || String(nodeId) !== String(selectedNodeId)) return;
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const z = zoomRef.current;
    onSelectedRectChange({
      left: canvasRect.left + x * z, top: canvasRect.top + y * z,
      right: canvasRect.left + (x + w) * z, bottom: canvasRect.top + (y + h) * z,
      width: w * z, height: h * z
    });
  }

  function onMouseDownNode(e, node) {
    if (!editMode) return;
    // Additive modifier click is handled in onClick (toggle) — don't start a drag.
    if (e.shiftKey || e.metaKey || e.ctrlKey) { e.stopPropagation(); return; }
    e.preventDefault();
    e.stopPropagation();
    // If this node is part of a multi-selection, remember every selected node's
    // origin so we can move them together.
    let group = null;
    if (multiSel.size > 1 && multiSel.has(String(node.id))) {
      group = process.nodes
        .filter(n => multiSel.has(String(n.id)))
        .map(n => ({ id: n.id, origX: n.x, origY: n.y }));
    }
    setDrag({
      nodeId: node.id, startX: toCanvasPoint(e).x, startY: toCanvasPoint(e).y,
      origX: node.x, origY: node.y, moved: false, group
    });
  }

  function onHandleMouseDown(e, node, side) {
    if (!editMode) return;
    e.preventDefault();
    e.stopPropagation();
    const from = anchor(node, side);
    setLink({ fromId: node.id, fromSide: side, from, cur: from, overId: null });
    if (onNodeInteractionStart) onNodeInteractionStart();
  }

  function onResizeMouseDown(e, node, corner) {
    if (!editMode) return;
    e.preventDefault();
    e.stopPropagation();
    setResize({
      nodeId: node.id, corner, startX: toCanvasPoint(e).x, startY: toCanvasPoint(e).y,
      origX: node.x, origY: node.y, origW: node.w, origH: node.h
    });
    if (onNodeInteractionStart) onNodeInteractionStart();
  }

  function startEditText(e, node) {
    if (!editMode) return;
    e.preventDefault();
    e.stopPropagation();
    setEditingId(node.id);
    setEditingText(node.text || '');
    if (onNodeInteractionStart) onNodeInteractionStart();
  }

  function commitEditText(nodeId) {
    if (onNodeTextChange) onNodeTextChange(nodeId, editingText);
    setEditingId(null);
    if (onNodeInteractionEnd) onNodeInteractionEnd();
  }

  function startEdgeLabel(index, mid, curText) {
    if (!editMode) return;
    setEditingEdge({ index, x: mid.x, y: mid.y, text: curText || '' });
    if (onNodeInteractionStart) onNodeInteractionStart();
  }
  function commitEdgeLabel() {
    if (editingEdge && onEdgeLabelChange) onEdgeLabelChange(editingEdge.index, editingEdge.text);
    setEditingEdge(null);
    if (onNodeInteractionEnd) onNodeInteractionEnd();
  }
  function cancelEdgeLabel() {
    setEditingEdge(null);
    if (onNodeInteractionEnd) onNodeInteractionEnd();
  }

  function onEdgeHandleMouseDown(e, edgeIndex, end, fromPoint) {
    if (!editMode) return;
    e.preventDefault();
    e.stopPropagation();
    setLink({ reconnect: { edgeIndex, end }, from: fromPoint, cur: fromPoint, overId: null });
    // Hide the context-menu popup while the endpoint is being dragged so it
    // never sits on top of the arrow end you're moving.
    if (onNodeInteractionStart) onNodeInteractionStart();
  }

  function onMouseMove(e) {
    if (marquee) {
      const pt = toCanvasPoint(e);
      setMarquee(prev => prev ? { ...prev, x1: pt.x, y1: pt.y } : prev);
      return;
    }
    if (link) {
      setLink(prev => prev ? { ...prev, cur: toCanvasPoint(e) } : prev);
      return;
    }
    if (resize) {
      const pt = toCanvasPoint(e);
      const dx = pt.x - resize.startX;
      const dy = pt.y - resize.startY;
      let x = resize.origX, y = resize.origY, w = resize.origW, h = resize.origH;
      if (resize.corner.includes('e')) w = resize.origW + dx;
      if (resize.corner.includes('w')) { w = resize.origW - dx; x = resize.origX + dx; }
      if (resize.corner.includes('s')) h = resize.origH + dy;
      if (resize.corner.includes('n')) { h = resize.origH - dy; y = resize.origY + dy; }
      if (w < MIN_NODE_W) { if (resize.corner.includes('w')) x -= (MIN_NODE_W - w); w = MIN_NODE_W; }
      if (h < MIN_NODE_H) { if (resize.corner.includes('n')) y -= (MIN_NODE_H - h); h = MIN_NODE_H; }
      x = Math.round(Math.max(RAIL_W + 4, x) / SNAP_SIZE) * SNAP_SIZE;
      y = Math.round(Math.max(4, y) / SNAP_SIZE) * SNAP_SIZE;
      w = Math.round(w / SNAP_SIZE) * SNAP_SIZE;
      h = Math.round(h / SNAP_SIZE) * SNAP_SIZE;
      const fw = Math.max(MIN_NODE_W, w), fh = Math.max(MIN_NODE_H, h);
      if (onNodeResize) onNodeResize(resize.nodeId, x, y, fw, fh);
      reportSelectedRect(resize.nodeId, x, y, fw, fh);
      updateEdgeAutoScroll(e);
      return;
    }
    if (!drag) return;
    const dragPt = toCanvasPoint(e);
    const dx = dragPt.x - drag.startX;
    const dy = dragPt.y - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

    const draggedNode = process.nodes.find(n => n.id === drag.nodeId);
    const nw = draggedNode?.w || 0;
    const nh = draggedNode?.h || 0;

    // raw (un-snapped) position
    let rawX = Math.max(RAIL_W + 4, drag.origX + dx);
    let rawY = Math.max(4, drag.origY + dy);

    // Magnetic alignment against the other nodes: left / center / right (X)
    // and top / middle / bottom (Y). If a candidate is within ALIGN_TOL px
    // it wins over the plain grid snap, so stacked shapes line up evenly.
    let alignX = null, guideV = null;
    let alignY = null, guideH = null;
    let bestDX = ALIGN_TOL, bestDY = ALIGN_TOL;
    for (const o of process.nodes) {
      if (String(o.id) === String(drag.nodeId)) continue;
      const xCands = [
        [o.x, o.x],                                       // left ↔ left
        [o.x + o.w / 2 - nw / 2, o.x + o.w / 2],          // center ↔ center
        [o.x + o.w - nw, o.x + o.w]                       // right ↔ right
      ];
      for (const [cand, line] of xCands) {
        const d = Math.abs(cand - rawX);
        if (d < bestDX) { bestDX = d; alignX = cand; guideV = line; }
      }
      const yCands = [
        [o.y, o.y],
        [o.y + o.h / 2 - nh / 2, o.y + o.h / 2],
        [o.y + o.h - nh, o.y + o.h]
      ];
      for (const [cand, line] of yCands) {
        const d = Math.abs(cand - rawY);
        if (d < bestDY) { bestDY = d; alignY = cand; guideH = line; }
      }
    }

    // For a group move we translate every selected node by the same delta and
    // skip magnetic single-node snapping (it would fight the group).
    if (drag.group && drag.group.length > 1) {
      let ddx = rawX - drag.origX;
      let ddy = rawY - drag.origY;
      ddx = Math.round(ddx / SNAP_SIZE) * SNAP_SIZE;
      ddy = Math.round(ddy / SNAP_SIZE) * SNAP_SIZE;
      setGuides(null);
      if (!drag.moved) setDrag(prev => ({ ...prev, moved: true }));
      if (!drag.moved && onNodeInteractionStart) onNodeInteractionStart();
      for (const g of drag.group) {
        const gx = Math.max(RAIL_W + 4, g.origX + ddx);
        const gy = Math.max(4, g.origY + ddy);
        onNodeMove(g.id, gx, gy);
      }
      updateEdgeAutoScroll(e);
      return;
    }

    let nx = alignX != null ? alignX : Math.round(rawX / SNAP_SIZE) * SNAP_SIZE;
    let ny = alignY != null ? alignY : Math.round(rawY / SNAP_SIZE) * SNAP_SIZE;
    nx = Math.max(RAIL_W + 4, nx);
    ny = Math.max(4, ny);
    setGuides((guideV != null || guideH != null) ? { v: guideV, h: guideH } : null);

    if (!drag.moved) setDrag(prev => ({ ...prev, moved: true }));
    if (!drag.moved && onNodeInteractionStart) onNodeInteractionStart();
    onNodeMove(drag.nodeId, nx, ny);
    reportSelectedRect(drag.nodeId, nx, ny, nw, nh);
    updateEdgeAutoScroll(e);
  }

  function finishLink(targetNode) {
    if (!link) return;
    if (link.reconnect) {
      if (targetNode && onEdgeReconnect) {
        const edge = process.edges[link.reconnect.edgeIndex];
        const draggingFrom = link.reconnect.end === 'from';
        const fixedId = edge && (draggingFrom ? edge.to : edge.from);
        const fixedNode = process.nodes.find(n => String(n.id) === String(fixedId));
        const fixedSide = edge && (draggingFrom ? (edge.e || 'left') : (edge.s || 'right'));
        const fromPt = fixedNode ? anchor(fixedNode, fixedSide) : null;
        const toSide = nearestSide(targetNode, link.cur, fromPt);
        onEdgeReconnect(link.reconnect.edgeIndex, link.reconnect.end, targetNode.id, toSide);
      }
      setLink(null);
      if (onNodeInteractionEnd) onNodeInteractionEnd();
      return;
    }
    if (targetNode && String(targetNode.id) !== String(link.fromId) && onCreateEdge) {
      const toSide = nearestSide(targetNode, link.cur, link.from);
      onCreateEdge(link.fromId, link.fromSide, targetNode.id, toSide);
      didLinkRef.current = true;
      setTimeout(() => { didLinkRef.current = false; }, 0);
    }
    setLink(null);
    if (onNodeInteractionEnd) onNodeInteractionEnd();
  }

  function endDrag() {
    stopEdgeAutoScroll();
    setGuides(null);
    // Finish a rubber-band selection.
    if (marquee) {
      const box = normRect(marquee);
      const moved = Math.abs(marquee.x1 - marquee.x0) > 3 || Math.abs(marquee.y1 - marquee.y0) > 3;
      if (moved && onMarqueeSelect) {
        const ids = process.nodes
          .filter(n => rectsOverlap(box, { x: n.x, y: n.y, w: n.w, h: n.h }))
          .map(n => n.id);
        onMarqueeSelect(ids);
        didMarqueeRef.current = true;
        setTimeout(() => { didMarqueeRef.current = false; }, 0);
      } else if (onClearMultiSelect) {
        onClearMultiSelect();
      }
      setMarquee(null);
      return;
    }
    if (link) { setLink(null); if (onNodeInteractionEnd) onNodeInteractionEnd(); return; }
    if (resize) {
      if (onNodeResizeEnd) onNodeResizeEnd(resize.nodeId);
      setResize(null);
      if (onNodeInteractionEnd) onNodeInteractionEnd();
      return;
    }
    if (!drag) return;
    if (drag.moved) {
      // Group move: commit once (single history entry + one repack).
      if (drag.group && drag.group.length > 1) {
        if (onNodeMoveEnd) onNodeMoveEnd(drag.group.map(g => g.id));
      } else if (onNodeMoveEnd) {
        onNodeMoveEnd(drag.nodeId);
      }
      if (onNodeInteractionEnd) onNodeInteractionEnd();
    }
    setDrag(null);
  }

  const modalOpen = modalNodeId !== null && modalNodeId !== undefined;

  return (
    <div
      ref={canvasRef}
      className={`diagram-canvas ${link ? 'linking' : ''} ${dropPreview ? 'drop-active' : ''}`}
      style={{ width: canvasW, height: canvasH, ...(zoom !== 1 ? { zoom } : {}) }}
      data-zoom={zoom}
      onMouseDown={(e) => {
        // Start a rubber-band selection when pressing on empty canvas in edit
        // mode (not on a node/handle, which stopPropagation on their own).
        if (!editMode) return;
        if (e.button !== 0) return;
        if (e.target !== e.currentTarget && !e.target.classList?.contains('lane-row')) return;
        const pt = toCanvasPoint(e);
        setMarquee({ x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y });
      }}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      onDragOver={onCanvasDragOver}
      onDrop={onCanvasDrop}
      onDragLeave={onCanvasDragLeave}
      onClick={() => { if (!drag?.moved && !marquee && !didMarqueeRef.current && !didLinkRef.current && onBackgroundClick) onBackgroundClick(); }}
    >
      <div className="rail-layer" ref={railLayerRef}>
        {process.lanes.map((lane, idx) => (
          <div
            key={lane.id}
            className="lane-rail"
            style={{ top: lane.y, height: lane.h, width: RAIL_W }}
            onClick={(e) => { e.stopPropagation(); onLaneClick(idx, e.currentTarget.getBoundingClientRect()); }}
          >
            <LaneLabel label={lane.label} h={lane.h} />
          </div>
        ))}
      </div>

      {process.lanes.map((lane) => (
        <div
          key={'row-' + lane.id}
          className="lane-row"
          style={{ top: lane.y, height: lane.h, left: RAIL_W }}
        />
      ))}

      {/* SVG edges (now clickable in edit mode) */}
      <Edges
        process={process}
        width={canvasW}
        height={canvasH}
        editMode={editMode}
        selectedEdgeId={selectedEdgeId}
        onEdgeClick={onEdgeClick}
        onEdgeHandleMouseDown={onEdgeHandleMouseDown}
        reconnecting={link?.reconnect || null}
        editingEdgeIndex={editingEdge?.index}
        onStartEdgeLabel={startEdgeLabel}
        presentActiveId={presentActiveId}
        moving={!!drag || !!resize}
      />

      {link && (() => {
        const preview = computeLinkPath(link, process);
        if (!preview) return null;
        return (
          <svg
            className="link-preview"
            width={canvasW}
            height={canvasH}
            style={{ pointerEvents: 'none', position: 'absolute', top: 0, left: 0, overflow: 'visible', zIndex: 9 }}
          >
            <defs>
              <marker id="arrow-link" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0.5 1 L 9 5 L 0.5 9 z" fill={preview.color} />
              </marker>
            </defs>
            <path
              d={preview.d}
              fill="none"
              stroke={preview.color}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={preview.dashed ? '6 5' : undefined}
              markerStart={preview.markerStart}
              markerEnd={preview.markerEnd}
            />
          </svg>
        );
      })()}

      {guides?.v != null && <div className="align-guide v" style={{ left: guides.v }} />}
      {guides?.h != null && <div className="align-guide h" style={{ top: guides.h }} />}

      {editingEdge && (
        <input
          className="edge-label-edit"
          autoFocus
          value={editingEdge.text}
          style={{ left: editingEdge.x, top: editingEdge.y }}
          placeholder="Ox mətni"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setEditingEdge(prev => prev ? { ...prev, text: e.target.value } : prev)}
          onFocus={(e) => e.target.select()}
          onBlur={commitEdgeLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitEdgeLabel(); }
            if (e.key === 'Escape') { e.preventDefault(); cancelEdgeLabel(); }
          }}
        />
      )}

      {dropPreview && (
        <img
          className="drop-ghost"
          src={shapeImage(dropPreview.shape)}
          alt=""
          style={{ left: dropPreview.x, top: dropPreview.y }}
        />
      )}

      {marquee && (() => {
        const b = normRect(marquee);
        return <div className="marquee-box" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />;
      })()}

      {multiMenu && (
        <MultiNodeMenu
          x={multiMenu.x} y={multiMenu.y}
          count={multiSel.size}
          onClose={() => setMultiMenu(null)}
          onColor={(c) => { patchSelectedNodes && patchSelectedNodes({ color: c }); }}
          onStyle={(s) => { patchSelectedNodes && patchSelectedNodes({ style: s }); }}
          onDelete={() => { setMultiMenu(null); deleteSelectedNodes && deleteSelectedNodes(); }}
        />
      )}

      {process.nodes.map((node) => {
        const isSelected =
          String(modalNodeId) === String(node.id) ||
          String(selectedNodeId) === String(node.id) ||
          multiSel.has(String(node.id));
        const isMultiSel = multiSel.size > 1 && multiSel.has(String(node.id));
        const dimmed = modalOpen && !isSelected;
        const isPresentSource = presentActiveId != null && !isSelected && presentSourceIds.has(String(node.id));
        const isLinkTarget = link && String(link.overId) === String(node.id) &&
          (link.reconnect || String(link.fromId) !== String(node.id));
        const showHandles = editMode && !drag && !resize && (String(hoverNodeId) === String(node.id) || (link && !link.reconnect && String(link.fromId) === String(node.id)));

        const { shape, style } = nodeView(node);
        const isEditingText = editingId === node.id;
        const isSvgShape = SVG_SHAPES.includes(shape);
        const cls = [
          'node', shape, `s-${style}`,
          isSvgShape ? 'svg-shape' : 'box-shape',
          isSelected ? 'selected' : '',
          isMultiSel ? 'multi-selected' : '',
          dimmed ? 'dimmed' : '',
          isPresentSource ? 'present-source' : '',
          editMode ? 'editable' : '',
          drag?.nodeId === node.id ? 'dragging' : '',
          resize?.nodeId === node.id ? 'resizing' : '',
          isLinkTarget ? 'link-target' : '',
          isEditingText ? 'editing-text' : ''
        ].filter(Boolean).join(' ');

        // per-node custom color overrides the diagram accent for this node only —
        // derive the full hover/selected/stroke-border variant set so every
        // state (not just the base fill) follows the custom color consistently.
        const nodeStyle = { left: node.x, top: node.y, width: node.w, minHeight: node.h };
        if (node.color) {
          const vars = deriveAccentVars(node.color);
          if (vars) Object.assign(nodeStyle, vars);
        }

        return (
          <div
            key={node.id}
            className={cls}
            style={nodeStyle}
            onMouseDown={(e) => { if (!isEditingText) onMouseDownNode(e, node); }}
            onMouseEnter={() => {
              setHoverNodeId(node.id);
              if (link) setLink(prev => prev ? { ...prev, overId: node.id } : prev);
            }}
            onMouseLeave={() => {
              setHoverNodeId(prev => (String(prev) === String(node.id) ? null : prev));
              if (link) setLink(prev => (prev && String(prev.overId) === String(node.id) ? { ...prev, overId: null } : prev));
            }}
            onMouseUp={(e) => {
              if (link) { e.stopPropagation(); finishLink(node); }
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (isEditingText) return;
              if (drag?.moved) return;
              if (didLinkRef.current) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const additive = e.shiftKey || e.metaKey || e.ctrlKey;
              // Edit mode: left click only selects (move/resize); the context
              // menu popup opens with RIGHT click only.
              onNodeClick(node.id, rect, editMode ? false : true, { additive });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (isEditingText) return;
              // If several nodes are selected and this is one of them, open the
              // multi-node action menu instead of the single-node popup.
              if (editMode && multiSel.size > 1 && multiSel.has(String(node.id))) {
                setMultiMenu({ x: e.clientX, y: e.clientY });
                return;
              }
              const rect = e.currentTarget.getBoundingClientRect();
              onNodeClick(node.id, rect, true);
            }}
          >
            <ShapeBg shape={shape} style={style} />
            <div className="num">{node.id}</div>
            {isEditingText ? (
              <textarea
                className="node-text-edit"
                autoFocus
                value={editingText}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setEditingText(e.target.value)}
                onFocus={(e) => e.target.select()}
                onBlur={() => commitEditText(node.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEditText(node.id); }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setEditingId(null);
                    if (onNodeInteractionEnd) onNodeInteractionEnd();
                  }
                }}
              />
            ) : (
              <div
                className="text"
                onDoubleClick={(e) => startEditText(e, node)}
                title={editMode ? 'İki dəfə klikləyin: mətni redaktə et' : undefined}
              >
                {node.text}
              </div>
            )}

            {showHandles && SIDES.map(side => (
              <div
                key={side}
                className={`link-handle ${side} ${shape === 'diamond' ? 'on-diamond' : ''}`}
                title="Ox çəkmək üçün sürükləyin"
                onMouseDown={(e) => onHandleMouseDown(e, node, side)}
                onClick={(e) => e.stopPropagation()}
              >
                <span className="link-dot" />
              </div>
            ))}

            {editMode && !drag && !resize && isSelected && !isEditingText && CORNERS.map(corner => (
              <div
                key={corner}
                className={`resize-handle ${corner}`}
                title="Ölçünü dəyişmək üçün sürükləyin"
                onMouseDown={(e) => onResizeMouseDown(e, node, corner)}
                onClick={(e) => e.stopPropagation()}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/* Vertical lane name that never gets cut off: if it doesn't fit the rail at
   12px, the font steps down (to 8px) until it does. */
function LaneLabel({ label, h }) {
  const ref = useRef(null);
  const [size, setSize] = useState(12);
  useEffect(() => { setSize(12); }, [label, h]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rail = el.parentElement;
    const tooBig = el.scrollWidth > (rail?.clientWidth || 56) - 4 || el.scrollHeight > el.clientHeight + 1;
    if (tooBig && size > 8) setSize(s => Math.max(8, +(s - 0.5).toFixed(1)));
  });
  return (
    <div className="lane-label" ref={ref} style={size !== 12 ? { fontSize: size } : undefined} title={label}>
      {String(label || '').split('\n').map((line, i, arr) => (
        <span key={i}>{line}{i < arr.length - 1 && <br />}</span>
      ))}
    </div>
  );
}

function ShapeBg({ shape, style }) {
  const dash = style === 'dashed' ? '7 5' : undefined;

  const POLY = {
    diamond: '50,2 98,50 50,98 2,50',
    parallelogram: '20,5 98,5 80,95 2,95',
    preparation: '25,2 75,2 98,50 75,98 25,98 2,50',
    manualinput: '2,22 98,2 98,98 2,98',
    trapezoid: '22,4 78,4 98,96 2,96',
    triangledown: '3,6 97,6 50,97',
  };
  if (POLY[shape]) {
    return (
      <svg className="shape-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polygon
          points={POLY[shape]}
          className="shape-fill"
          vectorEffect="non-scaling-stroke"
          strokeDasharray={dash}
        />
      </svg>
    );
  }
  if (shape === 'document') {
    return (
      <svg className="shape-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path
          d="M0,0 H100 V86 C78,99 64,99 50,88 C36,77 22,77 0,86 Z"
          className="shape-fill"
          vectorEffect="non-scaling-stroke"
          strokeDasharray={dash}
        />
      </svg>
    );
  }
  return null;
}

// How close two sides' distances need to be (in canvas px) before we treat
// the drop point as "ambiguous" and fall back to the source-facing side.
const SIDE_AMBIGUITY_PX = 16;

function nearestSide(node, pt, fromPt) {
  const dTop = Math.abs(pt.y - node.y);
  const dBottom = Math.abs(pt.y - (node.y + node.h));
  const dLeft = Math.abs(pt.x - node.x);
  const dRight = Math.abs(pt.x - (node.x + node.w));
  const dists = [
    ['top', dTop],
    ['bottom', dBottom],
    ['left', dLeft],
    ['right', dRight],
  ].sort((a, b) => a[1] - b[1]);

  // The drop point clearly favors one side over the others — honor exactly
  // where the arrow was dragged to.
  if (!fromPt || dists[1][1] - dists[0][1] >= SIDE_AMBIGUITY_PX) {
    return dists[0][0];
  }

  // Only when the drop is genuinely ambiguous (near the middle, or two sides
  // are nearly tied — e.g. a small/close, stacked sub-process box) do we
  // fall back to the side facing back toward the source, so the elbow enters
  // naturally instead of doubling back.
  return sideTowardPoint(fromPt, { x: node.x + node.w / 2, y: node.y + node.h / 2 });
}

// The side of a free (cursor) endpoint that faces back toward the source, so
// the elbow enters it naturally instead of doubling back.
function sideTowardPoint(fromPt, toPt) {
  const dx = toPt.x - fromPt.x, dy = toPt.y - fromPt.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'left' : 'right';
  return dy >= 0 ? 'top' : 'bottom';
}

/* Compute the live, bent (orthogonal, Figma-style) preview path for whatever
   link drag is in progress — either creating a new arrow, or reconnecting an
   existing one. Returns { d, color, dashed, markerStart, markerEnd } or null.
   The moving end snaps to a hovered node's nearest side, otherwise follows the
   cursor as a zero-size virtual node so the router still produces a clean elbow. */
function computeLinkPath(link, process) {
  if (!link) return null;
  const nodeMap = Object.fromEntries(process.nodes.map(n => [String(n.id), n]));
  const V = pt => ({ id: null, x: pt.x, y: pt.y, w: 0, h: 0 });

  if (link.reconnect) {
    const edge = process.edges[link.reconnect.edgeIndex];
    if (!edge) return null;
    const draggingFrom = link.reconnect.end === 'from';
    const fixedId = draggingFrom ? edge.to : edge.from;
    const fixedNode = nodeMap[String(fixedId)];
    if (!fixedNode) return null;
    const fixedSide = draggingFrom ? (edge.e || 'left') : (edge.s || 'right');

    const target = link.overId != null ? nodeMap[String(link.overId)] : null;
    let movingNode, movingSide;
    if (target && String(target.id) !== String(fixedId)) {
      movingNode = target; movingSide = nearestSide(target, link.cur, anchor(fixedNode, fixedSide));
    } else {
      movingNode = V(link.cur);
      movingSide = sideTowardPoint(anchor(fixedNode, fixedSide), link.cur);
    }
    // keep the arrow's direction (from → to) intact
    const [fromN, fromS, toN, toS] = draggingFrom
      ? [movingNode, movingSide, fixedNode, fixedSide]
      : [fixedNode, fixedSide, movingNode, movingSide];
    const { d } = edgeGeometry(fromN, toN, fromS, toS, edge.via, []);
    const arrow = edge.arrow || 'end';
    return {
      d,
      color: edge.color || 'var(--edge-color, var(--primary))',
      dashed: !!edge.dashed,
      markerStart: (arrow === 'start' || arrow === 'both') ? 'url(#arrow-link)' : undefined,
      markerEnd: (arrow === 'end' || arrow === 'both') ? 'url(#arrow-link)' : undefined
    };
  }

  // creating a new arrow from a node's side handle
  const fromNode = nodeMap[String(link.fromId)];
  if (!fromNode) return null;
  const fromSide = link.fromSide;
  const target = link.overId != null ? nodeMap[String(link.overId)] : null;
  let toN, toS;
  if (target && String(target.id) !== String(link.fromId)) {
    toN = target; toS = nearestSide(target, link.cur, anchor(fromNode, fromSide));
  } else {
    toN = V(link.cur); toS = sideTowardPoint(anchor(fromNode, fromSide), link.cur);
  }
  const { d } = edgeGeometry(fromNode, toN, fromSide, toS, null, []);
  return { d, color: 'var(--edge-color, var(--primary))', dashed: false, markerStart: undefined, markerEnd: 'url(#arrow-link)' };
}

/* ====== SVG EDGES ====== */
function Edges({ process, width, height, editMode, selectedEdgeId, onEdgeClick, onEdgeHandleMouseDown, reconnecting, editingEdgeIndex, onStartEdgeLabel, presentActiveId, moving }) {
  const nodeMap = Object.fromEntries(process.nodes.map(n => [String(n.id), n]));
  // Fan-out offsets so several arrows sharing one node-side don't overlap.
  const offsets = useMemo(() => endpointOffsets(process), [process.edges, process.nodes]);
  // Router-made arrows whose boxes moved / changed size get a fresh clean path
  // (instead of dropping back to the simple router).
  // (skipped while a box is being dragged — recomputed on drop)
  const rerouted = useMemo(() => (moving ? {} : stalePaths(process)), [process.edges, process.nodes, moving]);
  // exact polyline of every arrow, as drawn
  const lines = useMemo(() => allEdgePoints(process, (e, i, a, b) => effectiveVia(e, a, b) || rerouted[i] || null, offsets),
    [process.edges, process.nodes, rerouted, offsets]);

  return (
    <svg
      className="edges"
      width={width}
      height={height}
      style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible', pointerEvents: 'none' }}
    >
      <defs>
        {/* context-stroke lets one marker follow whatever color each path uses */}
        <marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0.5 1 L 9 5 L 0.5 9 Z" fill="context-stroke" />
        </marker>
        <marker id="arrow-fallback" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0.5 1 L 9 5 L 0.5 9 Z" fill="var(--edge-color, var(--primary))" />
        </marker>
      </defs>
      {process.edges.map((e, i) => {
        const from = nodeMap[String(e.from)];
        const to = nodeMap[String(e.to)];
        if (!from || !to) return null;
        // While an endpoint of this edge is being dragged, hide the stored edge —
        // the live bent preview above shows it moving instead (so it reads as
        // "moving this arrow", not "a new straight arrow appeared").
        if (reconnecting && String(reconnecting.edgeIndex) === String(i)) return null;
        const obstacles = process.nodes.filter(
          n => String(n.id) !== String(from.id) && String(n.id) !== String(to.id)
        );
        const sSide = e.s || 'right';
        const eSide = e.e || 'left';
        const off = offsets[i] || { fromOff: 0, toOff: 0 };
        const pts = lines[i];
        const d = pts ? roundedPath(pts, CORNER_R) : '';
        const mid = pts ? polylineMidpoint(pts) : { x: 0, y: 0 };
        void obstacles;
        const stroke = e.color || (e.dashed ? '#7ba0b3' : 'var(--edge-color, var(--primary))');
        const isSel = String(selectedEdgeId) === String(i);
        const fromPt = anchor(from, sSide, off.fromOff);
        const toPt = anchor(to, eSide, off.toOff);
        // Which ends carry an arrowhead. Default 'end' keeps old diagrams intact.
        const arrow = e.arrow || 'end';
        const markerStart = (arrow === 'start' || arrow === 'both') ? 'url(#arrow)' : undefined;
        const markerEnd = (arrow === 'end' || arrow === 'both') ? 'url(#arrow)' : undefined;
        const hasLabel = e.label && String(e.label).trim().length > 0;
        const isEditingLabel = String(editingEdgeIndex) === String(i);
        const labelText = String(e.label || '');
        const labelW = Math.max(22, labelText.length * 7 + 16);
        // Presentation: only the arrow *arriving* at the current node stays
        // lit and draws itself. Its outgoing arrows (to not-yet-reached nodes)
        // dim like every other edge.
        const presenting = presentActiveId != null;
        const flowIn = presenting && String(e.to) === String(presentActiveId);
        const dimEdge = presenting && !flowIn;
        return (
          <g
            key={i}
            className={`edge-group ${isSel ? 'sel' : ''}`}
            style={{ opacity: dimEdge ? 0.2 : 1, transition: 'opacity 0.35s ease' }}
          >
            {/* selection glow underlay — follows this edge's own color, not the global theme */}
            {isSel && (
              <path d={d} fill="none" stroke={stroke}
                strokeOpacity="0.28" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
            )}
            {/* wide invisible hit area — only clickable in edit mode.
                Single click selects the edge; double click edits its label. */}
            {editMode && (
              <path
                d={d}
                fill="none"
                stroke="transparent"
                strokeWidth="16"
                strokeLinecap="round"
                style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                onClick={(ev) => {
                  ev.stopPropagation();
                  const pt = { left: ev.clientX, right: ev.clientX, top: ev.clientY, bottom: ev.clientY, width: 0, height: 0 };
                  onEdgeClick && onEdgeClick(i, pt);
                }}
                onDoubleClick={(ev) => {
                  ev.stopPropagation();
                  onStartEdgeLabel && onStartEdgeLabel(i, mid, e.label);
                }}
              />
            )}
            {/* visible line — during presentation the edge arriving at the
                current node draws itself from start → hədəf, once. The `key`
                changes with the active node so the one-shot replays each step. */}
            <path
              key={flowIn ? `line-draw-${presentActiveId}` : 'line'}
              d={d}
              className={flowIn ? 'edge-draw-anim' : ''}
              stroke={stroke}
              strokeWidth={isSel ? 3 : 2}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={flowIn ? undefined : (e.dashed ? '5 5' : null)}
              pathLength={flowIn ? 1 : undefined}
              markerStart={markerStart}
              markerEnd={markerEnd}
              style={{ pointerEvents: 'none' }}
            />
            {/* edge text label sitting on the middle of the line */}
            {hasLabel && !isEditingLabel && (
              <g
                className="edge-label"
                style={{ pointerEvents: editMode ? 'all' : 'none', cursor: editMode ? 'text' : 'default' }}
                onMouseDown={(ev) => editMode && ev.stopPropagation()}
                onClick={(ev) => {
                  if (!editMode) return;
                  ev.stopPropagation();
                  const pt = { left: ev.clientX, right: ev.clientX, top: ev.clientY, bottom: ev.clientY, width: 0, height: 0 };
                  onEdgeClick && onEdgeClick(i, pt);
                }}
                onDoubleClick={(ev) => {
                  if (!editMode) return;
                  ev.stopPropagation();
                  onStartEdgeLabel && onStartEdgeLabel(i, mid, e.label);
                }}
              >
                <rect
                  x={mid.x - labelW / 2} y={mid.y - 11}
                  width={labelW} height={22} rx={6}
                  className="edge-label-bg"
                  stroke={stroke}
                />
                <text x={mid.x} y={mid.y} className="edge-label-text"
                  dominantBaseline="central" textAnchor="middle">{labelText}</text>
              </g>
            )}
            {/* draggable endpoint handles — drag onto a different node to reconnect */}
            {editMode && isSel && (
              <>
                <circle
                  cx={fromPt.x} cy={fromPt.y} r="7"
                  className="edge-endpoint"
                  style={{ pointerEvents: 'all', cursor: 'grab' }}
                  onMouseDown={(ev) => onEdgeHandleMouseDown(ev, i, 'from', fromPt)}
                />
                <circle
                  cx={toPt.x} cy={toPt.y} r="7"
                  className="edge-endpoint"
                  style={{ pointerEvents: 'all', cursor: 'grab' }}
                  onMouseDown={(ev) => onEdgeHandleMouseDown(ev, i, 'to', toPt)}
                />
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ====== marquee helpers ====== */
function normRect(m) {
  const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
  return { x, y, w: Math.abs(m.x1 - m.x0), h: Math.abs(m.y1 - m.y0) };
}
function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/* ====== PATH ROUTING ====== */
// Normalised (0–100) outlines of the SVG-bodied shapes, mirroring ShapeBg so a
// connection point can be pulled in onto the *visible* edge instead of the
// rectangular bounding box (which leaves a gap on slanted shapes).
const SHAPE_POLY = {
  diamond:       [[50, 2], [98, 50], [50, 98], [2, 50]],
  parallelogram: [[20, 5], [98, 5], [80, 95], [2, 95]],
  preparation:   [[25, 2], [75, 2], [98, 50], [75, 98], [25, 98], [2, 50]],
  manualinput:   [[2, 22], [98, 2], [98, 98], [2, 98]],
  trapezoid:     [[22, 4], [78, 4], [98, 96], [2, 96]],
  document:      [[0, 0], [100, 0], [100, 86], [50, 88], [0, 86]],
  triangledown:  [[3, 6], [97, 6], [50, 97]],
};

// First point where the ray from the shape centre toward `target` crosses the
// polygon outline — i.e. where an arrow should actually touch the shape.
function rayHitsPolygon(center, target, poly) {
  const dx = target.x - center.x, dy = target.y - center.y;
  let bestT = Infinity, best = null;
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
    const ex = p2.x - p1.x, ey = p2.y - p1.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((p1.x - center.x) * ey - (p1.y - center.y) * ex) / den;
    const u = ((p1.x - center.x) * dy - (p1.y - center.y) * dx) / den;
    if (t > 1e-6 && u >= -1e-6 && u <= 1 + 1e-6 && t < bestT) {
      bestT = t; best = { x: center.x + dx * t, y: center.y + dy * t };
    }
  }
  return best;
}

function rectAnchor(node, side, offset = 0) {
  const { x, y, w, h } = node;
  // `offset` slides the point along the side (perpendicular to the exit
  // direction) so several arrows sharing one side fan out instead of stacking.
  switch (side) {
    case 'top':    return { x: x + w / 2 + offset, y };
    case 'right':  return { x: x + w, y: y + h / 2 + offset };
    case 'bottom': return { x: x + w / 2 + offset, y: y + h };
    case 'left':   return { x, y: y + h / 2 + offset };
    default:       return { x: x + w / 2, y: y + h / 2 };
  }
}

export function anchor(node, side, offset = 0) {
  const base = rectAnchor(node, side, offset);
  const shape = node && node.type ? nodeView(node).shape : null;
  const poly = shape && SHAPE_POLY[shape];
  if (!poly || !node.w || !node.h) return base;
  // Pull the point in onto the real (slanted/curved) edge so the arrow touches
  // the shape, not the rectangle around it.
  const { x, y, w, h } = node;
  const center = { x: x + w / 2, y: y + h / 2 };
  const abs = poly.map(([px, py]) => ({ x: x + (px / 100) * w, y: y + (py / 100) * h }));
  return rayHitsPolygon(center, base, abs) || base;
}

/* Spread endpoints that share the same node + side so multiple arrows into (or
   out of) one node don't collapse onto a single point. Returns a map
   { [edgeIndex]: { fromOff, toOff } } of along-side pixel offsets. Endpoints are
   ordered by the opposite node's position so the fan-out doesn't cross itself. */
export function endpointOffsets(process) {
  const nodeMap = Object.fromEntries(process.nodes.map(n => [String(n.id), n]));
  const groups = new Map();
  const push = (key, rec) => { (groups.get(key) || groups.set(key, []).get(key)).push(rec); };

  process.edges.forEach((e, i) => {
    const from = nodeMap[String(e.from)];
    const to = nodeMap[String(e.to)];
    if (!from || !to) return;
    const sSide = e.s || 'right';
    const eSide = e.e || 'left';
    push(`${e.from}|${sSide}`, { i, end: 'from', other: to });
    push(`${e.to}|${eSide}`,   { i, end: 'to',   other: from });
  });

  const out = {};
  const slot = i => (out[i] || (out[i] = { fromOff: 0, toOff: 0 }));
  const GAP = 20, MARGIN = 12;

  for (const [key, arr] of groups) {
    if (arr.length < 2) continue; // a lone endpoint stays centered
    const node = nodeMap[key.slice(0, key.lastIndexOf('|'))];
    const side = key.slice(key.lastIndexOf('|') + 1);
    if (!node) continue;
    const horizontal = side === 'top' || side === 'bottom';
    const sideLen = horizontal ? node.w : node.h;
    arr.sort((a, b) => {
      const av = horizontal ? (a.other.x + a.other.w / 2) : (a.other.y + a.other.h / 2);
      const bv = horizontal ? (b.other.x + b.other.w / 2) : (b.other.y + b.other.h / 2);
      return av - bv;
    });
    const n = arr.length;
    const maxSpread = Math.max(0, sideLen - 2 * MARGIN);
    const gap = Math.min(GAP, maxSpread / (n - 1));
    arr.forEach((rec, j) => {
      const off = (j - (n - 1) / 2) * gap;
      const s = slot(rec.i);
      if (rec.end === 'from') s.fromOff = off; else s.toOff = off;
    });
  }
  return out;
}

// A point a short distance straight out from a node's side. Making the path
// start/end with this stub guarantees the line leaves/enters the shape
// perpendicular to its edge and never cuts back across the node body (fix 12).
const STUB = 12;
function stubPoint(pt, side, dist = STUB) {
  switch (side) {
    case 'top':    return { x: pt.x, y: pt.y - dist };
    case 'bottom': return { x: pt.x, y: pt.y + dist };
    case 'left':   return { x: pt.x - dist, y: pt.y };
    case 'right':  return { x: pt.x + dist, y: pt.y };
    default:       return { ...pt };
  }
}

function pathPoints(from, to, sSide, eSide, via, sOff = 0, eOff = 0) {
  const s = anchor(from, sSide, sOff);
  const e = anchor(to, eSide, eOff);
  const sStub = stubPoint(s, sSide);
  const eStub = stubPoint(e, eSide);

  if (via && via.length > 0) {
    const pts = [s, sStub];
    let prev = sStub;
    for (const v of via) {
      pts.push({ x: v.x, y: prev.y });
      pts.push({ x: v.x, y: v.y });
      prev = v;
    }
    pts.push({ x: eStub.x, y: prev.y });
    pts.push(eStub);
    pts.push(e);
    return dedupe(pts);
  }

  // Route between the two stub points, then cap with the real anchors so the
  // arrow head still lands exactly on the node edge.
  const mid = midRoute(sStub, eStub, sSide, eSide);
  return dedupe([s, ...mid, e]);
}

// Orthogonal routing between two (already stubbed) points.
function midRoute(s, e, sSide, eSide) {
  if (Math.abs(s.x - e.x) < 1 || Math.abs(s.y - e.y) < 1) return [s, e];
  const sH = sSide === 'left' || sSide === 'right';
  const eH = eSide === 'left' || eSide === 'right';
  const sV = sSide === 'top' || sSide === 'bottom';
  const eV = eSide === 'top' || eSide === 'bottom';
  if (sV && eV) {
    // Both stubs already clear their node by STUB px. When both exit the SAME
    // way (both top / both bottom) the shared run must sit past the outer stub,
    // otherwise it doubles back across the source node. Opposite ways route
    // between them (average).
    const midY = sSide === eSide
      ? (sSide === 'bottom' ? Math.max(s.y, e.y) : Math.min(s.y, e.y))
      : (s.y + e.y) / 2;
    return [s, { x: s.x, y: midY }, { x: e.x, y: midY }, e];
  }
  if (sH && eH) {
    const midX = sSide === eSide
      ? (sSide === 'right' ? Math.max(s.x, e.x) : Math.min(s.x, e.x))
      : (s.x + e.x) / 2;
    return [s, { x: midX, y: s.y }, { x: midX, y: e.y }, e];
  }
  if (sV && eH) return [s, { x: s.x, y: e.y }, e];
  if (sH && eV) return [s, { x: e.x, y: s.y }, e];
  return [s, e];
}

/* ====== OBSTACLE AVOIDANCE ======
   The base orthogonal path (pathPoints) only knows about the two
   connected nodes. If a third node happens to sit on one of its
   straight segments, the line would previously cut right through it.
   This walks each segment and, if it overlaps a node's bounding box,
   inserts a rectangular "step" around that box on whichever side is
   closer. Runs a few passes since detouring can create a new overlap. */
const CLEARANCE = 16;
const MAX_AVOID_PASSES = 6;

function toBox(node) {
  return { x: node.x, y: node.y, w: node.w, h: node.h };
}

function segHitsBox(p1, p2, box, margin) {
  const bx1 = box.x - margin, by1 = box.y - margin;
  const bx2 = box.x + box.w + margin, by2 = box.y + box.h + margin;
  if (Math.abs(p1.y - p2.y) < 0.5) {
    // horizontal segment
    const y = p1.y;
    const x1 = Math.min(p1.x, p2.x), x2 = Math.max(p1.x, p2.x);
    if (y <= by1 || y >= by2) return false;
    return x2 > bx1 + 0.5 && x1 < bx2 - 0.5;
  }
  if (Math.abs(p1.x - p2.x) < 0.5) {
    // vertical segment
    const x = p1.x;
    const y1 = Math.min(p1.y, p2.y), y2 = Math.max(p1.y, p2.y);
    if (x <= bx1 || x >= bx2) return false;
    return y2 > by1 + 0.5 && y1 < by2 - 0.5;
  }
  return false; // diagonal segments aren't produced by this router
}

function detourAroundBox(p1, p2, box) {
  const bx1 = box.x - CLEARANCE, by1 = box.y - CLEARANCE;
  const bx2 = box.x + box.w + CLEARANCE, by2 = box.y + box.h + CLEARANCE;

  if (Math.abs(p1.y - p2.y) < 0.5) {
    // horizontal: step above or below the box, whichever is a shorter detour
    const y = p1.y;
    const dir = p2.x >= p1.x ? 1 : -1;
    const aboveDelta = Math.abs(by1 - y);
    const belowDelta = Math.abs(by2 - y);
    const newY = aboveDelta <= belowDelta ? by1 : by2;
    const lo = Math.min(p1.x, p2.x), hi = Math.max(p1.x, p2.x);
    let enterX = Math.max(lo, bx1);
    let exitX = Math.min(hi, bx2);
    if (dir < 0) [enterX, exitX] = [exitX, enterX];
    return [
      { x: enterX, y },
      { x: enterX, y: newY },
      { x: exitX, y: newY },
      { x: exitX, y }
    ];
  }
  if (Math.abs(p1.x - p2.x) < 0.5) {
    // vertical: step left or right of the box
    const x = p1.x;
    const dir = p2.y >= p1.y ? 1 : -1;
    const leftDelta = Math.abs(bx1 - x);
    const rightDelta = Math.abs(bx2 - x);
    const newX = leftDelta <= rightDelta ? bx1 : bx2;
    const lo = Math.min(p1.y, p2.y), hi = Math.max(p1.y, p2.y);
    let enterY = Math.max(lo, by1);
    let exitY = Math.min(hi, by2);
    if (dir < 0) [enterY, exitY] = [exitY, enterY];
    return [
      { x, y: enterY },
      { x: newX, y: enterY },
      { x: newX, y: exitY },
      { x, y: exitY }
    ];
  }
  return null;
}

function pathClearOfBoxes(pts, boxes) {
  for (let i = 0; i < pts.length - 1; i++) {
    for (const box of boxes) {
      if (segHitsBox(pts[i], pts[i + 1], box, CLEARANCE)) return false;
    }
  }
  return true;
}

// If the blocked segment's near end is a free bend (fed by a perpendicular
// segment, not one of the fixed stub points), try pushing that whole shared
// run past the box instead of notching around it right at the collision.
// This turns "short stub, then jog out and back" into one clean elbow that
// simply reaches further (fix 13). Falls back to null so the caller can
// still notch when no such run exists or sliding it doesn't actually clear.
function trySlideBend(pts, hitIdx, hitBox, boxes, stubStart, stubEnd) {
  const p1 = pts[hitIdx], p2 = pts[hitIdx + 1];
  const segVertical = Math.abs(p1.x - p2.x) < 0.5; // blocked segment runs along y

  // The anchors (first/last point, on the node's side) and the short stubs
  // right after/before them must never move: sliding them is what produced
  // slanted segments and arrows that no longer touch their box.
  const fixedPt = i => i <= 1 || i >= pts.length - 2;
  const tryNeighbor = (feedIdx, sharedIdx, boundaryIdx) => {
    if (feedIdx < 0 || feedIdx > pts.length - 1 || sharedIdx === boundaryIdx) return null;
    if (fixedPt(feedIdx) || fixedPt(sharedIdx)) return null;
    const feed = pts[feedIdx], shared = pts[sharedIdx];
    const feedVertical = Math.abs(feed.x - shared.x) < 0.5;
    if (feedVertical === segVertical) return null; // not perpendicular — no run to slide

    const cur = segVertical ? shared.y : shared.x;
    const candidates = segVertical
      ? [hitBox.y - CLEARANCE, hitBox.y + hitBox.h + CLEARANCE]
      : [hitBox.x - CLEARANCE, hitBox.x + hitBox.w + CLEARANCE];
    candidates.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));

    for (const val of candidates) {
      const out = pts.slice();
      if (segVertical) {
        out[sharedIdx] = { ...shared, y: val };
        out[feedIdx] = { ...feed, y: val };
      } else {
        out[sharedIdx] = { ...shared, x: val };
        out[feedIdx] = { ...feed, x: val };
      }
      const deduped = dedupe(out);
      if (pathClearOfBoxes(deduped, boxes)) return deduped;
    }
    return null;
  };

  // hitIdx is the shared point on the near side of the blocked segment;
  // hitIdx+1 is the shared point on the far side.
  return tryNeighbor(hitIdx - 1, hitIdx, stubStart) || tryNeighbor(hitIdx + 2, hitIdx + 1, stubEnd);
}

function avoidObstacles(points, obstacles, protectEnds = false) {
  if (!obstacles || !obstacles.length || points.length < 2) return points;
  const boxes = obstacles.map(toBox);
  let pts = points.slice();
  for (let pass = 0; pass < MAX_AVOID_PASSES; pass++) {
    let hit = null, hitIdx = -1;
    // When protectEnds is set, the very first and very last segments are the
    // perpendicular stubs leaving/entering the source/target node — they are
    // allowed to touch those nodes, so skip them (fix 12).
    const lo = protectEnds ? 1 : 0;
    const hi = protectEnds ? pts.length - 2 : pts.length - 1;
    for (let i = lo; i < hi; i++) {
      for (const box of boxes) {
        if (segHitsBox(pts[i], pts[i + 1], box, CLEARANCE)) { hit = box; hitIdx = i; break; }
      }
      if (hit) break;
    }
    if (!hit) break;

    const stubStart = protectEnds ? 1 : -1;
    const stubEnd = protectEnds ? pts.length - 2 : -1;
    const slid = trySlideBend(pts, hitIdx, hit, boxes, stubStart, stubEnd);
    if (slid) { pts = slid; continue; }

    const detour = detourAroundBox(pts[hitIdx], pts[hitIdx + 1], hit);
    if (!detour) break;
    pts = [...pts.slice(0, hitIdx + 1), ...detour, ...pts.slice(hitIdx + 1)];
  }
  return dedupe(pts);
}

function dedupe(pts) {
  const r = [];
  for (const p of pts) {
    const last = r[r.length - 1];
    if (!last || Math.abs(last.x - p.x) > 0.5 || Math.abs(last.y - p.y) > 0.5) r.push(p);
  }
  return r;
}

function roundedPath(points, r) {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];
    const dist1 = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const dist2 = Math.hypot(next.x - curr.x, next.y - curr.y);
    const rr = Math.min(r, dist1 / 2, dist2 / 2);
    if (rr < 0.5) { d += ` L ${curr.x} ${curr.y}`; continue; }
    const dx1 = (curr.x - prev.x) / dist1;
    const dy1 = (curr.y - prev.y) / dist1;
    const dx2 = (next.x - curr.x) / dist2;
    const dy2 = (next.y - curr.y) / dist2;
    const beforeX = curr.x - dx1 * rr;
    const beforeY = curr.y - dy1 * rr;
    const afterX  = curr.x + dx2 * rr;
    const afterY  = curr.y + dy2 * rr;
    d += ` L ${beforeX} ${beforeY} Q ${curr.x} ${curr.y} ${afterX} ${afterY}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/** Every edge's routed polyline, exactly as drawn (bends, fan-out, avoidance). */
export function allEdgePoints(process, viaFor, offsets) {
  const nodeMap = Object.fromEntries((process.nodes || []).map(n => [String(n.id), n]));
  return (process.edges || []).map((e, i) => {
    const from = nodeMap[String(e.from)], to = nodeMap[String(e.to)];
    if (!from || !to) return null;
    const obstacles = process.nodes.filter(n => String(n.id) !== String(from.id) && String(n.id) !== String(to.id));
    const off = offsets[i] || { fromOff: 0, toOff: 0 };
    const via = viaFor(e, i, from, to);
    let pts = pathPoints(from, to, e.s || 'right', e.e || 'left', via, off.fromOff, off.toOff);
    if (!via || !via.length) pts = avoidObstacles(pts, obstacles);
    return pts;
  });
}

/* Returns the routed SVG path plus the geometric midpoint of the line,
   used to anchor an edge's text label on top of the arrow. */
function edgeGeometry(from, to, sSide, eSide, via, obstacles, sOff = 0, eOff = 0) {
  let points = pathPoints(from, to, sSide, eSide, via, sOff, eOff);
  if (!via || !via.length) {
    points = avoidObstacles(points, obstacles);
  }
  return { d: roundedPath(points, CORNER_R), mid: polylineMidpoint(points) };
}
export { edgeGeometry };

// Bend points saved by the AI router carry `viaFor` = where both boxes were
// when the path was made. Once either box moves or is resized the bends are
// stale, so the arrow goes back to automatic routing. Hand-placed bends (no
// viaFor) are used exactly as before.
export function effectiveVia(e, from, to) {
  if (!e?.via || !e.via.length) return null;
  if (!e.viaFor) return e.via;
  const r = n => `${Math.round(n.x)},${Math.round(n.y)},${Math.round(n.w)},${Math.round(n.h)}`;
  return e.viaFor === `${r(from)}|${r(to)}|${e.s || 'right'}|${e.e || 'left'}` ? e.via : null;
}

/** { edgeIndex: via } for router-made arrows whose saved bends are stale. */
export function stalePaths(process) {
  try {
    const byId = new Map((process?.nodes || []).map(n => [String(n.id), n]));
    return rerouteStale(process, e => {
      if (!e?.viaFor || !e.via?.length) return false;
      const a = byId.get(String(e.from)), b = byId.get(String(e.to));
      return !!a && !!b && !effectiveVia(e, a, b);
    });
  } catch {
    return {};
  }
}

// The routed polyline (before corner-rounding) for an edge — used to test
// whether a not-yet-created arrow would visually cross an existing one.
export function edgePoints(from, to, sSide, eSide, via, obstacles, sOff = 0, eOff = 0) {
  let points = pathPoints(from, to, sSide, eSide, via, sOff, eOff);
  if (!via || !via.length) points = avoidObstacles(points, obstacles);
  return points;
}

// Strict segment crossing (interior points only) — two lines that merely share
// an endpoint (edges meeting at a common node) are NOT counted as crossing.
function segCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}
export function polylinesCross(a, b) {
  for (let i = 0; i < a.length - 1; i++)
    for (let j = 0; j < b.length - 1; j++)
      if (segCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
  return false;
}

// Point at half the total arc-length of a polyline — a stable label anchor.
function polylineMidpoint(pts) {
  if (!pts.length) return { x: 0, y: 0 };
  if (pts.length === 1) return pts[0];
  const seg = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    seg.push(l); total += l;
  }
  let half = total / 2;
  for (let i = 0; i < seg.length; i++) {
    if (half <= seg[i]) {
      const t = seg[i] ? half / seg[i] : 0;
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * t
      };
    }
    half -= seg[i];
  }
  return pts[pts.length - 1];
}

/* ====== MULTI-NODE CONTEXT MENU ======
   Shown on right-click when 2+ nodes are selected. Applies colour / border
   style / delete to every selected node at once. */
const MULTI_SWATCHES = ['#3a7894', '#1f4456', '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#16a34a'];
const MULTI_STYLES = [['solid', 'Tam'], ['stroke', 'Kontur'], ['dashed', 'Kəsik']];

function MultiNodeMenu({ x, y, count, onClose, onColor, onStyle, onDelete }) {
  const { t } = useLabels();
  useEffect(() => {
    function close(e) {
      if (document.body.dataset.labelEdit === '1') return; // frozen while editing text
      // ignore clicks inside the menu
      if (e.target.closest && e.target.closest('.multi-menu')) return;
      onClose();
    }
    function onKey(e) {
      if (document.body.dataset.labelEdit === '1') return;
      onClose(e);
    }
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // keep the menu on-screen
  const style = {
    left: Math.min(x, window.innerWidth - 230),
    top: Math.min(y, window.innerHeight - 200)
  };

  return (
    <div
      className="multi-menu"
      style={style}
      onMouseDown={e => e.stopPropagation()}
      /* Without this, a swatch click bubbles up to the canvas' background
         onClick, which calls onBackgroundClick → clears the multi-selection.
         The first colour applied, but every later click hit an empty
         selection and silently did nothing. Keep the click inside the menu. */
      onClick={e => e.stopPropagation()}
    >
      <div className="multi-menu-head">{count} node seçildi</div>

      <div className="multi-menu-label">{t('nodemenu.color_tab', 'Rəng')}</div>
      <div className="multi-menu-swatches">
        {MULTI_SWATCHES.map(c => (
          <button key={c} className="mm-swatch" style={{ background: c }} title={c}
            onClick={() => onColor(c)} />
        ))}
        <button className="mm-swatch mm-clear" title="Standart" onClick={() => onColor('')} />
      </div>

      <div className="multi-menu-label">{t('multiselect.border_label', 'Sərhəd')}</div>
      <div className="multi-menu-styles">
        {MULTI_STYLES.map(([s, label]) => (
          <button key={s} className="mm-style" onClick={() => onStyle(s)}>{label}</button>
        ))}
      </div>

      <button className="multi-menu-delete" onClick={onDelete}>Seçilənləri sil</button>
    </div>
  );
}
export { polylineMidpoint as polylineMidpointExport };
