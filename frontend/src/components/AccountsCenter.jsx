// AccountsCenter.jsx — developer only: make and manage login accounts.
//   <AccountsButton />       topbar chip "Hesablar"
//   <ChangePasswordModal />  own password (forced on the developer's first login)
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Users, UserPlus, Loader2, AlertTriangle, KeyRound, Power, Pencil, Check, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { api } from '../api/client.js';

const ROLE_LABEL = {
  admin: 'Admin',
  viewer: 'Baxış (yalnız oxuyur)',
  editor_2: 'Mətn redaktoru',
  developer: 'Developer'
};
const COLORS = ['#F7CF5B', '#6B7A99', '#7DD3FC', '#F7900A', '#4CAF6A', '#E0218A', '#1A73E8', '#8B5CF6', '#14B8A6', '#EF4444'];
function colorFor(username) {
  let h = 0;
  for (const c of String(username)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
function textOn(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#1f2937' : '#fff';
}
const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

function randomPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const a = new Uint32Array(12);
  crypto.getRandomValues(a);
  const s = [...a].map(n => abc[n % abc.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

function Sheet({ title, icon: Icon, onClose, children, foot, closable = true, width = 560 }) {
  useEffect(() => {
    if (!closable) return;
    const k = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [closable, onClose]);
  return createPortal(
    <div className="upd-backdrop" onMouseDown={e => { if (closable && e.target === e.currentTarget) onClose(); }}>
      <div className="upd-sheet" style={{ width: `min(${width}px, 100%)` }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="upd-head">
          <span className="upd-head-icon"><Icon size={17} /></span>
          <h3>{title}</h3>
          {closable && <button type="button" className="upd-x" onClick={onClose} aria-label="Bağla"><X size={17} /></button>}
        </div>
        <div className="upd-body">{children}</div>
        {foot && <div className="upd-foot">{foot}</div>}
      </div>
    </div>,
    document.body
  );
}

function PasswordField({ value, onChange, placeholder, autoFocus, onGenerate }) {
  const [show, setShow] = useState(!!onGenerate);
  return (
    <div className="acc-pass">
      <input type={show ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} autoComplete="new-password" />
      <button type="button" className="acc-icon-btn" onClick={() => setShow(s => !s)} title={show ? 'Gizlət' : 'Göstər'}>{show ? <EyeOff size={15} /> : <Eye size={15} />}</button>
      {onGenerate && <button type="button" className="acc-gen" onClick={() => { onGenerate(); setShow(true); }}>Yarat</button>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
export function ChangePasswordModal({ forced = false, onDone, onLogout, onClose }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mismatch = again && next !== again;
  async function save() {
    setError('');
    if (next.length < 8) return setError('Yeni şifrə ən azı 8 simvol olmalıdır.');
    if (next !== again) return setError('Yeni şifrələr eyni deyil.');
    setBusy(true);
    try { await api.changePassword(cur, next); onDone?.(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return (
    <Sheet
      title={forced ? 'Yeni şifrə seçin' : 'Şifrəni dəyiş'}
      icon={KeyRound}
      closable={!forced}
      onClose={onClose}
      width={440}
      foot={(
        <>
          {forced
            ? <button type="button" className="upd-btn ghost" onClick={onLogout}>Çıxış</button>
            : <button type="button" className="upd-btn ghost" onClick={onClose}>Ləğv et</button>}
          <button type="button" className="upd-btn primary" onClick={save} disabled={busy || !cur || !next || !again}>
            {busy ? <Loader2 size={15} className="upd-spin" /> : <Check size={15} />} Şifrəni saxla
          </button>
        </>
      )}
    >
      {forced && <p className="upd-muted">Bu, ilk girişdir. Davam etmək üçün yalnız sizin bildiyiniz yeni şifrə seçin.</p>}
      <form className="acc-form" onSubmit={e => { e.preventDefault(); save(); }}>
        <label>Hazırkı şifrə<PasswordField value={cur} onChange={setCur} autoFocus /></label>
        <label>Yeni şifrə<PasswordField value={next} onChange={setNext} placeholder="Ən azı 8 simvol" /></label>
        <label>Yeni şifrə təkrar<PasswordField value={again} onChange={setAgain} /></label>
        {mismatch && <span className="acc-hint bad">Şifrələr eyni deyil</span>}
        <button type="submit" hidden />
      </form>
      {error && <div className="upd-error"><AlertTriangle size={15} /><span>{error}</span></div>}
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
export function AccountsButton() {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(false);
  const dev = typeof localStorage !== 'undefined' && localStorage.getItem('dev') === '1';
  if (!dev) return null;
  return (
    <>
      <button type="button" className="pill-chip upd-chip" onClick={() => setOpen(true)} title="Hesablar">
        <Users size={15} /><span>Hesablar</span>
      </button>
      {open && <AccountsCenter onClose={() => setOpen(false)} onPassword={() => { setOpen(false); setPw(true); }} />}
      {pw && <ChangePasswordModal onClose={() => setPw(false)} onDone={() => setPw(false)} />}
    </>
  );
}

function AccountsCenter({ onClose, onPassword }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);        // new account form
  const [edit, setEdit] = useState(null);        // { username, name, role, password }
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(null);        // { username, password } just created/reset — show once

  const load = () => api.listUsers().then(setData).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);

  async function create() {
    setError('');
    setBusy(true);
    try {
      await api.createUser(form);
      setMade({ username: form.username, password: form.password, name: form.name });
      setForm(null);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function saveEdit() {
    setError('');
    setBusy(true);
    try {
      const patch = { name: edit.name };
      if (!edit.builtin) {
        patch.role = edit.role;
        if (edit.password) patch.password = edit.password;
      }
      await api.updateUser(edit.username, patch);
      if (edit.password) setMade({ username: edit.username, password: edit.password, name: edit.name, reset: true });
      setEdit(null);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function toggle(u) {
    setError('');
    if (!u.disabled && !confirm(`"${u.name}" hesabı deaktiv edilsin? Həmin hesabla daxil olan hər kəs dərhal çıxarılacaq.`)) return;
    try { await api.updateUser(u.username, { disabled: !u.disabled }); await load(); }
    catch (e) { setError(e.message); }
  }

  const all = data ? [...data.users, ...data.builtins] : [];
  const roles = data?.roles || ['admin', 'viewer', 'editor_2'];

  return (
    <Sheet
      title="Hesablar"
      icon={Users}
      onClose={onClose}
      width={620}
      foot={<button type="button" className="upd-btn ghost" onClick={onPassword}><KeyRound size={14} /> Developer şifrəsini dəyiş</button>}
    >
      <p className="upd-muted">Burada yaratdığınız ad canlı kursorun yanında və tarixçədə görünür. Versiya yeniləmələri və bu pəncərə yalnız developer üçündür.</p>

      {made && (
        <div className="acc-made">
          <ShieldCheck size={18} />
          <div>
            <b>{made.reset ? 'Yeni şifrə saxlandı' : 'Hesab yaradıldı'}: {made.name}</b>
            <span>Bu məlumatı həmin şəxsə verin. Şifrə bir daha göstərilməyəcək.</span>
            <code>İstifadəçi adı: {made.username}{'\n'}Şifrə: {made.password}</code>
          </div>
          <button type="button" className="acc-icon-btn" onClick={() => setMade(null)} aria-label="Bağla"><X size={15} /></button>
        </div>
      )}

      {!form ? (
        <button type="button" className="upd-drop acc-new" onClick={() => setForm({ name: '', username: '', role: 'admin', password: randomPassword() })}>
          <UserPlus size={20} /><b>Yeni hesab yarat</b>
        </button>
      ) : (
        <form className="acc-card acc-form" onSubmit={e => { e.preventDefault(); create(); }}>
          <div className="acc-grid">
            <label>Ad, soyad<input autoFocus value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Məs. Kənan Musalı" /></label>
            <label>İstifadəçi adı<input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value.replace(/\s+/g, '').toLowerCase() }))} placeholder="kenan.m" autoComplete="off" /></label>
            <label>Rol
              <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                {roles.map(r => <option key={r} value={r}>{ROLE_LABEL[r] || r}</option>)}
              </select>
            </label>
            <label>Şifrə<PasswordField value={form.password} onChange={v => setForm(f => ({ ...f, password: v }))} onGenerate={() => setForm(f => ({ ...f, password: randomPassword() }))} /></label>
          </div>
          <div className="acc-actions">
            <button type="button" className="upd-btn ghost" onClick={() => setForm(null)}>Ləğv et</button>
            <button type="submit" className="upd-btn primary" disabled={busy || !form.name.trim() || form.username.length < 3 || form.password.length < 8}>
              {busy ? <Loader2 size={15} className="upd-spin" /> : <UserPlus size={15} />} Yarat
            </button>
          </div>
        </form>
      )}

      {error && <div className="upd-error"><AlertTriangle size={15} /><span>{error}</span></div>}

      {!data ? <div className="acc-loading"><Loader2 size={18} className="upd-spin" /></div> : (
        <ul className="acc-list">
          {all.map(u => {
            const c = colorFor(u.username);
            const editing = edit?.username === u.username;
            return (
              <li key={u.username} className={`${u.disabled ? 'off' : ''} ${editing ? 'editing' : ''}`}>
                <div className="acc-row">
                  <span className="pr-av" style={{ background: c, color: textOn(c) }}>{initials(u.name)}</span>
                  <span className="acc-who">
                    <b>{u.name}</b>
                    <span>{u.username}{u.builtin ? ', daxili hesab' : ''}{u.disabled ? ', deaktiv' : ''}</span>
                  </span>
                  <span className={`acc-role r-${u.role}`}>{ROLE_LABEL[u.role] || u.role}</span>
                  <button type="button" className="acc-icon-btn" title="Redaktə et" onClick={() => setEdit(editing ? null : { username: u.username, name: u.name, role: u.role, builtin: u.builtin, password: '' })}><Pencil size={14} /></button>
                  <button type="button" className={`acc-icon-btn ${u.disabled ? 'on' : 'danger'}`} title={u.disabled ? 'Aktiv et' : 'Deaktiv et'} onClick={() => toggle(u)}><Power size={14} /></button>
                </div>
                {editing && (
                  <form className="acc-form acc-edit" onSubmit={e => { e.preventDefault(); saveEdit(); }}>
                    <div className="acc-grid">
                      <label>Ad, soyad<input autoFocus value={edit.name} onChange={e => setEdit(x => ({ ...x, name: e.target.value }))} /></label>
                      {!u.builtin && (
                        <label>Rol
                          <select value={edit.role} onChange={e => setEdit(x => ({ ...x, role: e.target.value }))}>
                            {roles.map(r => <option key={r} value={r}>{ROLE_LABEL[r] || r}</option>)}
                          </select>
                        </label>
                      )}
                      {!u.builtin && (
                        <label className="span2">Yeni şifrə (boş qalsa dəyişmir)<PasswordField value={edit.password} onChange={v => setEdit(x => ({ ...x, password: v }))} onGenerate={() => setEdit(x => ({ ...x, password: randomPassword() }))} /></label>
                      )}
                    </div>
                    {u.builtin && <span className="acc-hint">Daxili hesabın şifrəsi və rolu proqramda yazılıb. Burada adını dəyişə və ya hesabı deaktiv edə bilərsiniz.</span>}
                    <div className="acc-actions">
                      <button type="button" className="upd-btn ghost" onClick={() => setEdit(null)}>Ləğv et</button>
                      <button type="submit" className="upd-btn primary" disabled={busy || !edit.name.trim() || (edit.password && edit.password.length < 8)}>
                        {busy ? <Loader2 size={15} className="upd-spin" /> : <Check size={15} />} Saxla
                      </button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
