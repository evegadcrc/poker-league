-- ============================================================================
-- Poker Friends — tournament write hardening (Phase-2 review iter 1, security)
--
-- CRITICAL fix. The 0001 tournament write policies were gated on
--   `auth_is_admin() OR created_by = auth_player_id()`
-- — NOT admin-only. Because Supabase grants INSERT/UPDATE/DELETE on public
-- tables to `authenticated` by default, RLS is the ONLY gate, so any signed-in
-- league member could:
--   1. INSERT a tournament with `created_by = <own player id>` (the `with check`
--      passed on the owner clause), producing a phantom fecha in the active
--      season visible to everyone.
--   2. UPDATE any column of that row (payout_distribution / counts_for_league /
--      status / season_id / current_level / prizes …) — the owner clause passed
--      the `using`/`with check`.
--   3. Thereby return TRUE from `fn_is_tournament_admin()` (0009:63-78 honours the
--      `created_by` owner path) and drive every fecha-scoped admin RPC on it:
--      clock / eliminate / eliminate_multi / complete_tournament / add_rebuy /
--      confirm_payment — i.e. inject season points.
--
-- This is the exact class Phase-1's 0012 killed on `player` + `entry`: a
-- self-write RLS policy is pure attack surface when every legitimate write
-- already goes through a SECURITY DEFINER RPC. The sole legit tournament INSERT
-- is `create_tournament` (0010/0015), a DEFINER RPC that bypasses RLS, is
-- admin-gated internally, and sets `created_by` server-side — so tightening the
-- policies to admin-only breaks no legitimate flow (every legit owner is itself
-- a global admin, still covered by `auth_is_admin()`). The one direct client
-- write that remains (the admin prize-distribution editor's
-- `.update({ payout_distribution, counts_for_league })`) is performed by a
-- global admin, who still passes `auth_is_admin()`.
--
-- FIX: drop the three tournament write policies and recreate them admin-only,
-- removing the `OR created_by = auth_player_id()` escape. SELECT is unchanged
-- (players still read fechas). Matches the drop-if-exists idiom of 0012.
-- ============================================================================

-- ---- tournament INSERT: admin only (was: admin OR owner) -------------------
drop policy if exists "admin insert tournament" on public.tournament;
create policy "admin insert tournament" on public.tournament for insert to authenticated
  with check (public.auth_is_admin());

-- ---- tournament UPDATE: admin only (was: admin OR owner) --------------------
drop policy if exists "admin update tournament" on public.tournament;
create policy "admin update tournament" on public.tournament for update to authenticated
  using (public.auth_is_admin())
  with check (public.auth_is_admin());

-- ---- tournament DELETE: admin only (was: admin OR owner) --------------------
-- No non-admin delete path exists once INSERT is admin-only (a non-admin can no
-- longer own a row), but the owner escape is dropped here too for consistency
-- with the 0012 pattern and to close the `fn_is_tournament_admin` owner path.
drop policy if exists "admin delete tournament" on public.tournament;
create policy "admin delete tournament" on public.tournament for delete to authenticated
  using (public.auth_is_admin());
