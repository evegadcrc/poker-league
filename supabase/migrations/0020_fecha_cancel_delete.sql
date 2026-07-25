-- ============================================================================
-- Poker Friends — Phase 3: admin cancel + hard-delete for a fecha
--
-- Two admin affordances for a fecha that should not (or never should have)
-- happened:
--
--   CANCEL — a soft flag. `tournament.cancelled_at` marks a scheduled/live fecha
--     as called off. The row stays (history), keeps its non-`completed` status
--     so it never reaches the leaderboard/points aggregation, and the FE stops
--     offering the open/play/check-in actions. No points logic changes: a
--     cancelled fecha is simply never completed. The write goes through the
--     existing admin-only tournament UPDATE policy (0017) — a direct
--     `.update({ cancelled_at })`, same path CoverControl / ScheduleEditor use.
--
--   DELETE — a hard removal for a fecha created by mistake. Unlike cancel, this
--     drops the row and its children. tournament→entry and tournament→
--     gallery_photo are both `on delete cascade` (0001 / 0016), so a bare row
--     delete would cascade; we nonetheless delete the children explicitly and in
--     FK-safe order (gallery_photo, entry, then tournament) so the intent is
--     obvious and the function is correct regardless of future FK changes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) tournament.cancelled_at — nullable; existing rows stay null (not cancelled).
-- ---------------------------------------------------------------------------
alter table public.tournament add column if not exists cancelled_at timestamptz;

-- ---------------------------------------------------------------------------
-- (2) delete_tournament(id) — admin-only hard delete of a fecha + its children.
--     SECURITY DEFINER (bypasses RLS to remove child rows), pinned search_path.
--     Admin-gated internally on auth_is_admin(); service_role admitted for the
--     integration suite (matches the create_player / admin-RPC guard shape).
--     Deletes gallery_photo → entry → tournament (FK-safe order).
-- ---------------------------------------------------------------------------
create or replace function public.delete_tournament(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- coalesce guards the NULL-role fail-open: `auth.role() = 'service_role'` is
  -- NULL when the JWT lacks a role claim, and `if not (… or NULL)` skips the raise.
  if not (public.auth_is_admin() or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'eliminar fecha: solo un admin puede eliminar una fecha';
  end if;

  if not exists (select 1 from public.tournament where id = p_id) then
    raise exception 'eliminar fecha: la fecha % no existe', p_id;
  end if;

  delete from public.gallery_photo where tournament_id = p_id;
  delete from public.entry         where tournament_id = p_id;
  delete from public.tournament    where id = p_id;
end;
$$;

-- The admin gate is internal, so authenticated is safe (non-admins are rejected
-- inside); service_role is admitted for the integration suite. No anon/PUBLIC.
revoke all on function public.delete_tournament(uuid) from public, anon;
grant execute on function public.delete_tournament(uuid) to authenticated, service_role;
