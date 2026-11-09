import { useState, useEffect, useRef } from 'react';
import { Bell, BellOff, Settings, Volume2, VolumeX, Save, X, Clock } from './icons.jsx';
import { useLabels } from '../labels/LabelsContext.jsx';
import notifySound from '../assets/notify.mp3';

const INTERVAL_KEY = 'absheron_notif_interval';
const SOUND_KEY = 'absheron_notif_sound';
const MIN_MIN = 1;
const MAX_MIN = 30;

function readInterval() {
  const v = parseInt(localStorage.getItem(INTERVAL_KEY), 10);
  return v >= MIN_MIN && v <= MAX_MIN ? v : 10;
}

export default function SaveReminder({ editMode, dirty, onSave }) {
  const { t } = useLabels();

  const [intervalMin, setIntervalMin] = useState(readInterval);
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem(SOUND_KEY) !== '0');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toastOpen, setToastOpen] = useState(false);

  const wrapRef = useRef(null);
  const audioRef = useRef(null);

  const editRef = useRef(editMode);
  const dirtyRef = useRef(dirty);
  const soundRef = useRef(soundOn);
  useEffect(() => { editRef.current = editMode; }, [editMode]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => { soundRef.current = soundOn; }, [soundOn]);

  useEffect(() => { localStorage.setItem(INTERVAL_KEY, String(intervalMin)); }, [intervalMin]);
  useEffect(() => { localStorage.setItem(SOUND_KEY, soundOn ? '1' : '0'); }, [soundOn]);

  useEffect(() => {
    const ms = intervalMin * 60 * 1000;
    const id = setInterval(() => {
      if (editRef.current && dirtyRef.current) {
        setToastOpen(true);
        if (soundRef.current) playChime();
      }
    }, ms);
    return () => clearInterval(id);
  }, [intervalMin]);

  useEffect(() => { if (!dirty) setToastOpen(false); }, [dirty]);
  useEffect(() => { if (!editMode) { setToastOpen(false); setSettingsOpen(false); } }, [editMode]);

  useEffect(() => {
    if (!settingsOpen) return;
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setSettingsOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [settingsOpen]);

  function playChime() {
    try {
      if (!audioRef.current) {
        audioRef.current = new Audio(notifySound);
        audioRef.current.volume = 0.6;
      }
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => synthChime());
    } catch (e) {
      synthChime();
    }
  }

  function synthChime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const notes = [1046.5, 1318.5, 1568.0];
      notes.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        const start = ctx.currentTime + i * 0.14;
        o.frequency.value = f;
        o.type = 'sine';
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
        o.connect(g); g.connect(ctx.destination);
        o.start(start); o.stop(start + 0.5);
      });
      setTimeout(() => ctx.close().catch(() => {}), 1200);
    } catch (e) { /* silent */ }
  }

  function saveNow() {
    setToastOpen(false);
    onSave && onSave();
  }

  return (
    <div className="notif-wrap" ref={wrapRef}>
      <button
        className={`hist-btn notif-bell ${settingsOpen ? 'active' : ''}`}
        onClick={() => setSettingsOpen(v => !v)}
        title={t('notif.settings', 'Bildiriş parametrləri')}
      >
        {soundOn ? <Bell size={16} /> : <BellOff size={16} />}
      </button>

      {settingsOpen && (
        <div className="notif-panel">
          <div className="notif-panel-head">
            <Settings size={14} />
            <span>{t('notif.title', 'Yadda saxlama xatırlatması')}</span>
          </div>

          <div className="notif-row">
            <label className="notif-label">
              {t('notif.every', 'Hər')} <b>{intervalMin}</b> {t('notif.minutes', 'dəqiqə')}
            </label>
            <input
              type="range"
              min={MIN_MIN}
              max={MAX_MIN}
              step={1}
              value={intervalMin}
              onChange={(e) => setIntervalMin(Number(e.target.value))}
              className="notif-range"
            />
            <div className="notif-range-scale">
              <span>{MIN_MIN} dəq</span>
              <span>{MAX_MIN} dəq</span>
            </div>
          </div>

          <button
            className="notif-sound-toggle"
            onClick={() => setSoundOn(v => !v)}
          >
            {soundOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
            <span>{t('notif.sound', 'Səs')}</span>
            <span className={`notif-switch ${soundOn ? 'on' : ''}`}><i /></span>
          </button>
        </div>
      )}

      {toastOpen && (
        <div className="notif-toast">
          <span className="notif-toast-icon"><Bell size={16} /></span>
          <div className="notif-toast-text">
            <span className="notif-toast-title">{t('notif.reminder_title', 'Yadda saxlamağı unutmayın')}</span>
            <span className="notif-toast-sub">
              <Clock size={12} /> {t('notif.reminder_sub', 'Xeyli redaktə etdiniz — dəyişiklikləri saxlayın.')}
            </span>
          </div>
          <div className="notif-toast-actions">
            <button className="draft-btn primary" onClick={saveNow}>{t('topbar.save', 'Yadda saxla')}</button>
            <button
              className="notif-gear"
              onClick={() => setSettingsOpen(true)}
              title={t('notif.settings', 'Bildiriş parametrləri')}
            >
              <Settings size={15} />
            </button>
            <button className="notif-gear" onClick={() => setToastOpen(false)} title={t('notif.dismiss', 'Bağla')}>
              <X size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}