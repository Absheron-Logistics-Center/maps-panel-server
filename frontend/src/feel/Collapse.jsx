import { useEffect, useRef, useState } from 'react';
import feel from './feel.js';

/**
 * Height-animated open/close for folder bodies. Children stay mounted while
 * closing so they can slide shut, and are unmounted afterwards (same as the
 * old `{open && ...}`). Plays the expand/collapse sound on user toggles only
 * (not on the first render).
 */
export default function Collapse({ open, children, sound = true }) {
  const [mounted, setMounted] = useState(open);
  const [phase, setPhase] = useState(open ? 'done' : 'closed'); // closed | opening | done | closing
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    let t1 = 0, raf1 = 0, raf2 = 0;
    if (open) {
      if (sound) { feel.play('expand'); feel.haptic('light'); }
      setMounted(true);
      setPhase('closed');
      // two frames so the 0fr state is painted before going to 1fr
      raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => setPhase('opening')); });
      t1 = setTimeout(() => setPhase('done'), 600);
    } else {
      if (sound) { feel.play('collapse'); feel.haptic('light'); }
      setPhase('closing');
      t1 = setTimeout(() => { setMounted(false); setPhase('closed'); }, feel.reduceMotion() ? 0 : 320);
    }
    return () => { clearTimeout(t1); cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!mounted) return null;
  const cls = phase === 'opening' ? 'is-open'
    : phase === 'done' ? 'is-open is-done'
      : phase === 'closing' ? 'is-closing' : '';
  return (
    <div className={`feel-collapse ${cls}`}>
      <div className="feel-collapse-inner">{children}</div>
    </div>
  );
}
