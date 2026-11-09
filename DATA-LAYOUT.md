# Data layout (Mongo + data/ folder)

Every section folder has the same four files. Mongo document `_id` = the same path.

| File | What it is |
|---|---|
| `data/<section>/home.json` | Home page list: folders + items |
| `data/<section>/home-archive.json` | Items archived from Home (restorable) |
| `data/<section>/home-deleted.json` | Items deleted from that archive — not shown, but kept (their diagram/PDF files stay too) |
| `data/<section>/hesabat.json` | Hesabat table rows (always numbered 1..n) |
| `data/<section>/hesabat-archive.json` | Archived Hesabat rows (restorable from the page) |
| `data/<section>/hesabat-deleted.json` | Hesabat rows removed with the trash icon / "Hamısını sil" — not shown, but kept |
| `data/diagrams/items/diagram-<id>.json` | The diagram itself (lanes, nodes, edges) |

Sections: `diagrams` = İş Axışları, `files` = Normativ Sənədlər, `templates` = Şablonlar, `jobs` = Vəzifə Təlimatları.

Vəzifə Təlimatları: Home = Struktur vahidi folder → Struktur bölməsi folder → one file per Vəzifə
(PDF/Word/Excel; a second file for the same Vəzifə is refused — replace it with "Redaktə et").
When vahid and bölmə have the same name there is only one folder. Hesabat columns:
Struktur vahidi (`strukturAdi`), Struktur bölməsi (`bolme`), Vəzifə (`title`), Status (Mövcuddur / Mövcud deyil), Tarix.
"Qovluqları yarat" on that hesabat builds the folder tree from the table (adds only what is missing).
Statuses are stored by their real names ("Planlaşdırılır", "Təsdiqlənmiş", …).

## Home and Hesabat are separate
Nothing is copied between them automatically. A Hesabat row can be linked to a
Home item (link icon in the table). The link dialog shows which fields differ
and lets you choose, per field, which side's value to keep.

## Nothing is hard-deleted
- Home: the archive button (and removing a folder) moves items to `home-archive.json`; deleting from the archive moves them to `home-deleted.json` (files are kept).
- Hesabat: archive icon → `hesabat-archive.json` (restorable); trash icon → `hesabat-deleted.json` (kept, not shown). Remaining rows are renumbered.
- Hesabat delete never touches Home (rows are unlinked by default).

## Migration (automatic, one time)
On first start the new code moves the old files
(`index.json`, `archive.json`, `sheets.json`, `processes/process-N.json`) to the names above,
in Mongo and in `data/`. Files that existed in data/Mongo but were missing from the lists
(e.g. `process-1.json`, `pdf-4.pdf`, `pdf-9.pdf`) are put into that section's Home archive,
marked "Datadan bərpa edildi".

Deploy the server and Vercel at the same time — the old code still reads the old file names.


## ALM-AI (data/ai/)
Same storage as everything else (Mongo + `data/`), so every PC sees the same chats.

| File | What it is |
|---|---|
| `data/ai/chats.json` | List of chats: title, screen, who created/updated it, when, tokens used |
| `data/ai/chats/chat-<id>.json` | One chat with all its messages (no file contents inside) |
| `data/ai/usage.json` | Requests and tokens: total, per day (last ~120 days), per model, per user |
| `data/ai/files/<hash>.pdf/.png/.jpg` | Original PDFs/images sent in chats — an old chat reloads its files from here |

Deleting a chat in the panel only hides it (`deleted: true` in `chats.json`); the chat file stays.

### What ALM-AI learns by itself
| File | What it is |
|---|---|
| `data/ai/knowledge.json` | Conventions learned from ALL diagrams (numbering, shapes/styles, arrows, lane names, labels) + an index of every diagram |
| `data/ai/examples.json` | Every hand-made diagram in the exact format the AI writes — the closest ones are given to it as worked examples |
| `data/ai/lessons.json` | Rules the admins taught it in chat (or typed in "Öyrəndikləri") — removing one only hides it |
| `data/ai/learn-log.json` | What it learned and when |

On the own server it re-learns 30 s after start, every 6 hours, and whenever the diagram list changes
(checked every 15 min). On Vercel it learns on first use and when "İndi öyrən" is pressed.
