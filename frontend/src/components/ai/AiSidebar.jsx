// AiSidebar.jsx
// The ALM-AI panel. It is deliberately dumb about the app: the parent (Home /
// Diagram / Hesabat) supplies a live `context` snapshot and a `runActions`
// executor, so the same panel works on every screen without knowing how each
// stores its state. Optional `snapshot()` (Diagram) returns a picture of the
// open diagram so the model can SEE it, not just read its JSON.
//
// What it does:
//   • streams the answer as it is written (with the model's reasoning, if any)
//   • attachments: pick, drag & drop or Ctrl+V — images, screenshots, PDFs
//     (every page), Word, Excel, CSV, text
//   • model picker (live list from the server) + "deep thinking" switch
//   • automatic failover when a model is rate-limited — shown, never blocking
//   • questions with clickable options (single or multi choice)
//   • proposed actions → confirm popup (nothing changes without approval)
//   • chat history, copy, edit & resend, regenerate, stop
//   • resizable / expandable panel

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import feel from '../../feel/feel.js';
import {
  Sparkles, ArrowUp, Square, Paperclip, Camera, Brain, ChevronDown, Check, Copy,
  RotateCcw, History, SquarePen, Maximize2, Minimize2, FileText, FileSpreadsheet,
  X, Gauge, Trash2, AlertCircle, Loader2, ChevronRight, Pencil, Search, RefreshCw,
  Eye, ListTree, Zap, ImagePlus, Cpu, ScanEye, GraduationCap, BookOpen, Plus
} from 'lucide-react';
import { aiApi, peekReply } from '../../api/aiClient.js';
import AiActionPopup from './AiActionPopup.jsx';
import AiMarkdown from './AiMarkdown.jsx';
import { describeAction } from './aiActions.js';
import { buildFromSpec } from './aiBuild.js';
import { buildDiagramSvg } from '../diagramExport.js';
import {
  ACCEPT, processFile, toWireMessages, slimForStorage, formatBytes, isSupported, svgToAttachment,
  recordSourceUse
} from './aiAttachments.js';
import './ai.css';

/* ------------------------------------------------------------------ */
/* storage (per browser; never required for the panel to work)         */
/* ------------------------------------------------------------------ */
const LS = {
  chats: 'alm-ai-chats-v2',
  active: 'alm-ai-active-v2',
  model: 'alm-ai-model-v2',
  deep: 'alm-ai-deep',
  width: 'alm-ai-width',
  check: 'alm-ai-autocheck'
};

const DIAGRAM_ACTIONS = new Set(['create_diagram', 'generate_diagram']);
const CHECK_PROMPT = '[Avtomatik yoxlama] Əlavədəki şəkil sənin təklif etdiyin diaqramın proqramda REAL görünüşüdür. ' +
  'Onu orijinal sənədlə (əvvəlki əlavələr) diqqətlə müqayisə et: addımlar və nömrələr, panellər, sütun/sıra mövqeyi, ' +
  'forma, stil/rəng (tünd dolu / ağ çərçivəli / ikiqat xətt), oxların istiqaməti və tərəfləri, kəsik xətlər, etiketlər, ' +
  'üst-üstə düşən və ya qarışıq xətlər. Fərq varsa düzəldilmiş TAM action-u qaytar, yoxdursa eyni action-u qaytar.';

/* ---------- "this diagram already exists" ---------- */
function normTitle(t) {
  return String(t || '').toLocaleLowerCase('az').replace(/[“”"'«»()\[\].,:;!?/\\_–—-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function titleSimilarity(a, b) {
  const x = normTitle(a), y = normTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length > 12 && (x.includes(y) || y.includes(x))) return 0.9;
  const A = new Set(x.split(' ')), B = new Set(y.split(' '));
  let common = 0;
  A.forEach(w => { if (B.has(w)) common++; });
  return (2 * common) / (A.size + B.size);
}
/** Diagrams in the list (or archive) whose title matches a create_diagram. */
export function findDuplicates(actions, ctx) {
  const create = (actions || []).find(a => a.type === 'create_diagram');
  if (!create || !ctx) return [];
  // the model already handles it (archives / restores the old one)
  const handled = new Set((actions || [])
    .filter(a => a.type === 'archive_diagram' || a.type === 'delete_diagram' || a.type === 'unarchive_diagram')
    .map(a => String(a.processId)));
  const groups = new Map((ctx.groups || []).map(g => [String(g.id), g.name]));
  const pool = [
    ...(ctx.processes || []).map(p => ({ ...p, archived: false, groupName: groups.get(String(p.groupId)) || '' })),
    ...(ctx.archived || []).map(p => ({ ...p, archived: true }))
  ];
  return pool
    .map(p => ({ ...p, score: titleSimilarity(create.title, p.title) }))
    .filter(p => p.score >= 0.82 && !handled.has(String(p.id)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

/* ---------- "no text left behind" ---------- */
const normWords = t => String(t || '').toLocaleLowerCase('az')
  .replace(/[“”"'«»()\[\].,:;!?/\\_–—•\uf0b7-]+/g, ' ').split(/\s+/).filter(w => w.length >= 3);
/** Lines of the PDF's text layer that don't appear anywhere in the diagram. */
export function missingTextLines(history, action) {
  const src = [...history].reverse().find(m => m.role === 'user' && !m.auto && m.attachments?.some(a => a.kind === 'pdf'));
  const pdf = src?.attachments?.find(a => a.kind === 'pdf');
  const pages = pdf?.pages || [];
  if (!pages.length) return null;
  const hay = new Set(normWords([
    action.title, action.subtitle,
    ...(action.lanes || []).map(l => (typeof l === 'string' ? l : l?.label)),
    ...(action.nodes || []).flatMap(n => [n.text, ...(n.general || []), ...(n.risks || [])]),
    ...(action.edges || []).map(e => e.label)
  ].join(' ')));
  const missing = [];
  for (const p of pages) {
    for (const raw of String(p.text || '').split('\n')) {
      const line = raw.trim();
      if (line.length < 6 || /^səhifə\s*\d+$/i.test(line) || /^\d+(\.\d+)*$/.test(line)) continue;
      const words = normWords(line);
      if (words.length < 2) continue;
      const found = words.filter(w => hay.has(w)).length;
      if (found / words.length < 0.7 && !missing.includes(line)) missing.push(line);
    }
  }
  return missing.slice(0, 40);
}

/** Picture of what a create/generate_diagram action will really look like. */
export async function previewOfAction(a, { name = 'yoxlama.png', source = 'preview' } = {}) {
  const built = buildFromSpec(a);
  const { svg, width, height } = buildDiagramSvg({ ...built, title: a.title || '' });
  return svgToAttachment(svg, { width, height, name, source });
}
function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function loadChats() {
  try { const a = JSON.parse(lsGet(LS.chats, '[]')); return Array.isArray(a) ? a : []; } catch { return []; }
}
function saveChats(chats) {
  let list = chats.slice(0, 40);
  for (let tries = 0; tries < 6; tries++) {
    if (lsSet(LS.chats, JSON.stringify(list))) return;
    list = list.slice(0, Math.max(1, Math.floor(list.length / 2)));   // quota — drop oldest
  }
}
function slimMessage(m) {
  const out = { ...m };
  delete out.streaming;
  if (m.attachments) out.attachments = m.attachments.map(slimForStorage);
  return out;
}

let idSeq = 0;
const uid = p => `${p}-${Date.now().toString(36)}-${(idSeq++).toString(36)}`;

/* ------------------------------------------------------------------ */

function viewLabel(ctx) {
  if (!ctx) return '';
  if (ctx.view === 'diagram') return ctx.diagram?.title ? `Diaqram · ${ctx.diagram.title}` : 'Diaqram';
  if (ctx.view === 'list') return 'İş axışları';
  if (ctx.view === 'hesabat') return 'Hesabat';
  return ctx.view || '';
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'indicə';
  if (s < 3600) return `${Math.floor(s / 60)} dəq əvvəl`;
  if (s < 86400) return `${Math.floor(s / 3600)} saat əvvəl`;
  return new Date(ts).toLocaleDateString('az-AZ', { day: 'numeric', month: 'short' });
}

function shortModel(id) {
  if (!id) return 'Model';
  if (id === 'auto') return 'Avtomatik';
  const m = String(id).split(':').slice(1).join(':') || id;
  return m.replace(/^models\//, '').replace(/^meta-llama\//, '').replace(/:free$/, '');
}

function actionsSummary(m) {
  if (!m.actions?.length) return '';
  const types = {};
  m.actions.forEach(a => { types[a.type] = (types[a.type] || 0) + 1; });
  const list = Object.entries(types).map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', ');
  const state = m.actionsState === 'done' ? 'icra edildi' : m.actionsState === 'cancelled' ? 'ləğv edildi' : 'gözləyir';
  return `\n\n[Təklif etdiyin əməliyyatlar: ${list} — ${state}]`;
}

/* ================================================================== */

export default function AiSidebar({ open, onClose, context, runActions, suggestions = [], snapshot }) {
  const [chats, setChats] = useState(loadChats);
  const [chatId, setChatId] = useState(() => {
    const id = lsGet(LS.active);
    return id && loadChats().some(c => c.id === id) ? id : uid('chat');
  });
  const [messages, setMessages] = useState(() => {
    const id = lsGet(LS.active);
    return loadChats().find(c => c.id === id)?.messages || [];
  });

  const [input, setInput] = useState('');
  const [draft, setDraft] = useState([]);           // attachments in the composer
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [tick, setTick] = useState(0);

  const [catalog, setCatalog] = useState(null);     // /api/ai/models
  const [catalogErr, setCatalogErr] = useState('');
  const [model, setModel] = useState(() => lsGet(LS.model, 'auto'));
  const [deep, setDeep] = useState(() => lsGet(LS.deep) === '1');
  const [autoCheck, setAutoCheck] = useState(() => lsGet(LS.check, '1') === '1');
  const [limits, setLimits] = useState(null);

  const [panel, setPanel] = useState(null);         // 'history' | 'usage' | null
  const [modelMenu, setModelMenu] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(() => {
    const w = parseInt(lsGet(LS.width, '480'), 10);
    return Number.isFinite(w) ? w : 480;
  });
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState(null);
  const [pending, setPending] = useState(null);     // { actions, ctx, msgId }
  const [toast, setToast] = useState('');
  const [ctxLabel, setCtxLabel] = useState('');

  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const abortRef = useRef(null);
  const stickRef = useRef(true);
  const dragDepth = useRef(0);
  const skipSaveRef = useRef(false);   // just opened from history — don't bump it
  const saveTimer = useRef(null);
  const [serverOk, setServerOk] = useState(true);

  /* ---------- lifecycle ---------- */
  // Chat history lives on the server (data/ai/) — same on every PC. The local
  // copy is only a cache for when the server can't be reached.
  async function syncChats() {
    try {
      const list = await aiApi.chats();
      if (!Array.isArray(list)) return;
      setChats(prev => {
        const local = new Map(prev.map(c => [c.id, c]));
        const merged = list.map(c => {
          const l = local.get(c.id);
          // keep cached messages only if they are not older than the server's
          return l && l.messages && (l.updatedAt || 0) >= (c.updatedAt || 0) ? { ...c, messages: l.messages } : c;
        });
        // chats made here that never reached the server (offline) stay listed
        prev.forEach(c => { if (!list.some(x => x.id === c.id) && c.unsynced) merged.push(c); });
        saveChats(merged);
        return merged;
      });
      setServerOk(true);
    } catch {
      setServerOk(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    try { setCtxLabel(viewLabel(context?.())); } catch { setCtxLabel(''); }
    if (!catalog) refreshCatalog(false);
    syncChats();
    // active chat opened on another PC / after a refresh: pull its messages
    if (!messages.length && chatId) {
      aiApi.getChat(chatId).then(c => {
        if (c?.messages?.length) { skipSaveRef.current = true; setMessages(m => (m.length ? m : c.messages)); }
      }).catch(() => {});
    }
    setTimeout(() => inputRef.current?.focus(), 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  // persist the active chat (slimmed) whenever it settles
  useEffect(() => {
    if (busy) return;
    lsSet(LS.active, chatId);
    if (!messages.length) return;
    if (skipSaveRef.current) { skipSaveRef.current = false; return; }
    setChats(prev => {
      const existing = prev.find(c => c.id === chatId);
      const firstUser = messages.find(m => m.role === 'user');
      const titled = messages.find(m => m.role === 'assistant' && m.title)?.title;
      const chat = {
        id: chatId,
        title: existing?.title || titled || (firstUser?.content || firstUser?.attachments?.[0]?.name || 'Yeni söhbət').slice(0, 60),
        view: existing?.view || ctxLabel,
        updatedAt: Date.now(),
        messages: messages.slice(-200).map(slimMessage)
      };
      if (titled && existing && existing.title !== titled && !existing.titleLocked) chat.title = titled;
      let tin = 0, tout = 0;
      messages.forEach(m => { if (m.meta) { tin += m.meta.tokensIn || 0; tout += m.meta.tokensOut || 0; } });
      chat.tokensIn = tin;
      chat.tokensOut = tout;
      chat.createdBy = existing?.createdBy || null;
      chat.unsynced = true;
      const next = [chat, ...prev.filter(c => c.id !== chatId)];
      saveChats(next);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        aiApi.saveChat(chat.id, { title: chat.title, view: chat.view, messages: chat.messages })
          .then(meta => {
            setServerOk(true);
            setChats(cur => {
              const upd = cur.map(c => (c.id === chat.id ? { ...c, ...meta, messages: c.messages, unsynced: false } : c));
              saveChats(upd);
              return upd;
            });
          })
          .catch(() => setServerOk(false));
      }, 500);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, busy, chatId]);

  // keep scrolled to the bottom unless the admin scrolled up to read
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, busy, open]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  // autosize the textarea
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, [input, open]);

  async function refreshCatalog(fresh) {
    setCatalogErr('');
    try {
      const c = await aiApi.models(fresh);
      setCatalog(c);
      if (c?.enabled) {
        const all = (c.groups || []).flatMap(g => g.models.map(m => `${g.provider}:${m.id}`));
        setModel(cur => (cur === 'auto' || (cur && all.includes(cur)) ? cur : 'auto'));
      }
    } catch (e) {
      setCatalogErr(e.message || 'Model siyahısı alınmadı');
    }
  }

  async function refreshLimits() {
    try { setLimits(await aiApi.limits()); } catch { setLimits(null); }
  }

  useEffect(() => { if (model) lsSet(LS.model, model); }, [model]);
  useEffect(() => { lsSet(LS.deep, deep ? '1' : '0'); }, [deep]);
  useEffect(() => { lsSet(LS.check, autoCheck ? '1' : '0'); }, [autoCheck]);

  const modelInfo = useMemo(() => {
    if (model === 'auto') return { id: 'auto', label: 'Avtomatik', auto: true };
    if (!catalog?.groups || !model) return null;
    const [prov, ...rest] = model.split(':');
    const id = rest.join(':');
    const g = catalog.groups.find(x => x.provider === prov);
    const m = g?.models.find(x => x.id === id);
    return m ? { ...m, provider: prov, providerLabel: g.label } : { id, label: id, provider: prov, providerLabel: g?.label || prov };
  }, [catalog, model]);

  /* ---------- attachments ---------- */
  const addFiles = useCallback(async (files, { pasted = false } = {}) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    for (const file of list) {
      if (!isSupported(file)) { setToast(`"${file.name}" dəstəklənmir`); continue; }
      const tempId = uid('tmp');
      setDraft(d => [...d, { id: tempId, name: file.name || 'şəkil', kind: 'loading', progress: 'Hazırlanır…' }]);
      try {
        const att = await processFile(file, {
          pasted,
          onProgress: p => setDraft(d => d.map(x => (x.id === tempId ? { ...x, progress: p } : x)))
        });
        setDraft(d => d.map(x => (x.id === tempId ? att : x)));
      } catch (e) {
        setDraft(d => d.filter(x => x.id !== tempId));
        setToast(e.message || 'Fayl oxunmadı');
      }
    }
    inputRef.current?.focus();
  }, []);

  async function addSnapshot() {
    if (!snapshot) return;
    const tempId = uid('tmp');
    setDraft(d => [...d, { id: tempId, name: 'diaqram.png', kind: 'loading', progress: 'Diaqramın şəkli çəkilir…' }]);
    try {
      const att = await snapshot();
      setDraft(d => d.map(x => (x.id === tempId ? att : x)));
    } catch (e) {
      setDraft(d => d.filter(x => x.id !== tempId));
      setToast(e.message || 'Diaqramın şəkli alınmadı');
    }
  }

  function onPaste(e) {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) {
      e.preventDefault();
      addFiles(files, { pasted: true });
    }
  }

  function onDragEnter(e) {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  }
  function onDragLeave(e) {
    if (!dragOver) return;
    e.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) { dragDepth.current = 0; setDragOver(false); }
  }
  function onDrop(e) {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  }

  /* ---------- conversation ---------- */
  const patch = (id, fn) => setMessages(ms => ms.map(m => (m.id === id ? { ...m, ...(typeof fn === 'function' ? fn(m) : fn) } : m)));

  function buildWire(history) {
    // Fold action results (system lines) into the next user turn so the model
    // knows what actually happened.
    const merged = [];
    let notes = [];
    for (const m of history) {
      if (m.role === 'system') { notes.push(m.content); continue; }
      if (m.role === 'user') {
        let prefix = notes.length ? `[Sistem qeydi: ${notes.join(' | ')}]\n\n` : '';
        notes = [];
        // the same file again → tell the model, so it asks before duplicating
        for (const a of m.attachments || []) {
          if (!a.hash || m.auto) continue;
          const earlier = merged.some(x => x.role === 'user' && x.attachments?.some(b => b.hash === a.hash));
          const uses = (a.usedBefore || []).filter(u => u.title);
          if (uses.length) {
            prefix += `[Qeyd: "${a.name}" faylı əvvəl də göndərilib — ondan "${uses[0].title}" diaqramı yaradılıb (${new Date(uses[0].at).toLocaleDateString('az-AZ')}).]\n`;
          } else if (earlier) {
            prefix += `[Qeyd: "${a.name}" faylı bu söhbətdə artıq göndərilib.]\n`;
          }
        }
        merged.push({ ...m, content: prefix + (m.content || (m.attachments?.length ? 'Əlavəyə bax.' : '')) });
      } else if (m.role === 'assistant' && !m.error) {
        // The version under review goes back in full, so the check turn can
        // correct it instead of rebuilding from scratch.
        const full = m.actionsState === 'checking' && m.actions?.length
          ? `\n\n[Yoxlanılan action-ların tam JSON-u]\n${JSON.stringify(m.actions)}`
          : '';
        const body = [m.content || '', m.ask ? `\n\n[Sualın: ${m.ask.text} — variantlar: ${(m.ask.options || []).join(' / ')}]` : '', actionsSummary(m), full].join('');
        merged.push({ ...m, content: body || '…' });
      }
    }
    const provider = !model || model === 'auto' ? 'auto' : model.split(':')[0];
    return toWireMessages(merged, { provider, maxBytes: catalog?.maxRequestBytes || 4 * 1024 * 1024 });
  }

  // Every proposed batch goes through here: a create_diagram whose title
  // already exists stops at a question instead of opening the popup.
  function offerActions(actions, ctx, msgId) {
    if (!actions?.length) return;
    const dupes = findDuplicates(actions, ctx);
    if (dupes.length) {
      patch(msgId, { dupes, actionsState: 'dupe' });
      return;
    }
    setPending({ actions, ctx, msgId });
  }

  function resolveDupe(m, choice, target) {
    let ctx = null;
    try { ctx = context(); } catch { /* ignore */ }
    const create = m.actions.find(a => a.type === 'create_diagram');
    const rest = m.actions.filter(a => a !== create);
    let actions;
    if (choice === 'replace') {
      actions = [{ type: 'archive_diagram', processId: target.id }, { ...create, groupId: create.groupId ?? target.groupId }, ...rest];
    } else if (choice === 'rename') {
      const base = create.title || 'Yeni diaqram';
      actions = [{ ...create, title: `${base} (yeni)` }, ...rest];
    } else if (choice === 'open') {
      actions = [{ type: 'open_diagram', processId: target.id }];
    } else if (choice === 'restore') {
      actions = [{ type: 'unarchive_diagram', processId: target.id }];
    } else {
      patch(m.id, { actionsState: 'cancelled', dupes: null });
      return;
    }
    patch(m.id, { actions, dupes: null, actionsState: 'pending' });
    setPending({ actions, ctx, msgId: m.id });
  }

  async function runTurn(history, opts = {}) {
    const asstId = uid('a');
    const placeholder = { id: asstId, role: 'assistant', content: '', streaming: true, thought: '', failovers: [], at: Date.now() };
    setMessages([...history, placeholder]);
    setBusy(true);
    setStartedAt(Date.now());
    stickRef.current = true;

    const ctl = new AbortController();
    abortRef.current = ctl;
    let raw = '';
    let ctx = null;

    try {
      ctx = context();
      const wire = buildWire(history);
      const res = await aiApi.chatStream(wire, ctx, {
        model: model || 'auto',
        thinking: deep ? 'high' : 'low',
        signal: ctl.signal,
        onDelta: t => { raw += t; patch(asstId, { content: peekReply(raw) }); },
        onThought: t => patch(asstId, m => ({ thought: (m.thought || '') + t })),
        onReset: () => { raw = ''; patch(asstId, { content: '' }); },
        chatId,
        onStatus: s => {
          if (s.type === 'failover') patch(asstId, m => ({ failovers: [...(m.failovers || []), s] }));
          if (s.type === 'read') patch(asstId, m => ({ status: `Diaqram oxunur: #${s.id}${s.title ? ` ${s.title}` : ''}`, reads: [...(m.reads || []), { id: s.id, title: s.title }] }));
          if (s.type === 'retry') patch(asstId, { status: 'Cavab düzgün formatda yenidən yazılır…' });
        }
      });

      const reply = res.reply || (res.actions?.length ? 'Aşağıdakı əməliyyatları təklif edirəm.' : (res.ask ? '' : '…'));
      let actions = res.actions || [];
      // A check turn that "forgot" the actions keeps the ones it was checking.
      if (opts.isCheck && !actions.length && opts.fallbackActions?.length) actions = opts.fallbackActions;
      const final = {
        ...placeholder,
        content: reply,
        streaming: false,
        thought: undefined,
        ask: res.ask || null,
        actions,
        actionsState: actions.length ? 'pending' : null,
        attachmentNotes: res.attachmentNotes || null,
        title: res.title || null,
        meta: res.meta || null,
        lesson: res.meta?.lessonSaved || null,
        isCheck: !!opts.isCheck
      };
      patch(asstId, m => ({ ...final, thought: m.thought }));
      if (!opts.isCheck) feel.play('receive');
      if (res.meta?.usage) setLimits(l => (l ? { ...l, usage: res.meta.usage } : l));

      // The model built a diagram from a document → show it what that diagram
      // really looks like and let it correct itself before the admin sees it.
      const diagram = actions.find(a => DIAGRAM_ACTIONS.has(a.type));
      const fromDocument = history.some(m => m.role === 'user' && !m.auto
        && m.attachments?.some(a => a.kind === 'pdf' || (a.kind === 'image' && a.source !== 'preview')));
      if (diagram && fromDocument && autoCheck && !opts.isCheck && !ctl.signal.aborted) {
        let shot = null;
        try { shot = await previewOfAction(diagram); } catch (err) { console.warn('[ai] preview failed', err); }
        if (shot) {
          patch(asstId, { actionsState: 'checking' });
          abortRef.current = null;
          const miss = missingTextLines(history, diagram);
          // step numbers must be real document numbers (30, 30.1, A.2) — never "30_m"
          const badIds = (diagram.nodes || []).map(n => String(n.id ?? '')).filter(id => id && !/^(\d+|[A-Z])(\.\d+)*$/i.test(id));
          const textNote = miss == null ? ''
            : miss.length
              ? `\n\n[Mətn yoxlaması: sənəddə olub diaqramda TAPILMAYAN sətirlər — hamısını yerinə əlavə et (node mətni, ox etiketi, panel adı və ya data bloku), heç birini buraxma:\n- ${miss.join('\n- ')}]`
              : '\n\n[Mətn yoxlaması: sənəddəki bütün sətirlər diaqramda var.]';
          const idNote = badIds.length
            ? `\n\n[Nömrə yoxlaması: bu id-lər sənəddə ola bilməz — PDF-in mətn qatından düzgün nömrəni tap və düzəlt: ${badIds.join(', ')}]`
            : '';
          const checkMsg = { id: uid('u'), role: 'user', auto: true, content: CHECK_PROMPT + textNote + idNote, attachments: [shot], missing: miss, at: Date.now() };
          const checked = await runTurn([...history, { ...final, actionsState: 'checking' }, checkMsg], {
            isCheck: true, fallbackActions: actions
          });
          patch(asstId, { actionsState: checked ? 'checked' : 'pending' });
          if (!checked) offerActions(actions, ctx, asstId);
          return final;
        }
      }
      if (actions.length) offerActions(actions, ctx, asstId);
      return final;
    } catch (e) {
      if (ctl.signal.aborted) {
        patch(asstId, m => ({ streaming: false, stopped: true, content: m.content || peekReply(raw) }));
      } else {
        patch(asstId, m => ({ streaming: false, error: e.message || 'AI cavab vermədi', content: m.content || '' }));
        feel.signal('error');
      }
    } finally {
      if (abortRef.current === ctl) abortRef.current = null;
      if (!opts.isCheck) setBusy(false);
    }
    return null;
  }

  function send(textArg) {
    if (busy) return;
    // Clicking a suggestion / answer option sends just that text; whatever is
    // in the composer stays there for the next message.
    const fromComposer = textArg === undefined;
    const ready = fromComposer ? draft.filter(a => a.kind !== 'loading') : [];
    if (fromComposer && draft.some(a => a.kind === 'loading')) { setToast('Fayllar hələ hazırlanır…'); return; }
    const content = String(textArg ?? input).trim();
    if (!content && !ready.length) return;
    const userMsg = { id: uid('u'), role: 'user', content, attachments: ready.length ? ready : undefined, at: Date.now() };
    if (fromComposer) { setInput(''); setDraft([]); }
    feel.play('send');
    runTurn([...messages, userMsg]);
  }

  function stop() {
    abortRef.current?.abort();
  }

  function regenerate() {
    if (busy) return;
    let idx = -1;
    messages.forEach((m, i) => { if (m.role === 'user') idx = i; });
    if (idx < 0) return;
    runTurn(messages.slice(0, idx + 1));
  }

  function editMessage(id) {
    if (busy) return;
    const idx = messages.findIndex(m => m.id === id);
    if (idx < 0) return;
    const m = messages[idx];
    setInput(m.content || '');
    setDraft((m.attachments || []).filter(a => !a.stale));
    setMessages(messages.slice(0, idx));
    if ((m.attachments || []).some(a => a.stale)) setToast('Köhnə söhbətin faylları yenidən əlavə edilməlidir');
    setTimeout(() => inputRef.current?.focus(), 30);
  }

  function newChat() {
    if (busy) stop();
    setChatId(uid('chat'));
    setMessages([]);
    setInput('');
    setDraft([]);
    setPending(null);
    setPanel(null);
    setTimeout(() => inputRef.current?.focus(), 30);
  }

  function openChat(c) {
    if (busy) return;
    skipSaveRef.current = true;
    setChatId(c.id);
    setMessages(c.messages || []);
    setPending(null);
    setPanel(null);
    // always take the server copy — it may have been continued on another PC
    aiApi.getChat(c.id).then(full => {
      if (full?.messages) { skipSaveRef.current = true; setMessages(full.messages); }
    }).catch(() => { if (!c.messages) setToast('Söhbət yüklənmədi'); });
  }

  function deleteChat(id) {
    setChats(prev => {
      const next = prev.filter(c => c.id !== id);
      saveChats(next);
      return next;
    });
    aiApi.deleteChat(id).catch(() => {});   // hidden on the server, the file is kept
    if (id === chatId) newChat();
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); setToast('Kopyalandı'); }
    catch { setToast('Kopyalanmadı'); }
  }

  /* ---------- actions ---------- */
  async function confirmActions(actions) {
    const msgId = pending?.msgId;
    setPending(null);
    setBusy(true);
    try {
      const results = await runActions(actions);
      const lines = (Array.isArray(results) ? results : [results]).filter(Boolean);
      if (msgId) patch(msgId, { actionsState: 'done', actionsRan: actions.length });
      // remember which files built which diagram, so sending one again is noticed
      const built = actions.filter(a => DIAGRAM_ACTIONS.has(a.type));
      if (built.length) {
        const idx = messages.findIndex(x => x.id === msgId);
        const src = messages.slice(0, idx < 0 ? messages.length : idx).reverse()
          .find(x => x.role === 'user' && !x.auto && x.attachments?.length);
        let title = built[0].title;
        if (!title) { try { title = context()?.diagram?.title; } catch { /* ignore */ } }
        (src?.attachments || []).forEach(a => recordSourceUse(a, title || 'diaqram'));
      }
      setMessages(m => [...m, { id: uid('s'), role: 'system', content: lines.length ? lines.join('\n') : 'Əməliyyat tamamlandı.', at: Date.now() }]);
    } catch (e) {
      setMessages(m => [...m, { id: uid('s'), role: 'system', error: true, content: 'Xəta: ' + (e.message || e), at: Date.now() }]);
    } finally {
      setBusy(false);
    }
  }

  function cancelActions() {
    const msgId = pending?.msgId;
    setPending(null);
    if (msgId) patch(msgId, { actionsState: 'cancelled' });
  }

  function reviewActions(m) {
    let ctx = null;
    try { ctx = context(); } catch { /* ignore */ }
    setPending({ actions: m.actions, ctx, msgId: m.id });
  }

  /* ---------- resize ---------- */
  function startResize(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = ev => {
      const w = Math.max(380, Math.min(window.innerWidth - 80, startW + (startX - ev.clientX)));
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('aip-resizing');
      setWidth(w => { lsSet(LS.width, String(Math.round(w))); return w; });
    };
    document.body.classList.add('aip-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  if (!open) return null;

  const empty = messages.length === 0;
  const lastAssistantIdx = (() => { let k = -1; messages.forEach((m, i) => { if (m.role === 'assistant') k = i; }); return k; })();
  const lastUserIdx = (() => { let k = -1; messages.forEach((m, i) => { if (m.role === 'user') k = i; }); return k; })();
  const panelWidth = expanded ? Math.min(1180, window.innerWidth - 40) : width;
  const elapsed = busy && startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0;
  void tick;
  const notConfigured = catalog && !catalog.enabled;

  return (
    <>
      <aside
        className={`aip ${expanded ? 'expanded' : ''}`}
        style={{ width: panelWidth }}
        onPaste={onPaste}
        onDragEnter={onDragEnter}
        onDragOver={e => { if (dragOver) e.preventDefault(); }}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            if (modelMenu) setModelMenu(false);
            else if (preview) setPreview(null);
            else if (panel) setPanel(null);
            else if (busy) stop();
            else onClose();
          }
        }}
      >
        {!expanded && <div className="aip-resize" onPointerDown={startResize} title="Eni dəyiş" />}

        {/* ---------- header ---------- */}
        <header className="aip-head">
          <div className="aip-brand">
            <span className="aip-mark"><Sparkles size={15} /></span>
            <div className="aip-brand-text">
              <strong>ALM-AI</strong>
              {ctxLabel && <span title={ctxLabel}>{ctxLabel}</span>}
            </div>
          </div>
          <div className="aip-head-tools">
            <button className="aip-ib" title="Yeni söhbət" onClick={newChat}><SquarePen size={16} /></button>
            <button className={`aip-ib ${panel === 'history' ? 'on' : ''}`} title="Söhbət tarixçəsi"
              onClick={() => setPanel(p => (p === 'history' ? null : 'history'))}><History size={16} /></button>
            <button className={`aip-ib ${panel === 'learn' ? 'on' : ''}`} title="Öyrəndikləri"
              onClick={() => setPanel(p => (p === 'learn' ? null : 'learn'))}><GraduationCap size={16} /></button>
            <button className={`aip-ib ${panel === 'usage' ? 'on' : ''}`} title="Model və istifadə"
              onClick={() => { setPanel(p => (p === 'usage' ? null : 'usage')); refreshLimits(); }}><Gauge size={16} /></button>
            <button className="aip-ib" title={expanded ? 'Kiçilt' : 'Genişləndir'} onClick={() => setExpanded(v => !v)}>
              {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button className="aip-ib" title="Bağla (Esc)" onClick={onClose}><X size={17} /></button>
          </div>
        </header>

        {/* ---------- drawers ---------- */}
        {panel === 'history' && (
          <div className="aip-drawer">
            <div className="aip-drawer-head">
              <span>Söhbətlər</span>
              <button className="aip-link" onClick={newChat}><SquarePen size={13} /> Yeni</button>
            </div>
            {!serverOk && (
              <div className="aip-warn"><AlertCircle size={14} /><span>Serverə qoşulmaq olmadı — yalnız bu kompüterdəki söhbətlər göstərilir.</span></div>
            )}
            {chats.length === 0 && <div className="aip-drawer-empty">Hələ söhbət yoxdur.</div>}
            <div className="aip-chatlist">
              {chats.map(c => (
                <div key={c.id} className={`aip-chatrow ${c.id === chatId ? 'on' : ''}`} onClick={() => openChat(c)}>
                  <div className="aip-chatrow-main">
                    <div className="aip-chatrow-title">{c.title || 'Söhbət'}</div>
                    <div className="aip-chatrow-sub">
                      {[c.view, c.updatedBy || c.createdBy, timeAgo(c.updatedAt),
                        (c.tokensIn || c.tokensOut) ? `${((c.tokensIn || 0) + (c.tokensOut || 0)).toLocaleString()} token` : null
                      ].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <button className="aip-ib sm" title="Sil" onClick={e => { e.stopPropagation(); deleteChat(c.id); }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {panel === 'learn' && <LearnPanel onToast={setToast} />}

        {panel === 'usage' && (
          <UsagePanel limits={limits} catalog={catalog} model={model} onRefresh={() => { refreshLimits(); refreshCatalog(true); }}
            autoCheck={autoCheck} setAutoCheck={setAutoCheck} />
        )}

        {/* ---------- messages ---------- */}
        <div
          className="aip-scroll"
          ref={scrollRef}
          onScroll={e => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {empty ? (
            <Welcome
              suggestions={suggestions}
              onPick={s => send(s)}
              canSnapshot={!!snapshot}
              onAttach={() => fileRef.current?.click()}
              onSnapshot={addSnapshot}
              notConfigured={notConfigured}
            />
          ) : (
            <div className="aip-thread">
              {messages.map((m, i) => {
                if (m.role === 'user') {
                  return (
                    <UserMessage key={m.id} m={m} canEdit={!busy && i === lastUserIdx}
                      onEdit={() => editMessage(m.id)} onPreview={setPreview} onCopy={() => copyText(m.content)} />
                  );
                }
                if (m.role === 'system') {
                  return (
                    <div key={m.id} className={`aip-sys ${m.error ? 'err' : ''}`}>
                      <span className="aip-sys-icon">{m.error ? <AlertCircle size={13} /> : <Check size={13} />}</span>
                      <div className="aip-sys-text">{m.content}</div>
                    </div>
                  );
                }
                return (
                  <AssistantMessage
                    key={m.id}
                    m={m}
                    isLast={i === lastAssistantIdx}
                    busy={busy}
                    elapsed={elapsed}
                    hadAttachments={!!messages[i - 1]?.attachments?.length}
                    onCopy={() => copyText(m.content)}
                    onRegenerate={regenerate}
                    onAnswer={send}
                    onReview={() => reviewActions(m)}
                    onDupe={(choice, target) => resolveDupe(m, choice, target)}
                    context={pending?.ctx}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* ---------- composer ---------- */}
        <footer className="aip-composer">
          {draft.length > 0 && (
            <div className="aip-drafts">
              {draft.map(a => (
                <AttachmentChip key={a.id} a={a} onRemove={() => setDraft(d => d.filter(x => x.id !== a.id))}
                  onPreview={() => a.kind !== 'loading' && setPreview(a)} />
              ))}
            </div>
          )}
          <div className={`aip-box ${busy ? 'busy' : ''}`}>
            <textarea
              ref={inputRef}
              rows={1}
              placeholder={draft.length ? 'Fayl haqqında nə soruşmaq istəyirsiniz?' : 'Sual verin, tapşırıq yazın və ya fayl əlavə edin…'}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (!busy) send();
                }
              }}
            />
            <div className="aip-box-bar">
              <div className="aip-box-left">
                <button className="aip-tool" title="Fayl əlavə et (PDF, şəkil, Word, Excel…)" onClick={() => fileRef.current?.click()}>
                  <Paperclip size={16} />
                </button>
                {snapshot && (
                  <button className="aip-tool" title="Açıq diaqramın şəklini əlavə et — AI onu görsün" onClick={addSnapshot}>
                    <Camera size={16} />
                  </button>
                )}
                <button className={`aip-tool toggle ${deep ? 'on' : ''}`} onClick={() => setDeep(v => !v)}
                  title="Dərin düşünmə: mürəkkəb sənədlər və böyük diaqramlar üçün daha diqqətli, bir az yavaş">
                  <Brain size={15} /><span>Dərin</span>
                </button>
                <div className="aip-model-wrap">
                  <button className={`aip-tool model ${modelMenu ? 'on' : ''}`} onClick={() => setModelMenu(v => !v)}
                    title="Modeli dəyiş">
                    <Cpu size={14} />
                    <span className="aip-model-name">{modelInfo ? (modelInfo.label || shortModel(model)) : (catalogErr ? 'Model ?' : '…')}</span>
                    <ChevronDown size={13} />
                  </button>
                  {modelMenu && (
                    <ModelMenu
                      catalog={catalog}
                      error={catalogErr}
                      value={model}
                      onPick={v => { setModel(v); setModelMenu(false); }}
                      onRefresh={() => refreshCatalog(true)}
                      onClose={() => setModelMenu(false)}
                    />
                  )}
                </div>
              </div>
              {busy && !pending ? (
                <button className="aip-send stop" onClick={stop} title="Dayandır (Esc)"><Square size={13} fill="currentColor" /></button>
              ) : (
                <button className="aip-send" data-sound="off" onClick={() => send()} title="Göndər (Enter)"
                  disabled={busy || (!input.trim() && !draft.length) || draft.some(a => a.kind === 'loading')}>
                  <ArrowUp size={17} />
                </button>
              )}
            </div>
          </div>
          <div className="aip-foot-note">
            Enter — göndər · Shift+Enter — yeni sətir · Ctrl+V — ekran görüntüsü yapışdır
          </div>
          <input ref={fileRef} type="file" multiple accept={ACCEPT} hidden
            onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        </footer>

        {dragOver && (
          <div className="aip-dropzone">
            <div className="aip-dropzone-inner">
              <ImagePlus size={28} />
              <strong>Faylı buraya buraxın</strong>
              <span>PDF, şəkil, ekran görüntüsü, Word, Excel, CSV, mətn</span>
            </div>
          </div>
        )}

        {toast && <div className="aip-toast">{toast}</div>}
      </aside>

      {preview && <Preview a={preview} onClose={() => setPreview(null)} />}

      {pending && (
        <AiActionPopup
          actions={pending.actions}
          context={pending.ctx}
          onCancel={cancelActions}
          onConfirm={confirmActions}
        />
      )}
    </>
  );
}

/* ================================================================== */
/* pieces                                                              */
/* ================================================================== */

function Welcome({ suggestions, onPick, canSnapshot, onAttach, onSnapshot, notConfigured }) {
  return (
    <div className="aip-welcome">
      <div className="aip-welcome-mark"><Sparkles size={22} /></div>
      <h2>Nə üzərində işləyək?</h2>
      <p>
        Proses diaqramı qurum, mövcud diaqramı izah edim, hesabatı təşkil edim və ya
        göndərdiyiniz sənədi oxuyum — PDF-in hər səhifəsini, şəkildəki hər formanı və oxu görürəm.
      </p>
      {notConfigured && (
        <div className="aip-warn">
          <AlertCircle size={14} />
          <span>AI açarı təyin edilməyib. Serverdə <code>GEMINI_API_KEY</code> əlavə edin.</span>
        </div>
      )}
      <div className="aip-quick">
        <button className="aip-quick-card" onClick={onAttach}>
          <span className="aip-quick-icon"><FileText size={16} /></span>
          <span><strong>Sənəd oxut</strong><em>PDF/şəkil → izah və ya diaqram</em></span>
        </button>
        {canSnapshot && (
          <button className="aip-quick-card" onClick={onSnapshot}>
            <span className="aip-quick-icon"><Eye size={16} /></span>
            <span><strong>Diaqramı göstər</strong><em>AI açıq diaqramı görsün</em></span>
          </button>
        )}
      </div>
      {suggestions.length > 0 && (
        <div className="aip-sugg">
          {suggestions.map((s, i) => (
            <button key={i} className="aip-sugg-item" onClick={() => onPick(s)}>
              <Zap size={13} /><span>{s}</span><ChevronRight size={14} className="aip-sugg-go" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AttachmentChip({ a, onRemove, onPreview, compact }) {
  if (a.kind === 'loading') {
    return (
      <div className="aip-chip loading">
        <span className="aip-chip-thumb"><Loader2 size={15} className="aip-spin" /></span>
        <span className="aip-chip-meta"><b>{a.name}</b><i>{a.progress}</i></span>
      </div>
    );
  }
  const Icon = a.kind === 'pdf' ? FileText : a.kind === 'text' && /xls|csv/.test(a.ext || a.name) ? FileSpreadsheet : FileText;
  const sub = a.kind === 'pdf'
    ? `PDF · ${a.pageCount || a.pages?.length || '?'} səh.`
    : a.kind === 'image'
      ? (a.source === 'diagram' ? 'Diaqram şəkli' : a.source === 'paste' ? 'Ekran görüntüsü' : 'Şəkil')
      : (a.ext || 'fayl').toUpperCase();
  return (
    <div className={`aip-chip ${compact ? 'compact' : ''} ${a.stale ? 'stale' : ''}`} onClick={onPreview} title={a.previewError || a.name}>
      <span className="aip-chip-thumb">
        {a.thumb ? <img src={a.thumb} alt="" /> : <Icon size={16} />}
      </span>
      <span className="aip-chip-meta">
        <b>{a.name}</b>
        <i>{sub}{a.size ? ` · ${formatBytes(a.size)}` : ''}</i>
        {a.usedBefore?.length > 0 && !compact && (
          <i className="aip-chip-used" title={a.usedBefore.map(u => u.title).join(', ')}>
            Əvvəl istifadə olunub: {a.usedBefore[0].title}
          </i>
        )}
      </span>
      {onRemove && (
        <button className="aip-chip-x" onClick={e => { e.stopPropagation(); onRemove(); }} title="Götür"><X size={12} /></button>
      )}
    </div>
  );
}

function UserMessage({ m, canEdit, onEdit, onPreview, onCopy }) {
  if (m.auto) {
    const shot = m.attachments?.[0];
    return (
      <div className="aip-autocheck">
        {shot?.thumb && (
          <button className="aip-autocheck-thumb" onClick={() => onPreview(shot)} title="Böyüt">
            <img src={shot.thumb} alt="" />
          </button>
        )}
        <div className="aip-autocheck-text">
          <b><ScanEye size={13} /> Avtomatik yoxlama</b>
          <span>Qurulacaq diaqramın real görünüşü AI-yə göstərildi — orijinal sənədlə müqayisə edir.</span>
          {Array.isArray(m.missing) && (
            <span className={m.missing.length ? 'aip-autocheck-miss' : 'aip-autocheck-ok'}>
              {m.missing.length ? `${m.missing.length} sətir mətn diaqramda tapılmadı — AI-yə əlavə etməsi tapşırıldı` : 'Sənəddəki bütün mətn diaqramda var'}
            </span>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="aip-user">
      {m.attachments?.length > 0 && (
        <div className="aip-user-atts">
          {m.attachments.map(a => <AttachmentChip key={a.id} a={a} compact onPreview={() => onPreview(a)} />)}
        </div>
      )}
      {m.content && <div className="aip-user-bubble">{m.content}</div>}
      <div className="aip-msg-tools right">
        {m.content && <button className="aip-ib xs" title="Kopyala" onClick={onCopy}><Copy size={13} /></button>}
        {canEdit && <button className="aip-ib xs" title="Redaktə et və yenidən göndər" onClick={onEdit}><Pencil size={13} /></button>}
      </div>
    </div>
  );
}

function AssistantMessage({ m, isLast, busy, elapsed, hadAttachments, onCopy, onRegenerate, onAnswer, onReview, onDupe, context }) {
  const [thoughtOpen, setThoughtOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [picked, setPicked] = useState([]);
  const streaming = !!m.streaming;
  const waiting = streaming && !m.content;

  const lastThought = useMemo(() => {
    const t = String(m.thought || '').trim();
    if (!t) return '';
    const head = t.split('\n').filter(l => /^\*\*.+\*\*$/.test(l.trim())).pop();
    return (head || t.split('\n').pop() || '').replace(/\*\*/g, '').slice(0, 120);
  }, [m.thought]);

  return (
    <div className={`aip-asst ${m.error ? 'has-error' : ''}`}>
      <div className="aip-asst-avatar"><Sparkles size={13} /></div>
      <div className="aip-asst-body">
        {(m.thought || waiting) && (
          <div className={`aip-thought ${thoughtOpen ? 'open' : ''}`}>
            <button className="aip-thought-head" onClick={() => m.thought && setThoughtOpen(v => !v)}>
              {streaming ? <Loader2 size={13} className="aip-spin" /> : <Brain size={13} />}
              <span className="aip-thought-label">
                {waiting
                  ? (m.status || lastThought || (hadAttachments ? 'Sənəd oxunur…' : 'Düşünürəm…'))
                  : (streaming ? 'Yazır…' : 'Düşüncə prosesi')}
              </span>
              {streaming && <span className="aip-elapsed">{elapsed}s</span>}
              {m.thought && <ChevronDown size={13} className="aip-thought-caret" />}
            </button>
            {thoughtOpen && m.thought && <div className="aip-thought-body"><AiMarkdown text={m.thought} /></div>}
          </div>
        )}

        {m.content && (
          <div className={`aip-asst-content ${streaming ? 'streaming' : ''}`}>
            <AiMarkdown text={m.content} />
          </div>
        )}

        {m.stopped && <div className="aip-note">Dayandırıldı.</div>}

        {(m.reads?.length > 0 || m.meta?.examples?.length > 0) && !streaming && (
          <div className="aip-refs">
            <BookOpen size={12} />
            <span>
              {m.reads?.length > 0 && <>Oxudu: {m.reads.map(r => `#${r.id}${r.title ? ` ${r.title}` : ''}`).join(', ')}. </>}
              {m.meta?.examples?.length > 0 && <>Nümunə götürdü: {m.meta.examples.map(e => `#${e.id} ${e.title}`).join(', ')}.</>}
            </span>
          </div>
        )}
        {m.lesson && (
          <div className="aip-lesson"><GraduationCap size={13} /><span>Yadda saxladı: {m.lesson}</span></div>
        )}

        {m.error && (
          <div className="aip-error">
            <AlertCircle size={14} />
            <div>
              <div className="aip-error-text">{m.error}</div>
              {isLast && !busy && (
                <button className="aip-link" onClick={onRegenerate}><RotateCcw size={12} /> Yenidən cəhd et</button>
              )}
            </div>
          </div>
        )}

        {m.attachmentNotes && (
          <div className={`aip-notes ${notesOpen ? 'open' : ''}`}>
            <button className="aip-notes-head" onClick={() => setNotesOpen(v => !v)}>
              <ListTree size={13} /><span>Sənəddən oxunanlar</span>
              <ChevronDown size={13} className="aip-thought-caret" />
            </button>
            {notesOpen && <div className="aip-notes-body"><AiMarkdown text={m.attachmentNotes} /></div>}
          </div>
        )}

        {m.ask && (
          <div className="aip-ask">
            <div className="aip-ask-q">{m.ask.text}</div>
            {m.ask.options?.length > 0 && (
              <div className="aip-ask-opts">
                {m.ask.options.map((opt, k) => {
                  const on = picked.includes(opt);
                  return (
                    <button
                      key={k}
                      className={`aip-opt ${on ? 'on' : ''}`}
                      disabled={busy || !isLast}
                      onClick={() => {
                        if (m.ask.multi) setPicked(p => (on ? p.filter(x => x !== opt) : [...p, opt]));
                        else onAnswer(opt);
                      }}
                    >
                      {m.ask.multi && <span className="aip-opt-box">{on && <Check size={11} />}</span>}
                      {opt}
                    </button>
                  );
                })}
              </div>
            )}
            {m.ask.multi && isLast && (
              <button className="aip-ask-send" disabled={busy || !picked.length} onClick={() => onAnswer(picked.join(', '))}>
                Seçilənləri göndər ({picked.length})
              </button>
            )}
            {isLast && <div className="aip-ask-hint">və ya öz cavabınızı aşağıda yazın</div>}
          </div>
        )}

        {m.dupes?.length > 0 && m.actionsState === 'dupe' && (
          <DupeCard m={m} busy={busy} onChoose={onDupe} />
        )}

        {m.actions?.length > 0 && m.actionsState !== 'dupe' && (
          <ActionsCard m={m} context={context} onReview={onReview} busy={busy} />
        )}

        {!streaming && !m.error && (m.content || m.ask) && (
          <div className="aip-msg-tools">
            <button className="aip-ib xs" title="Kopyala" onClick={onCopy}><Copy size={13} /></button>
            {isLast && !busy && <button className="aip-ib xs" title="Yenidən yarat" onClick={onRegenerate}><RotateCcw size={13} /></button>}
            {m.meta?.model && (
              <span className="aip-meta" title={(m.meta.attempts || []).map(a => `${a.provider}:${a.model} ${a.ok ? '✓' : '✗ ' + (a.error || '')}`).join('\n')}>
                {shortModel(`${m.meta.provider}:${m.meta.model}`)}
                {(m.meta.attempts || []).length > 1 ? ' · avtomatik seçildi' : ''}
                {m.meta.tokensIn ? ` · ${(m.meta.tokensIn + (m.meta.tokensOut || 0)).toLocaleString()} token` : ''}
                {m.meta.truncated ? ' · yarımçıq' : ''}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DupeCard({ m, busy, onChoose }) {
  const t = m.dupes[0];
  const create = m.actions.find(a => a.type === 'create_diagram');
  return (
    <div className="aip-ask aip-dupe">
      <div className="aip-ask-q">
        <AlertCircle size={14} /> Bu diaqram artıq var
      </div>
      <div className="aip-dupe-list">
        {m.dupes.map(d => (
          <div key={d.id} className="aip-dupe-row">
            <b>{d.title}</b>
            <span>{d.archived ? 'Arxivdə' : (d.groupName ? `Qovluq: ${d.groupName}` : 'Siyahıda')} · #{d.id}</span>
          </div>
        ))}
      </div>
      <div className="aip-dupe-q">“{create?.title}” yaradılmazdan əvvəl seçin — nə edək?</div>
      <div className="aip-ask-opts">
        {!t.archived && <button className="aip-opt" disabled={busy} onClick={() => onChoose('replace', t)}>Köhnəsini arxivlə, yenisini qur</button>}
        {t.archived && <button className="aip-opt" disabled={busy} onClick={() => onChoose('restore', t)}>Arxivdən bərpa et</button>}
        <button className="aip-opt" disabled={busy} onClick={() => onChoose('rename', t)}>Yeni adla ayrıca qur</button>
        {!t.archived && <button className="aip-opt" disabled={busy} onClick={() => onChoose('open', t)}>Mövcudu aç</button>}
        <button className="aip-opt" disabled={busy} onClick={() => onChoose('cancel', t)}>Heç nə etmə</button>
      </div>
      <div className="aip-ask-hint">Köhnə diaqram heç vaxt silinmir — yalnız arxivə köçür.</div>
    </div>
  );
}

function ActionsCard({ m, onReview, busy }) {
  const items = m.actions.slice(0, 4).map(a => {
    try { return describeAction(a, null).title; } catch { return a.type; }
  });
  const state = m.actionsState;
  return (
    <div className={`aip-acts ${state || ''}`}>
      <div className="aip-acts-head">
        <span className="aip-acts-icon">{state === 'done' ? <Check size={14} /> : state === 'checking' ? <Loader2 size={14} className="aip-spin" /> : <Zap size={14} />}</span>
        <span className="aip-acts-title">
          {state === 'done' ? `${m.actionsRan || m.actions.length} əməliyyat icra edildi`
            : state === 'cancelled' ? `${m.actions.length} əməliyyat ləğv edildi`
            : state === 'checking' ? 'Nəticə yoxlanılır…'
            : state === 'checked' ? 'İlk variant — yoxlanılıb, düzəldilmiş versiya aşağıdadır'
            : `${m.actions.length} əməliyyat təsdiq gözləyir`}
        </span>
      </div>
      <ul className="aip-acts-list">
        {items.map((t, i) => <li key={i}>{t}</li>)}
        {m.actions.length > 4 && <li className="more">… və daha {m.actions.length - 4}</li>}
      </ul>
      {state !== 'done' && state !== 'checking' && (
        <button className={`aip-acts-btn ${state === 'checked' ? 'ghost' : ''}`} onClick={onReview} disabled={busy}>
          <Eye size={13} /> {state === 'cancelled' || state === 'checked' ? 'Bu variantı aç' : 'Bax və təsdiq et'}
        </button>
      )}
    </div>
  );
}

function ModelMenu({ catalog, error, value, onPick, onRefresh, onClose }) {
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    setTimeout(() => document.addEventListener('mousedown', h), 0);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);

  const groups = (catalog?.groups || []).map(g => ({
    ...g,
    models: g.models.filter(m => !q || `${m.label} ${m.id}`.toLowerCase().includes(q.toLowerCase()))
  })).filter(g => g.models.length);
  const total = (catalog?.groups || []).reduce((n, g) => n + g.models.length, 0);

  return (
    <div className="aip-menu" ref={ref}>
      <div className="aip-menu-head">
        <span>Model</span>
        <button className="aip-ib xs" title="Siyahını yenilə" onClick={onRefresh}><RefreshCw size={13} /></button>
      </div>
      {total > 8 && (
        <div className="aip-menu-search">
          <Search size={13} />
          <input autoFocus placeholder="Model axtar…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      )}
      <div className="aip-menu-list">
        {catalog?.enabled && !q && (
          <div className="aip-menu-group">
            <button className={`aip-menu-item ${value === 'auto' ? 'on' : ''}`} onClick={() => onPick('auto')}>
              <span className="aip-menu-item-main">
                <span className="aip-menu-item-name">Avtomatik</span>
                <span className="aip-menu-badges">
                  <i className="def">tövsiyə</i>
                  <i>cavab verməyən model ötürülür</i>
                </span>
              </span>
              {value === 'auto' && <Check size={14} />}
            </button>
          </div>
        )}
        {error && <div className="aip-menu-empty">{error}</div>}
        {!catalog && !error && <div className="aip-menu-empty"><Loader2 size={14} className="aip-spin" /> Yüklənir…</div>}
        {catalog && !catalog.enabled && <div className="aip-menu-empty">Heç bir AI açarı təyin edilməyib.</div>}
        {groups.map(g => (
          <div key={g.provider} className="aip-menu-group">
            <div className="aip-menu-group-label">{g.label}</div>
            {g.models.map(m => {
              const id = `${g.provider}:${m.id}`;
              const on = id === value;
              const isDefault = id === catalog.autoFirst;
              return (
                <button key={id} className={`aip-menu-item ${on ? 'on' : ''}`} onClick={() => onPick(id)}>
                  <span className="aip-menu-item-main">
                    <span className="aip-menu-item-name">{m.label || m.id}</span>
                    <span className="aip-menu-badges">
                      {isDefault && <i className="dim">avtomatikdə birinci</i>}
                      {m.vision && <i>görür</i>}
                      {m.pdf && <i>PDF</i>}
                      {m.thinking && <i>düşünür</i>}
                      {m.context ? <i className="dim">{m.context >= 1e6 ? `${Math.round(m.context / 1e6)}M` : `${Math.round(m.context / 1000)}K`}</i> : null}
                    </span>
                  </span>
                  {on && <Check size={14} />}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="aip-menu-foot">Avtomatik: bir model cavab verməsə, səssizcə növbətisi sınanır — Gemini, Groq, OpenRouter.</div>
    </div>
  );
}

function UsagePanel({ limits, catalog, model, onRefresh, autoCheck, setAutoCheck }) {
  // saved counters (data/ai/usage.json) — same on every PC, survive restarts
  const st = limits?.stored;
  const td = st?.today, tot = st?.total;
  const tk = b => ((b?.tokensIn || 0) + (b?.tokensOut || 0)).toLocaleString();
  const top = Object.entries(st?.byModel || {}).sort((a, b) => (b[1].requests || 0) - (a[1].requests || 0)).slice(0, 5);
  const users = Object.entries(st?.byUser || {}).sort((a, b) => (b[1].requests || 0) - (a[1].requests || 0)).slice(0, 5);
  return (
    <div className="aip-drawer">
      <div className="aip-drawer-head">
        <span>Model və istifadə</span>
        <button className="aip-link" onClick={onRefresh}><RefreshCw size={12} /> Yenilə</button>
      </div>
      {!limits ? (
        <div className="aip-drawer-empty"><Loader2 size={14} className="aip-spin" /> Yüklənir…</div>
      ) : !limits.enabled ? (
        <div className="aip-warn"><AlertCircle size={14} /><span>AI açarı yoxdur. Serverdə <code>GEMINI_API_KEY</code> əlavə edin.</span></div>
      ) : (
        <>
          <div className="aip-stats">
            <div><b>{td?.requests ?? 0}</b><span>bu gün sorğu</span></div>
            <div><b>{tk(td)}</b><span>bu gün token</span></div>
            <div><b>{tot?.requests ?? 0}</b><span>cəmi sorğu</span></div>
            <div><b>{tk(tot)}</b><span>cəmi token</span></div>
          </div>
          <label className="aip-check">
            <input type="checkbox" checked={autoCheck} onChange={e => setAutoCheck(e.target.checked)} />
            <span>
              <b>Avtomatik yoxlama</b>
              <em>Sənəddən diaqram qurulanda AI nəticənin şəklinə baxıb orijinalla müqayisə edir və səhvləri təsdiqdən əvvəl düzəldir.</em>
            </span>
          </label>
          <div className="aip-kv"><span>Seçilmiş model</span><b>{shortModel(model) || '—'}</b></div>
          <div className="aip-kv"><span>Standart</span><b>{shortModel(catalog?.defaultModel) || '—'}</b></div>
          <div className="aip-kv"><span>Server</span><b>{catalog?.where === 'vercel' ? 'Vercel (əlavə ≤ 4MB)' : 'Öz server'}</b></div>
          {top.length > 0 && (
            <div className="aip-bymodel">
              <div className="aip-bymodel-h">Modellər</div>
              {top.map(([k, v]) => <div key={k}><span>{shortModel(k)}</span><b>{v.requests} · {tk(v)} token</b></div>)}
            </div>
          )}
          {users.length > 0 && (
            <div className="aip-bymodel">
              <div className="aip-bymodel-h">İstifadəçilər</div>
              {users.map(([k, v]) => <div key={k}><span>{k}</span><b>{v.requests} · {tk(v)} token</b></div>)}
            </div>
          )}
          <div className="aip-provs">
            {limits.providers.map(p => (
              <span key={p.name} className={`aip-prov ${p.configured ? 'on' : ''}`}>
                {p.label}{p.configured ? '' : ' — açar yoxdur'}
              </span>
            ))}
          </div>
          <div className="aip-drawer-note">{limits.usageNote}</div>
        </>
      )}
    </div>
  );
}

function Preview({ a, onClose }) {
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  let body;
  if (a.kind === 'image') {
    const src = a.data ? `data:${a.mime};base64,${a.data}` : a.thumb;
    body = src ? <img className="aip-pv-img" src={src} alt={a.name} /> : <div className="aip-pv-empty">Önizləmə yoxdur</div>;
  } else if (a.kind === 'pdf') {
    const pages = a.pages || [];
    body = (
      <div className="aip-pv-pages">
        {a.previewError && <div className="aip-warn"><AlertCircle size={14} /><span>{a.previewError}</span></div>}
        {pages.map(p => (
          <figure key={p.n} className="aip-pv-page">
            {p.image ? <img src={`data:image/jpeg;base64,${p.image}`} alt={`Səhifə ${p.n}`} />
              : p.thumb ? <img src={p.thumb} alt={`Səhifə ${p.n}`} />
              : <pre className="aip-pv-text">{p.text || '(mətn yoxdur)'}</pre>}
            <figcaption>Səhifə {p.n}</figcaption>
          </figure>
        ))}
        {!pages.length && !a.previewError && <div className="aip-pv-empty">Önizləmə yoxdur</div>}
      </div>
    );
  } else {
    body = <pre className="aip-pv-text">{a.text || '(məzmun saxlanılmayıb)'}</pre>;
  }
  return (
    <div className="aip-pv" onClick={onClose}>
      <div className="aip-pv-card" onClick={e => e.stopPropagation()}>
        <div className="aip-pv-head">
          <b>{a.name}</b>
          <span>{a.kind === 'pdf' ? `${a.pageCount || a.pages?.length || '?'} səhifə` : formatBytes(a.size)}</span>
          <button className="aip-ib" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="aip-pv-body">{body}</div>
      </div>
    </div>
  );
}


/* What ALM-AI learned on its own (data/ai/knowledge.json) + rules the admins
   taught it (lessons.json) + its log. */
function LearnPanel({ onToast }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const load = () => aiApi.learn().then(setData).catch(() => setData({ error: true }));
  useEffect(() => { load(); }, []);
  async function learnNow() {
    setBusy(true);
    try { await aiApi.learnNow(); await load(); onToast('Yenidən öyrəndi'); }
    catch (e) { onToast(e.message || 'Alınmadı'); }
    finally { setBusy(false); }
  }
  async function add() {
    const t = text.trim();
    if (t.length < 8) return;
    try { await aiApi.addLesson(t); setText(''); await load(); onToast('Qayda əlavə edildi'); } catch (e) { onToast(e.message); }
  }
  async function remove(id) {
    try { await aiApi.removeLesson(id); await load(); } catch (e) { onToast(e.message); }
  }
  return (
    <div className="aip-drawer">
      <div className="aip-drawer-head">
        <span>Öyrəndikləri</span>
        <button className="aip-link" onClick={learnNow} disabled={busy}>
          {busy ? <Loader2 size={12} className="aip-spin" /> : <RefreshCw size={12} />} İndi öyrən
        </button>
      </div>
      {!data ? (
        <div className="aip-drawer-empty"><Loader2 size={14} className="aip-spin" /> Yüklənir…</div>
      ) : data.error ? (
        <div className="aip-warn"><AlertCircle size={14} /><span>Məlumat alınmadı.</span></div>
      ) : (
        <>
          <div className="aip-learn-sub">
            {data.stats ? `${data.stats.diagrams} diaqram · ${data.stats.nodes} addım · ${data.stats.edges} ox` : 'Hələ öyrənməyib'}
            {data.learnedAt ? ` · ${timeAgo(data.learnedAt)}` : ''}
            {data.background ? ' · arxa fonda 24/7 işləyir' : ' · tələb olunanda öyrənir'}
          </div>
          {data.rules?.length > 0 && (
            <ul className="aip-learn-rules">{data.rules.map((r, i) => <li key={i}>{r}</li>)}</ul>
          )}
          <div className="aip-learn-h">Sizin öyrətdiyiniz qaydalar ({data.lessons?.length || 0})</div>
          <div className="aip-learn-add">
            <input value={text} onChange={e => setText(e.target.value)} placeholder="Yeni qayda yazın, məs. “Səhifə keçidi addım deyil”"
              onKeyDown={e => { if (e.key === 'Enter') add(); }} />
            <button className="aip-ib sm" title="Əlavə et" onClick={add}><Plus size={15} /></button>
          </div>
          {(data.lessons || []).map(l => (
            <div key={l.id} className="aip-lesson-row">
              <span>{l.text}</span>
              <em>{[l.by, timeAgo(l.at), l.count > 1 ? `${l.count}×` : null].filter(Boolean).join(' · ')}</em>
              <button className="aip-ib xs" title="Sil" onClick={() => remove(l.id)}><Trash2 size={12} /></button>
            </div>
          ))}
          {data.log?.length > 0 && (
            <>
              <div className="aip-learn-h">Jurnal</div>
              <div className="aip-learn-log">
                {data.log.slice(0, 15).map((x, i) => <div key={i}><b>{timeAgo(x.at)}</b> {x.message}</div>)}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
