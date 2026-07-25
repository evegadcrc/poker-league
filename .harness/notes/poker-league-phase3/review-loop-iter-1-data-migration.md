# Review iter 1 — poker-league-phase3 (DATA-MIGRATION LENS ONLY)
Diff: `main...HEAD -- supabase/migrations/` (0019–0022), 4 files, +634/-0
Verdict: FINDINGS (no Critical — 1 required, 4 optional, 4 FYI, 1 nit)

Scope: data-migration axis only. Applied on top of shipped 0001–0018. Target prod state:
1 active Liga 2026 season, 1 admin player, a blind structure, NO fechas/entries/completed games.

## Method / empirical notes
- The running local Supabase (127.0.0.1:54322) hosts a DIFFERENT project (Poppin: routes/invoices/…),
  NOT poker-league — the poker migrations are not applied there, so live-catalog introspection of poker
  objects was impossible. Verified structurally from source + catalog queries for pure-SQL semantics
  (isolated `begin…rollback`, no writes, no Poppin objects touched).
- Empirically confirmed the load-bearing NEW logic in 0019 (jsonb graduated bonus):
  `'[20,15,10,5]'::jsonb ->> (fp-1)` for fp 1..6 → 20/15/10/5/0/0 (correct); out-of-range `->> 4` → NULL
  (coalesce→0). chop `round(avg())::int` math sane.
- Authoritative FK map (grep, all 22 migrations): the ONLY tables referencing `tournament(id)` are
  `entry` (0001:116) and `gallery_photo` (0016:31), BOTH `on delete cascade`. `entry(id)` has ZERO FK
  children. `create_player(p_name text, p_email text)` = (name, email). `auth_is_admin`/`auth_player_id`
  exist (0001). `entry` NOT-NULL-without-default cols = only tournament_id/player_id.

## Findings

### Required
- 0022:54, 0022:58 — **`create policy` NOT guarded by `drop policy if exists` → idempotency /
  re-runnability regression vs the project idiom.** Every other policy-creating migration (0016:52-54,
  0017:37/42/51) precedes each `create policy` with `drop policy if exists`. Postgres has no
  `CREATE POLICY IF NOT EXISTS`, so if 0022 fails AFTER the table+policies are created (transient error,
  or a later statement in the same file errors) the migration is not recorded as applied, and a re-`db push`
  re-runs 0022 top-to-bottom: `create table if not exists` passes, then `create policy "admin read
  signup_request"` errors `policy already exists` → the push wedges and needs manual cleanup on the LIVE
  DB. Fix: prepend `drop policy if exists "admin read signup_request" on public.signup_request;` and the
  same for the update policy, matching 0016/0017. (Clean first-apply is unaffected; this is a retry hazard only.)

### Optional / Consider
- 0022:88-95 — **`request_access` has no `on conflict` on the pending INSERT (concurrency).** Two
  near-simultaneous anon calls for the same unknown email both miss the `select … where email=v_email`,
  both `insert`, and the second raises `unique_violation` (surfaced to the user instead of `'pending'`).
  Plausible on a double-tapped login button. Consider `insert … on conflict (email) do nothing` then
  return `'pending'`.
- 0019:50-55 — **Step (3) backfill is an unconditional `update … where status='active'`** with no
  guard that the season is still on v1 defaults. Migration tracking prevents re-run in practice, but if it
  ever re-executed it would silently clobber any admin-customised active-season scoring config back to v2.
  Also the `top_finish_bonuses='[20,15,10,5]'` assignment here is redundant with the column-add default
  (line 36) that already backfilled every row.
- 0020:50-52 — **`delete_tournament` leaves orphan guest players.** A guest created by `add_guest_entry`
  (0021) whose only entry is in the deleted fecha keeps its `player` row (is_guest=true, now entry-less).
  Harmless to the leaderboard (roster requires an entry AND `where not p.is_guest`), but such rows
  accumulate. Consider deleting now-parentless `is_guest` players in the same function.
- 0019:69 — **`fn_tournament_points` keeps bare `set search_path = public`** while every sibling NEW
  function in this batch (0020/0021/0022) and the recreated `leaderboard` (0021:61) use the 0012 idiom
  `public, pg_temp`. Result-neutral here (all body refs are schema-qualified; every unqualified call is a
  pg_catalog builtin), and it matches the prior 0009 def — so not a regression — but the recreate was the
  moment to align it. Low value; author's call.

### Nit
- 0019:54 — redundant re-set of `top_finish_bonuses` (already applied by the column default at line 36).

### FYI
- 0019 (history-rewrite, latent, currently unreachable): the active-season v1→v2 backfill does NOT rewrite
  any stored `entry.points_earned` — those are frozen at completion and `fn_tournament_points` is invoked
  ONLY by `complete_tournament` (0009:737), which raises on already-completed fechas. So no automatic
  re-score, and prod has no completed fechas anyway. Flag only so that IF a future "recompute standings"
  path is added, it would re-score pre-existing completed fechas under v2 (and the leaderboard would then
  mix v1/v2-scored fechas within one season). Verdict for THIS diff: safe.
- 0019 jsonb negative-index quirk: `'[20,15,10,5]'::jsonb ->> -1` returns the LAST element (empirically
  `5`), NOT null — so the `coalesce(…,0)` does NOT protect a position-0 / off-by-one; only the
  `between 1 and 4` guard does. As written `final_position` is 1-based and guarded → unreachable. Noted so
  a future loosening of that guard doesn't silently award 5 pts to an out-of-range position.
- 0020 naming: new `tournament.cancelled_at` shares a name with the pre-existing `entry.cancelled_at`
  (player-RSVP cancel, read by `fn_tournament_points` step 4). Distinct table/column; the engine reads
  `entry.cancelled_at` only — no collision, no engine change. Fine.
- Table-rewrite/lock: all three column adds (`season.top_finish_bonuses` NOT NULL DEFAULT const;
  `player.is_guest` NOT NULL DEFAULT false; `tournament.cancelled_at` nullable) are metadata-only in
  PG11+ (constant/absent defaults) and target tiny tables → no rewrite, no meaningful lock. No concern.

## Verified clean (the axis-critical items)
- **Faithful recreate — `fn_tournament_points` (0019 vs 0009:547-652):** line-by-line identical except the
  intended top-finish term (flat `bonus_top3 [P≤3]` → graduated `top_finish_bonuses ->> (P-1)` for
  `P between 1 and 4`, else 0), applied identically in the regular-finisher (line 106-108) and chop
  (line 122-124) branches. N definition, no-show coalesce, cancel-band logic, else-0, signature,
  search_path all unchanged. No behaviour drift beyond the approved v2 change.
- **Faithful recreate — `leaderboard` (0021 vs 0018:45-149):** byte-identical (roster incl. roster-at-0
  union, counts_for_league filter, agg, form_rows/form_agg alignment, projection, ordering/tiebreaks,
  security definer/stable, `public,pg_temp`, grants) EXCEPT the single added `where not p.is_guest`
  (line 140). Guests enter `roster` via their entry but are dropped at projection; per-player aggregates
  never mix players, so every real player's row is identical. Double-covered in the roster-at-0 fallback.
- **Grants preserved:** `fn_tournament_points` → service_role re-asserted (0019:184-185);
  `leaderboard` → authenticated+service_role re-asserted after DROP (0021:149-150). No grant lost.
- **DROP safety:** `drop function if exists public.leaderboard(uuid)` without CASCADE — no DB object
  depends on it (only app/tests call the RPC), so the drop is safe and would fail loudly, not silently, if
  a dependent existed.
- **No prod-state failure:** every object 0019–0022 references (season cols, player/tournament/entry,
  create_player, auth_is_admin, auth_player_id) pre-exists; function bodies aren't executed at migrate
  time. `add_guest_entry`'s insert satisfies all entry NOT-NULL cols; `'checked_in'` is a valid
  entry_status. All four apply cleanly on the current prod state.
- **0020 delete completeness:** `gallery_photo` → `entry` → `tournament` covers both (and the only) FK
  children of tournament; `entry` has no FK children, so `delete from entry` can't hit an FK violation.
  DEFINER + admin gate + `public,pg_temp`. FK-safe order correct.
- **0022 create-table idempotent** (`if not exists`), RLS enabled, anon table grants revoked, no
  INSERT/DELETE policy (default-deny; writes go through DEFINER RPCs), `create_player` arg order correct,
  `signup_request` is a brand-new name (no pre-existing conflict).

## Axes checked
correctness ✓ (data-migration only) · readability n/a · architecture n/a ·
security n/a (routed elsewhere; noted anon-write growth vector in FYI) · performance n/a
(other axes intentionally skipped — focused lens)
