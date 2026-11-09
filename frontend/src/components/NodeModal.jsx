// NodeModal.jsx - viewer popup with unlimited custom sections + free icons
import { useEffect } from 'react';
import { X } from './icons.jsx';
import { Icon } from './iconLibrary.jsx';
import { getSections } from './infoModel.js';

export default function NodeModal({ node, onClose, anchorRect, presentation = false }) {
  // Escape closes the popup, same as clicking the backdrop. In presentation
  // mode the parent owns Escape (it exits the whole presentation), so skip it.
  useEffect(() => {
    if (!node || presentation) return;
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [node, onClose, presentation]);

  if (!node) return null;

  const sections = getSections(node).filter(s => s.items.length > 0);
  const cardStyle = computeCardStyle(anchorRect);

  return (
    <div
      className={`modal-backdrop ${presentation ? 'present' : ''}`}
      onClick={presentation ? undefined : onClose}
    >
      <div
        className={`modal-card ${presentation ? 'present-card' : ''}`}
        style={cardStyle}
        onClick={e => e.stopPropagation()}
      >
        {!presentation && (
          <button className="modal-close" onClick={onClose} aria-label="Bağla">
            <X size={18} />
          </button>
        )}

        {node.text && (
          <div className="modal-node-title">
            {node.icon && (
              <span
                className="modal-node-icon"
                style={node.color ? { background: `${node.color}1f`, color: node.color } : undefined}
              >
                <Icon name={node.icon} size={17} />
              </span>
            )}
            <span>{node.text}</span>
          </div>
        )}

        {sections.length === 0 && (
          <p className="popup-preview-empty">Bu addım üçün məlumat əlavə edilməyib.</p>
        )}

        {sections.map(s => (
          <div key={s.id} className={`modal-section ${s.risky ? 'risks' : ''}`}>
            <h3 style={s.color ? { color: s.color } : undefined}>
              <Icon name={s.icon} size={18} />
              <span>{s.title}:</span>
            </h3>
            {s.type === 'list' ? (
              <ul>{s.items.map((r, i) => <li key={i}>{r}</li>)}</ul>
            ) : (
              s.items.map((p, i) => <p key={i}>{p}</p>)
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const CARD_W = 560;
const MARGIN = 16;

function computeCardStyle(anchorRect) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxH = Math.round(vh * 0.82);

  if (!anchorRect) {
    return {
      position: 'fixed',
      left: Math.max(MARGIN, (vw - CARD_W) / 2),
      top: Math.max(MARGIN, (vh - 480) / 2),
      transform: 'none', margin: 0, maxHeight: maxH,
      width: Math.min(CARD_W, vw - 2 * MARGIN),
    };
  }

  let left;
  const rightRoom = vw - anchorRect.right - MARGIN;
  const leftRoom = anchorRect.left - MARGIN;
  if (rightRoom >= CARD_W) left = anchorRect.right + MARGIN;
  else if (leftRoom >= CARD_W) left = anchorRect.left - CARD_W - MARGIN;
  else left = Math.max(MARGIN, (vw - CARD_W) / 2);

  let top = anchorRect.top;
  top = Math.max(MARGIN, Math.min(top, vh - maxH - MARGIN));

  return {
    position: 'fixed', left, top, transform: 'none', margin: 0,
    maxHeight: maxH, width: Math.min(CARD_W, vw - 2 * MARGIN),
  };
}