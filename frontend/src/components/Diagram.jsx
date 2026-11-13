// Diagram.jsx
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ChevronLeft, LogOut, Edit3, Eye, EyeOff, Save, Loader2, CheckCircle2, AlertCircle, Undo2, Redo2,
  Maximize2, Minimize2, PanelRight, PanelRightOpen, X,
  Play, Pause, SkipBack, SkipForward, RotateCcw, MonitorPlay, Clock
} from './icons.jsx';
import { LogoFull } from './Logo.jsx';
import { useLabels } from '../labels/LabelsContext.jsx';
import { api, setToken } from '../api/client.js';
import DiagramCanvas, { edgePoints, polylinesCross, effectiveVia } from './DiagramCanvas.jsx';
import NodeModal from './NodeModal.jsx';
import AdminPanel from './AdminPanel.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import SelectionMenu from './SelectionMenu.jsx';
import { deriveAccentVars, deriveLaneVars, deriveEdgeVars, asColorString, normalizeTheme } from './colorUtils.js';
import { autoNodeHeight } from './nodeMeasure.js';
import { nodeDefaults } from './nodeStyle.js';
import { resolveNodePlacement } from './nodeLayout.js';
import AiButton from './ai/AiButton.jsx';
import { AiBinding, useAi } from './ai/AiHost.jsx';
import { StatusControl } from './Status.jsx';
import SaveReminder from './SaveReminder.jsx';
import { buildFromSpec, findLane, nextNodeId as nextFreeNodeId, portsFor, safeShape, safeStyle } from './ai/aiBuild.js';
import { buildDiagramSvg } from './diagramExport.js';
import { svgToAttachment } from './ai/aiAttachments.js';
import { tidyEdges } from './ai/aiRoute.js';

const DRAFT_KEY = (id) => `absheron_draft_${id}`;
const DRAFT_TS_KEY = (id) => `absheron_draft_${id}_ts`;

// Human-friendly "last edited" label for the unsaved-changes banner.
const AZ_MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun',
  'iyul', 'avqust', 'sentyabr', 'oktyabr', 'noyabr', 'dekabr'];
function formatDraftTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const isYest = d.toDateString() === yest.toDateString();
  if (sameDay) return `bu gün ${hhmm}`;
  if (isYest) return `dünən ${hhmm}`;
  return `${d.getDate()} ${AZ_MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hhmm}`;
}
const LANE_PAD = 20;
const LANE_MIN_H = 160;

// Mirror of DiagramCanvas's auto-fit content size, so fit-to-screen scales correctly.
function canvasDims(process) {
  const RAIL_W = 56, PAD_RIGHT = 80, PAD_BOTTOM = 40, MIN_W = 700, MIN_H = 300;
  const nodes = process?.nodes || [];
  const lanes = process?.lanes || [];
  const contentRight = nodes.length
    ? Math.max(...nodes.map(n => (n.x || 0) + (n.w || 0)))
    : RAIL_W + 200;
  const contentBottom = lanes.length
    ? Math.max(...lanes.map(l => (l.y || 0) + (l.h || 0)))
    : 200;
  return {
    w: Math.max(MIN_W, contentRight + PAD_RIGHT),
    h: Math.max(MIN_H, contentBottom + PAD_BOTTOM)
  };
}

/**
 * Repack lanes vertically so each lane fits its assigned nodes.
 * - Stacks lanes top-to-bottom starting at y=20.
 * - Each lane is just tall enough to fit its nodes (min LANE_MIN_H).
 * - Nodes get shifted with their lane so they stay visually positioned inside it.
 * - Nodes without a laneId (or with an invalid one) are auto-assigned to the
 *   nearest lane by Y center.
 *
 * Returns { lanes, nodes }.
 */
function repackLanes(lanes, nodes) {
  if (lanes.length === 0) return { lanes, nodes };

  // 1. Ensure every node has a valid laneId. Infer from current Y if missing.
  const tagged = nodes.map(n => {
    if (n.laneId && lanes.some(l => l.id === n.laneId)) return n;
    const cy = (n.y || 0) + (n.h || 100) / 2;
    let best = lanes[0];
    let bestDist = Infinity;
    let contained = false;
    for (const lane of lanes) {
      if (cy >= lane.y && cy < lane.y + lane.h) {
        best = lane; contained = true; break;
      }
      const dist = Math.min(Math.abs(cy - lane.y), Math.abs(cy - (lane.y + lane.h)));
      if (!contained && dist < bestDist) { bestDist = dist; best = lane; }
    }
    return { ...n, laneId: best.id };
  });

  // 2. Stack lanes; compute each lane's required height and the shift to apply to its nodes.
  let cursorY = 20;
  const shiftByLane = {};

  const newLanes = lanes.map(lane => {
    const laneNodes = tagged.filter(n => n.laneId === lane.id);

    let height = LANE_MIN_H;
    if (laneNodes.length > 0) {
      // Measure how far down nodes extend, relative to the lane's *current* top.
      const maxBottomRel = Math.max(
        ...laneNodes.map(n => (n.y || 0) + (n.h || 100) - lane.y)
      );
      height = Math.max(LANE_MIN_H, maxBottomRel + LANE_PAD);
    }

    const newY = cursorY;
    shiftByLane[lane.id] = newY - lane.y; // how far this lane is moving
    cursorY += height;

    return { ...lane, y: newY, h: height };
  });

  // 3. Apply shifts to nodes so they ride along with their lane.
  const newNodes = tagged.map(n => ({
    ...n,
    y: Math.round((n.y || 0) + (shiftByLane[n.laneId] || 0))
  }));

  return { lanes: newLanes, nodes: newNodes };
}

export default function Diagram({ processId, focusNodeId, onBack, onLogout }) {
  const role = localStorage.getItem('role');
  const isViewer = role === 'viewer';
  const isAdmin = role === 'admin' || role === 'editor_2';
  const { t, tByText } = useLabels();

  const [process, setProcess] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // View: fit-to-width (no horizontal scroll) vs classic (native size)
  const [fitWidth, setFitWidth] = useState(false);
  // Canvas zoom (right-side slider / Ctrl+wheel). Scales ONLY the diagram —
  // boxes, text, arrows, lanes — never the top bar or editor panels.
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  // "Safe area": only when the user scrolls (or drags a box) to the right
  // end, the canvas grows by about one screen there — never on open — and
  // shrinks back when they scroll away again and nothing was put there.
  const [extra, setExtra] = useState({ w: 0, h: 0 });
  useEffect(() => { setExtra({ w: 0, h: 0 }); }, [processId]);
  // Side panel open/close (edit mode)
  const [panelOpen, setPanelOpen] = useState(true);
  // Height of the floating navbar (AdminPanel), so the canvas can pad clear of it
  const [navbarH, setNavbarH] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Live size of the diagram container, for fit-to-screen scaling
  const [containerW, setContainerW] = useState(0);
  const [containerH, setContainerH] = useState(0);
  const containerRef = useRef(null);

  const [hasDraft, setHasDraft] = useState(false);
  const [draftTs, setDraftTs] = useState(null); // ms timestamp of the last unsaved edit
  const [serverProcess, setServerProcess] = useState(null);
  const [modalAnchorRect, setModalAnchorRect] = useState(null);
  const [interacting, setInteracting] = useState(false);
  const interactingRef = useRef(false);
  interactingRef.current = interacting;
  // Border style chosen in the "Node əlavə et" sidebar for new shapes.
  const [addStyle, setAddStyle] = useState('solid');
  // Presentation ("Təqdimat") mode: auto-walk every node id 1→last, scroll to
  // it, spotlight it and show its popup, with play/pause/step/exit controls.
  const [presenting, setPresenting] = useState(false);
  const [presentIndex, setPresentIndex] = useState(0);
  const [presentPlaying, setPresentPlaying] = useState(true);
  const [presentPopup, setPresentPopup] = useState(false);
  // User toggle: whether the info popup appears for each node during a presentation.
  const [presentShowPopup, setPresentShowPopup] = useState(true);
  // Per-node dwell while auto-playing — user adjustable 1s…10s via the slider.
  const [presentDwell, setPresentDwell] = useState(4000); // ms
  // Inline "jump to node" editor for the presentation counter (null = not editing).
  const [presentJumpDraft, setPresentJumpDraft] = useState(null);
  // A new edge awaiting confirmation because it would cross existing arrow(s).
  const [pendingEdge, setPendingEdge] = useState(null);
  // AI assistant sidebar (admin only).
  const { open: aiOpen, setOpen: setAiOpen } = useAi();

  // Multi-select: set of node ids selected together (edit mode).
  const [selectedIds, setSelectedIds] = useState([]);
  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  const editModeRef = useRef(editMode);
  useEffect(() => { editModeRef.current = editMode; }, [editMode]);
  const selectionRef = useRef(selection);
  useEffect(() => { selectionRef.current = selection; }, [selection]);

  const processRef = useRef(process);
  const dirtyRef = useRef(dirty);
  useEffect(() => { processRef.current = process; }, [process]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  // Track the diagram container width so fit-to-width can scale correctly
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => { setContainerW(el.clientWidth); setContainerH(el.clientHeight); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [editMode, panelOpen, loading]);

  // ---- Undo / redo history ----
  const historyRef = useRef([]);   // array of process snapshots
  const indexRef = useRef(-1);     // pointer into historyRef
  const lastTagRef = useRef(null); // coalescing tag of last commit
  const lastTimeRef = useRef(0);   // timestamp of last commit
  const HISTORY_CAP = 200;
  const [histMeta, setHistMeta] = useState({ canUndo: false, canRedo: false });

  function syncHistMeta() {
    setHistMeta({
      canUndo: indexRef.current > 0,
      canRedo: indexRef.current < historyRef.current.length - 1
    });
  }

  function resetHistory(p) {
    historyRef.current = p ? [p] : [];
    indexRef.current = p ? 0 : -1;
    lastTagRef.current = null;
    lastTimeRef.current = 0;
    syncHistMeta();
  }

  function applySnapshot(p) {
    setProcess(p);
    processRef.current = p;
    setDirty(true);
  }

  function undo() {
    if (indexRef.current <= 0) return;
    indexRef.current -= 1;
    lastTagRef.current = null;
    applySnapshot(historyRef.current[indexRef.current]);
    syncHistMeta();
  }

  function redo() {
    if (indexRef.current >= historyRef.current.length - 1) return;
    indexRef.current += 1;
    lastTagRef.current = null;
    applySnapshot(historyRef.current[indexRef.current]);
    syncHistMeta();
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [processId]);

  // When opened from the list with a focused node, open that node's popup.
  useEffect(() => {
    if (!loading && process && focusNodeId != null) {
      const exists = process.nodes.some(n => String(n.id) === String(focusNodeId));
      if (exists) {
        setEditMode(false);
        setSelection({ kind: 'node', id: focusNodeId });
        setModalAnchorRect(null);
      }
    }
    /* eslint-disable-next-line */
  }, [loading, focusNodeId]);

  useEffect(() => {
    if (dirty && process) {
      try {
        localStorage.setItem(DRAFT_KEY(processId), JSON.stringify(process));
        const ts = Date.now();
        localStorage.setItem(DRAFT_TS_KEY(processId), String(ts));
        setDraftTs(ts);
      } catch (e) { }
    }
  }, [process, dirty, processId]);

  useEffect(() => {
    function onBeforeUnload(e) {
      if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; }
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    function onKeyDown(e) {
      if (!editMode) return;
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // Delete / Backspace removes the current selection (not while typing).
      if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
        if (selectedIdsRef.current.length) { e.preventDefault(); deleteSelectedNodes(); return; }
        // Fix #10 — a selected arrow (edge) is removed with Delete too.
        if (selectionRef.current?.kind === 'edge') { e.preventDefault(); deleteEdgeByIndex(selectionRef.current.id); return; }
        if (selectionRef.current?.kind === 'node') { e.preventDefault(); deleteNodeById(selectionRef.current.id); return; }
        return;
      }
      // Fix #9 — move the selected node(s) with the arrow keys.
      if (!typing && !mod &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const ids = selectedIdsRef.current.length
          ? selectedIdsRef.current
          : (selectionRef.current?.kind === 'node' ? [selectionRef.current.id] : []);
        if (ids.length) {
          e.preventDefault();
          const step = e.shiftKey ? 1 : 10; // Shift = fine 1px, else 10px grid
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          moveNodesBy(ids, dx, dy);
        }
        return;
      }
      // Escape clears the multi-selection.
      if (e.key === 'Escape' && !typing) {
        if (selectedIdsRef.current.length) { setSelectedIds([]); }
        return;
      }
      if (!mod) return;
      if (typing) return;
      // Ctrl/Cmd+A selects all nodes.
      if (key === 'a') { e.preventDefault(); selectAllNodes(); return; }
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    /* eslint-disable-next-line */
  }, [editMode]);

  // Clear multi-selection whenever we leave edit mode.
  useEffect(() => { if (!editMode) setSelectedIds([]); }, [editMode]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const p = await api.getProcess(processId);
      const normalized = normalizeProcess(p);
      setServerProcess(normalized);
      setStatus(p.status ?? null);

      const draftStr = localStorage.getItem(DRAFT_KEY(processId));
      if (draftStr) {
        try {
          const draft = normalizeProcess(JSON.parse(draftStr));
          setProcess(draft);
          processRef.current = draft;
          resetHistory(draft);
          setHasDraft(true);
          setDirty(true);
          const ts = Number(localStorage.getItem(DRAFT_TS_KEY(processId)));
          setDraftTs(Number.isFinite(ts) && ts > 0 ? ts : null);
        } catch {
          setProcess(normalized);
          processRef.current = normalized;
          resetHistory(normalized);
          setHasDraft(false);
          setDirty(false);
          setDraftTs(null);
        }
      } else {
        setProcess(normalized);
        processRef.current = normalized;
        resetHistory(normalized);
        setHasDraft(false);
        setDirty(false);
        setDraftTs(null);
      }
      setSelection(null);
    } catch (e) {
      setError(e.message);
      if (e.status === 401) onLogout();
    } finally {
      setLoading(false);
    }
  }

  function discardDraft() {
    localStorage.removeItem(DRAFT_KEY(processId));
    localStorage.removeItem(DRAFT_TS_KEY(processId));
    setProcess(serverProcess);
    processRef.current = serverProcess;
    resetHistory(serverProcess);
    setHasDraft(false);
    setDirty(false);
    setDraftTs(null);
    setSelection(null);
  }

  /**
   * Commit a change as an undo checkpoint.
   * Pass an optional `tag` so rapid edits to the same field (typing) coalesce
   * into a single history entry instead of one-per-keystroke.
   */
  function updateProcess(updater, tag) {
    const prev = processRef.current;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    if (next === prev) return;

    const now = Date.now();
    const coalesce = tag && tag === lastTagRef.current && (now - lastTimeRef.current) < 800
      && historyRef.current.length > 1;

    let hist = historyRef.current.slice(0, indexRef.current + 1);
    if (coalesce) {
      hist[hist.length - 1] = next;        // replace top — merge with previous edit
    } else {
      hist.push(next);
      while (hist.length > HISTORY_CAP) hist.shift();
    }
    historyRef.current = hist;
    indexRef.current = hist.length - 1;
    lastTagRef.current = tag || null;
    lastTimeRef.current = now;

    setProcess(next);
    processRef.current = next;
    setDirty(true);
    syncHistMeta();
  }

  /** Live update with no history checkpoint (used during drag). */
  function updateProcessLive(updater) {
    const prev = processRef.current;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    setProcess(next);
    processRef.current = next;
    setDirty(true);
  }

  async function save() {
    if (!process || saving) return;
    setSaving(true);
    try {
      await api.updateProcess(process.id, process);
      localStorage.removeItem(DRAFT_KEY(processId));
      localStorage.removeItem(DRAFT_TS_KEY(processId));
      setDirty(false);
      setHasDraft(false);
      setDraftTs(null);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (e) {
      alert('Yadda saxlanılmadı: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(next) {
    const prev = status;
    setStatus(next);
    try { await api.setProcessStatus(process.id, next); }
    catch (e) { setStatus(prev); alert('Status dəyişdirilə bilmədi: ' + e.message); }
  }

  function toggleEdit() {
    if (isViewer) return;
    setEditMode(prev => {
      const next = !prev;
      if (next) setPanelOpen(true); // entering edit → editor panel opens right away
      return next;
    });
    setSelection(null);
  }

  function logout() {
    setToken(null);
    localStorage.removeItem('role');
    localStorage.removeItem('username');
    onLogout();
  }

  const onNodeClick = useCallback((nodeId, rect, menu = true, opts = {}) => {
    // Multi-select toggle (Shift/Ctrl/Cmd click) — edit mode only, no popup.
    if (opts.additive && editModeRef.current) {
      setSelectedIds(prev => {
        const has = prev.some(id => String(id) === String(nodeId));
        return has ? prev.filter(id => String(id) !== String(nodeId)) : [...prev, nodeId];
      });
      setSelection(null);
      setModalAnchorRect(null);
      return;
    }
    // Plain click: single select. If the node is part of an existing
    // multi-selection and this is just a select (not opening menu), keep the
    // group so a drag can move them together; otherwise collapse to one.
    if (!(menu === false && selectedIdsRef.current.some(id => String(id) === String(nodeId)))) {
      setSelectedIds([nodeId]);
    }
    setSelection({ kind: 'node', id: nodeId, menu: menu !== false });
    setModalAnchorRect(rect || null);
    setInteracting(false);
  }, []);

  /** Marquee/rubber-band select: replace selection with everything in the box. */
  const onMarqueeSelect = useCallback((ids) => {
    setSelectedIds(ids);
    setSelection(null);
    setModalAnchorRect(null);
  }, []);

  /** Select all nodes (Ctrl+A). */
  const selectAllNodes = useCallback(() => {
    const p = processRef.current;
    if (!p) return;
    setSelectedIds(p.nodes.map(n => n.id));
    setSelection(null);
    setModalAnchorRect(null);
  }, []);

  /** Delete every selected node (and edges touching them). */
  const deleteSelectedNodes = useCallback(() => {
    const ids = selectedIdsRef.current;
    if (!ids.length) return;
    const idSet = new Set(ids.map(String));
    updateProcess(p => {
      const nodes = p.nodes.filter(n => !idSet.has(String(n.id)));
      const edges = p.edges.filter(e => !idSet.has(String(e.from)) && !idSet.has(String(e.to)));
      const r = repackLanes(p.lanes, nodes);
      return { ...p, nodes: r.nodes, lanes: r.lanes, edges };
    });
    setSelectedIds([]);
    setSelection(null);
    setModalAnchorRect(null);
  }, []);

  /** Fix #10 — delete a single arrow (edge) by its index. */
  const deleteEdgeByIndex = useCallback((index) => {
    updateProcess(p => ({ ...p, edges: p.edges.filter((_, i) => i !== index) }));
    setSelection(null);
    setModalAnchorRect(null);
  }, []);

  /** Delete one node by id (used by keyboard when a single node is selected). */
  const deleteNodeById = useCallback((id) => {
    updateProcess(p => {
      const nodes = p.nodes.filter(n => String(n.id) !== String(id));
      const edges = p.edges.filter(e => String(e.from) !== String(id) && String(e.to) !== String(id));
      const r = repackLanes(p.lanes, nodes);
      return { ...p, nodes: r.nodes, lanes: r.lanes, edges };
    });
    setSelectedIds([]);
    setSelection(null);
    setModalAnchorRect(null);
  }, []);

  /** Fix #9 — nudge the given node ids by (dx, dy), reassigning lanes + repacking.
   *  Consecutive nudges coalesce into a single undo step via the shared tag. */
  const moveNodesBy = useCallback((ids, dx, dy) => {
    if (!ids || !ids.length) return;
    const idSet = new Set(ids.map(String));
    updateProcess(p => {
      const nodes = p.nodes.map(n => {
        if (!idSet.has(String(n.id))) return n;
        const nx = Math.max(60, (n.x || 0) + dx);
        const ny = Math.max(4, (n.y || 0) + dy);
        const cy = ny + (n.h || 100) / 2;
        let laneId = n.laneId, best = Infinity, contained = false;
        for (const lane of p.lanes) {
          if (cy >= lane.y && cy < lane.y + lane.h) { laneId = lane.id; contained = true; break; }
          const dist = Math.min(Math.abs(cy - lane.y), Math.abs(cy - (lane.y + lane.h)));
          if (!contained && dist < best) { best = dist; laneId = lane.id; }
        }
        return { ...n, x: nx, y: ny, laneId };
      });
      const r = repackLanes(p.lanes, nodes);
      return { ...p, lanes: r.lanes, nodes: r.nodes };
    }, 'nudge-nodes');
  }, []);

  /** Apply a patch (color/style) to all selected nodes at once. */
  const patchSelectedNodes = useCallback((patch) => {
    const ids = selectedIdsRef.current;
    if (!ids.length) return;
    const idSet = new Set(ids.map(String));
    updateProcess(p => ({
      ...p,
      nodes: p.nodes.map(n => idSet.has(String(n.id)) ? { ...n, ...patch } : n)
    }));
  }, []);

  const onLaneClick = useCallback((laneIndex, rect) => {
    if (!editMode) return;
    setSelection({ kind: 'lane', id: laneIndex });
    setModalAnchorRect(rect || null);
  }, [editMode]);

  const onEdgeClick = useCallback((edgeIndex, rect) => {
    if (!editMode) return;
    setSelection({ kind: 'edge', id: edgeIndex });
    setModalAnchorRect(rect || null);
  }, [editMode]);

  function closeModal() {
    setSelection(null);
    setModalAnchorRect(null);
    setInteracting(false);
    setSelectedIds([]);
  }

  /** Selection made from inside the ALƏTLƏR toolbar (not a canvas click) —
   * there's no click point to anchor to, so the context menu falls back
   * to its centered default position. */
  const selectWithoutAnchor = useCallback((sel) => {
    setSelection(sel ? { ...sel, menu: true } : sel);
    setModalAnchorRect(null);
  }, []);

  /**
   * Called continuously during drag.
   * Updates the node's x, y, and laneId (based on which lane its center is in now).
   * Does NOT repack — that runs once on drag end for smoother dragging.
   */
  const onNodeMove = useCallback((nodeId, x, y) => {
    updateProcessLive(p => {
      const node = p.nodes.find(n => n.id === nodeId);
      if (!node) return p;

      const centerY = y + (node.h || 100) / 2;
      let targetLaneId = node.laneId;
      let bestDist = Infinity;
      let contained = false;

      for (const lane of p.lanes) {
        if (centerY >= lane.y && centerY < lane.y + lane.h) {
          targetLaneId = lane.id;
          contained = true;
          break;
        }
        const dist = Math.min(
          Math.abs(centerY - lane.y),
          Math.abs(centerY - (lane.y + lane.h))
        );
        if (!contained && dist < bestDist) {
          bestDist = dist;
          targetLaneId = lane.id;
        }
      }

      return {
        ...p,
        nodes: p.nodes.map(n =>
          n.id === nodeId ? { ...n, x, y, laneId: targetLaneId } : n
        )
      };
    });
  }, []);

  /**
   * Called once when the drag ends. Repacks lanes vertically (so a lane grows
   * to fit its nodes) and, only if the dropped node literally overlaps another,
   * nudges it out by the minimum distance. Otherwise the node stays exactly
   * where the user released it — free placement, no forced auto-layout.
   */
  const onNodeMoveEnd = useCallback((nodeIdOrIds) => {
    const ids = Array.isArray(nodeIdOrIds) ? nodeIdOrIds : [nodeIdOrIds];
    const idSet = new Set(ids.map(String));
    updateProcess(p => {
      let nodes = p.nodes;
      // Nudge each moved node out of any overlap (minimal, free placement).
      for (const nid of ids) {
        const moved = nodes.find(n => String(n.id) === String(nid));
        if (!moved) continue;
        const lane = p.lanes.find(l => l.id === moved.laneId);
        const others = nodes.filter(n => !idSet.has(String(n.id)) && n.laneId === moved.laneId);
        const { x, y } = resolveNodePlacement(
          { x: moved.x, y: moved.y, w: moved.w, h: moved.h },
          others,
          { laneTop: lane ? lane.y : 0 }
        );
        if (x !== moved.x || y !== moved.y) {
          nodes = nodes.map(n => String(n.id) === String(moved.id) ? { ...n, x, y } : n);
        }
      }
      const r = repackLanes(p.lanes, nodes);
      return { ...p, lanes: r.lanes, nodes: r.nodes };
    });
    /* eslint-disable-next-line */
  }, []);

  /**
   * Create an edge by dragging from one node's side handle to another node.
   * Avoids duplicate edges between the same pair/sides.
   */
  // Actually append the edge (skips exact duplicates).
  const addEdge = useCallback((fromId, fromSide, toId, toSide) => {
    updateProcess(p => {
      const exists = p.edges.some(e =>
        String(e.from) === String(fromId) &&
        String(e.to) === String(toId) &&
        (e.s || 'bottom') === fromSide &&
        (e.e || 'top') === toSide
      );
      if (exists) return p;
      return { ...p, edges: [...p.edges, { from: fromId, to: toId, s: fromSide, e: toSide }] };
    });
  }, []);

  // List existing arrows the proposed one would visually cross (by "from → to").
  const crossingsFor = useCallback((fromId, fromSide, toId, toSide) => {
    const p = processRef.current;
    if (!p) return [];
    const nodeMap = Object.fromEntries(p.nodes.map(n => [String(n.id), n]));
    const from = nodeMap[String(fromId)], to = nodeMap[String(toId)];
    if (!from || !to) return [];
    const newObs = p.nodes.filter(n => String(n.id) !== String(fromId) && String(n.id) !== String(toId));
    const newPts = edgePoints(from, to, fromSide, toSide, null, newObs);
    const hits = [];
    p.edges.forEach(e => {
      const ef = nodeMap[String(e.from)], et = nodeMap[String(e.to)];
      if (!ef || !et) return;
      // ignore an already-identical edge
      if (String(e.from) === String(fromId) && String(e.to) === String(toId)) return;
      const obs = p.nodes.filter(n => String(n.id) !== String(e.from) && String(n.id) !== String(e.to));
      const pts = edgePoints(ef, et, e.s || 'right', e.e || 'left', effectiveVia(e, ef, et), obs);
      if (polylinesCross(newPts, pts)) hits.push(`${e.from} → ${e.to}`);
    });
    return hits;
  }, []);

  const onCreateEdge = useCallback((fromId, fromSide, toId, toSide) => {
    const crossed = crossingsFor(fromId, fromSide, toId, toSide);
    if (crossed.length) {
      setPendingEdge({ fromId, fromSide, toId, toSide, crossed });
      return;
    }
    addEdge(fromId, fromSide, toId, toSide);
  }, [crossingsFor, addEdge]);

  const confirmPendingEdge = useCallback(() => {
    setPendingEdge(pe => {
      if (pe) addEdge(pe.fromId, pe.fromSide, pe.toId, pe.toSide);
      return null;
    });
  }, [addEdge]);

  /** Double-click-to-edit text directly on the canvas.
   * Width stays fixed — the height auto-grows to fit the new text. */
  const onNodeTextChange = useCallback((nodeId, text) => {
    updateProcess(p => {
      const newNodes = p.nodes.map(n => {
        if (String(n.id) !== String(nodeId)) return n;
        return { ...n, text, h: autoNodeHeight(n, text) };
      });
      const r = repackLanes(p.lanes, newNodes);
      return { ...p, lanes: r.lanes, nodes: r.nodes };
    }, `node-${nodeId}-text-inline`);
  }, []);

  /** Inline double-click edit of an edge's text label. */
  const onEdgeLabelChange = useCallback((edgeIndex, text) => {
    updateProcess(p => ({
      ...p,
      edges: p.edges.map((e, i) => i === edgeIndex ? { ...e, label: text } : e)
    }), `edge-${edgeIndex}-label-inline`);
  }, []);

  /** Live resize while dragging a corner handle — no repack yet, for smoothness. */
  const onNodeResize = useCallback((nodeId, x, y, w, h) => {
    updateProcessLive(p => ({
      ...p,
      nodes: p.nodes.map(n => String(n.id) === String(nodeId) ? { ...n, x, y, w, h } : n)
    }));
  }, []);

  /** Repack lanes once resizing finishes, same pattern as onNodeMoveEnd. */
  const onNodeResizeEnd = useCallback((nodeId) => {
    updateProcess(p => {
      let nodes = p.nodes;
      if (nodeId != null) {
        nodes = nodes.map(n => {
          if (String(n.id) !== String(nodeId)) return n;
          const needed = autoNodeHeight(n, n.text);
          return needed > n.h ? { ...n, h: needed } : n;
        });
      }
      const r = repackLanes(p.lanes, nodes);
      return { ...p, lanes: r.lanes, nodes: r.nodes };
    });
  }, []);

  /** Drag an existing edge's endpoint onto a different node to reconnect it. */
  const onEdgeReconnect = useCallback((edgeIndex, end, targetNodeId, targetSide) => {
    updateProcess(p => ({
      ...p,
      edges: p.edges.map((e, i) => {
        if (i !== edgeIndex) return e;
        return end === 'from'
          ? { ...e, from: targetNodeId, s: targetSide }
          : { ...e, to: targetNodeId, e: targetSide };
      })
    }), `edge-${edgeIndex}-reconnect`);
  }, []);

  const LABEL_BY_SHAPE = {
    pill: 'başlanğıc/son', rect: 'addım', diamond: 'qərar', parallelogram: 'məlumat/giriş',
    subprocess: 'alt-proses', manualinput: 'əl daxiletmə', document: 'sənəd',
    preparation: 'hazırlıq', delay: 'gecikmə', trapezoid: 'mərhələ'
  };

  function nextNodeId(nodes) {
    const used = new Set(nodes.map(n => String(n.id)));
    let n = 1;
    while (used.has(String(n))) n++;
    return n;
  }

  /**
   * Create a node in a given lane at (preferX, preferY) but nudged so it never
   * overlaps an existing node — it lands beside them with a clean gap (rule 1/3).
   * preferX/preferY are in canvas coordinates; omit to default near the lane's start.
   */
  function createNode(shape, style, laneId, preferX, preferY) {
    const p0 = processRef.current;
    const lane0 = p0.lanes.find(l => l.id === laneId) || p0.lanes[0];
    if (!lane0) return;
    const id = nextNodeId(p0.nodes);
    const defaults = nodeDefaults(shape);
    updateProcess(p => {
      const lane = p.lanes.find(l => l.id === laneId) || p.lanes[0];
      if (!lane) return p;
      const laneNodes = p.nodes.filter(n => n.laneId === lane.id);
      const w = defaults.w, h = defaults.h;
      const startX = preferX != null ? preferX - w / 2 : 80;
      const startY = preferY != null ? preferY - h / 2 : lane.y + 20;
      const { x, y } = resolveNodePlacement(
        { x: startX, y: startY, w, h },
        laneNodes,
        { laneTop: lane.y }
      );
      const node = {
        id, type: shape, style: style || 'solid', x, y, laneId: lane.id, w, h,
        text: `Yeni ${LABEL_BY_SHAPE[shape] || 'addım'}`,
        info: { general: [''] }
      };
      const newNodes = [...p.nodes, node];
      const r = repackLanes(p.lanes, newNodes);
      return { ...p, lanes: r.lanes, nodes: r.nodes };
    });
    setSelection({ kind: 'node', id });
  }

  /** Change zoom keeping the point in the middle of the view in place. */
  function zoomAround(next) {
    const z0 = zoomRef.current || 1;
    const z1 = Math.round(Math.min(2, Math.max(0.25, next)) * 100) / 100;
    if (z1 === z0) return;
    const sc = containerRef.current;
    if (!sc) { setZoom(z1); return; }
    const cx = (sc.scrollLeft + sc.clientWidth / 2) / z0;
    const cy = (sc.scrollTop + sc.clientHeight / 2) / z0;
    setZoom(z1);
    requestAnimationFrame(() => {
      sc.scrollLeft = cx * z1 - sc.clientWidth / 2;
      sc.scrollTop = cy * z1 - sc.clientHeight / 2;
    });
  }
  useEffect(() => {
    const sc = containerRef.current;
    if (!sc) return undefined;
    let raf = 0, idle = 0;
    // Grow: reaching the right end adds about one screen there (right only —
    // below the last lane there is nothing to put, so no room is added there).
    const check = () => {
      raf = 0;
      const z = zoomRef.current || 1;
      const canScrollX = sc.scrollWidth > sc.clientWidth + 4;
      const atRight = canScrollX && sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 24;
      if (!atRight) return;
      const maxW = (sc.clientWidth / z) * 8;
      setExtra(e => {
        const w = Math.min(maxW, e.w + sc.clientWidth / z);
        return w === e.w ? e : { w, h: 0 };
      });
    };
    // Shrink: once scrolling stops, the empty room beyond what is on screen
    // is taken back. Boxes placed out there are part of the diagram, so the
    // canvas always still fits them (the base size follows the content).
    const trim = () => {
      idle = 0;
      // never pull the room away while a box is being dragged out there
      if (interactingRef.current || document.body.classList.contains('dragging')) {
        idle = setTimeout(trim, 400);
        return;
      }
      const el = sc.querySelector('.diagram-canvas');
      if (!el) return;
      const z = zoomRef.current || 1;
      const scR = sc.getBoundingClientRect(), elR = el.getBoundingClientRect();
      // right edge of what is on screen now, in canvas units
      const viewR = (scR.left + sc.clientWidth - elR.left) / z;
      const screenW = sc.clientWidth / z;
      setExtra(e => {
        if (!e.w) return e;
        const baseW = (parseFloat(el.style.width) || 0) - e.w;
        // still out at the end -> keep one screen ahead; moved back -> none
        const keepW = viewR >= baseW - 24 ? Math.ceil(viewR - baseW + screenW) : 0;
        const w = Math.max(0, Math.min(e.w, keepW));
        return w === e.w ? e : { w, h: 0 };
      });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(check);
      if (idle) clearTimeout(idle);
      idle = setTimeout(trim, 350);
    };
    sc.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      sc.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
      if (idle) clearTimeout(idle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef.current, loading]);

  // Ctrl + mouse wheel zooms the canvas too (plain wheel still scrolls).
  useEffect(() => {
    const sc = containerRef.current;
    if (!sc) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAround((zoomRef.current || 1) * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => sc.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef.current, loading]);

  /** Which lane is currently centered in the scroll viewport. */
  function viewportLaneId() {
    const p = processRef.current;
    if (!p || !p.lanes.length) return null;
    const scroller = containerRef.current?.querySelector('.diagram-canvas')?.parentElement;
    const canvasEl = containerRef.current?.querySelector('.diagram-canvas');
    if (!scroller || !canvasEl) return p.lanes[0].id;
    const scRect = scroller.getBoundingClientRect();
    const cvRect = canvasEl.getBoundingClientRect();
    // Y in canvas coords at the vertical middle of the visible area.
    const midCanvasY = ((scRect.top + scRect.height / 2) - cvRect.top) / (zoomRef.current || 1);
    let best = p.lanes[0];
    for (const lane of p.lanes) {
      if (midCanvasY >= lane.y && midCanvasY < lane.y + lane.h) { best = lane; break; }
    }
    return best.id;
  }

  /** Sidebar CLICK: add the shape to whichever lane is in the viewport now. */
  const onAddShape = useCallback((shape, style) => {
    if (!processRef.current?.lanes.length) { alert('Əvvəlcə bir panel əlavə edin.'); return; }
    const laneId = viewportLaneId();
    createNode(shape, style, laneId);
    /* eslint-disable-next-line */
  }, []);

  /** Canvas DROP: add the shape at the drop point, in the lane under it. */
  const onCanvasDropShape = useCallback((shape, style, canvasX, canvasY) => {
    const p = processRef.current;
    if (!p?.lanes.length) { alert('Əvvəlcə bir panel əlavə edin.'); return; }
    let laneId = p.lanes[0].id;
    for (const lane of p.lanes) {
      if (canvasY >= lane.y && canvasY < lane.y + lane.h) { laneId = lane.id; break; }
    }
    createNode(shape, style, laneId, canvasX, canvasY);
    /* eslint-disable-next-line */
  }, []);

  /** Fix 11: archive the whole diagram from inside the editor sidebar. */
  const onArchiveDiagram = useCallback(async () => {
    if (!process) return;
    if (!confirm(`"${process.title}" diaqramını arxivə köçürmək istəyirsiniz?`)) return;
    try {
      if (dirty) await api.updateProcess(process.id, process).catch(() => {});
      await api.archiveProcess(process.id);
      localStorage.removeItem(DRAFT_KEY(processId));
      localStorage.removeItem(DRAFT_TS_KEY(processId));
      onBack();
    } catch (e) {
      alert('Arxivə köçürülə bilmədi: ' + e.message);
    }
    /* eslint-disable-next-line */
  }, [process, dirty]);

  /* ===================== Təqdimat (presentation) ===================== */
  // Every node walked in ascending id order (numeric-aware).
  const presentOrder = useMemo(() => {
    if (!process) return [];
    return [...process.nodes].sort((a, b) => {
      const na = Number(a.id), nb = Number(b.id);
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    });
  }, [process?.nodes]);
  const presentOrderRef = useRef(presentOrder);
  useEffect(() => { presentOrderRef.current = presentOrder; }, [presentOrder]);

  function findScroller() {
    const canvasEl = containerRef.current?.querySelector('.diagram-canvas');
    return { canvasEl, scroller: canvasEl?.parentElement || null };
  }
  function scrollNodeIntoView(node, smooth = true) {
    const { canvasEl, scroller } = findScroller();
    if (!canvasEl || !scroller || !node) return;
    // Work in the scroller's own coordinate space via bounding rects, so this
    // is correct regardless of what the canvas' offsetParent happens to be.
    const cv = canvasEl.getBoundingClientRect();
    const sc = scroller.getBoundingClientRect();
    const z = zoomRef.current || 1;
    const nodeLeftInContent = (cv.left - sc.left) + scroller.scrollLeft + (node.x || 0) * z;
    const nodeTopInContent = (cv.top - sc.top) + scroller.scrollTop + (node.y || 0) * z;
    const left = nodeLeftInContent + (node.w || 0) * z / 2 - scroller.clientWidth / 2;
    const top = nodeTopInContent + (node.h || 0) * z / 2 - scroller.clientHeight / 2;
    scroller.scrollTo({
      left: Math.max(0, left), top: Math.max(0, top),
      behavior: smooth ? 'smooth' : 'auto'
    });
  }
  function nodeScreenRect(node) {
    const { canvasEl } = findScroller();
    if (!canvasEl || !node) return null;
    const r = canvasEl.getBoundingClientRect();
    const z = zoomRef.current || 1;
    return {
      left: r.left + (node.x || 0) * z, top: r.top + (node.y || 0) * z,
      right: r.left + ((node.x || 0) + (node.w || 0)) * z,
      bottom: r.top + ((node.y || 0) + (node.h || 0)) * z,
      width: (node.w || 0) * z, height: (node.h || 0) * z
    };
  }

  function startPresentation() {
    if (!process || !process.nodes.length) return;
    setEditMode(false);
    setFitWidth(false);
    setPanelOpen(false);
    setSelectedIds([]);
    setSelection(null);
    setModalAnchorRect(null);
    setPresentPopup(false);
    setPresentIndex(0);
    setPresentPlaying(true);
    setPresenting(true);
  }
  const exitPresentation = useCallback(() => {
    setPresenting(false);
    setPresentPlaying(false);
    setPresentPopup(false);
    setSelection(null);
    setModalAnchorRect(null);
  }, []);
  const presentGoto = useCallback((i) => {
    const n = presentOrderRef.current.length;
    if (!n) return;
    setPresentIndex(Math.max(0, Math.min(n - 1, i)));
  }, []);
  const presentNext = useCallback(() => {
    setPresentIndex(i => {
      const last = presentOrderRef.current.length - 1;
      if (i >= last) { setPresentPlaying(false); return i; }
      return i + 1;
    });
  }, []);
  const presentPrev = useCallback(() => setPresentIndex(i => Math.max(0, i - 1)), []);
  const presentRestart = useCallback(() => { setPresentIndex(0); setPresentPlaying(true); }, []);
  const presentTogglePlay = useCallback(() => {
    setPresentPlaying(p => {
      // Pressing play again after the deck finished restarts from the top.
      if (!p && presentIndex >= presentOrderRef.current.length - 1) { setPresentIndex(0); return true; }
      return !p;
    });
  }, [presentIndex]);

  // Drive each step: spotlight the node, scroll to it, then reveal the popup.
  useEffect(() => {
    if (!presenting) return;
    const node = presentOrder[presentIndex];
    if (!node) return;
    setPresentPopup(false);
    setSelection({ kind: 'node', id: node.id, menu: false });
    setModalAnchorRect(null);
    scrollNodeIntoView(node, true);
    const t = setTimeout(() => {
      setModalAnchorRect(nodeScreenRect(node));
      setPresentPopup(true);
    }, 560);
    return () => clearTimeout(t);
    /* eslint-disable-next-line */
  }, [presenting, presentIndex]);

  // Auto-advance while playing; stop when the last node is reached.
  useEffect(() => {
    if (!presenting || !presentPlaying) return;
    if (presentIndex >= presentOrder.length - 1) { setPresentPlaying(false); return; }
    const t = setTimeout(() => setPresentIndex(i => i + 1), presentDwell);
    return () => clearTimeout(t);
    /* eslint-disable-next-line */
  }, [presenting, presentPlaying, presentIndex, presentOrder.length, presentDwell]);

  // Keyboard: Esc exits, ←/→ step, Space toggles play.
  useEffect(() => {
    if (!presenting) return;
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); exitPresentation(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setPresentPlaying(false); presentNext(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setPresentPlaying(false); presentPrev(); }
      else if (e.key === ' ') { e.preventDefault(); presentTogglePlay(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presenting, exitPresentation, presentNext, presentPrev, presentTogglePlay]);

  const presentCurrent = presenting ? presentOrder[presentIndex] : null;
  const showModal = presenting
    ? (presentShowPopup && presentPopup && !!presentCurrent)
    : (!editMode && selection?.kind === 'node' && process);

  // Commit the inline counter edit: jump to that 1-based position in the walk.
  const presentJumpCommit = useCallback(() => {
    setPresentJumpDraft(draft => {
      if (draft != null && draft !== '') {
        const n = presentOrderRef.current.length;
        const pos = Math.max(1, Math.min(n, parseInt(draft, 10) || 1));
        setPresentPlaying(false);
        setPresentIndex(pos - 1);
      }
      return null;
    });
  }, []);

  /* ===================== AI köməkçi ===================== */
  // A trimmed snapshot of the diagram: enough for the model to reason about
  // ids, lanes and wiring, without shipping x/y/w/h it must never invent.
  function aiContext() {
    const p = processRef.current;
    return {
      view: 'diagram',
      role,
      unsavedChanges: dirty,
      editMode,
      diagram: p ? {
        id: p.id,
        title: p.title,
        subtitle: p.subtitle || '',
        lanes: (p.lanes || []).map(l => ({ id: l.id, label: l.label })),
        nodes: (p.nodes || []).map(n => ({
          id: n.id,
          type: n.type,
          style: n.style || 'solid',
          laneId: n.laneId,
          text: n.text,
          general: n.info?.general?.filter(Boolean) || [],
          risks: n.info?.risks?.filter(Boolean) || []
        })),
        edges: (p.edges || []).map(e => ({ from: e.from, to: e.to, s: e.s, e: e.e, dashed: !!e.dashed, label: e.label || '' }))
      } : null,
      hint: 'Bu, açıq diaqramın redaktə ekranıdır. Dəyişikliklər lokaldır — serverə yazmaq üçün "save" action-ı lazımdır.'
    };
  }

  // Picture of the diagram as it is right now (unsaved edits included), so the
  // assistant can look at layout, crossings and lane fit — not just the JSON.
  async function aiSnapshot() {
    const p = processRef.current;
    if (!p) throw new Error('Diaqram açıq deyil');
    const { svg, width, height } = buildDiagramSvg(p);
    const safe = String(p.title || 'diaqram').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'diaqram';
    return svgToAttachment(svg, { width, height, name: `${safe}.png` });
  }

  async function runAiActions(actions) {
    const log = [];
    // Anything that mutates the diagram goes through updateProcess(), so every
    // AI edit lands in the undo stack and Ctrl+Z takes it back.
    for (const a of actions) {
      switch (a.type) {
        case 'generate_diagram': {
          const built = buildFromSpec(a);
          updateProcess(p => ({
            ...p,
            lanes: built.lanes,
            nodes: built.nodes,
            edges: built.edges,
            width: built.width,
            height: built.height
          }), null);
          setSelection(null);
          setSelectedIds([]);
          if (!editMode) setEditMode(true);
          log.push(`Diaqram quruldu: ${built.lanes.length} panel, ${built.nodes.length} node, ${built.edges.length} əlaqə. Ctrl+Z ilə geri ala bilərsiniz.`);
          break;
        }
        case 'add_lane': {
          updateProcess(p => {
            const lane = { id: `lane-${Date.now()}`, label: a.label || 'Yeni panel', y: 0, h: LANE_MIN_H };
            const r = repackLanes([...p.lanes, lane], p.nodes);
            return { ...p, lanes: r.lanes, nodes: r.nodes };
          });
          log.push(`Panel əlavə edildi: "${a.label}"`);
          break;
        }
        case 'delete_lane': {
          const lane = findLane(processRef.current?.lanes, a.laneId);
          if (!lane) { log.push('Panel tapılmadı.'); break; }
          updateProcess(p => {
            const gone = new Set(p.nodes.filter(n => n.laneId === lane.id).map(n => String(n.id)));
            const nodes = p.nodes.filter(n => n.laneId !== lane.id);
            const edges = p.edges.filter(e => !gone.has(String(e.from)) && !gone.has(String(e.to)));
            const r = repackLanes(p.lanes.filter(l => l.id !== lane.id), nodes);
            return { ...p, lanes: r.lanes, nodes: r.nodes, edges };
          });
          log.push(`Panel silindi: "${lane.label}"`);
          break;
        }
        case 'add_node': {
          const p0 = processRef.current;
          if (!p0?.lanes?.length) { log.push('Əvvəlcə panel əlavə edin.'); break; }
          const lane = findLane(p0.lanes, a.lane ?? a.laneId) || p0.lanes[0];
          // The model reaches for names like "rectangle" / "decision"; an
          // unknown type renders as nothing on the canvas, so normalise it the
          // same way the diagram builder does.
          const shape = safeShape(a.shape);
          const style = safeStyle(a.style);
          const text = a.text || 'Yeni addım';
          const def = nodeDefaults(shape);
          const id = nextFreeNodeId(p0.nodes);
          let h = def.h;
          try { h = autoNodeHeight({ type: shape, style, w: def.w }, text); } catch { /* default */ }
          updateProcess(p => {
            const l = p.lanes.find(x => x.id === lane.id) || p.lanes[0];
            const laneNodes = p.nodes.filter(n => n.laneId === l.id);
            // Land it to the right of whatever is already in the lane, then let
            // the shared placement helper clear any leftover overlap.
            const startX = laneNodes.length
              ? Math.max(...laneNodes.map(n => n.x + n.w)) + 70
              : 85;
            const { x, y } = resolveNodePlacement(
              { x: startX, y: l.y + 30, w: def.w, h },
              laneNodes,
              { laneTop: l.y }
            );
            const info = { general: (a.general?.length ? a.general : ['']) };
            if (a.risks?.length) info.risks = a.risks;
            const node = { id, type: shape, style, x, y, laneId: l.id, w: def.w, h, text, info };
            const r = repackLanes(p.lanes, [...p.nodes, node]);
            return { ...p, lanes: r.lanes, nodes: r.nodes };
          });
          setSelection({ kind: 'node', id });
          log.push(`Node #${id} əlavə edildi: "${text}"`);
          break;
        }
        case 'update_node': {
          const exists = (processRef.current?.nodes || []).some(n => String(n.id) === String(a.nodeId));
          if (!exists) { log.push(`Node #${a.nodeId} tapılmadı.`); break; }
          updateProcess(p => ({
            ...p,
            nodes: p.nodes.map(n => {
              if (String(n.id) !== String(a.nodeId)) return n;
              const next = { ...n };
              if (a.shape) next.type = safeShape(a.shape);
              if (a.style) next.style = safeStyle(a.style);
              if (a.text != null) {
                next.text = a.text;
                try { next.h = autoNodeHeight(next, a.text); } catch { /* keep height */ }
              }
              if (a.general || a.risks) {
                next.info = { ...(n.info || {}) };
                if (a.general) next.info.general = a.general.length ? a.general : [''];
                if (a.risks) next.info.risks = a.risks;
              }
              return next;
            })
          }));
          log.push(`Node #${a.nodeId} yeniləndi.`);
          break;
        }
        case 'delete_node': {
          updateProcess(p => ({
            ...p,
            nodes: p.nodes.filter(n => String(n.id) !== String(a.nodeId)),
            edges: p.edges.filter(e => String(e.from) !== String(a.nodeId) && String(e.to) !== String(a.nodeId))
          }));
          setSelection(null);
          log.push(`Node #${a.nodeId} silindi.`);
          break;
        }
        case 'add_edge': {
          const p0 = processRef.current;
          const from = p0?.nodes.find(n => String(n.id) === String(a.from));
          const to = p0?.nodes.find(n => String(n.id) === String(a.to));
          if (!from || !to) { log.push('Ox üçün node tapılmadı.'); break; }
          // Ports come from the real geometry, not from the model's guess.
          const { s, t } = portsFor(from, to);
          updateProcess(p => {
            const dup = p.edges.some(e => String(e.from) === String(from.id) && String(e.to) === String(to.id));
            if (dup) return p;
            const edge = { from: from.id, to: to.id, s, e: t, dashed: !!a.dashed };
            if (a.label) edge.label = a.label;
            return { ...p, edges: [...p.edges, edge] };
          });
          log.push(`Ox: #${from.id} → #${to.id}`);
          break;
        }
        case 'delete_edge': {
          updateProcess(p => ({
            ...p,
            edges: p.edges.filter(e => !(String(e.from) === String(a.from) && String(e.to) === String(a.to)))
          }));
          log.push(`Ox silindi: #${a.from} → #${a.to}`);
          break;
        }
        case 'set_title': {
          updateProcess(p => ({
            ...p,
            ...(a.title != null ? { title: a.title } : {}),
            ...(a.subtitle != null ? { subtitle: a.subtitle } : {})
          }));
          log.push('Başlıq yeniləndi. (Siyahıdakı ad "Yadda saxla"dan sonra yenilənir.)');
          break;
        }
        case 'relayout': {
          updateProcess(p => {
            const r = repackLanes(p.lanes, p.nodes);
            return { ...p, lanes: r.lanes, nodes: r.nodes };
          });
          log.push('Yerləşmə səliqəyə salındı.');
          break;
        }
        case 'tidy_edges': {
          updateProcess(p => ({ ...p, edges: tidyEdges(p) }), 'tidy-edges');
          log.push('Bütün oxlar səliqəyə salındı (kəsişmə və üst-üstə düşmə olmadan). Ctrl+Z ilə geri ala bilərsiniz.');
          break;
        }
        case 'save':
          await save();
          log.push('Yadda saxlanıldı.');
          break;
        case 'present':
          setAiOpen(false);
          startPresentation();
          log.push('Təqdimat başladı.');
          break;
        case 'archive_diagram':
          await onArchiveDiagram();
          return log;
        case 'logout':
          logout();
          return log;
        default:
          log.push(`Naməlum əməliyyat: ${a.type}`);
      }
    }
    return log;
  }

  return (
    <>
      <div className={`topbar ${presenting ? 'is-hidden' : ''}`}>
        <div className="top-left">
          <button className="pill-chip back-chip" onClick={onBack}>
            <ChevronLeft size={16} />
            <span className="label">{process?.title || '...'}</span>
          </button>
        </div>

        <LogoFull />

        <div className="top-right">
          {!editMode && (
            <button
              className={`pill-chip edit-chip nospace ${fitWidth ? 'active' : ''}`}
              onClick={() => setFitWidth(v => !v)}
              title={fitWidth ? 'Klassik görünüş' : 'Tam en (ekrana sığdır)'}
            >
              {fitWidth ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              <span>{fitWidth ? t('topbar.fullwidth_off', 'Klassik') : t('topbar.fullwidth_on', 'Tam en')}</span>
            </button>
          )}

          {!isViewer && editMode && !panelOpen && (
            <button
              className="pill-chip edit-chip nospace"
              onClick={() => setPanelOpen(true)}
              title="Paneli aç"
            >
              <PanelRightOpen size={16} />
              <span>{t('topbar.panel', 'Panel')}</span>
            </button>
          )}

          {!isViewer && editMode && (
            <div className="history-group">
              <button
                className="hist-btn"
                onClick={undo}
                disabled={!histMeta.canUndo}
                title="Geri al (Ctrl+Z)"
              >
                <Undo2 size={16} />
              </button>
              <button
                className="hist-btn"
                onClick={redo}
                disabled={!histMeta.canRedo}
                title="İrəli al (Ctrl+Shift+Z)"
              >
                <Redo2 size={16} />
              </button>
            </div>
          )}

          <AiButton active={aiOpen} onClick={() => setAiOpen(v => !v)} />

          {process && process.nodes.length > 0 && (
            <button
              className="pill-chip present-chip nospace edit-chip"
              onClick={startPresentation}
              title="Təqdimat rejimi — addımları avtomatik göstər"
            >
              <MonitorPlay size={16} />
              <span>{t('topbar.presentation', 'Təqdimat')}</span>
            </button>
          )}

          {!isViewer && editMode && (
            <SaveReminder editMode={editMode} dirty={dirty} onSave={save} />
          )}

          {!isViewer && editMode && (
            <button
              className={`pill-chip save-chip ${dirty ? 'dirty' : ''}`}
              onClick={save}
              disabled={saving || !dirty}
            >
              {saving
                ? <Loader2 size={16} className="spin" />
                : savedFlash
                  ? <CheckCircle2 size={16} />
                  : <Save size={16} />
              }
              <span>{saving ? t('topbar.saving', 'Saxlanılır...') : savedFlash ? t('topbar.saved', 'Saxlanıldı') : t('topbar.save', 'Yadda saxla')}</span>
            </button>
          )}

          {!isViewer && (
            <button className="pill-chip edit-chip nospace" onClick={toggleEdit}>
              {editMode ? <Eye size={16} /> : <Edit3 size={16} />}
              <span>{editMode ? t('topbar.view', 'Baxış') : t('topbar.edit', 'Redaktə et')}</span>
            </button>
          )}

          {process && (
            <div className="topbar-status">
              <StatusControl value={status} editable={isAdmin} onChange={changeStatus} size={15} />
            </div>
          )}

          <button className="logout-btn" onClick={logout}>
            <LogOut size={16} /><span>{t('topbar.logout', 'Çıxış')}</span>
          </button>
        </div>
      </div>

      {isAdmin && !presenting && (
        <AiBinding
          context={aiContext}
          runActions={runAiActions}
          snapshot={aiSnapshot}
          suggestions={[
            'Bu diaqramı izah et',
            'SSO girişi üçün proses diaqramı qur',
            'Sonuncu addımdan sonra təsdiq mərhələsi əlavə et',
            'Riskləri olmayan node-ları tap',
            'Diaqramdakı məntiqi boşluqları və bağlanmamış budaqları yoxla'
          ]}
        />
      )}

      {!isViewer && hasDraft && !editMode && !presenting && (
        <div className="draft-banner">
          <span className="draft-banner-icon"><AlertCircle size={16} /></span>
          <div className="draft-banner-text">
            <span className="draft-banner-title">{tByText('Saxlanılmamış dəyişikliklər var')}</span>
            {draftTs && (
              <span className="draft-banner-time">
                <Clock size={12} /> {tByText('Son dəyişiklik:')} {formatDraftTime(draftTs)}
              </span>
            )}
          </div>
          <div className="draft-banner-actions">
            <button className="draft-btn primary" onClick={() => { setEditMode(true); setPanelOpen(true); }}>
              {tByText('Redaktəyə davam et')}
            </button>
            <button className="draft-btn" onClick={discardDraft}>{tByText('Ləğv et')}</button>
          </div>
        </div>
      )}

      <div className={`diagram-wrap ${editMode ? 'edit-mode' : ''} ${presenting ? 'presenting' : ''}`}>
        <div className="diagram-main" style={themeVars(process)}>
          <div
            className={`diagram-container ${fitWidth && !editMode ? 'fit' : ''}`}
            ref={containerRef}
            style={!isViewer && editMode && panelOpen ? { paddingTop: navbarH - 60, marginRight: sidebarOpen ? 400 : undefined } : undefined}
          >
            {loading && (
              <div className="empty-state"><Loader2 size={20} className="spin" />Yüklənir...</div>
            )}
            {error && !loading && (
              <div className="empty-state error">{error}</div>
            )}
            {!loading && !error && process && (() => {
              const pad = 32; // container padding (16 each side)
              const dims = canvasDims(process);
              const availW = Math.max(0, containerW - pad);
              const availH = Math.max(0, containerH - pad);
              const fit = fitWidth && !editMode && dims.w && dims.h && availW && availH;
              const scale = fit
                ? Math.min(1, availW / dims.w, availH / dims.h)
                : 1;
              const wrapStyle = scale < 1
                ? {
                    width: dims.w,
                    height: dims.h,
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left'
                  }
                : undefined;
              const canvas = (
                <DiagramCanvas
                  process={process}
                  selectedNodeId={editMode && selection?.kind === 'node' ? selection.id : null}
                  selectedEdgeId={editMode && selection?.kind === 'edge' ? selection.id : null}
                  modalNodeId={!editMode && selection?.kind === 'node' ? selection.id : null}
                  editMode={!isViewer && editMode}
                  onNodeClick={onNodeClick}
                  onLaneClick={onLaneClick}
                  onEdgeClick={onEdgeClick}
                  onNodeMove={onNodeMove}
                  onNodeMoveEnd={onNodeMoveEnd}
                  onCreateEdge={onCreateEdge}
                  onNodeTextChange={onNodeTextChange}
                  onEdgeLabelChange={onEdgeLabelChange}
                  onNodeResize={onNodeResize}
                  onNodeResizeEnd={onNodeResizeEnd}
                  onEdgeReconnect={onEdgeReconnect}
                  onBackgroundClick={closeModal}
                  onSelectedRectChange={setModalAnchorRect}
                  onNodeInteractionStart={() => setInteracting(true)}
                  onNodeInteractionEnd={() => setInteracting(false)}
                  onCanvasDropShape={onCanvasDropShape}
                  selectedNodeIds={selectedIds}
                  onMarqueeSelect={onMarqueeSelect}
                  onClearMultiSelect={() => setSelectedIds([])}
                  patchSelectedNodes={patchSelectedNodes}
                  deleteSelectedNodes={deleteSelectedNodes}
                  presentActiveId={presenting ? (presentCurrent?.id ?? null) : null}
                  zoom={fit ? 1 : zoom}
                  extraW={fit ? 0 : extra.w}
                  extraH={fit ? 0 : extra.h}
                />
              );
              return scale < 1
                ? <div className="canvas-scale" style={wrapStyle}>{canvas}</div>
                : canvas;
            })()}
          </div>
          {!loading && !error && process && !(fitWidth && !editMode) && !(!isViewer && editMode && panelOpen) && (
            <ZoomSlider zoom={zoom} onZoom={(z) => zoomAround(z)}
              shifted={!isViewer && editMode && panelOpen && sidebarOpen} />
          )}
        </div>

        {!isViewer && editMode && panelOpen && process && (
          <ErrorBoundary resetKey={process.id}>
          <AdminPanel
            process={process}
            selection={selection}
            setSelection={selectWithoutAnchor}
            updateProcess={updateProcess}
            onClose={() => setPanelOpen(false)}
            onHeightChange={setNavbarH}
            onSidebarChange={setSidebarOpen}
            addStyle={addStyle}
            setAddStyle={setAddStyle}
            onAddShape={onAddShape}
            onArchive={onArchiveDiagram}
            zoom={zoom}
            onZoom={zoomAround}
          />
          </ErrorBoundary>
        )}

        {!isViewer && editMode && selection && selection.menu !== false && process && !interacting && (
          <SelectionMenu
            selection={selection}
            process={process}
            updateProcess={updateProcess}
            setSelection={setSelection}
            anchorRect={modalAnchorRect}
          />
        )}
      </div>

      {presenting && (
        <div className="present-bar" onMouseDown={e => e.stopPropagation()}>
          <button className="present-btn" onClick={presentRestart} title="Əvvələ qayıt">
            <RotateCcw size={18} />
          </button>
          <button className="present-btn" onClick={() => { setPresentPlaying(false); presentPrev(); }}
            disabled={presentIndex <= 0} title="Əvvəlki">
            <SkipBack size={18} />
          </button>
          <button className="present-btn play" onClick={presentTogglePlay}
            title={presentPlaying ? 'Dayandır' : 'Oynat'}>
            {presentPlaying ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button className="present-btn" onClick={() => { setPresentPlaying(false); presentNext(); }}
            disabled={presentIndex >= presentOrder.length - 1} title="Növbəti">
            <SkipForward size={18} />
          </button>

          <div className="present-count" title="Nömrəyə keçmək üçün klikləyin">
            {presentJumpDraft != null ? (
              <input
                className="present-jump-input"
                type="number"
                min={1}
                max={presentOrder.length}
                autoFocus
                value={presentJumpDraft}
                onChange={e => setPresentJumpDraft(e.target.value)}
                onBlur={presentJumpCommit}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); presentJumpCommit(); }
                  else if (e.key === 'Escape') { e.preventDefault(); setPresentJumpDraft(null); }
                }}
              />
            ) : (
              <button
                className="present-jump-btn"
                onClick={() => setPresentJumpDraft(String(presentIndex + 1))}
                title="Nömrəyə keçmək üçün klikləyin"
              >
                {presentIndex + 1}
              </button>
            )}
            <span className="present-count-total"> / {presentOrder.length}</span>
          </div>

          <div className="present-sep" />

          <button
            className={`present-btn ${presentShowPopup ? 'on' : ''}`}
            onClick={() => setPresentShowPopup(v => !v)}
            title={presentShowPopup ? 'Popup-u gizlət' : 'Popup-u göstər'}
          >
            {presentShowPopup ? <Eye size={18} /> : <EyeOff size={18} />}
          </button>

          <label className="present-speed" title="Hər node üçün müddət">
            <Clock size={20} />
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={Math.round(presentDwell / 1000)}
              onChange={e => setPresentDwell(Number(e.target.value) * 1000)}
            />
            <span className="present-speed-val">{Math.round(presentDwell / 1000)}s</span>
          </label>

          <div className="present-sep" />
          <button className="present-btn exit" onClick={exitPresentation} title="Təqdimatdan çıx (Esc)">
            <X size={18} />
          </button>
        </div>
      )}

      {showModal && (
        <NodeModal
          node={presenting
            ? presentCurrent
            : process.nodes.find(n => String(n.id) === String(selection.id))}
          onClose={presenting ? () => {} : closeModal}
          anchorRect={modalAnchorRect}
          presentation={presenting}
        />
      )}

      {pendingEdge && (
        <div className="confirm-backdrop" onClick={() => setPendingEdge(null)}>
          <div className="confirm-card" onClick={e => e.stopPropagation()}>
            <div className="confirm-title">Oxlar kəsişir</div>
            <p className="confirm-text">
              Bu ox mövcud {pendingEdge.crossed.length > 1 ? 'oxlarla' : 'oxu ilə'} kəsişir:{' '}
              <b>{pendingEdge.crossed.join(', ')}</b>. Yenə də əlavə edilsin?
            </p>
            <div className="confirm-actions">
              <button className="confirm-btn ghost" onClick={() => setPendingEdge(null)}>
                Ləğv et
              </button>
              <button className="confirm-btn primary" onClick={confirmPendingEdge}>
                Bəli, əlavə et
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function themeVars(process) {
  const t = process?.theme || {};
  let s = {};
  if (t.node) {
    const vars = deriveAccentVars(t.node);
    if (vars) s = { ...s, ...vars };
  }
  if (t.lane) {
    const vars = deriveLaneVars(t.lane);
    if (vars) s = { ...s, ...vars };
  }
  if (t.edge) {
    const vars = deriveEdgeVars(t.edge);
    if (vars) s = { ...s, ...vars };
  }
  return s;
}

function normalizeProcess(p) {
  const lanes = (p.lanes || []).map((l, i) => ({
    id: l.id || `lane-${i + 1}`,
    label: l.label || '',
    y: l.y ?? 0,
    h: l.h ?? LANE_MIN_H
  }));
  // Coerce any legacy colour-objects (theme / per-node / per-edge) into plain
  // strings so nothing downstream ever calls a string method on an object.
  const nodes = (p.nodes || []).map(n => {
    const withColor = (n.color != null && typeof n.color !== 'string') ? { ...n, color: asColorString(n.color) } : n;
    const needed = autoNodeHeight(withColor, withColor.text);
    return needed > (withColor.h || 0) ? { ...withColor, h: needed } : withColor;
  });
  const edges = (p.edges || []).map(e =>
    (e.color != null && typeof e.color !== 'string') ? { ...e, color: asColorString(e.color) } : e
  );
  return {
    ...p,
    theme: normalizeTheme(p.theme),
    width: p.width || 1200,
    height: p.height || 600,
    lanes,
    nodes,
    edges
  };
}

/* Top-right zoom control (view mode): semi-transparent, floats over the canvas, only
   scales the diagram. 25%–200%, starts at 100%, click the % to reset. */
function ZoomSlider({ zoom, onZoom, shifted }) {
  const pct = Math.round(zoom * 100);
  return (
    <div className={`zoom-slider ${shifted ? 'shifted' : ''}`} onMouseDown={e => e.stopPropagation()}>
      <button className="zoom-btn" onClick={() => onZoom(zoom - 0.1)} title="Kiçilt (Ctrl + təkər)" aria-label="Kiçilt">−</button>
      <input
        className="zoom-range"
        type="range" min={25} max={200} step={5}
        value={pct}
        onChange={e => onZoom(Number(e.target.value) / 100)}
        aria-label="Miqyas"
      />
      <button className="zoom-btn" onClick={() => onZoom(zoom + 0.1)} title="Böyüt (Ctrl + təkər)" aria-label="Böyüt">+</button>
      <button className="zoom-pct" onClick={() => onZoom(1)} title="100%-ə qaytar">{pct}%</button>
    </div>
  );
}
