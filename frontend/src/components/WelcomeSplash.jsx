// WelcomeSplash.jsx — right after an admin logs in: a big animated
// "Xoş gəldiniz, <name>" over the whole screen, then it lifts away and the
// app is there. Click or press any key to skip.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export default function WelcomeSplash({ name, onDone }) {
  const [leaving, setLeaving] = useState(false);
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  const letters = words.join(' ');

  useEffect(() => {
    const hold = reduce ? 1200 : 1500 + letters.length * 35;
    const t1 = setTimeout(() => setLeaving(true), hold);
    const t2 = setTimeout(onDone, hold + 650);
    const skip = () => { setLeaving(true); setTimeout(onDone, 350); };
    window.addEventListener('keydown', skip, { once: true });
    return () => { clearTimeout(t1); clearTimeout(t2); window.removeEventListener('keydown', skip); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div
      className={`welcome ${leaving ? 'leaving' : ''}`}
      onClick={() => { setLeaving(true); setTimeout(onDone, 350); }}
      role="status"
      aria-label={`Xoş gəldiniz, ${name}`}
    >
      <div className="welcome-inner">
        <span className="welcome-hi">Xoş gəldiniz,</span>
        <span className="welcome-name" aria-hidden="true">
          {words.map((w, wi) => {
            const before = words.slice(0, wi).join(' ').length + (wi ? 1 : 0);
            return (
              <span key={wi} className="welcome-word">
                {[...w].map((ch, i) => (
                  <span key={i} style={{ animationDelay: `${180 + (before + i) * 45}ms` }}>{ch}</span>
                ))}
              </span>
            );
          })}
        </span>
      </div>
    </div>,
    document.body
  );
}
