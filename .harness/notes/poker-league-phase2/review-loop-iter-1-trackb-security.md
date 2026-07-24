# Review iter 1 (FOCUSED LENS: security) — poker-league-phase2 Track B
Diff: `84b4222...191b670`, 34 files, +4220/-5 (security surface: mig 0016, Galeria.tsx, FechaDetail.tsx, Fechas.tsx, gallery.integration.test.ts, notify.ts)
Verdict: FINDINGS (no Critical — the flagged privesc/spoof vectors are all closed)

Lens scope: security ONLY. Correctness/readability/architecture/performance deliberately not assessed (another pass owns them).

## Bottom line
Every vector the dispatch called out is **closed**:
- gallery_photo SELECT is league-member-only; non-member (`auth_player_id()` NULL) and anon see nothing.
- gallery_photo INSERT pins `uploader_id = auth_player_id()` → uploader-spoof impossible; non-member can't insert (NULL ≠ a NOT NULL uploader_id).
- gallery_photo DELETE is uploader-or-admin only; non-uploader non-admin blocked.
- `gallery` storage objects: own-player-id-folder gate on INSERT/UPDATE/DELETE, with an explicit `auth_player_id() is not null` on INSERT to lock out non-members. Crafted paths (`../`, leading-slash, foreign-id, root) all fail the first-segment match (verified empirically, below).
- `tournament.cover_url` write is admin-only after mig 0017 (`using/with check (auth_is_admin())`); the removed `created_by` owner-escape is NOT relied on. Admin cover-set still works; non-admin blocked.
- Notifications pass only plain-text `title`/`body` to `new Notification(...)` — no HTML/eval/URL sink.
- No new SECURITY DEFINER function in this diff; pre-existing helpers (`auth_player_id`/`auth_is_admin`) pin `search_path`.

The committed integration test (`gallery.integration.test.ts`) exercises the gallery_photo table RLS through REAL signed-in clients and asserts exactly these cases (member insert-own + read-back; spoof-insert → 42501; non-member read → 0 rows; non-uploader delete → no-op, row survives; admin delete → gone). Solid coverage of the table gate.

## Findings

- (required) `supabase/migrations/0016_gallery.sql:76-78` — the `gallery` bucket is created PUBLIC with **no `allowed_mime_types` and no `file_size_limit`**. Any authenticated league member, bypassing the FE `accept="image/*"`, can upload arbitrary content-typed bytes (HTML/SVG/JS) or unbounded-size files into their own folder of a world-readable bucket (member controls `contentType` via `.upload(path,file,{contentType:file.type})`, Galeria.tsx:69 / FechaDetail.tsx:590). Blast radius is limited (served from the separate Supabase storage origin, not the app origin; the app renders only via `<img>`, which won't execute SVG script; object names carry random UUIDs), so this is NOT a privesc — but an unrestricted public bucket is a real hardening gap + storage-abuse/DoS vector and the fix is cheap. Fix: `allowed_mime_types => array['image/jpeg','image/png','image/webp','image/gif']` and a `file_size_limit` (e.g. `'10MB'`) on the bucket insert. NOTE: the `avatars` bucket (0011:121-123) shares this gap, so this is a pattern-consistency item, not a regression — the orchestrator may batch-fix both; but Phase 2 widens exposure (any member can now write, vs. avatars = self only).

- Optional: `supabase/migrations/0016_gallery.sql:60-62` — the gallery_photo INSERT policy pins `uploader_id` to the caller but leaves `storage_path` and `tournament_id` unconstrained. A member can insert a row whose `storage_path` points at another member's object/cover, or attach a photo to any `tournament_id`. Because the bucket is public-read, this leaks nothing not already public (worst case: the grid shows an image the "uploader" didn't upload, or a photo posted to an arbitrary fecha). Single-league app, so cross-league tournament_id isn't a concern today (multi-league is an open §11 question). Consider a `with check` clause `split_part(storage_path,'/',1) = uploader_id::text` to keep the row self-consistent and make future object-cleanup safe.

- Optional: `src/routes/FechaDetail.tsx:630` and `src/routes/Fechas.tsx:236` — `style={{ backgroundImage: \`url(${coverUrl})\` }}` interpolates the DB value into a CSS `url()` unquoted/unencoded. The value is admin-written (post-0017) and produced by `getPublicUrl` (percent-encoded path), so CSS-injection isn't practically reachable, but unquoted `url()` interpolation of a DB-shaped string is a smell. Consider `url("...")` with `encodeURI`, or render an `<img>`.

- Nit: `src/lib/notify.ts:139` — `new Notification(title, { body })` with `title` = `tournament.name` and `body` containing player names (both DB/user-supplied). The Notification API renders these as plain text (no HTML), so there is no injection — noted only to confirm it was checked. No `icon`/`data`/URL fields are fed from untrusted input.

## FYI (no action)
- `supabase/migrations/0016_gallery.sql:85-87` — gallery photos are effectively world-readable: the bucket is public and the `gallery public read` storage policy grants SELECT `to public`. The gallery_photo TABLE RLS gates who can *discover* the paths, not who can fetch the *bytes*. This is the documented, intentional design (0016 header: public so `getPublicUrl`/covers render without the stopped imgproxy) and mirrors avatars; random-UUID names are non-enumerable. Flagging so it's a conscious call for a "private friends' league": anyone with a URL can view the image, with no auth at the byte layer.
- `src/components/Galeria.tsx` — no UI (or RPC) path deletes a gallery photo. A gallery_photo row deleted via the RLS-permitted direct call (uploader/admin) leaves the storage object orphaned (no table→bucket cascade). Not a security issue; interacts with the unvalidated-`storage_path` item above.

## Empirical verification (psql, read-only / no mutation)
Local Supabase DB (`127.0.0.1:54322`) is on a DIFFERENT timeline than this branch — 31 applied migrations but **no `gallery_photo` table, no `tournament.cover_url` column, and no `gallery` bucket** (this branch's 0016/0017 are not applied there). I did NOT apply them (would mutate state; dispatch = rolled-back tx only). So live-policy execution against 0016/0017 could not be run here.
What I did verify (pure function, zero state), the crux of the storage owner-folder gate:
```
storage.foldername() first-segment vs 'PLAYERID':
  PLAYERID/2024-abc.jpg          seg1=PLAYERID        matches=t
  PLAYERID/covers/2024-abc.jpg   seg1=PLAYERID        matches=t   (admin cover path passes)
  OTHERID/2024-abc.jpg           seg1=OTHERID         matches=f
  ../OTHERID/x.jpg               seg1=..              matches=f
  x.jpg (bucket root)            seg1=NULL            matches=NULL→denied
  /OTHERID/x.jpg (leading slash) seg1=''(empty)       matches=f
```
Confirms a member can only write/delete objects whose first path segment equals their own player id; every crafted cross-user path fails the match. Combined with the explicit `auth_player_id() is not null` on INSERT, the storage gate is sound. The table-RLS gate is proven by the committed integration test (read + verified correct). The 0017 tournament-UPDATE admin-only gate is verified by source reading (no `created_by` escape remains).

## Axes checked (focused lens)
security ✓ (touches-sensitive: YES — new public Storage bucket + storage.objects RLS, gallery_photo table RLS, admin-gated tournament.cover_url direct write, local Notification of user-supplied text). correctness/readability/architecture/performance — NOT ASSESSED (out of lens).
