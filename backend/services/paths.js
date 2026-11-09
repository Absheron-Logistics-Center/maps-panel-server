/*
  ONE place that knows where every JSON lives (Mongo _id == this path, and
  the server mirrors the same path under data/).

  Each section folder holds the same four clearly named files:

    data/<section>/home.json             what the Home page lists (folders + items)
    data/<section>/home-archive.json     items archived from the Home page
    data/<section>/home-deleted.json     items deleted from that archive (kept, not shown)
    data/<section>/hesabat.json          the Hesabat (report) table rows
    data/<section>/hesabat-archive.json  Hesabat rows that were archived (restorable on the page)
    data/<section>/hesabat-deleted.json  Hesabat rows deleted with the trash icon (kept, not shown)

  İş Axışları also keeps one file per diagram — the diagram itself:

    data/diagrams/items/diagram-<id>.json

  Home and Hesabat are SEPARATE lists. A Hesabat row may point at a Home item
  through `itemId`, but nothing is copied between them automatically.

  Old names (index.json, sheets.json, archive.json, processes/process-N.json)
  are listed in LEGACY so services/migrate.js can move them once.
*/

export const dataDir = () => (process.env.DATA_PATH || 'data').replace(/^\/|\/$/g, '');

// kind -> folder + the key the Home list is stored under
export const SECTIONS = {
  diagrams:  { dir: 'diagrams',  listKey: 'processes' },
  pdfs:      { dir: 'files',     listKey: 'pdfs' },
  templates: { dir: 'templates', listKey: 'pdfs' },
  jobs:      { dir: 'jobs',      listKey: 'pdfs' }   // Vəzifə Təlimatları
};

function sec(kind) {
  const s = SECTIONS[kind];
  if (!s) {
    const e = new Error('Yanlış bölmə');
    e.status = 400;
    throw e;
  }
  return s;
}

export const homePath           = (kind) => `${dataDir()}/${sec(kind).dir}/home.json`;
export const homeArchivePath    = (kind) => `${dataDir()}/${sec(kind).dir}/home-archive.json`;
// Items deleted from the Home archive: gone from the page, kept here (Mongo + data/), files untouched.
export const homeDeletedPath    = (kind) => `${dataDir()}/${sec(kind).dir}/home-deleted.json`;
export const hesabatPath        = (kind) => `${dataDir()}/${sec(kind).dir}/hesabat.json`;
export const hesabatArchivePath = (kind) => `${dataDir()}/${sec(kind).dir}/hesabat-archive.json`;
// Rows removed with the trash icon: gone from the page, kept here (Mongo + data/).
export const hesabatDeletedPath = (kind) => `${dataDir()}/${sec(kind).dir}/hesabat-deleted.json`;
export const diagramPath        = (id)   => `${dataDir()}/diagrams/items/diagram-${id}.json`;
export const layoutMarkerPath   = ()     => `${dataDir()}/layout-version.json`;

export const LAYOUT_VERSION = 3;
export const restoreMarkerPath = () => `${dataDir()}/restore-applied.json`;

export const LEGACY = {
  index:   (kind) => `${dataDir()}/${sec(kind).dir}/index.json`,
  archive: (kind) => `${dataDir()}/${sec(kind).dir}/archive.json`,
  sheets:  (kind) => `${dataDir()}/${sec(kind).dir}/sheets.json`,
  processPrefix: () => `${dataDir()}/diagrams/processes/`,
  process: (id) => `${dataDir()}/diagrams/processes/process-${id}.json`
};

// Which section a stored path belongs to (used by the status-name encoder).
export function kindOfPath(p) {
  const rel = String(p || '').slice(dataDir().length + 1);
  const top = rel.split('/')[0];
  if (top === 'diagrams') return 'diagrams';
  if (top === 'files') return 'pdfs';
  if (top === 'templates') return 'templates';
  if (top === 'jobs') return 'jobs';
  return null;
}
