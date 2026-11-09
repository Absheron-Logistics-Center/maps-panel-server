# Hosting Map-Panel at http://172.25.60.81/maps-panel

I can't RDP into your server myself, so these are the exact steps to run
yourself in that Remote Desktop session. Three changed files are included
in this delivery — drop them into your project first:

- `backend/server.js` → replaces `backend/server.js`
- `frontend/vite.config.js` → replaces `frontend/vite.config.js`
- `backend/services/sheetsStore.js` → (from the earlier fix, if not already applied)
- `backend/.env.example` → copy to `backend/.env`, fill in `JWT_SECRET`
- `frontend/.env.production.local` → put in `frontend/` as-is

## 1. Prereqs on the server

Open PowerShell (as admin) in that RDP session and check:

```powershell
node -v      # need Node 18+ — if missing, install from nodejs.org
```

## 2. Build the frontend

```powershell
cd C:\path\to\Map-Panel\frontend
npm install
npm run build
```

This produces `frontend/dist` with all asset URLs and API calls prefixed
with `/maps-panel`, because of `.env.production.local`.

## 3. Set up the backend

```powershell
cd C:\path\to\Map-Panel\backend
npm install
copy .env.example .env
notepad .env      # set JWT_SECRET to any long random string
```

Leave `MONGODB_URI` / `GITHUB_TOKEN` / `GITHUB_OWNER` / `GITHUB_REPO` blank
in `.env` — that's what makes all diagrams/pdfs/hesabat data save as plain
files under `Map-Panel\data\` on this server instead of Mongo or GitHub.

Quick test (temporary, foreground):

```powershell
node server.js
```

Then from the server itself, browse to `http://localhost:4000/maps-panel`
— you should see the app. Ctrl+C to stop once confirmed.

## 4. Keep it running (don't just leave the console window open)

A plain `node server.js` dies the moment you close the RDP session. Run it
as a proper Windows service with [NSSM](https://nssm.cc/download):

```powershell
nssm install MapsPanel "C:\Program Files\nodejs\node.exe" "C:\path\to\Map-Panel\backend\server.js"
nssm set MapsPanel AppDirectory "C:\path\to\Map-Panel\backend"
nssm start MapsPanel
```

Confirm again: `http://localhost:4000/maps-panel` should still work after
you log out of the RDP session.

## 5. Point /maps-panel at it from whatever serves /itsupport

Since itsupport is a PHP site, port 80 is already owned by IIS or Apache.
Whichever it is, you need exactly one rule: forward `/maps-panel/*` on
port 80 to `http://localhost:4000/maps-panel/*` — same path, not stripped.

**If it's IIS** (check: is IIS Manager / `inetmgr` installed?) — you need
the *Application Request Routing* and *URL Rewrite* modules (Microsoft
downloads, install once), then in IIS Manager, on the site handling port 80:

1. Enable ARR proxy: Server node → *Application Request Routing Cache* →
   *Server Proxy Settings…* → check "Enable proxy".
2. On the site → *URL Rewrite* → *Add Rule* → *Reverse Proxy* →
   pattern `^maps-panel/(.*)`, rewrite URL `http://localhost:4000/maps-panel/{R:1}`.

**If it's Apache** (check: is there an `httpd.conf`, e.g. under
`C:\xampp\apache\conf\`?) — enable `mod_proxy` / `mod_proxy_http`, then add:

```apache
ProxyPass        /maps-panel http://localhost:4000/maps-panel
ProxyPassReverse /maps-panel http://localhost:4000/maps-panel
```

and restart Apache.

If you're not sure which one owns port 80, run in PowerShell:

```powershell
Get-Service W3SVC -ErrorAction SilentlyContinue   # exists → IIS
tasklist | findstr /i httpd                        # found → Apache
```

Send me the result and I'll give you the exact rule for that one — the
snippets above are the standard form either way, but I'd rather confirm
before you spend time on the wrong one.

## 6. Verify

`http://172.25.60.81/maps-panel` should load the app, log in, and every
change (diagrams, hesabat rows, pdf uploads) should land as files under
`Map-Panel\data\` on that server — check with:

```powershell
dir C:\path\to\Map-Panel\data\diagrams
```
