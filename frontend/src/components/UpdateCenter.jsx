// UpdateCenter.jsx — "Sistem yeniləməsi": install a new version from the
// panel, like a phone / OS update. The service keeps running; only the
// worker process restarts when backend code changed (see backend/server.js).
//
//   <UpdateButton />   topbar chip for admins (shows the version)
//   <UpdateWatcher />  for everyone: after an update, offers a page reload
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, UploadCloud, Check, Loader2, AlertTriangle, RotateCcw, ChevronDown, FileCode2,
  MonitorCog, Server, PackageCheck, CircleDot, History, RefreshCw, Sparkles, Bell, Send
} from 'lucide-react';
import { systemApi } from '../api/systemClient.js';

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const time = /T/.test(String(s)) ? ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
  return `${dd}.${mm}.${d.getFullYear()}${time}`;
}
const mb = n => (n / 1024 / 1024).toFixed(n > 10 * 1024 * 1024 ? 0 : 1) + ' MB';

/* ------------------------------------------------------------------ */
export function UpdateButton() {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);
  // developer only: admins do not see versions or installs
  const dev = typeof localStorage !== 'undefined' && localStorage.getItem('dev') === '1';
  const refresh = () => systemApi.overview().then(setInfo).catch(() => setInfo(null));
  useEffect(() => { if (dev) refresh(); }, [dev]);
  if (!dev || !info) return null;
  const pending = !!info.pending;
  const busy = ['installing', 'restarting'].includes(info.status?.state);
  return (
    <>
      <button
        type="button"
        className={`pill-chip upd-chip ${pending || busy ? 'has-news' : ''}`}
        onClick={() => setOpen(true)}
        title="Sistem yeniləməsi"
      >
        {busy ? <Loader2 size={15} className="upd-spin" /> : <PackageCheck size={15} />}
        <span>{busy ? 'Yenilənir…' : pending ? `Yeni: ${info.pending.version}` : `v${info.current.version}`}</span>
        {pending && !busy && <i className="upd-dot" />}
      </button>
      {open && <UpdateCenter initial={info} onClose={() => { setOpen(false); refresh(); }} />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Each user's own interface version                                   */
/* ------------------------------------------------------------------ */
// eslint-disable-next-line no-undef
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

function setUiCookie(version) {
  try { document.cookie = `mp_ui=${encodeURIComponent(version)}; path=/; max-age=${60 * 60 * 24 * 400}; samesite=lax`; } catch { /* ignore */ }
}

/** After login / on load: if this user runs another version than this page, load theirs. true = reloading. */
export async function syncMyInterface() {
  try {
    const me = await systemApi.myUi();
    if (!me?.enabled) return false;
    setUiCookie(me.mine);
    if (me.mine === APP_VERSION) { sessionStorage.removeItem('mp-ui-switch'); return false; }
    if (sessionStorage.getItem('mp-ui-switch') === me.mine) return false; // tried once already, do not loop
    sessionStorage.setItem('mp-ui-switch', me.mine);
    window.location.reload();
    return true;
  } catch { return false; }
}

async function switchTo(version) {
  await systemApi.setMyUi(version);
  setUiCookie(version);
  try { sessionStorage.removeItem('mp-ui-switch'); } catch { /* ignore */ }
  window.location.reload();
}

/* ------------------------------------------------------------------ */
const STATE_DONE = s => s === 'done';

export default function UpdateCenter({ initial, onClose }) {
  const [info, setInfo] = useState(initial);
  const [status, setStatus] = useState(initial?.status || null);
  const [upload, setUpload] = useState(null);      // { name, size, p }
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const fileRef = useRef(null);
  const bootRef = useRef(initial?.bootedAt || null);

  const active = status && ['installing', 'restarting'].includes(status.state);
  const finished = status && ['done', 'failed'].includes(status.state) && status.finishedAt
    && (!initial?.status?.finishedAt || status.finishedAt !== initial.status.finishedAt || active);
  const [watching, setWatching] = useState(active);

  async function reload() {
    try { const o = await systemApi.overview(); setInfo(o); setStatus(o.status); } catch (e) { setError(e.message); }
  }

  // follow the install, including the moment the server restarts
  useEffect(() => {
    if (!watching) return;
    let stop = false;
    async function tick() {
      try {
        const st = await systemApi.status();
        if (stop) return;
        setStatus(st);
        const restarted = st.bootedAt && bootRef.current && st.bootedAt !== bootRef.current;
        if (st.state === 'done' || st.state === 'failed') {
          if (st.state === 'done' && st.needs?.workerRestart && !restarted && !st.manualRestart) {
            // status says done, but this answer came from the old process
          } else {
            setWatching(false);
            reload();
            return;
          }
        }
      } catch { /* server restarting: keep polling */ }
      if (!stop) setTimeout(tick, 1000);
    }
    tick();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching]);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape' && !active) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, onClose]);

  async function pickFile(file) {
    if (!file) return;
    setError('');
    if (!/\.zip$/i.test(file.name)) { setError('Yeniləmə .zip faylı olmalıdır.'); return; }
    setUpload({ name: file.name, size: file.size, p: 0 });
    try {
      const plan = await systemApi.upload(file, p => setUpload(u => (u ? { ...u, p } : u)));
      setInfo(i => ({ ...i, pending: plan }));
      setUpload(null);
    } catch (e) {
      setUpload(null);
      setError(e.message);
    }
  }

  async function discard() {
    setError('');
    try { await systemApi.discard(); setInfo(i => ({ ...i, pending: null })); } catch (e) { setError(e.message); }
  }

  async function install() {
    setError('');
    try {
      bootRef.current = (await systemApi.version().catch(() => null))?.bootedAt || bootRef.current;
      const st = await systemApi.install();
      setStatus(st);
      setWatching(true);
    } catch (e) { setError(e.message); }
  }

  async function rollback() {
    setError('');
    setConfirmRollback(false);
    try {
      bootRef.current = (await systemApi.version().catch(() => null))?.bootedAt || bootRef.current;
      const st = await systemApi.rollback();
      setStatus(st);
      setWatching(true);
    } catch (e) { setError(e.message); }
  }

  const cur = info?.current || { version: '?' };
  const pending = info?.pending;
  const lastInstalled = (info?.history || []).find(h => !h.rolledBack);

  let body;
  if (!info?.canUpdate) {
    body = (
      <div className="upd-section">
        <VersionHero caption="Hazırkı versiya" version={cur.version} sub={cur.date ? fmtDate(cur.date) : ''} />
        <p className="upd-muted">Bu Vercel versiyasıdır. Burada yeniləmə GitHub-a push ilə olur; bu pəncərə yalnız öz serverdə yeniləmə quraşdırır.</p>
      </div>
    );
  } else if (watching || active || finished) {
    body = <Progress status={status} showLog={showLog} setShowLog={setShowLog} />;
  } else if (pending) {
    body = <PlanView plan={pending} showFiles={showFiles} setShowFiles={setShowFiles} supervised={info.supervised} />;
  } else {
    body = (
      <>
        <div className="upd-section">
          <VersionHero caption="Hazırkı versiya" version={cur.version} sub={[cur.date && fmtDate(cur.date), cur.title].filter(Boolean).join(', ')} />
          {cur.notes?.length > 0 && <Notes notes={cur.notes} title="Bu versiyada" collapsed />}
        </div>
        <label
          className={`upd-drop ${drag ? 'over' : ''} ${upload ? 'busy' : ''}`}
          onDragOver={e => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); pickFile(e.dataTransfer.files?.[0]); }}
        >
          <input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={e => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
          {upload ? (
            <>
              <Loader2 size={22} className="upd-spin" />
              <b>{upload.p < 1 ? 'Yüklənir' : 'Yoxlanılır'}: {upload.name}</b>
              <span className="upd-bar"><i style={{ width: `${Math.round(upload.p * 100)}%` }} /></span>
              <span className="upd-muted">{mb(upload.size)}</span>
            </>
          ) : (
            <>
              <UploadCloud size={24} />
              <b>Yeniləmə faylını seçin</b>
              <span className="upd-muted">.zip faylını bura sürükləyin və ya klikləyin. Quraşdırmadan əvvəl nəyin dəyişəcəyini görəcəksiniz.</span>
            </>
          )}
        </label>
        {status?.state === 'failed' && status.error && (
          <p className="upd-note bad"><AlertTriangle size={14} /> Son yeniləmə: {status.error}</p>
        )}
        {!info.supervised && (
          <p className="upd-note"><AlertTriangle size={14} /> Server köhnə qaydada işləyir. Bu versiyanı quraşdırdıqdan sonra xidməti bir dəfə əl ilə yenidən başladın; ondan sonra yeniləmələr dayanmadan quraşdırılacaq.</p>
        )}
        {(info.history || []).length > 0 && (
          <div className="upd-section">
            <h4 className="upd-h"><History size={14} /> Tarixçə</h4>
            <ul className="upd-history">
              {info.history.slice(0, 8).map((h, i) => (
                <li key={i} className={h.rolledBack ? 'rolled' : ''}>
                  <span className="upd-hv">{h.version}</span>
                  <span className="upd-hm">{fmtDate(h.at)}{h.by ? `, ${h.by}` : ''}</span>
                  {h.rolledBack && <span className="upd-tag">{h.failedToStart ? 'açılmadı, geri qaytarıldı' : 'geri qaytarıldı'}</span>}
                </li>
              ))}
            </ul>
            {lastInstalled && !confirmRollback && (
              <button type="button" className="upd-btn ghost danger" onClick={() => setConfirmRollback(true)}>
                <RotateCcw size={14} /> {lastInstalled.from} versiyasına qayıt
              </button>
            )}
            {confirmRollback && (
              <div className="upd-confirm">
                <span>{lastInstalled.version} silinib {lastInstalled.from} versiyası qaytarılsın? Data (diaqramlar, hesabat) dəyişmir.</span>
                <div>
                  <button type="button" className="upd-btn ghost" onClick={() => setConfirmRollback(false)}>Xeyr</button>
                  <button type="button" className="upd-btn primary danger" onClick={rollback}>Bəli, qayıt</button>
                </div>
              </div>
            )}
          </div>
        )}
      </>
    );
  }

  let footer = null;
  if (info?.canUpdate && !watching && !active) {
    if (finished) {
      footer = status.state === 'done'
        ? <button type="button" className="upd-btn primary" onClick={() => (status.rollback ? window.location.reload() : switchTo(status.to).catch(() => window.location.reload()))}><RefreshCw size={15} /> {status.rollback ? 'Səhifəni yenilə' : 'Mənim ekranımı yenilə'}</button>
        : <button type="button" className="upd-btn" onClick={() => { setStatus({ state: 'idle' }); reload(); }}>Bağla</button>;
    } else if (pending) {
      footer = (
        <>
          <button type="button" className="upd-btn ghost" onClick={discard}>Ləğv et</button>
          <button type="button" className="upd-btn primary" onClick={install} disabled={pending.nothingChanged}>
            <PackageCheck size={15} /> {pending.nothingChanged ? 'Dəyişiklik yoxdur' : 'Quraşdır'}
          </button>
        </>
      );
    }
  }

  return createPortal(
    <div className="upd-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !active) onClose(); }}>
      <div className="upd-sheet" role="dialog" aria-modal="true" aria-label="Sistem yeniləməsi">
        <div className="upd-head">
          <span className="upd-head-icon"><PackageCheck size={17} /></span>
          <h3>Sistem yeniləməsi</h3>
          <button type="button" className="upd-x" onClick={onClose} disabled={active} aria-label="Bağla"><X size={17} /></button>
        </div>
        <div className="upd-body">
          {body}
          {error && <div className="upd-error"><AlertTriangle size={15} /><span>{error}</span></div>}
        </div>
        {footer && <div className="upd-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

function VersionHero({ caption, version, sub, from }) {
  return (
    <div className="upd-hero">
      <span className="upd-hero-cap">{caption}</span>
      <span className="upd-hero-ver">{version}</span>
      {(sub || from) && <span className="upd-hero-sub">{from ? `hazırkı: ${from}` : ''}{from && sub ? ', ' : ''}{sub}</span>}
    </div>
  );
}

function Notes({ notes, title = 'Nə yenidir', collapsed = false }) {
  const [open, setOpen] = useState(!collapsed);
  if (!notes?.length) return null;
  return (
    <div className="upd-notes">
      <button type="button" className="upd-h as-btn" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <Sparkles size={14} /> {title} <ChevronDown size={14} className={`upd-chev ${open ? 'open' : ''}`} />
      </button>
      {open && <ul>{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </div>
  );
}

function PlanView({ plan, showFiles, setShowFiles, supervised }) {
  const f = plan.files;
  const n = f.added.length + f.changed.length + f.remove.length;
  const effects = [
    { icon: FileCode2, text: `${n} fayl dəyişəcək: ${f.added.length} yeni, ${f.changed.length} yenilənmiş${f.remove.length ? `, ${f.remove.length} silinəcək` : ''}`, sub: f.same ? `${f.same} fayl eynidir, toxunulmur` : null },
    plan.needs.frontendBuild && { icon: MonitorCog, text: 'Yeni interfeys versiyası qurulacaq', sub: 'Heç kimin ekranı özü dəyişmir. Hər istifadəçi öz zəngindən istədiyi vaxt keçəcək.' },
    plan.needs.backendInstall && { icon: PackageCheck, text: 'Server paketləri yenilənəcək (npm install)' },
    plan.needs.workerRestart
      ? { icon: Server, text: supervised ? 'Server özü yenidən başlayacaq' : 'Server əl ilə yenidən başladılmalıdır', sub: supervised ? 'Bir neçə saniyə. Xidməti dayandırmaq lazım deyil.' : 'net stop MapsPanel, sonra net start MapsPanel' }
      : { icon: Server, text: 'Server dayanmadan işləməyə davam edir' }
  ].filter(Boolean);
  const warnings = [
    plan.older && `Bu versiya (${plan.version}) hazırkından (${plan.from}) köhnədir.`,
    plan.sameVersion && !plan.nothingChanged && `Versiya nömrəsi eynidir (${plan.version}).`,
    plan.nothingChanged && 'Bu paketdəki bütün fayllar artıq quraşdırılıb.',
    plan.needs.fullRestart && 'server.js dəyişir: bu dəyişiklik xidmət növbəti dəfə yenidən başlayanda işə düşəcək.',
    !plan.hasManifest && 'Paketdə update.json yoxdur, versiya nömrəsi avtomatik verildi.'
  ].filter(Boolean);
  return (
    <div className="upd-section">
      <VersionHero caption={plan.title || 'Yeni versiya'} version={plan.version} from={plan.from} sub={fmtDate(plan.date)} />
      <Notes notes={plan.notes} />
      <div className="upd-effects">
        {effects.map((e, i) => (
          <div key={i} className="upd-effect">
            <e.icon size={16} />
            <div><b>{e.text}</b>{e.sub && <span>{e.sub}</span>}</div>
          </div>
        ))}
      </div>
      {warnings.map((w, i) => <p key={i} className="upd-note"><AlertTriangle size={14} /> {w}</p>)}
      {n > 0 && (
        <div className="upd-files">
          <button type="button" className="upd-h as-btn" onClick={() => setShowFiles(v => !v)} aria-expanded={showFiles}>
            <FileCode2 size={14} /> Faylların siyahısı <ChevronDown size={14} className={`upd-chev ${showFiles ? 'open' : ''}`} />
          </button>
          {showFiles && (
            <ul>
              {f.added.map(p => <li key={'a' + p}><i className="add">yeni</i>{p}</li>)}
              {f.changed.map(p => <li key={'c' + p}><i className="chg">dəyişib</i>{p}</li>)}
              {f.remove.map(p => <li key={'r' + p}><i className="del">silinir</i>{p}</li>)}
            </ul>
          )}
        </div>
      )}
      <p className="upd-muted small">Data (diaqramlar, hesabat, PDF-lər) və .env parametrləri yeniləmədə dəyişmir. Hazırkı fayllar ehtiyata alınır, xəta olsa avtomatik geri qaytarılır.</p>
    </div>
  );
}

function Progress({ status, showLog, setShowLog }) {
  if (!status) return <div className="upd-section"><Loader2 className="upd-spin" /></div>;
  const steps = status.steps || [];
  const done = steps.filter(s => STATE_DONE(s.state)).length;
  const pct = status.state === 'done' ? 100 : Math.round(((done + (steps.some(s => s.state === 'active') ? 0.5 : 0)) / Math.max(1, steps.length)) * 100);
  const failed = status.state === 'failed';
  const ok = status.state === 'done';
  return (
    <div className="upd-section">
      <div className={`upd-hero ${ok ? 'ok' : failed ? 'bad' : ''}`}>
        <span className="upd-hero-cap">
          {ok ? (status.rollback ? 'Geri qaytarıldı' : 'Quraşdırıldı') : failed ? 'Alınmadı' : status.rollback ? 'Geri qaytarılır' : 'Quraşdırılır'}
        </span>
        <span className="upd-hero-ver">{status.to}</span>
        {status.from && <span className="upd-hero-sub">{status.rollback ? `${status.from} əvəzinə` : `${status.from} versiyasından`}</span>}
      </div>
      <span className={`upd-bar big ${failed ? 'bad' : ''}`}><i style={{ width: `${failed ? 100 : pct}%` }} /></span>
      <ol className="upd-steps">
        {steps.map(s => (
          <li key={s.key} className={s.state}>
            <span className="upd-step-icon">
              {s.state === 'done' ? <Check size={13} /> : s.state === 'active' ? <Loader2 size={13} className="upd-spin" /> : s.state === 'failed' ? <X size={13} /> : <CircleDot size={11} />}
            </span>
            <span className="upd-step-text">{s.label}{s.detail ? <em>{s.detail}</em> : null}</span>
          </li>
        ))}
      </ol>
      {status.state === 'restarting' && <p className="upd-muted small">Server yenidən başlayır. Bu pəncərə özü yenilənəcək.</p>}
      {ok && status.manualRestart && (
        <p className="upd-note"><AlertTriangle size={14} /> Fayllar quraşdırıldı. Server kodu dəyişdiyi üçün xidməti bir dəfə yenidən başladın: net stop MapsPanel, sonra net start MapsPanel.</p>
      )}
      {ok && !status.manualRestart && !status.rollback && <p className="upd-muted">Hazırdır. Digər istifadəçilərdə zəng çıxacaq və hər kəs istədiyi vaxt keçəcək. Öz ekranınız üçün aşağıdakı düyməni basın.</p>}
      {ok && status.rollback && <p className="upd-muted">Hazırdır. Geri alınan versiyada olanlar avtomatik olaraq qalan ən yeni versiyaya keçir.</p>}
      {failed && (
        <div className="upd-error"><AlertTriangle size={15} /><span>{status.error}{status.rolledBack ? ' Əvvəlki fayllar geri qaytarıldı, panel köhnə versiya ilə işləyir.' : ''}</span></div>
      )}
      {status.log && (
        <div className="upd-files">
          <button type="button" className="upd-h as-btn" onClick={() => setShowLog(v => !v)} aria-expanded={showLog}>
            <FileCode2 size={14} /> Jurnal <ChevronDown size={14} className={`upd-chev ${showLog ? 'open' : ''}`} />
          </button>
          {showLog && <pre className="upd-log">{status.log.trim().split('\n').slice(-80).join('\n')}</pre>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Everyone: a bell when a newer interface is installed on the server.   */
/* Each user switches when they want, like a phone update.               */
/* ------------------------------------------------------------------ */
const notice = (() => {
  let data = null, timer = null, busy = false;
  const subs = new Set();
  async function refresh() {
    if (busy) return;
    busy = true;
    try { data = await systemApi.myUi(); } catch { /* keep the last answer */ }
    busy = false;
    subs.forEach(f => f(data));
  }
  return {
    refresh,
    subscribe(f) {
      subs.add(f);
      if (data) f(data);
      if (subs.size === 1) {
        refresh();
        timer = setInterval(refresh, 60000);
        window.addEventListener('focus', refresh);
      }
      return () => {
        subs.delete(f);
        if (!subs.size) { clearInterval(timer); window.removeEventListener('focus', refresh); }
      };
    }
  };
})();

const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

/**
 * Hub page, top right: who you are, which version YOUR screen runs, and a
 * bell that always opens: either "a new version is ready" or "you are up to
 * date", plus your own "update by itself" switch.
 */
export function HubAccount() {
  const [n, setN] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState('');
  const wrap = useRef(null);
  const name = (typeof localStorage !== 'undefined' && (localStorage.getItem('displayName') || localStorage.getItem('username'))) || '';
  useEffect(() => notice.subscribe(setN), []);
  useEffect(() => {
    if (!open) return;
    const off = e => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);

  const enabled = !!n?.enabled;
  const mine = enabled ? n.mine : APP_VERSION;
  const newer = enabled ? n.newer || [] : [];
  const latest = newer[0];
  const notes = newer.flatMap(v => v.notes || []).slice(0, 10);

  async function update() {
    setBusy(true); setErr('');
    try { await switchTo(latest.version); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  async function check() {
    setChecking(true);
    await notice.refresh();
    setTimeout(() => setChecking(false), 400);
  }
  async function toggleAuto() {
    setErr('');
    try { await systemApi.setMyAuto(!n.auto); await notice.refresh(); }
    catch (e) { setErr(e.message); }
  }

  return (
    <div className="hub-me" ref={wrap}>
      <span className="hub-me-chip" title={`${name}, versiya ${mine}`}>
        <span className="hub-me-av">{initials(name)}</span>
        <span className="hub-me-text"><b>{name}</b><span>v{mine}</span></span>
      </span>
      <div className="notif-wrap">
        <button
          type="button"
          className={`hist-btn notif-bell upd-bell ${open ? 'active' : ''}`}
          onClick={() => { setOpen(o => !o); if (!open) notice.refresh(); }}
          title={latest ? `Yeni versiya: ${latest.version}` : 'Yeniləmələr'}
          aria-expanded={open}
        >
          <Bell size={16} />
          {latest && <i className="upd-bell-dot" />}
        </button>
        {open && (
          <div className="notif-panel upd-bell-panel">
            {latest ? (
              <>
                <span className="upd-hero-cap">Yeni versiya hazırdır</span>
                <span className="upd-bell-ver">{latest.version}</span>
                <span className="upd-hero-sub">{latest.date ? `${fmtDate(latest.date)} tarixli. ` : ''}Sizdəki: {mine}</span>
                {notes.length > 0 && <ul className="upd-bell-notes">{notes.map((x, i) => <li key={i}>{x}</li>)}</ul>}
                <p className="upd-muted small">Yalnız sizin ekranınız yenilənir. Data hamı üçün eynidir, heç nə itmir.</p>
              </>
            ) : (
              <>
                <span className="upd-hero-cap">Ən son versiya sizdədir</span>
                <span className="upd-bell-ver ok">{mine}</span>
                <span className="upd-hero-sub">{enabled ? 'Yeni versiya çıxanda burada görünəcək.' : 'Bu serverdə versiya yeniləmələri yoxdur.'}</span>
              </>
            )}
            {enabled && (
              <button type="button" className="upd-auto" role="switch" aria-checked={!!n.auto} onClick={toggleAuto}>
                <span className="upd-auto-text">
                  <b>Avtomatik yenilə</b>
                  <span>Yeni versiya çıxanda 10 saniyəlik geri sayımdan sonra özü keçir</span>
                </span>
                <span className={`notif-switch ${n.auto ? 'on' : ''}`}><i /></span>
              </button>
            )}
            {err && <p className="upd-muted small" style={{ color: 'var(--danger)' }}>{err}</p>}
            <div className="upd-bell-actions">
              {enabled && (
                <button type="button" className="upd-btn ghost sm" onClick={check} disabled={checking}>
                  {checking ? <Loader2 size={14} className="upd-spin" /> : <RotateCcw size={14} />} Yoxla
                </button>
              )}
              {latest && (
                <button type="button" className="upd-btn primary sm" onClick={update} disabled={busy}>
                  {busy ? <Loader2 size={14} className="upd-spin" /> : <RefreshCw size={14} />} Yenilə
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Anywhere in the app: a user who switched "Avtomatik yenilə" on gets a
 * 10 second countdown when a new version appears, then moves to it.
 * "Ləğv et" skips that version for this session; the bell still offers it.
 */
export function AutoUpdater() {
  const [n, setN] = useState(null);
  const [left, setLeft] = useState(null);
  const [skipped, setSkipped] = useState(() => { try { return sessionStorage.getItem('mp-auto-skip') || ''; } catch { return ''; } });
  useEffect(() => notice.subscribe(setN), []);
  const target = n?.enabled && n.auto && n.newer?.length ? n.newer[0].version : null;
  const active = target && target !== skipped;

  useEffect(() => {
    if (!active) { setLeft(null); return; }
    setLeft(10);
    const t = setInterval(() => setLeft(s => (s == null ? s : s - 1)), 1000);
    return () => clearInterval(t);
  }, [active, target]);
  useEffect(() => {
    if (left === 0 && target) switchTo(target).catch(() => setLeft(null));
  }, [left, target]);

  if (!active || left == null) return null;
  function cancel() {
    try { sessionStorage.setItem('mp-auto-skip', target); } catch { /* ignore */ }
    setSkipped(target);
  }
  return createPortal(
    <div className="upd-toast upd-countdown" role="status">
      <span className="upd-count">{Math.max(0, left)}</span>
      <div className="upd-toast-text">
        <b>Yeni versiya {target}</b>
        <span>{left > 0 ? `${left} saniyəyə avtomatik yenilənir` : 'Yenilənir…'}</span>
      </div>
      <button type="button" className="upd-btn ghost sm" onClick={cancel}>Ləğv et</button>
      <button type="button" className="upd-btn primary sm" onClick={() => switchTo(target)}><RefreshCw size={14} /> İndi</button>
    </div>,
    document.body
  );
}
