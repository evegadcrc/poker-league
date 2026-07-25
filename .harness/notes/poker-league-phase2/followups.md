# Follow-ups — poker-league-phase2

Non-blocking residuals surfaced during review-loop. Not required for merge; revisit in a
hardening pass or a later slice.

## Track A review (iter 2, non-blocking)
- **Direct admin `.update(tournament)` is not column-scoped.** Now admin-only (mig 0017), so it's
  defense-in-depth only — a compromised/rogue admin could write any tournament column. If we want
  least-privilege, route the prize-distribution write through a column-scoped SECURITY DEFINER RPC
  (`set_payout_distribution`) instead of a raw `.update()`. (Admins are trusted today.)
- **`fn_is_tournament_admin` owner path is latent dead-code.** With tournament INSERT now admin-only,
  `created_by` is always an admin, so the `created_by = caller` branch is unreachable. It re-opens the
  escalation hole if a future change ever lets a non-admin set `created_by`. Consider requiring
  `is_admin` in `fn_is_tournament_admin` (0009:63-78) as belt-and-suspenders.
- **`create_tournament` (0010:~124) `jsonb_array_length(payout_template)` unguarded.** A non-array
  template raises a one-RPC error (NOT a migration abort — the backfill was guarded in mig 0015).
  Add the same `jsonb_typeof = 'array'` guard for symmetry.

## Track B review (iter 1, non-blocking)
- **`gallery` bucket is PUBLIC → migrate to private + signed URLs (privacy).** Photo/cover *bytes* are
  world-readable to anyone holding the URL (mirrors avatars); for a private friends' league, switch the
  bucket to private and serve via `createSignedUrl`. Deferred here to keep parity with the avatars precedent (imgproxy is down locally).
- **`0016:60-62` gallery_photo INSERT `storage_path`/`tournament_id` not app-validated.** `with check`
  pins only `uploader_id = self`; a member could point a row at another object or an arbitrary fecha. Public bucket + single-league → low leak. Add `with check split_part(storage_path,'/',1) = uploader_id::text` when hardening.
## Phase 2.1 UI batch (verify-ui + polish notes)
- **Profile "Racha completa" pills show color only (no numbers).** The Tabla form pills now show the
  finishing number (mig 0018 leaderboard `form_positions`), but the profile racha reads the
  `player_profile` RPC which wasn't changed — add positions there for parity.
- **Premios on a completed fecha is data-gated on seed Fecha 1** (no `prizes`/`payout_distribution` —
  legacy seed row). Not a bug; a fecha created+completed via the app shows it. Optional: seed a demo
  completed fecha WITH prizes so it's visible in the local demo.
- **Máx-recompras + bonus-stack are form defaults only** (no per-fecha DB column; not enforced in the
  rebuy flow). Wire enforcement + persistence if these should actually bind per fecha.

- **Gallery upload needs a mobile pass (iter-2).** The `gallery` bucket allowlist omits `image/heic`+
  `image/heif` — iPhones shoot HEIC by default, so those uploads fail; and browsers often can't render
  HEIC in the grid anyway. Also no client-side downscale, so large phone photos hit the 10 MiB cap.
  Proper fix = convert HEIC→JPEG + downscale in the browser before upload (then the allowlist can stay
  JPEG/PNG/WebP). Affects most of the league (mobile-first). Do as a dedicated gallery-upload slice.

## Review iter-1 ui21 (cosmetic, deferred — need product intent)
- **FormPills gold chop pill shows true ordinality "2" for a co-champion** (FormPills.tsx:67 + mig 0018
  `f.final_position as pos`), while FechaDetail normalizes co-champions to 1º. Emit `1` (or drop the
  number) on champion-tier chops if leaderboard/FechaDetail should read consistently. Product call.
- **Live `Pendiente Pago` badge renders on every unpaid StandingRow** (Live.tsx:461), incl.
  eliminated/out and an unpaid winner — not just alive players. Gate on `alive` if the intent is
  "who still owes at the table"; leave as-is if any unpaid cash still owed should show. Product call.
