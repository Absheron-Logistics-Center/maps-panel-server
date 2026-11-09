# Abşeron Logistika Mərkəzi — Proses Xəritələri

Full-stack web application for managing logistics process maps. Vite + React frontend, Express backend, **GitHub used as JSON storage** (no database needed).

## How it works

- **Frontend** (Vite + React) — login screen, home with process list, diagram viewer, and an **admin panel on the right side** for editing.
- **Backend** (Node.js + Express) — auth + CRUD endpoints that read/write JSON files to a GitHub repo via the GitHub Contents API.
- **Storage** — every process is one JSON file in your GitHub repo (`data/processes/process-{id}.json`). The index of all processes lives in `data/index.json`. All edits commit back to the repo automatically.

## Project structure

```
absheron-app/
├── README.md
├── package.json            ← runs frontend + backend together
├── .gitignore
│
├── backend/                ← Express API
│   ├── package.json
│   ├── .env.example
│   ├── server.js
│   ├── routes/
│   │   ├── auth.js         ← POST /api/login
│   │   └── processes.js    ← CRUD for processes
│   └── services/
│       └── github.js       ← GitHub Contents API wrapper
│
├── frontend/               ← Vite + React
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   ├── .env.example
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── styles.css      ← all styling, CSS variables
│       ├── api/
│       │   └── client.js   ← fetch wrappers
│       └── components/
│           ├── Login.jsx
│           ├── Home.jsx
│           ├── Diagram.jsx
│           ├── DiagramCanvas.jsx
│           ├── NodeModal.jsx
│           ├── AdminPanel.jsx   ← right-side editor
│           ├── Logo.jsx
│           └── icons.jsx
│
└── data/                   ← seed data — push these to your GitHub repo once
    ├── index.json
    └── processes/
        ├── process-1.json
        ├── process-2.json
        └── process-3.json
```

## Setup

### 1. Create a GitHub repo for storage

Create a **new private GitHub repo** (e.g. `absheron-data`). It will hold your process JSON files.

Push the contents of the `data/` folder from this project into that repo so the structure is:

```
your-data-repo/
├── data/
│   ├── index.json
│   └── processes/
│       ├── process-1.json
│       ├── process-2.json
│       └── process-3.json
```

### 2. Generate a GitHub Personal Access Token (PAT)

1. Go to https://github.com/settings/personal-access-tokens/new
2. **Fine-grained token** → only your `absheron-data` repo
3. Permissions: **Contents: Read and write**
4. Copy the token (starts with `github_pat_...`)

### 3. Configure backend

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env`:

```
PORT=4000
GITHUB_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxx
GITHUB_OWNER=your-github-username
GITHUB_REPO=absheron-data
GITHUB_BRANCH=main
DATA_PATH=data
AUTH_USERNAME=admin
AUTH_PASSWORD=changeme
JWT_SECRET=replace-with-long-random-string
```

Install and run:

```bash
npm install
npm run dev
```

Backend now runs on http://localhost:4000

### 4. Configure frontend

```bash
cd ../frontend
cp .env.example .env
```

`frontend/.env`:

```
VITE_API_URL=http://localhost:4000
```

Install and run:

```bash
npm install
npm run dev
```

Frontend now runs on http://localhost:5173

### 5. Run both at once (optional)

From the project root:

```bash
npm install
npm run dev
```

This uses `concurrently` to spin up both servers together.

## Using the admin panel

1. Log in (`admin` / `changeme` by default — change in `.env`).
2. Open any process from the home page.
3. Click **Edit** in the top-right of the diagram to toggle edit mode.
4. The right-side admin panel appears with three sections:

   **PANELS (Lanes)** — the horizontal rows like "ADY", "MPO", "VPD-nin Əməliyyatlar və koordinasiya şöbəsi"
   - Click `+ Add panel` to create a new lane
   - Each panel shows its label and height; click to edit, trash icon to delete

   **NODES** — three buttons for the three types
   - `+ Pill` (full radius — for start/end nodes)
   - `+ Rectangle` (filled blue — for normal steps)
   - `+ Stroke` (outlined — for sub-steps like 5.1, 7.2)

   When you click one, a new node is added in the currently selected panel. Drag it to reposition.

   **SELECTED ITEM** — when you click a node in edit mode, this section shows:
   - Node ID (auto-generated, or you can override e.g. `5.1`)
   - Type (switch between pill/rect/stroke)
   - Text content
   - General info + Risks (for the click-popup)
   - Delete button

5. Click **Save** in the top bar. The backend commits the updated JSON file to your GitHub repo. That's it — your data is versioned in git.

## API reference

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST   | `/api/login` | `{ username, password }` → `{ token }` |
| GET    | `/api/processes` | list of `{id, title}` |
| GET    | `/api/processes/:id` | full process object |
| POST   | `/api/processes` | create new process |
| PUT    | `/api/processes/:id` | update full process |
| DELETE | `/api/processes/:id` | delete process |

All endpoints except `/api/login` require `Authorization: Bearer <token>`.

## Data model

```jsonc
// data/index.json
{
  "processes": [
    { "id": 1, "title": "Vaqonların Mərkəzə qəbulu prosesi" },
    { "id": 2, "title": "..." }
  ]
}

// data/processes/process-1.json
{
  "id": 1,
  "title": "Vaqonların Mərkəzə qəbulu prosesi",
  "width": 1820,
  "height": 720,
  "lanes": [
    { "id": "lane-1", "label": "ADY", "y": 20, "h": 200 }
  ],
  "nodes": [
    {
      "id": 1,
      "type": "pill",     // "pill" | "rect" | "stroke"
      "x": 100, "y": 70,
      "w": 230, "h": 110,
      "text": "...",
      "info": { "general": ["..."], "risks": ["..."] }
    }
  ],
  "edges": [
    { "from": 1, "to": 2, "s": "bottom", "e": "top", "dashed": false }
  ]
}
```

## Production deployment

- **Backend** → any Node host (Hostinger VPS, Railway, Fly.io). Set the `.env` vars.
- **Frontend** → run `npm run build` in `frontend/`, deploy `dist/` to any static host (Vercel, Netlify, or behind nginx on the same VPS). Set `VITE_API_URL` to your backend URL before building.

## License

Private — internal use only.


## AI Köməkçi (AI assistant)

Admin-only chatbot in a right-hand sidebar, opened from the ✨ button next to the
search icon. Understands English and Azerbaijani, **always replies in Azerbaijani**.

### Setup — 2 minutes, free

1. Get a free key at <https://aistudio.google.com/apikey>
2. Add it as an env var:
   - locally: `GEMINI_API_KEY=...` in `.env`
   - on Vercel: **Settings → Environment Variables** on the **backend** project, then redeploy.

That is the only required step. Free tier for `gemini-2.0-flash`: **15 req/min, 1500 req/day**.

Alternative free providers (drop in either key instead, it is auto-detected):

| Env var | Provider | Free tier |
|---|---|---|
| `GEMINI_API_KEY` | Google AI Studio | 15/min · 1500/day |
| `GROQ_API_KEY` | Groq | 30/min · 1000/day |
| `OPENROUTER_API_KEY` | OpenRouter (`:free` models) | 20/min · 50/day |

Optional: `AI_PROVIDER=gemini|groq|openrouter` to force one, `AI_MODEL=...` to override the model.

Live quota (used / limit, per minute and per day) is shown in the sidebar under the
gauge icon. Counters live in the serverless instance's memory and reset on a cold
start — the published provider limits next to them are the authoritative number.

### What it can do

- **Build diagrams from a prompt** — *"SSO mövzusunda proses diaqramı yarat"* produces
  real swimlanes, shapes and arrows, not an empty template.
- **Edit the open diagram** — add / update / delete nodes, lanes and arrows; change titles; relayout.
- **Manage the list** — create, rename and delete folders; archive, restore, delete and open diagrams; filter the search.
- **Run tools** — `save`, `Təqdimat` (presentation), archive, sign out.
- **Ask before guessing** — if the request is ambiguous it asks a clarifying question
  with tappable options instead of inventing an answer.

### How it stays safe

- `/api/ai/*` is **admin-only** server-side (`requireAdmin`), so hiding the button is not the only defence.
- Nothing runs automatically. Every batch of actions opens a **confirm popup** listing
  each operation in plain Azerbaijani; individual actions can be unchecked, destructive
  ones are flagged red.
- The model never writes coordinates. It emits a coordinate-free spec and
  `ai/aiBuild.js` computes lanes, columns, positions and arrow ports using the app's
  own `repackLanes` / `resolveNodePlacement` helpers — the same code the manual editor uses.
- All diagram edits go through `updateProcess()`, so **Ctrl+Z undoes anything the AI did**,
  and nothing reaches GitHub until you press *Yadda saxla*.
- The full schema (`index.json`, `process-<id>.json`, shapes, styles, ports) is in the
  system prompt, and a live context snapshot with the real ids is sent on every turn, so
  it cannot invent a `groupId` or `nodeId`.

### AI files

```
backend/
├── routes/ai.js               ← POST /api/ai/chat, GET /api/ai/limits (admin only)
└── services/
    ├── aiProvider.js          ← Gemini / Groq / OpenRouter adapters + usage counters
    └── aiSchema.js            ← system prompt (schema + action protocol + AZ rules)

frontend/src/
├── api/aiClient.js
└── components/ai/
    ├── AiButton.jsx           ← ✨ trigger next to search
    ├── AiSidebar.jsx          ← chat, quota panel, clarifying questions
    ├── AiActionPopup.jsx      ← confirm-before-run popup
    ├── aiActions.js           ← Azerbaijani descriptions of each action
    └── aiBuild.js             ← spec → real schema + auto layout
```
