import { useMemo } from 'react';

// Popup shown by the Sheets Excel import when a row has the SAME NAME as an
// existing row but other cells differ (status, struktur adı, number…).
// The admin decides per row: combine (and pick which value to keep for every
// differing field) or add it as a separate row. Nothing is written until
// "Tətbiq et" is pressed; "Ləğv et" imports nothing.
//
// props:
//   plan        – from buildImportPlan()
//   decisions   – { [conflictId]: { action: 'combine'|'separate', pick: { field: 'current'|'incoming' } } }
//   setDecisions
//   labelOf(field)   – column label
//   valueLabel(field, value) – display text for a value (status key → label)
//   onApply, onCancel
export default function ImportConflictModal({
  plan, decisions, setDecisions, labelOf, valueLabel, onApply, onCancel
}) {
  const total = plan.conflicts.length;
  const combineCount = useMemo(
    () => plan.conflicts.filter(c => (decisions[c.id]?.action || 'combine') === 'combine').length,
    [plan, decisions]
  );

  function setAction(id, action) {
    setDecisions(prev => ({ ...prev, [id]: { ...prev[id], action } }));
  }
  function setPick(id, field, which) {
    setDecisions(prev => ({
      ...prev,
      [id]: { ...prev[id], action: 'combine', pick: { ...(prev[id]?.pick || {}), [field]: which } }
    }));
  }
  // bulk helpers
  function bulk(action, which) {
    const next = {};
    for (const c of plan.conflicts) {
      const pick = {};
      for (const d of c.diffs) pick[d.field] = which || 'current';
      next[c.id] = { action, pick };
    }
    setDecisions(next);
  }

  return (
    <div className="imp-backdrop" role="dialog" aria-modal="true">
      <div className="imp-card">
        <div className="imp-head">
          <h2>Excel idxalı: {total} fərq tapıldı</h2>
          <p>
            Bu sətirlərin adı artıq siyahıda var, amma bəzi xanalar fərqlidir.
            Hər biri üçün <b>birləşdirin</b> (hansı dəyərin qalacağını seçin) və ya
            <b> ayrı sətir</b> kimi əlavə edin. Eyni olan sətirlər avtomatik birləşdirilib.
          </p>
          <div className="imp-summary">
            <span><b>{plan.toCreate.length}</b> yeni sətir</span>
            <span><b>{plan.autoMerge.length + plan.unchanged}</b> eyni (birləşdirilir)</span>
            {plan.mergedInFile > 0 && <span><b>{plan.mergedInFile}</b> faylda təkrar</span>}
            <span><b>{total}</b> qərar gözləyir</span>
          </div>
          <div className="imp-bulk">
            <button type="button" className="btn small" onClick={() => bulk('combine', 'incoming')}>
              Hamısını birləşdir — Excel dəyərləri
            </button>
            <button type="button" className="btn small" onClick={() => bulk('combine', 'current')}>
              Hamısını birləşdir — mövcud dəyərlər
            </button>
            <button type="button" className="btn small" onClick={() => bulk('separate')}>
              Hamısını ayrı sətir əlavə et
            </button>
          </div>
        </div>

        <div className="imp-list">
          {plan.conflicts.map((c, i) => {
            const dec = decisions[c.id] || { action: 'combine', pick: {} };
            const separate = dec.action === 'separate';
            return (
              <div key={c.id} className={'imp-item' + (separate ? ' is-separate' : '')}>
                <div className="imp-item-top">
                  <div className="imp-item-title">
                    <span className="imp-no">{i + 1}</span>
                    {c.row.title}
                  </div>
                  <div className="imp-seg" role="group">
                    <button
                      type="button"
                      className={!separate ? 'on' : ''}
                      onClick={() => setAction(c.id, 'combine')}
                    >Birləşdir</button>
                    <button
                      type="button"
                      className={separate ? 'on' : ''}
                      onClick={() => setAction(c.id, 'separate')}
                    >Ayrı sətir</button>
                  </div>
                </div>

                {!separate ? (
                  <div className="imp-diffs">
                    <div className="imp-diff-head">
                      <span />
                      <span>Mövcud sətir</span>
                      <span>Excel</span>
                    </div>
                    {c.diffs.map(d => {
                      const pick = dec.pick?.[d.field] || 'current';
                      return (
                        <div key={d.field} className="imp-diff">
                          <span className="imp-field">{labelOf(d.field)}</span>
                          <label className={'imp-opt' + (pick === 'current' ? ' on' : '')}>
                            <input
                              type="radio"
                              name={`${c.id}-${d.field}`}
                              checked={pick === 'current'}
                              onChange={() => setPick(c.id, d.field, 'current')}
                            />
                            <span>{valueLabel(d.field, d.current)}</span>
                          </label>
                          <label className={'imp-opt' + (pick === 'incoming' ? ' on' : '')}>
                            <input
                              type="radio"
                              name={`${c.id}-${d.field}`}
                              checked={pick === 'incoming'}
                              onChange={() => setPick(c.id, d.field, 'incoming')}
                            />
                            <span>{valueLabel(d.field, d.incoming)}</span>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="imp-note">Excel sətri mövcud sətirlə birləşdirilmir — ayrı yeni sətir kimi əlavə olunacaq.</div>
                )}
              </div>
            );
          })}
        </div>

        <div className="imp-foot">
          <span className="imp-foot-info">{combineCount} birləşdirilir · {total - combineCount} ayrı əlavə olunur</span>
          <div className="imp-foot-btns">
            <button type="button" className="btn small" onClick={onCancel}>Ləğv et</button>
            <button type="button" className="btn small primary" onClick={onApply}>Tətbiq et</button>
          </div>
        </div>
      </div>
    </div>
  );
}
