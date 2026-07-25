-- ============================================================================
-- Poker Friends — GUEST players (Phase 3)
--
-- A GUEST plays a SINGLE fecha but earns 0 season points and NEVER appears on
-- the Tabla / leaderboard. Guests are otherwise NORMAL entries: they count
-- toward N (field size) and the pot / prizes, so other players' points are
-- unaffected (decision — fixed, do not re-litigate).
--
-- STEP 1 — player.is_guest flag (default false; every existing member is a real
--   league player). add_guest_entry (below) is the ONLY writer that sets it true.
--
-- STEP 2 — leaderboard(season_id) recreated from 0018 VERBATIM with ONE change:
--   the final projection now filters `where not p.is_guest`, so a guest is never
--   emitted as a standings row. Everything else — roster-at-0 (0014), the
--   counts_for_league filter (0015), form + form_positions (0018), the aggregates,
--   tier logic, ordering, tiebreakers, SECURITY DEFINER + pinned search_path, and
--   the grants — is preserved byte-for-byte. A guest still contributes only to its
--   OWN (dropped) row: per-player aggregates never mix players, so excluding the
--   guest row leaves every real player's points identical.
--
-- STEP 3 — add_guest_entry(name, tournament_id) → the new guest player's id.
--   SECURITY DEFINER, pinned search_path, admin-gated (auth_is_admin(); the
--   service_role JWT is admitted so the integration suite can drive it, matching
--   the create_player guard shape in 0012). Creates a guest player (is_guest=true,
--   a synthesized collision-free placeholder email since player.email is NOT NULL
--   UNIQUE) and seeds a 'checked_in' entry for that player — exactly how a real
--   check-in seeds one (status + checked_in_at + starting-stack chips) — so the
--   admin can confirm payment / eliminate the guest from the live console.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) player.is_guest — NOT NULL DEFAULT false backfills every existing row.
-- ---------------------------------------------------------------------------
alter table public.player
  add column if not exists is_guest boolean not null default false;

-- ---------------------------------------------------------------------------
-- (2) leaderboard(season_id) — REPLACES 0018's definition (DROP + recreate so
--     the grants re-assert cleanly). Identical to 0018 except the guest
--     exclusion on the final projection. No object depends on this function
--     (only grants + comments reference it), so the drop is safe.
-- ---------------------------------------------------------------------------
drop function if exists public.leaderboard(uuid);

create function public.leaderboard(
  p_season_id uuid
) returns table (
  player_id      uuid,
  player_name    text,
  avatar_url     text,
  total_points   int,
  games_played   int,
  wins           int,
  podiums        int,
  form           text[],
  form_positions int[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with roster as (
    select distinct e.player_id
    from public.entry e
    join public.tournament t on t.id = e.tournament_id
    where t.season_id = p_season_id
    union
    -- Roster-at-0 (0014): fall back to the full league roster only when the
    -- season has NO entries yet. Empty the moment the season has any entry.
    select p.id
    from public.player p
    where not exists (
      select 1
      from public.entry e2
      join public.tournament t2 on t2.id = e2.tournament_id
      where t2.season_id = p_season_id
    )
  ),
  finished as (
    select e.*, t.scheduled_at
    from public.entry e
    join public.tournament t on t.id = e.tournament_id
    where t.season_id = p_season_id
      and t.status = 'completed'
      and t.counts_for_league            -- STEP 7 (0015): exclude standalone fechas
  ),
  agg as (
    select
      f.player_id,
      coalesce(sum(f.points_earned), 0)::int                                  as total_points,
      count(*) filter (where f.final_position is not null)::int               as games_played,
      count(*) filter (where f.final_position = 1 or f.chopped)::int          as wins,
      count(*) filter (where f.chopped or f.final_position between 1 and 3)::int as podiums,
      max(f.scheduled_at) filter (where f.final_position is not null)         as last_finish
    from finished f
    group by f.player_id
  ),
  form_rows as (
    select
      f.player_id,
      case
        when f.final_position = 1 or f.chopped   then 'champion'
        when f.final_position between 2 and 3    then 'podium'
        when f.made_final_table                  then 'final'
        else 'out'
      end as tier,
      f.final_position as pos,
      row_number() over (
        partition by f.player_id order by f.scheduled_at desc, f.id desc
      ) as rn
    from finished f
    where f.final_position is not null
  ),
  form_agg as (
    -- form + form_positions are aggregated from the SAME rows with the SAME
    -- `order by rn`, so index i of one lines up with index i of the other.
    select
      player_id,
      array_agg(tier order by rn) as form,
      array_agg(pos  order by rn) as form_positions
    from form_rows
    where rn <= 5
    group by player_id
  )
  select
    p.id,
    p.name,
    p.avatar_url,
    coalesce(a.total_points, 0),
    coalesce(a.games_played, 0),
    coalesce(a.wins, 0),
    coalesce(a.podiums, 0),
    coalesce(fa.form, array[]::text[]),
    coalesce(fa.form_positions, array[]::int[])
  from roster r
  join public.player p on p.id = r.player_id
  left join agg a       on a.player_id = r.player_id
  left join form_agg fa on fa.player_id = r.player_id
  where not p.is_guest                   -- GUESTS never appear on the Tabla (0021)
  order by
    coalesce(a.total_points, 0) desc,
    coalesce(a.wins, 0)         desc,
    coalesce(a.podiums, 0)      desc,
    a.last_finish               desc nulls last,
    p.name                      asc;   -- stable final tie-break
$$;

revoke all on function public.leaderboard(uuid) from public, anon;
grant execute on function public.leaderboard(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (3) add_guest_entry(name, tournament_id) → the new guest player's id.
--     Admin-only (auth_is_admin() OR service_role). Creates the guest player and
--     its 'checked_in' entry in one transaction; returns the guest player id.
-- ---------------------------------------------------------------------------
create or replace function public.add_guest_entry(
  p_name          text,
  p_tournament_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player_id uuid;
  v_stack     int;
begin
  -- coalesce guards the NULL-role fail-open: `auth.role() = 'service_role'` is
  -- NULL when the JWT lacks a role claim, and `if not (… or NULL)` skips the raise.
  if not (public.auth_is_admin() or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'invitado: solo un admin puede agregar invitados';
  end if;

  -- The fecha must exist; grab its starting stack to seed the guest's chips
  -- exactly like a real check-in.
  select coalesce(t.starting_stack, 0) into v_stack
  from public.tournament t
  where t.id = p_tournament_id;
  if not found then
    raise exception 'invitado: la fecha % no existe', p_tournament_id;
  end if;

  -- Guest player: is_guest=true → excluded from the leaderboard forever. email is
  -- NOT NULL UNIQUE, so synthesize a collision-free placeholder.
  insert into public.player (name, email, is_guest)
  values (p_name, 'guest+' || gen_random_uuid() || '@local', true)
  returning id into v_player_id;

  -- Seed the entry like a normal checked-in player (unique (tournament_id,
  -- player_id) is guaranteed by the fresh guest player id).
  insert into public.entry (tournament_id, player_id, status, checked_in_at, chips)
  values (p_tournament_id, v_player_id, 'checked_in', now(), v_stack);

  return v_player_id;
end;
$$;

revoke all on function public.add_guest_entry(text, uuid) from public, anon;
grant execute on function public.add_guest_entry(text, uuid) to authenticated, service_role;
