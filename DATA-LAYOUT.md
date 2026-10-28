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
