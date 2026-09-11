const API_URL = import.meta.env.VITE_API_URL || '';

let token = localStorage.getItem('auth_token') || null;

export function getToken() { return token; }

export function setToken(t) {
  token = t;
  if (t) localStorage.setItem('auth_token', t);
  else localStorage.removeItem('auth_token');
}

async function request(method, path, body) {
  // editor_2 may only change interface text. Any content mutation (diagrams,
  // groups, settings, pdfs, templates, status, archive, delete, reorder…) is a
  // silent no-op — it never reaches the server, so nothing is saved, added,
  // archived or deleted. Only label writes (/api/labels) and reads go through.
  if (
    method !== 'GET' &&
    localStorage.getItem('role') === 'editor_2' &&
    !path.startsWith('/api/labels') &&
    path !== '/api/login' && path !== '/api/me'
  ) {
    return null;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  // 401 -> the token is stale/invalid (e.g. server restarted with a new
  // JWT_SECRET, or the session just expired). Clearing the token alone isn't
  // enough: whichever screen is currently mounted has no reason to know to
  // bail out, so it keeps rendering with whatever partial data it already
  // had — that's what was crashing instead of cleanly returning to login.
  // A hard reload is the simplest thing that's always correct here: next
  // boot, App.jsx's own check finds no token and shows Login directly.
  if (res.status === 401) {
    setToken(null);
    localStorage.removeItem('role');
    localStorage.removeItem('username');
    if (path !== '/api/me') window.location.reload();
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!res.ok) {
    const msg = (data && data.error) || `Request failed: ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

const SHEET_KINDS = new Set(['diagrams', 'pdfs', 'templates']);

export const api = {
  login: (username, password) => request('POST', '/api/login', { username, password }),
  me:    () => request('GET',  '/api/me'),
  getHealth: () => request('GET', '/api/health'),
  // Returns { groups, processes }
  listProcesses: () => request('GET', '/api/processes'),
  getProcess:    (id) => request('GET', `/api/processes/${id}`),
  createProcess: (data) => request('POST', '/api/processes', data),
  updateProcess: (id, data) => request('PUT', `/api/processes/${id}`, data),
  updateProcessMeta: (id, data) => request('PUT', `/api/processes/${id}/meta`, data),
  deleteProcess: (id) => request('DELETE', `/api/processes/${id}`),
  archiveProcess: (id) => request('POST', `/api/processes/${id}/archive`),
  unarchiveProcess: (id) => request('POST', `/api/processes/${id}/unarchive`),
  setProcessStatus: (id, status) => request('PUT', `/api/processes/${id}/status`, { status }),

  // Diagram groups
  createGroup: (name, parentId) => request('POST', '/api/processes/group', { name, parentId: parentId ?? null }),
  renameGroup: (gid, name) => request('PUT', `/api/processes/group/${gid}`, { name }),
  moveGroup: (gid, parentId) => request('PUT', `/api/processes/group/${gid}`, { parentId }),
  deleteGroup: (gid) => request('DELETE', `/api/processes/group/${gid}`),

  // Ordering (drag & drop)
  reorderGroups: (order) => request('PUT', '/api/processes/groups/reorder', { order }),
  reorderProcesses: (groupId, order) => request('PUT', '/api/processes/reorder', { groupId, order }),

  // Settings (editable section titles)
  getSettings: () => request('GET', '/api/settings'),
  updateSettings: (patch) => request('PUT', '/api/settings', patch),

  // Diagram / PDF / Template Sheets catalogs (Mongo; sheet-only rows do not create items)
  // kind: 'diagrams' | 'pdfs' | 'templates'
  listSheets: (kind = 'diagrams') => request('GET', `/api/sheets/${kind}`),
  createSheet: (kind, data) => {
    if (typeof kind === 'object') {
      // backward compat: createSheet(data) → diagrams
      return request('POST', '/api/sheets/diagrams', kind);
    }
    return request('POST', `/api/sheets/${kind || 'diagrams'}`, data);
  },
  updateSheet: (kindOrId, idOrData, maybeData) => {
    if (typeof kindOrId === 'string' && SHEET_KINDS.has(kindOrId)) {
      return request('PUT', `/api/sheets/${kindOrId}/${idOrData}`, maybeData);
    }
    // backward compat: updateSheet(id, data)
    return request('PUT', `/api/sheets/diagrams/${kindOrId}`, idOrData);
  },
  deleteSheet: (kindOrId, maybeId) => {
    if (typeof kindOrId === 'string' && SHEET_KINDS.has(kindOrId)) {
      return request('DELETE', `/api/sheets/${kindOrId}/${maybeId}`);
    }
    return request('DELETE', `/api/sheets/diagrams/${kindOrId}`);
  },
  deleteSheetGroup: (kind = 'diagrams', name) => request('DELETE', `/api/sheets/${kind}/group`, { name }),
  // Bulk-remove rows that were auto-populated from diagrams/pdfs/templates
  // (old backfill / auto-sync). Hand-typed blank rows are untouched.
  clearLinkedSheets: (kind = 'diagrams') => request('DELETE', `/api/sheets/${kind}/linked`),
  // Wipe every row in this Sheets catalog
  clearAllSheets: (kind = 'diagrams') => request('DELETE', `/api/sheets/${kind}/all`),

  // Interface-text labels (editor_2 role only writes; everyone reads)
  getLabels: () => request('GET', '/api/labels'),
  setLabel: (id, text) => request('PUT', '/api/labels', { id, text }),
  resetLabel: (id) => request('DELETE', `/api/labels/${encodeURIComponent(id)}`)
};

// File upload (PDFs/templates) only works on the self-hosted server — Vercel's
// serverless functions can't reliably handle it. `/api/health` reports which
// mode we're in; components that render an upload button should check this
// (via the useUploadsEnabled hook below) and hide/disable it when false.
export let uploadsEnabled = true;
export const uploadsEnabledReady = api.getHealth()
  .then((h) => { uploadsEnabled = h?.uploadsEnabled !== false; return uploadsEnabled; })
  .catch(() => true); // if health check fails for some other reason, don't block uploads on that
