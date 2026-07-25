-- ============================================================================
-- Poker Friends — leaderboard roster = LOGGED-IN members (Tabla rule change)
--
-- RULE (product owner): the Tabla lists a member as soon as they have LOGGED IN
-- (so their real name exists) — regardless of whether they've played a fecha. A
-- member the admin approved/added but who has NOT logged in yet (their
-- `player.auth_user_id` is still NULL — we only have their name after the first
-- login binds it, see claim_player in 0002/0023) must NOT appear until they log
-- in.
--
-- This REPLACES 0021's leaderboard(uuid) (DROP + recreate so the grants
-- re-assert cleanly). Identical to 0021 — same return columns, points/wins/
-- games/podiums aggregation, form + form_positions shape, ordering + tiebreakers,
-- SECURITY DEFINER, pinned search_path, and grants — EXCEPT the `roster` CTE:
--
--   OLD (0021): (players with an entry this season) UNION (the full league roster
--     ONLY when the season has no entries yet — "roster-at-0", 0014).
--   NEW: every `player` with `auth_user_id IS NOT NULL` (i.e. has logged in at
--     least once) AND `not is_guest` AND `not blocked`. The old two-branch union
--     is now redundant: a member who played has, by construction, logged in, so
--     they are already in this roster; and a member who has NOT logged in must be
--     hidden whether or not the season has entries.
--
-- The points/form aggregates are LEFT JOINed onto the roster, so a logged-in
-- member with no entries shows total_points=0, wins=0, games_played=0, form={};
-- members who played keep their real numbers (identical to 0021 for them).
-- Guests (is_guest) and blocked (blocked) members are excluded. 0021 filtered
-- guests only on the final projection; the roster now filters guests AND blocked
-- up front (the final `where not p.is_guest` is preserved, harmlessly redundant).
-- ============================================================================

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
    -- LOGGED-IN members only: auth_user_id is bound on first login (claim_player),
    -- so `is not null` == "has logged in at least once". Approved-but-never-logged-in
    -- members (auth_user_id NULL) are hidden until they log in. Guests + blocked out.
    select p.id as player_id
    from public.player p
    where p.auth_user_id is not null
      and not p.is_guest
      and not p.blocked
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
