// AiButton.jsx
// Admin-only trigger. It renders nothing at all for viewers/editors, so the
// button simply doesn't exist for them — and the backend rejects /api/ai/*
// for non-admins too, so hiding it isn't the only line of defence.

import { Sparkles } from 'lucide-react';

export default function AiButton({ active, onClick }) {
  if (localStorage.getItem('role') !== 'admin') return null;
  return (
    <button
      className={`icon-btn ai-trigger ${active ? 'active' : ''}`}
      title="ALM-AI"
      onClick={onClick}
    >
      <Sparkles size={17} />
    </button>
  );
}
