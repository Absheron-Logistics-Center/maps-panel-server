// systemClient.js — version + update calls (see backend/routes/system.js)
import { getToken } from './client.js';

const API_URL = import.meta.env.VITE_API_URL || '';

async function call(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Sorğu alınmadı (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Upload the .zip with progress (fetch has no upload progress). */
function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}/api/system/update/upload`);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    try { xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name)); } catch { /* ignore */ }
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error((data && data.error) || (xhr.status === 413 ? 'Fayl çox böyükdür.' : `Yükləmə alınmadı (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new Error('Serverə qoşulmaq olmadı.'));
    xhr.send(file);
  });
}

export const systemApi = {
  version: () => call('GET', '/api/system/version'),
  overview: () => call('GET', '/api/system/update'),
  upload,
  discard: () => call('DELETE', '/api/system/update/pending'),
  install: () => call('POST', '/api/system/update/install'),
  status: () => call('GET', '/api/system/update/status'),
  rollback: () => call('POST', '/api/system/update/rollback'),
  // my own interface version (every user)
  myUi: () => call('GET', '/api/ui'),
  setMyUi: (version) => call('POST', '/api/ui', { version }),
  setMyAuto: (auto) => call('POST', '/api/ui', { auto })
};
