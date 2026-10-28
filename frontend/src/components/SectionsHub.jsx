import { useState, useEffect } from 'react';
import { LogoFull } from './Logo.jsx';
import { LogOut } from './icons.jsx';
import { api, setToken } from '../api/client.js';
import { useLabels } from '../labels/LabelsContext.jsx';
import TitleEditButton from './TitleEditButton.jsx';
import Welcome1Img from '../assets/welcome/1.png';
import Welcome2Img from '../assets/welcome/2.png';
import Welcome3Img from '../assets/welcome/3.png';
import Welcome4Img from '../assets/welcome/4.png';

function fmtTime(d) {
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const period = h >= 12 ? 'PM' : 'AM';
  const hh = (h % 12 || 12).toString().padStart(2, '0');
  return `${hh}:${m} ${period}`;
}
function fmtDate(d) {
  const dd = d.getDate().toString().padStart(2, '0');
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function DiagramTileIcon() {
  return (
    <svg viewBox="0 0 64 64" width="56" height="56" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="6"  y="10" width="18" height="14" rx="3" />
      <rect x="40" y="10" width="18" height="14" rx="3" />
      <rect x="6"  y="40" width="18" height="14" rx="3" />
      <rect x="40" y="40" width="18" height="14" rx="3" />
      <path d="M24 17h16" />
      <path d="M24 47h16" />
      <path d="M15 24v16" />
      <path d="M49 24v16" />
    </svg>
  );
}

function PdfTileIcon() {
  return (
    <svg viewBox="0 0 64 64" width="56" height="56" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 6h24l12 12v34a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4Z" />
      <path d="M38 6v12h12" />
      <text x="32" y="44" textAnchor="middle" fontSize="11" fontWeight="800" stroke="none" fill="currentColor" fontFamily="inherit">PDF</text>
    </svg>
  );
}

function FileTileIcon_REMOVED() { return null; }

function TemplateTileIcon() {
  return (
    <svg viewBox="0 0 64 64" width="112" height="96" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="10" y="6" width="44" height="52" rx="4" />
      <path d="M10 20h44" />
      <path d="M18 30h12" />
      <path d="M18 38h20" />
      <path d="M18 46h16" />
      <path d="M40 30h6" />
    </svg>
  );
}

export default function SectionsHub({ onPick, onLogout }) {
  const { t: tLabel } = useLabels();
  const [now, setNow] = useState(new Date());
  const [settings, setSettings] = useState(null);
  const role = localStorage.getItem('role');
  const isAdmin = role === 'admin' || role === 'editor_2';

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => setSettings({}));
  }, []);

  const s = settings || {};
  const t = (k, d) => (s[k] != null ? s[k] : d);

  async function saveSettings(patch) {
    const next = await api.updateSettings(patch);
    setSettings(next);
  }

  function logout() {
    setToken(null);
    localStorage.removeItem('role');
    localStorage.removeItem('username');
    onLogout();
  }

  return (
    <>
      <div className="topbar">
        <div className="top-left">
          <div className="pill-chip">{fmtTime(now)}</div>
          <div className="pill-chip">{fmtDate(now)}</div>
        </div>
        <button className="logout-btn" onClick={logout}>
          <LogOut size={16} /><span>{tLabel('topbar.logout', 'Çıxış')}</span>
        </button>
      </div>
<br />
      <div className="home-wrap hub-wrap">
        <LogoFull size="large" />
        <h2 className="home-title">
          {t('org_title', 'ABŞERON LOGİSTİKA MƏRKƏZİ')}
          {isAdmin && settings && (
            <TitleEditButton
              heading="Başlığı dəyiş"
              nameLabel="Təşkilat adı"
              name0={t('org_title', 'ABŞERON LOGİSTİKA MƏRKƏZİ')}
              onSave={({ name }) => saveSettings({ org_title: name })}
            />
          )}
        </h2>

        <div className="sections-grid">
          <div className="tile-wrap">
            <button className="section-tile" onClick={() => onPick('diagrams')}>
              <div className="section-tile-icon"><img src={Welcome2Img} /></div>
              <div className="section-tile-title">{t('hub_diagrams_title', 'İş Axışları')}</div>
              <div className="section-tile-sub">{t('hub_diagrams_sub', 'Proses xəritələri')}</div>
            </button>
            {isAdmin && settings && (
              <div className="tile-edit">
                <TitleEditButton
                  heading="Bölmə adını dəyiş"
                  nameLabel="Başlıq"
                  name0={t('hub_diagrams_title', 'İş Axışları')}
                  withSubtitle subtitleLabel="Alt yazı"
                  subtitle0={t('hub_diagrams_sub', 'Proses xəritələri')}
                  onSave={({ name, subtitle }) =>
                    saveSettings({ hub_diagrams_title: name, hub_diagrams_sub: subtitle })}
                />
              </div>
            )}
          </div>


          <div className="tile-wrap">
            <button className="section-tile" onClick={() => onPick('pdfs')}>
              <div className="section-tile-icon"><img src={Welcome1Img} /></div>
              <div className="section-tile-title">{t('hub_pdf_title', 'Normativ Sənədlər')}</div>
              <div className="section-tile-sub">{t('hub_pdf_sub', 'Prosedurlar, prosesler, əsəsnamələr')}</div>
            </button>
            {isAdmin && settings && (
              <div className="tile-edit">
                <TitleEditButton
                  heading="Bölmə adını dəyiş"
                  nameLabel="Başlıq"
                  name0={t('hub_pdf_title', 'Normativ Sənədlər')}
                  withSubtitle subtitleLabel="Alt yazı"
                  subtitle0={t('hub_pdf_sub', 'Prosedurlar, prosesler, əsəsnamələr')}
                  onSave={({ name, subtitle }) =>
                    saveSettings({ hub_pdf_title: name, hub_pdf_sub: subtitle })}
                />
              </div>
            )}
          </div>

          <div className="tile-wrap">
            <button className="section-tile" onClick={() => onPick('templates')}>
               <div className="section-tile-icon"><img src={Welcome3Img} /></div>
              <div className="section-tile-title">{t('hub_tmpl_title', 'Şablonlar')}</div>
              <div className="section-tile-sub">{t('hub_tmpl_sub', 'Sənəd şablonları')}</div>
            </button>
            {isAdmin && settings && (
              <div className="tile-edit">
                <TitleEditButton
                  heading="Bölmə adını dəyiş"
                  nameLabel="Başlıq"
                  name0={t('hub_tmpl_title', 'Şablonlar')}
                  withSubtitle subtitleLabel="Alt yazı"
                  subtitle0={t('hub_tmpl_sub', 'Sənəd şablonları')}
                  onSave={({ name, subtitle }) =>
                    saveSettings({ hub_tmpl_title: name, hub_tmpl_sub: subtitle })}
                />
              </div>
            )}
          </div>

          <div className="tile-wrap">
            <button className="section-tile" onClick={() => onPick('jobs')}>
              <div className="section-tile-icon"><img src={Welcome4Img} /></div>
              <div className="section-tile-title">{t('hub_jobs_title', 'Vəzifə Təlimatları')}</div>
              <div className="section-tile-sub">{t('hub_jobs_sub', 'Struktur bölmələri üzrə vəzifələr')}</div>
            </button>
            {isAdmin && settings && (
              <div className="tile-edit">
                <TitleEditButton
                  heading="Bölmə adını dəyiş"
                  nameLabel="Başlıq"
                  name0={t('hub_jobs_title', 'Vəzifə Təlimatları')}
                  withSubtitle subtitleLabel="Alt yazı"
                  subtitle0={t('hub_jobs_sub', 'Struktur bölmələri üzrə vəzifələr')}
                  onSave={({ name, subtitle }) =>
                    saveSettings({ hub_jobs_title: name, hub_jobs_sub: subtitle })}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
