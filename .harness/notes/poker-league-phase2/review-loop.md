# Review loop — poker-league-phase2

Phase 2 is reviewed PER-TRACK (full diff = 7095 lines, 7× review-loop's ~1000-line gate).

## Track A (refinements + close_season bug fix) — Final: APPROVED
Iterations: 2 (panel: five-axis + security + data-migration)
Range reviewed: `main...84b4222`

### Resolved
- **Critical (security):** tournament INSERT/UPDATE/DELETE RLS was `auth_is_admin() OR created_by=self`
  → a non-admin could self-insert a fecha, become `fn_is_tournament_admin`, drive
  eliminate_multi/clock/complete, and inject season points. Fixed: mig `0017` restricts all tournament
  writes to `auth_is_admin()` only; `create_tournament` (DEFINER) remains the legit insert path; admin
  `.update()` still works. Escalation verified closed via psql (non-admin INSERT→42501, UPDATE→0 rows).
  Commit `329d02d`.
- **Required (correctness):** multi-bust could select the entire in-play field (no survivor) →
  mislabel/rollback. Fixed: `eliminate_multi` raises on 0 survivors; MultiBustSheet disables
  eliminate+tie when all selected. Commit `bc0afca`.
- **Optional (data-migration):** 0015 backfill aborted the whole migration on a non-array
  `payout_template`. Fixed: `jsonb_typeof='array'` guard. Commit `bc0afca`.

### Confirmed safe by the panel
- Co-champion trap correctly avoided (mid-field tie sets `chop_group` only, never chopped/winner/
  made_final_table). close_season single-active invariant genuinely enforced (repair-all + partial
  unique index + archive-all). 0015 backfill does NOT rewrite completed-fecha prizes (no history
  rewrite). No Phase-1 RLS escalation reintroduced elsewhere.

### Non-blocking residuals → followups.md
- admin `.update` not column-scoped (now admin-only, defense-in-depth); fn_is_tournament_admin owner
  path latent dead-code; create_tournament jsonb_array_length unguarded (one-RPC error only).

## Track B (odds calc / learning / sound / gallery) — Final: APPROVED
Iterations: 2 (panel: five-axis + security)
Range reviewed: `84b4222...191b670`

### Resolved
- **Required (test-coverage):** elimination cue winner/co-champion exclusion was untested. Added real
  assertions (winner + co-champion chop → no "quedó fuera"; eliminated → fires). Commit `e0ad526`.
- **Required (security hardening):** `gallery` Storage bucket was public with no MIME/size cap → any
  member could upload arbitrary/unbounded files. Added image-only `allowed_mime_types` + 10 MiB
  `file_size_limit` (bucket stays public, matching avatars). Commit `d012827`.
- **Optional:** evaluator called with 5/6 cards (made-hand readout) but only 7-card inputs tested.
  Confirmed `evaluate7` is count-based (handles 5/6/7) — not a bug; pinned with 5- and 6-card tests.
  Commit `e0ad526`.
- **Nit:** unquoted `url(${coverUrl})` CSS → quoted. Commit `d012827`.

### Confirmed safe by the panel (no Critical)
- gallery_photo RLS: SELECT member-only, INSERT pins `uploader_id=self` (no spoof), DELETE
  uploader-or-admin; storage own-folder gate; `cover_url` write admin-only post-mig-0017 (no
  created_by escape); local Notification uses plain text only; no new SECURITY DEFINER fn. Evaluator +
  equity math correct, seeded RNG (deterministic, no flake), tests pin real known equities.

### Non-blocking residuals → followups.md
- gallery public-bucket → private+signed-URL (privacy); gallery_photo INSERT storage_path/tournament_id
  not app-validated; **gallery upload needs a mobile pass (HEIC + client-side downscale)**.

## Final
Both tracks APPROVED. Test gate green (317 passed / 1 skipped from clean db reset). Next: `/dh:verify-ui`
on Track B (net-new UX; design was skipped) → ship as stacked PRs (Track A, then Track B).
