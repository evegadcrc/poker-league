# Phase 3 — follow-ups (accepted, NOT built)

Captured while addressing the review-loop iter-1 findings. These are consciously
deferred, not forgotten. Fixed findings live in the migrations/routes/tests.

## Accepted risks

- **v2 scoring does not rescore already-completed active-season fechas.** 0019
  replaces `fn_tournament_points` + backfills the season config, but never re-runs
  the engine over completed fechas — their `points_earned` stays frozen at v1.
  ACCEPTED: prod's active season has 0 completed fechas, so there is nothing to
  rescore and the Tabla cannot mix v1/v2 within a season. If a mid-season formula
  change is ever needed, add an explicit rescore step (loop `fn_tournament_points`
  over each completed, league-counting active-season tournament) before deploy.

- **`request_access` has no rate-limit / captcha.** The anon key can insert one
  `signup_request` row per unique email (the `unique(email)` only dedupes exact
  repeats). ACCEPTED for a private friends' league: an admin reviews every request
  and the unique-email dedup caps trivial duplicates. Injection-safe (parameterized
  + pinned search_path, PROVEN by the security lens). Revisit (edge rate-limit or a
  Turnstile-style captcha + email-format validation) if the app ever goes public.

## Systemic follow-up (worth a dedicated pass)

- **DEFINER-writer ACL audit.** The two bugs fixed here (anon/authenticated retained
  implicit EXECUTE on SECURITY DEFINER writers because `revoke ... from public` does
  NOT strip role grants) and the NULL-role fail-open guard idiom
  (`auth.role() = 'service_role'` → NULL when the JWT lacks a role claim) both exist
  elsewhere in the schema — e.g. 0012 (`create_player`) carries the same guard shape,
  and other DEFINER writers were only `revoke ... from public`. Recommend a one-pass
  audit of EVERY SECURITY DEFINER function: (a) confirm anon/authenticated lack
  EXECUTE unless intended, and (b) harden all admin guards to
  `coalesce(auth.role(),'') = 'service_role'`. Out of scope for this batch (which is
  gated to the Phase-3 diff + the two named blast-radius helpers).
