# One shared database (Vercel + server)

## What was wrong
1. server.js loaded `.env` AFTER its imports ran, so on the server `MONGODB_URI` was empty when store.js read it. The server silently used local files while Vercel used Mongo → two different data sets (207 vs 210 rows).
2. Normativ Sənədlər, Şablonlar, settings and labels used GitHub/local files, never Mongo. On Vercel those lived in /tmp and every save was a GitHub commit (= Vercel redeploy).
3. A failed Mongo connection was cached forever and reads silently fell back to stale local files.

## How it works now
- MongoDB = single source of truth for ALL JSON (diagrams, hesabat/sheets, pdf + template lists, archives, settings, labels) and for the PDF/Word/Excel files (GridFS).
- Vercel: reads/writes Mongo only. Can view/download PDFs. Uploading files stays server-only (Vercel's 4.5 MB request limit).
- Server: same Mongo + a full copy in `data/` (and PDFs on disk). On start it uploads anything Mongo doesn't have yet (insert-only, never overwrites), then every 60 s pulls Vercel's changes into `data/`.
- If Mongo is unreachable the server keeps working from disk and pushes the changes when it's back (`data/.mongo-outbox.json`). Vercel shows an error instead of losing data.
- No GitHub writes for data any more.

## Deploy
Server (Windows): replace the project files, keep your existing `.env` (MONGODB_URI must be the full mongodb+srv://… string), then
```
cd backend && npm install && cd ..\frontend && npm run build
```
and restart the service (`nssm restart MapsPanel`, or `npm start` in backend).
Vercel: make sure `MONGODB_URI` is set, remove GITHUB_* vars, push to GitHub (auto-deploys).

Check: open `/maps-panel/api/health` on the server and `/api/health` on Vercel → `storage.mongoOk` must be true. `/api/debug` shows counts + a write test.
Atlas: Network Access must allow the server's public IP (or 0.0.0.0/0).
