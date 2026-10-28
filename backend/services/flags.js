// Small read of the on/off switches in data/settings.json (see routes/settings.js).
import { getFile } from './store.js';
const dataPath = () => (process.env.DATA_PATH || 'data').replace(/^\/|\/$/g, '');

// autolink_<kind>: link Hesabat rows and Home items with the same name
// automatically. Off unless the admin switched it on.
export async function autoLinkOn(kind) {
  try {
    const c = (await getFile(`${dataPath()}/settings.json`))?.content || {};
    return c[`autolink_${kind}`] === true;
  } catch { return false; }
}
