import { useState, useEffect, useRef } from 'react';
import { api, getToken, setToken } from './api/client.js';

import Login from './components/Login.jsx';
import SectionsHub from './components/SectionsHub.jsx';
import Home from './components/Home.jsx';
import Diagram from './components/Diagram.jsx';
import PdfList from './components/pdfs/PdfList.jsx';
import TemplateList from './components/pdfs/TemplateList.jsx';
import JobList from './components/pdfs/JobList.jsx';
import SheetsPage from './components/SheetsPage.jsx';
import EditorBar from './components/EditorBar.jsx';
import { syncMyInterface, AutoUpdater } from './components/UpdateCenter.jsx';
import PresenceLayer from './components/PresenceLayer.jsx';
import { AiProvider } from './components/ai/AiHost.jsx';
import WelcomeSplash from './components/WelcomeSplash.jsx';
import { ChangePasswordModal } from './components/AccountsCenter.jsx';
import { LabelsProvider } from './labels/LabelsContext.jsx';

// ---------------------------------------------------------------------
// URL <-> view sync. The app has no router (views are just React state),
// so the address bar used to never change while navigating. These two
// helpers translate between a `view`/id and a real path, so every screen
// gets its own URL, refresh keeps you on the same screen, and the
// browser Back/Forward buttons work via the popstate listener below.
// ---------------------------------------------------------------------
// Path this app is actually served under. Empty for the normal
// root-domain deploy (Vercel); e.g. "/maps-panel" when self-hosted
// alongside other apps (see vite.config.js's VITE_BASE / server.js's
// BASE_PATH). Vite bakes this in from VITE_BASE at build time. Every
// pushed/parsed URL below is relative to this — it must stay in front
// of the app's own routes rather than get replaced by them.
// '' or e.g. '/maps-panel'. An interface version is served from
// <base>/ui/<version>/ (its files), but its page addresses stay <base>/…
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/ui\/[^/]+\/?$/, '').replace(/\/+$/, '');

function withBase(subPath) {
  return BASE + subPath;
}

function stripBase(pathname) {
  if (BASE && pathname.startsWith(BASE)) {
    const rest = pathname.slice(BASE.length);
    return rest === '' ? '/' : rest;
  }
  return pathname;
}

function pathForView(view, { processId, sheetsKind } = {}) {
  if (view === 'diagram' && processId != null) return `/is-axislari/${processId}`;
  if (view === 'sheets') {
    if (sheetsKind === 'pdfs') return '/normativ-senedler/hesabat';
    if (sheetsKind === 'templates') return '/sablonlar/hesabat';
    if (sheetsKind === 'jobs') return '/vezife-telimatlari/hesabat';
    return '/is-axislari/hesabat';
  }
  if (view === 'diagrams') return '/is-axislari';
  if (view === 'pdfs') return '/normativ-senedler';
  if (view === 'templates') return '/sablonlar';
  if (view === 'jobs') return '/vezife-telimatlari';
  if (view === 'hub') return '/hub';
  return '/';
}

function viewFromPath(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0 || parts[0] === 'hub') return { view: 'hub' };
  if (parts[0] === 'is-axislari') {
    if (parts[1] === 'hesabat') return { view: 'sheets', sheetsKind: 'diagrams' };
    if (parts[1]) return { view: 'diagram', processId: /^\d+$/.test(parts[1]) ? Number(parts[1]) : parts[1] };
    return { view: 'diagrams' };
  }
  if (parts[0] === 'normativ-senedler') {
    if (parts[1] === 'hesabat') return { view: 'sheets', sheetsKind: 'pdfs' };
    return { view: 'pdfs' };
  }
  if (parts[0] === 'vezife-telimatlari') {
    if (parts[1] === 'hesabat') return { view: 'sheets', sheetsKind: 'jobs' };
    return { view: 'jobs' };
  }
  if (parts[0] === 'sablonlar') {
    if (parts[1] === 'hesabat') return { view: 'sheets', sheetsKind: 'templates' };
    return { view: 'templates' };
  }
  return null;
}

// who is logged in, for the parts that read it straight from localStorage
function rememberUser(u) {
  localStorage.setItem('role', u.role);
  localStorage.setItem('username', u.username);
  localStorage.setItem('displayName', u.name || u.username);
  if (u.dev) localStorage.setItem('dev', '1'); else localStorage.removeItem('dev');
}
function forgetUser() {
  ['role', 'username', 'displayName', 'dev'].forEach(k => localStorage.removeItem(k));
}

export default function App() {
  // views: 'login' | 'hub' | 'diagrams' | 'pdfs' | 'templates' | 'files' | 'diagram' | 'sheets'
  const [view, setView] = useState('login');
  const [user, setUser] = useState(null);
  const [processId, setProcessId] = useState(null);
  const [focusNodeId, setFocusNodeId] = useState(null);
  // Remembers the diagram we came from so, on returning to the list, it can
  // scroll to and open the right folder for that item (fix 15). Not cleared
  // on backToDiagrams — only replaced the next time a diagram is opened.
  const [lastOpenedProcessId, setLastOpenedProcessId] = useState(null);
  const [sheetsKind, setSheetsKind] = useState('diagrams'); // diagrams | pdfs | templates
  // itemId to scroll to / highlight when landing back on the pdfs or
  // templates list after opening it from a Sheets row (see openSheetItem).
  const [pdfsFocusId, setPdfsFocusId] = useState(null);
  const [templatesFocusId, setTemplatesFocusId] = useState(null);
  const [jobsFocusId, setJobsFocusId] = useState(null);
  const [bootChecking, setBootChecking] = useState(true);
  const [welcome, setWelcome] = useState(null); // admin name, shown once right after login
  function takeWelcome() {
    try {
      const n = sessionStorage.getItem('mp-welcome');
      if (n) { sessionStorage.removeItem('mp-welcome'); setWelcome(n); }
    } catch { /* ignore */ }
  }
  // A diagram id parsed from a share link (?d=<id>&n=<nodeId>), pending until
  // the user is authenticated. Kept in a ref so it survives re-renders.
  const pendingShare = useRef(null);
  // Set right before a popstate-driven state update so the URL-sync effect
  // below doesn't push a brand new history entry for a navigation the
  // browser Back/Forward button already produced.
  const suppressPushRef = useRef(false);

  // Read the share-link params once, and strip them from the URL so a refresh
  // doesn't keep forcing the same diagram open.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const d = params.get('d');
    if (d) {
      pendingShare.current = { id: d, nodeId: params.get('n') || null };
      const clean = window.location.pathname + window.location.hash;
      try { window.history.replaceState({}, '', clean); } catch (e) { }
    }
  }, []);

  function consumeShare() {
    const share = pendingShare.current;
    if (!share) return false;
    pendingShare.current = null;
    const id = /^\d+$/.test(share.id) ? Number(share.id) : share.id;
    openProcess(id, share.nodeId ? (/^\d+$/.test(share.nodeId) ? Number(share.nodeId) : share.nodeId) : null);
    return true;
  }

  // Restore whatever screen the address bar points to (deep link / page
  // refresh) instead of always dropping the user back on the hub.
  function restoreFromUrl() {
    const parsed = viewFromPath(stripBase(window.location.pathname));
    if (!parsed) { setView('hub'); return; }
    if (parsed.view === 'diagram') {
      setProcessId(parsed.processId);
      setLastOpenedProcessId(parsed.processId);
      setView('diagram');
    } else if (parsed.view === 'sheets') {
      setSheetsKind(parsed.sheetsKind || 'diagrams');
      setView('sheets');
    } else {
      setView(parsed.view);
    }
  }

  useEffect(() => {
    (async () => {
      const token = getToken();
      if (!token) {
        setBootChecking(false);
        return;
      }
      try {
        const me = await api.me();
        // this user is on another interface version than this page → load theirs
        if (await syncMyInterface()) return;
        setUser(me);
        rememberUser(me);
        takeWelcome();
        if (!consumeShare()) restoreFromUrl();
      } catch (e) {
        console.error(e);
        setToken(null);
        forgetUser();
      } finally {
        setBootChecking(false);
      }
    })();
    // eslint-disable-next-line
  }, []);

  // Keep the address bar in sync with the current screen. Runs after every
  // navigation; skipped once right after a popstate-driven update, since
  // the browser already changed the URL for us in that case.
  useEffect(() => {
    if (bootChecking || view === 'login') return;
    if (suppressPushRef.current) { suppressPushRef.current = false; return; }
    const path = withBase(pathForView(view, { processId, sheetsKind }));
    if (window.location.pathname !== path) {
      try { window.history.pushState({}, '', path + window.location.search); } catch (e) { }
    }
  }, [view, processId, sheetsKind, bootChecking]);

  // Browser Back/Forward support.
  useEffect(() => {
    function onPopState() {
      if (!user) return;
      suppressPushRef.current = true;
      restoreFromUrl();
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function onLogin(data) {
    rememberUser(data);
    // the welcome survives the reload onto this user's own interface version
    if (data.role === 'admin') { try { sessionStorage.setItem('mp-welcome', data.name || data.username); } catch { /* ignore */ } }
    if (await syncMyInterface()) return;
    setUser(data);
    takeWelcome();
    if (!consumeShare()) restoreFromUrl();
  }

  function onLogout() {
    setToken(null);
    forgetUser();
    setUser(null);
    setProcessId(null);
    setView('login');
    try { window.history.pushState({}, '', withBase('/')); } catch (e) { }
  }

  function pickSection(key) {
    if (key === 'diagrams') setView('diagrams');
    else if (key === 'pdfs') setView('pdfs');
    else if (key === 'templates') setView('templates');
    else if (key === 'jobs') setView('jobs');
  }

  function openProcess(id, nodeId = null) {
    setProcessId(id);
    setFocusNodeId(nodeId);
    setLastOpenedProcessId(id);
    setView('diagram');
  }

  function backToDiagrams() {
    setProcessId(null);
    setFocusNodeId(null);
    setView('diagrams');
  }

  function openSheets(kind = 'diagrams') {
    setSheetsKind(kind);
    setView('sheets');
  }

  function backFromSheets() {
    if (sheetsKind === 'pdfs') setView('pdfs');
    else if (sheetsKind === 'templates') setView('templates');
    else if (sheetsKind === 'jobs') setView('jobs');
    else setView('diagrams');
  }

  // Open the real item (diagram / pdf / template) a Sheets row is linked
  // to — the "open" button next to the trash can on the sheets table.
  function openSheetItem(kind, row) {
    const itemId = row?.itemId ?? row?.processId;
    if (itemId == null) return;
    if (kind === 'diagrams') {
      openProcess(itemId);
    } else if (kind === 'pdfs') {
      setPdfsFocusId(itemId);
      setView('pdfs');
    } else if (kind === 'templates') {
      setTemplatesFocusId(itemId);
      setView('templates');
    } else if (kind === 'jobs') {
      setJobsFocusId(itemId);
      setView('jobs');
    }
  }

  function backToHub() {
    setProcessId(null);
    setFocusNodeId(null);
    setView('hub');
  }

  function renderView() {
    if (bootChecking) {
      return <div className="boot-screen">Yüklənir...</div>;
    }

    if (view === 'login') {
      return <Login onLogin={onLogin} />;
    }

    if (view === 'hub') {
      return <SectionsHub onPick={pickSection} onLogout={onLogout} />;
    }

    if (view === 'diagrams') {
      return (
        <Home
          onOpen={openProcess}
          onLogout={onLogout}
          onBack={backToHub}
          onOpenSheets={() => openSheets('diagrams')}
          focusProcessId={lastOpenedProcessId}
        />
      );
    }

    if (view === 'sheets') {
      return (
        <SheetsPage
          kind={sheetsKind}
          withStatus={sheetsKind !== 'templates'}
          onBack={backFromSheets}
          onLogout={onLogout}
          onOpenItem={openSheetItem}
        />
      );
    }

    if (view === 'pdfs') {
      return (
        <PdfList
          onBack={backToHub}
          onLogout={onLogout}
          onOpenSheets={() => openSheets('pdfs')}
          focusItemId={pdfsFocusId}
        />
      );
    }

    if (view === 'templates') {
      return (
        <TemplateList
          onBack={backToHub}
          onLogout={onLogout}
          onOpenSheets={() => openSheets('templates')}
          focusItemId={templatesFocusId}
        />
      );
    }

    if (view === 'jobs') {
      return (
        <JobList
          onBack={backToHub}
          onLogout={onLogout}
          onOpenSheets={() => openSheets('jobs')}
          focusItemId={jobsFocusId}
        />
      );
    }

    if (view === 'diagram') {
      return (
        <Diagram
          processId={processId}
          focusNodeId={focusNodeId}
          onBack={backToDiagrams}
          onLogout={onLogout}
          user={user}
        />
      );
    }

    return null;
  }

  return (
    <LabelsProvider enabled={!!user}>
      <AiProvider enabled={user?.role === 'admin' && view !== 'login'}>
      {user?.role === 'editor_2' && <EditorBar onLogout={onLogout} />}
      {renderView()}
      {user && view !== 'login' && (
        <PresenceLayer
          page={pathForView(view, { processId, sheetsKind })}
          me={user}
        />
      )}
      {user?.mustChange && (
        <ChangePasswordModal forced onDone={() => setUser(u => ({ ...u, mustChange: false }))} onLogout={onLogout} />
      )}
      {user && view !== 'login' && <AutoUpdater />}
      {welcome && <WelcomeSplash name={welcome} onDone={() => setWelcome(null)} />}
      </AiProvider>
    </LabelsProvider>
  );
}