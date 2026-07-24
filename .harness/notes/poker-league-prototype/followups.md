# Follow-ups — poker-league-prototype

Deferred items from review iter 1. Criticals + Required were fixed in
`0012_security_hardening.sql` (commit `fix: harden RLS …`); the below were left
for a later pass.

## FE (required by the 0012 backend change — do in the FE fix pass)
- **Profile screen avatar/name update must switch from a direct `player` table
  update to the new `update_own_profile` RPC.** Dropping the player self-UPDATE
  policy means `supabase.from('player').update({avatar_url,name})` now silently
  affects 0 rows. Call `supabase.rpc('update_own_profile', { p_name, p_avatar_url })`
  instead (see `Profile.tsx:104-105`). Integration test already switched to the RPC.

## Backend — Optional / Consider / Nit (from review-loop-iter-1-backend.md)
- Optional: `checked_in` counts as "alive" in total−1 (0009:339-341) — an
  unpaid checked-in player inflates the bust count / could be crowned. Decide
  playing-only vs paid-required and document.
- Optional: concurrent busts (0009:311-370) — no `FOR UPDATE`; two simultaneous
  self_bust/eliminate can dup a final_position. Spec accepts optimistic + admin
  reconcile; a row lock would make it correct.
- Optional: no single-active-season constraint (0001:40-57) — add a partial
  unique index `on season(status) where status='active'`.
- Optional: `close_season` (0010) orphans unfinished fechas of the archived
  season; `open_tournament` never checks the season is active. Block close while
  a live fecha exists, or cascade scheduled fechas.
- Consider: `undo_last_elimination` works on a completed tournament, and
  `confirm_payment` will flip an eliminated/winner entry back to playing
  (0009:441-498, 227-247) — add a status guard.
- Nit: `auth.role() = 'service_role'` is deprecated vs `auth.jwt()->>'role'`
  (0009:145-151 and elsewhere, incl. the new `create_player` which matches the
  existing pattern for consistency). Low priority; works today.
- FYI: idempotency style inconsistent (bare `create` in 0001 vs `drop … if
  exists` in 0011) — fine for the reset-based model.
