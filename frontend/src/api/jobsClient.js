import { getToken, setToken } from './client.js';

const API_URL = import.meta.env.VITE_API_URL || '';

// Şablonlar bölməsi — PDF bölməsi ilə eyni struktur, ayrı data (/api/jobs).

function authHeaders(extra = {}) {
  const h = { ...extra };
  const t = getToken();
  if (t) h['Authorization'] = `Bearer ${t}`;
  return h;
}

async function jsonRequest(method, path, body) {
  const headers = authHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) {
    setToken(null);
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Read a File object → base64 (no data: prefix)
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result || '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    r.onerror = () => reject(new Error('Faylı oxumaq alınmadı'));
    r.readAsDataURL(file);
  });
}

async function fetchBlob(id) {
  const res = await fetch(`${API_URL}/api/jobs/${id}/file`, { headers: authHeaders() });
  if (res.status === 401) {
    setToken(null);
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`PDF yüklənmədi: ${res.status}`);
  return res.blob();
}

export const jobsApi = {
  // (Struktur vahidi, Struktur bölməsi) cütlərindən qovluq ağacı qur
  structure: (pairs) => jsonRequest('POST', '/api/jobs/structure', { pairs }),
  // Upload / replace the file of a Vəzifə from its hesabat row (row gets linked)
  fromRow: (rowId, file) => fileToBase64(file).then(dataBase64 =>
    jsonRequest('POST', `/api/jobs/from-row/${rowId}`, { filename: file.name, dataBase64 })),
  // Returns { groups, pdfs }
  list: () => jsonRequest('GET', '/api/jobs'),

  createGroup: (name, parentId) => jsonRequest('POST', '/api/jobs/group', { name, parentId: parentId ?? null }),
  renameGroup: (gid, name) => jsonRequest('PUT', `/api/jobs/group/${gid}`, { name }),
  moveGroup: (gid, parentId) => jsonRequest('PUT', `/api/jobs/group/${gid}`, { parentId }),
  deleteGroup: (gid) => jsonRequest('DELETE', `/api/jobs/group/${gid}`),

  // Ordering (drag & drop)
  reorderGroups: (order) => jsonRequest('PUT', '/api/jobs/groups/reorder', { order }),
  reorderPdfs: (groupId, order) => jsonRequest('PUT', '/api/jobs/reorder', { groupId, order }),

  create: ({ title, subtitle, groupId, file, sheetId }) =>
    fileToBase64(file).then(dataBase64 =>
      jsonRequest('POST', '/api/jobs', {
        title,
        subtitle: subtitle || '',
        groupId,
        filename: file.name,
        dataBase64,
        sheetId
      })
    ),

  update: (id, { title, subtitle, groupId, file, filename }) => {
    const body = {};
    if (typeof title === 'string') body.title = title;
    if (typeof subtitle === 'string') body.subtitle = subtitle;
    if (groupId !== undefined) body.groupId = groupId;
    if (typeof filename === 'string' && !file) body.filename = filename; // rename only
    if (file) {
      return fileToBase64(file).then(dataBase64 => {
        body.filename = file.name;
        body.dataBase64 = dataBase64;
        return jsonRequest('PUT', `/api/jobs/${id}`, body);
      });
    }
    return jsonRequest('PUT', `/api/jobs/${id}`, body);
  },

  remove: (id) => jsonRequest('DELETE', `/api/jobs/${id}`),

  archive: (id) => jsonRequest('POST', `/api/jobs/${id}/archive`),
  unarchive: (id, target = {}) => jsonRequest('POST', `/api/jobs/${id}/unarchive`, target),

  setStatus: (id, status) => jsonRequest('PUT', `/api/jobs/${id}/status`, { status }),

  async view(id) {
    const blob = await fetchBlob(id);
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    // Revoke later — don't revoke immediately or the tab can't load it
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },

  async download(id, filename) {
    const blob = await fetchBlob(id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `pdf-${id}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};
