// AiHost.jsx — ONE assistant for the whole app.
//
// The sidebar used to live inside each page (İş axışları, Hesabat, Diagram),
// so moving to another section unmounted it: the panel closed and a running
// answer was cut off. Now it is mounted once in App and stays alive while the
// admin moves between sections; a running answer keeps going in the
// background, also with the panel closed (the AI button shows a spinner).
//
// Each page only describes itself with <AiBinding context runActions … />.
// The newest page wins; actions proposed on another page wait until you are
// back on that page (the sidebar says so instead of running them on the
// wrong screen).
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import AiSidebar from './AiSidebar.jsx';

const AiCtx = createContext(null);
const NOOP = { open: false, setOpen: () => {}, toggle: () => {}, busy: false, register: () => {}, unregister: () => {}, bump: () => {} };

export function AiProvider({ enabled, children }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rev, setRev] = useState(0);              // a page arrived / left → re-render the sidebar
  const binding = useRef(null);

  const register = useCallback((token, props) => { binding.current = { token, ...props }; }, []);
  const unregister = useCallback((token) => {
    if (binding.current?.token === token) { binding.current = null; setRev(r => r + 1); }
  }, []);
  const bump = useCallback(() => setRev(r => r + 1), []);
  const toggle = useCallback(() => setOpen(o => !o), []);

  const value = useMemo(() => ({ open, setOpen, toggle, busy, register, unregister, bump }), [open, toggle, busy, register, unregister, bump]);

  const b = binding.current;
  const context = useCallback(() => {
    const cur = binding.current;
    if (cur?.context) return cur.context();
    return { view: 'other', note: 'Bu bölmədə AI yalnız söhbət edir; əməliyyat üçün İş axışları, Hesabat və ya diaqram səhifəsinə keçin.' };
  }, []);
  const runActions = useCallback(async (actions) => {
    const cur = binding.current;
    if (!cur?.runActions) throw new Error('Bu səhifədə əməliyyat icra edilmir. Əməliyyatın aid olduğu səhifəyə keçin.');
    return cur.runActions(actions);
  }, []);
  const snapshot = useCallback(() => binding.current?.snapshot?.(), []);

  return (
    <AiCtx.Provider value={value}>
      {children}
      {enabled && (
        <AiSidebar
          open={open}
          onClose={() => setOpen(false)}
          context={context}
          runActions={runActions}
          snapshot={b?.snapshot ? snapshot : undefined}
          suggestions={b?.suggestions || ['Nə edə bilərsən?']}
          pageKey={rev}
          onBusyChange={setBusy}
        />
      )}
    </AiCtx.Provider>
  );
}

export function useAi() {
  return useContext(AiCtx) || NOOP;
}

/** A page tells the assistant what it is. Renders nothing. */
export function AiBinding(props) {
  const ai = useAi();
  const token = useRef({});
  // latest closures every render (context() must see the current state)
  useLayoutEffect(() => { ai.register(token.current, props); });
  useEffect(() => {
    ai.bump();
    const t = token.current;
    return () => ai.unregister(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
