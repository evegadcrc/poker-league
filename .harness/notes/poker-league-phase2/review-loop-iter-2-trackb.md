# Review iter 2 — poker-league-phase2 (Track B, fresh-context re-review)
Diff: e0ad526 + d012827 (fix commits over iter-1 HEAD 191b670), 5 files, +119/-6
Verdict: FINDINGS (no Critical, no required; 2 optional, 1 FYI) → all iter-1 actionables RESOLVED
Gates: `npx vitest run evaluator.test.ts Live.notify.test.tsx` → 26 passed. No remaining
unquoted dynamic `url(${` anywhere in `src/`. Migration reads correctly; integration test
does not touch storage, so the bucket cap can't break it.

## Prior-iteration resolutions verified

- iter-1 #A (required) elimination-cue winner/co-champion EXCLUSION untested (`src/lib/notify.ts:99-100`)
  — **RESOLVED.** Two new cases in `Live.notify.test.tsx`:
  - `:202` co-champion chop (both `playing→winner`, Dee pre-seeded eliminated) asserts
    `cueCount('elimination')===0` and no toast. This DIRECTLY catches the bug: if `winner`
    were folded into `out`, Ana+Cid become newlyOut → elimination fires → assertion fails.
    Strong, non-stub.
  - `:179` champion `playing→winner` + runner-up `playing→eliminated` in one batch asserts
    the singular toast `'Cid quedó fuera'` and NOT `'Ana'`. Load-bearing assertion is the
    singular text: if `winner` were included, newlyOut=[Cid,Ana] → message becomes
    `'2 jugadores quedaron fuera'` → `toHaveTextContent('Cid quedó fuera')` fails. Real.
    (The `not.toHaveTextContent('Ana')` is decorative — the plural message also omits 'Ana'
    — but it rides on the meaningful assertion, so no false pass.)
  - Contract confirmed at source: `notify.ts:99-100` keys `out` on `status==='eliminated'`
    only; `winner` excluded. No behavior change in this diff (tests-only).

- iter-1 #B (required, security hardening) `gallery` bucket no MIME/size cap
  (`supabase/migrations/0016_gallery.sql:76-78`) — **RESOLVED** at `0016:80-89`.
  `file_size_limit=10485760` (10 MiB) + `allowed_mime_types=[image/jpeg,png,webp,gif]`,
  and the `on conflict do update` now also updates both columns (idempotent re-apply).
  Bucket stays `public=true` — intended, matches avatars, dispatch-confirmed. FE upload
  paths send `contentType: file.type` under `accept="image/*"` (`Galeria.tsx:69`,
  `FechaDetail.tsx:590`); a bucket rejection surfaces a user-visible `role="alert"` error
  (`Galeria.tsx:70-72`), not a silent failure. The deferred residuals (public→signed URL
  migration; unvalidated `storage_path`/`tournament_id`) are recorded in `followups.md`.

- iter-1 #C (optional) evaluator 5/6-card paths untested (`Calculadora.tsx:105`) —
  **RESOLVED.** Six new cases in `evaluator.test.ts:62-97` with meaningful KNOWN best-hands:
  5-card royal SF, two-pair+kicker, all-five-kicker high card; 6-card flush-over-6th,
  full-house, one-pair-best-3-kickers (low card dropped). Verified each by hand against the
  packed tie-break structure — all correct. `evaluate7` confirmed count-based
  (`evaluator.ts:71-149`): `flushSuit` needs `count>=5`, `straightHighFromMask` reads the
  rank bitmask, kickers iterate ranks — no 7-card assumption anywhere. Genuinely handles <7.

- iter-1 #Nit unquoted `url(${coverUrl})` — **RESOLVED.** `FechaDetail.tsx:630` and
  `Fechas.tsx:236` both now `url("${...}")`. Grep confirms zero remaining unquoted dynamic
  `url(${` in `src/`.

## Findings (new, non-blocking)

- Optional: `supabase/migrations/0016_gallery.sql:84` — the MIME allowlist omits `image/heic`
  / `image/heif` / `image/avif`. This is a mobile-first PWA (CLAUDE.md) for phone uploads;
  iOS Safari's photo-library picker usually transcodes HEIC→JPEG through a file input, but a
  user who browses to an actual `.heic`/`.avif` via the Files app (or some Android pickers)
  sends `file.type='image/heic'`, which the bucket now rejects → the generic "No se pudo
  subir la foto. Probá de nuevo." (`Galeria.tsx:71`) with no reason. Consider adding
  `image/heic`,`image/heif`,`image/avif` to the allowlist. Not a regression blocker.

- Optional: `supabase/migrations/0016_gallery.sql:83` — 10 MiB per-object cap with no FE
  downscale/compression. Newer high-MP phone photos (48MP JPEG/HEIC) can exceed 10 MiB and
  would hit the same generic error. 10 MiB is a reasonable default; flag only so the value is
  a conscious call. If bumped, keep it modest to preserve the storage-abuse protection.

- FYI: editing an in-flight migration (`0016`) in place is fine here because 0016 is NOT yet
  applied to any real environment (per iter-1 security note the local DB is on a different
  timeline; this branch's 0016/0017 aren't applied). If 0016 had already shipped anywhere, a
  new forward migration would be required instead of an in-place edit.

## New-issue sweep
- No test weakened; both changes are purely additive tests + a migration hardening + a CSS
  quote. No logic touched in `notify.ts` or `evaluator.ts`.
- Bucket cap does NOT break the gallery integration test (`gallery.integration.test.ts` only
  exercises the `gallery_photo` TABLE via service-role/anon clients; it never uploads a
  storage object).
- FE upload error handling surfaces bucket rejections loudly (alert), not silently.

## Axes checked
correctness ✓ · readability ✓ · architecture ✓ · security ✓ (touches-sensitive: yes — public
Storage bucket now MIME/size-capped; no privesc change) · performance ✓
