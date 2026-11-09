import { useEffect, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import feel from './feel.js';

/** Topbar button: sound + haptics on / off (saved in this browser). */
export default function FeelToggle() {
  const [on, setOn] = useState(feel.enabled);
  const [bump, setBump] = useState(0);
  useEffect(() => feel.subscribe(s => setOn(s.sound || s.haptics)), []);
  return (
    <button
      type="button"
      className={`icon-btn feel-toggle ${on ? '' : 'off'} ${bump ? 'bump' : ''}`}
      data-sound="off"
      title={on ? 'Səs və titrəmə: açıq — söndürmək üçün klikləyin' : 'Səs və titrəmə: sönülü — açmaq üçün klikləyin'}
      aria-label={on ? 'Səsi söndür' : 'Səsi aç'}
      aria-pressed={on}
      onClick={() => {
        feel.setEnabled(!on);
        setBump(b => b + 1);
        setTimeout(() => setBump(0), 420);
      }}
    >
      {on ? <Volume2 size={17} /> : <VolumeX size={17} />}
    </button>
  );
}
