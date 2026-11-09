# One codebase, two deployments

This is now a single project. Same `backend/`, same `frontend/`, same routes,
for both:

- **Vercel** (`https://maps-panel.vercel.app/`) — deploys as-is, nothing
  changes here. `VERCEL=1` is set automatically by Vercel, `BASE_PATH` and
  `SERVE_FRONTEND` are unset there, so it behaves exactly like before.
- **Your server** (`http://172.25.60.81:4000/maps-panel/`) — controlled by
  `.env` (`BASE_PATH=/maps-panel`, `SERVE_FRONTEND=1`, `PORT=4000`).
  Run with `npm start` from `backend/` (same as before).

No more copy-pasting changed files between two folders — one repo, one
`git push`, both deployments pick it up.

## Why the data didn't match

Your server's `.env` had no `MONGODB_URI` / `GITHUB_TOKEN` — it was running
fully standalone, saving only to its own local `data/` folder. Vercel saves
diagrams to MongoDB and PDFs/templates to GitHub. Two separate databases,
not a sync bug. On top of that, `services/github.js` had a bug where, even
once GitHub *was* configured, this server would still trust its own local
cached copy forever instead of re-checking GitHub — fixed in this version.

## Vercel: view + Sheets editing only, no PDF upload

Per your request: creating or replacing a PDF/template file now returns a
clear error on Vercel, and the file field in the upload modal is replaced
with a note instead of a broken upload attempt. This is enforced in
`backend/routes/pdfs.js` / `templates.js` (checked server-side, not just
hidden in the UI, so it can't be bypassed by calling the API directly) and
mirrored in the frontend (`PdfFormModal.jsx`) via `GET /api/health` ->
`uploadsEnabled`. Everything else — browsing PDFs, editing Sheets, diagrams
(Mongo) — works the same on both. File upload only works from
`http://172.25.60.81:4000/maps-panel/`.

## Already done for you

- `GITHUB_TOKEN`/`OWNER`/`REPO`/`JWT_SECRET`/AI keys are already filled into
  `.env` in this zip.
- Your live `data/files/index.json` on GitHub had an **unresolved git merge
  conflict** in it, which also meant 7 real PDFs (ALM policies, ISO
  9001/14001/45001 certs, "Anbar logistikası şöbəsi əsasnaməsi") had lost
  their file, and one PDF (id 4) had been silently overwritten by a
  different document. I fixed the index structure directly on GitHub
  (conflict removed, duplicate ids given unique numbers) — **the 7
  documents still need their actual file re-uploaded**, from the server
  (Vercel can't upload — see above), onto these ids:
  2, 3, 5, 6, 7, 8, and 131 (Nəqliyyat Idarəetmə Siyasəti — id 4 itself is
  fine, it correctly shows "Anbar idarəetmə prosesi").

## What's left for you to do on your server

1. Still fill in `MONGODB_URI` in `.env` — the full connection string
   (`mongodb+srv://user:password@cluster.mongodb.net/mappanel`), not just
   the password. I couldn't reach MongoDB from where this was built (only
   GitHub was reachable from here), so this part needs to run from your
   server.
2. Restart the server (`npm start` in `backend/`).
3. One-time reconciliation, from `backend/`:
   ```
   node scripts/sync-data.mjs --dry-run
   ```
   Review the output — it lists what it would add on each side. Then:
   ```
   node scripts/sync-data.mjs
   ```
   This is additive only: anything only on your server gets pushed up,
   anything only on Mongo/GitHub gets pulled down. Nothing that already
   exists on both sides is overwritten (if an item differs on both sides,
   it's logged for you to check manually, not auto-resolved).
4. From then on: diagrams and Sheets edits made from *either* side land in
   the same MongoDB; PDFs/templates uploaded from the server land in the
   same GitHub repo that Vercel reads from. Both auto-save a local mirror
   copy under `data/` too.

## Company WiFi -> auto-redirect to the internal server

Not implemented — needs either a real domain (for split-horizon DNS) or
HTTPS on the internal server (browsers block a HTTPS page from silently
calling an HTTP address). You said you only have the `*.vercel.app` domain
and the server IP, so for now: bookmark
`http://172.25.60.81:4000/maps-panel/` directly on company WiFi, use the
Vercel URL everywhere else.
