-- ============================================================================
-- Poker Friends — form finishing-positions + odds flag (Phase 2)
--
-- STEP 1 — leaderboard(season_id) now returns finishing POSITIONS alongside form
--   The form-guide pills used to be color-only (tier per game). To render the
--   finishing NUMBER inside each pill, the RPC now also returns each player's
--   `final_position` for the SAME last-5 completed games, aligned 1:1 with the
--   existing `form` tiers array and in the SAME order (most-recent-first).
--   Because adding a column changes the function's return TABLE shape (which
--   CREATE OR REPLACE cannot do), we DROP the current function and recreate it.
--   Everything else — roster-at-0 (0014), counts_for_league filter (0015), the
--   aggregates, tier logic, ordering and tiebreakers — is preserved byte-for-byte
--   from 0015's definition; the ONLY additions are the `form_positions int[]`
--   return column and the `array_agg(final_position order by rn)` that fills it.
--   `form` and `form_positions` are built from the SAME `form_rows` CTE with the
--   SAME `order by rn`, so they are guaranteed aligned index-for-index.
--
-- STEP 2 — tournament.odds_enabled flag
--   Adds a per-fecha boolean gate for the odds calculator (admin toggle + the
--   calculator itself land in a later slice). NOT NULL DEFAULT true backfills
--   every existing row to true.
--
-- The recreated leaderboard keeps SECURITY DEFINER and pins search_path per the
-- 0012 hardening idiom (public, pg_temp). Grants are re-asserted after the drop.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) tournament.odds_enabled — per-fecha odds-calculator gate.
--     NOT NULL DEFAULT true → existing rows backfill to true automatically.
-- ---------------------------------------------------------------------------
alter table public.tournament
  add column if not exists odds_enabled boolean not null default true;

-- ---------------------------------------------------------------------------
-- (2) leaderboard(season_id) — REPLACES 0015's definition (DROP + recreate to
--     widen the return TABLE with `form_positions int[]`). No other object
--     depends on this function (only grants + comments reference it), so the
--     drop is safe; grants are re-asserted below.
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
  order by
    coalesce(a.total_points, 0) desc,
    coalesce(a.wins, 0)         desc,
    coalesce(a.podiums, 0)      desc,
    a.last_finish               desc nulls last,
    p.name                      asc;   -- stable final tie-break
$$;

revoke all on function public.leaderboard(uuid) from public, anon;
grant execute on function public.leaderboard(uuid) to authenticated, service_role;
