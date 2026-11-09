import { useState } from 'react';
import { Pencil } from './icons.jsx';
import NameModal from './NameModal.jsx';

// A small pencil button (admin) that opens NameModal to edit a label.
// onSave({ name, subtitle }) — subtitle only present when withSubtitle.
export default function TitleEditButton({
  heading = 'Adı dəyiş',
  nameLabel = 'Başlıq',
  name0 = '',
  withSubtitle = false,
  subtitleLabel = 'Alt yazı',
  subtitle0 = '',
  onSave,
  className = 'title-edit-btn',
  stopProp = false
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        title="Adı dəyiş"
        onClick={(e) => { if (stopProp) e.stopPropagation(); e.preventDefault(); setOpen(true); }}
      >
        <Pencil size={13} />
      </button>
      {open && (
        <NameModal
          heading={heading}
          nameLabel={nameLabel}
          name0={name0}
          withSubtitle={withSubtitle}
          subtitleLabel={subtitleLabel}
          subtitle0={subtitle0}
          onClose={() => setOpen(false)}
          onSave={async (v) => { await onSave(v); setOpen(false); }}
        />
      )}
    </>
  );
}
