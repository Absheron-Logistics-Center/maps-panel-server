import { getToken, setToken } from './client.js';

const API_URL = import.meta.env.VITE_API_URL || '';

// Şablonlar bölməsi — PDF bölməsi ilə eyni struktur, ayrı data (/api/templates).

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
  const res = await fetch(`${API_URL}/api/templates/${id}/file`, { headers: authHeaders() });
  if (res.status === 401) {
    setToken(null);
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`PDF yüklənmədi: ${res.status}`);
  return res.blob();
}

export const templatesApi = {
  // Returns { groups, pdfs }
  list: () => jsonRequest('GET', '/api/templates'),

  createGroup: (name, parentId) => jsonRequest('POST', '/api/templates/group', { name, parentId: parentId ?? null }),
  renameGroup: (gid, name) => jsonRequest('PUT', `/api/templates/group/${gid}`, { name }),
  moveGroup: (gid, parentId) => jsonRequest('PUT', `/api/templates/group/${gid}`, { parentId }),
  deleteGroup: (gid) => jsonRequest('DELETE', `/api/templates/group/${gid}`),

  // Ordering (drag & drop)
  reorderGroups: (order) => jsonRequest('PUT', '/api/templates/groups/reorder', { order }),
  reorderPdfs: (groupId, order) => jsonRequest('PUT', '/api/templates/reorder', { groupId, order }),

  create: ({ title, subtitle, groupId, file, sheetId }) =>
    fileToBase64(file).then(dataBase64 =>
      jsonRequest('POST', '/api/templates', {
        title,
        subtitle: subtitle || '',
        groupId,
        filename: file.name,
        dataBase64,
        sheetId
      })
    ),

  update: (id, { title, subtitle, groupId, file }) => {
    const body = {};
    if (typeof title === 'string') body.title = title;
    if (typeof subtitle === 'string') body.subtitle = subtitle;
    if (groupId !== undefined) body.groupId = groupId;
    if (file) {
      return fileToBase64(file).then(dataBase64 => {
        body.filename = file.name;
        body.dataBase64 = dataBase64;
        return jsonRequest('PUT', `/api/templates/${id}`, body);
      });
    }
    return jsonRequest('PUT', `/api/templates/${id}`, body);
  },

  remove: (id) => jsonRequest('DELETE', `/api/templates/${id}`),

  archive: (id) => jsonRequest('POST', `/api/templates/${id}/archive`),
  unarchive: (id) => jsonRequest('POST', `/api/templates/${id}/unarchive`),

  setStatus: (id, status) => jsonRequest('PUT', `/api/templates/${id}/status`, { status }),

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
