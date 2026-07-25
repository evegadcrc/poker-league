-- ============================================================================
-- Poker Friends — season integrity (Phase 2, steps 1 & 2)
--
-- STEP 1 — single-active season invariant + close_season all-active fix
--   The domain rule is "one active season at a time" (CLAUDE.md / §schema), but
--   nothing enforced it: the schema allowed any number of status='active' rows
--   and close_season (0010) archived only the NEWEST active row
--   (`order by year desc limit 1`), silently leaving older active rows behind.
--   This migration:
--     (1a) REPAIRS any pre-existing >1-active data (archives all but the newest
--          active row) so the partial unique index can be created on dirty data.
--     (1b) adds a partial UNIQUE index enforcing at most one active season.
--     (1c) fixes close_season to archive ALL active rows in its (already single)
--          transaction, carrying config forward from the newest active row.
--
-- STEP 2 — leaderboard roster-at-0
--   leaderboard(season_id) previously derived its roster ONLY from players with
--   an entry in the season, so a brand-new season with no fechas returned an
--   EMPTY table. It now falls back to the FULL league roster (every player at
--   0 pts / empty form) when the season has no entries yet. Non-empty seasons
--   are unchanged (identical roster, ordering, and tiebreakers).
--
-- Both functions keep the SECURITY DEFINER + pinned search_path pattern from
-- their original definitions (matching 0010 / 0003 / 0012).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1a) REPAIR — collapse any pre-existing >1-active rows to a single active
--      one before the unique index is created. Keeps the newest active row by
--      (year desc, created_at desc, id desc) — the same "newest" convention
--      close_season carries config forward from — and archives the rest.
-- ---------------------------------------------------------------------------
update public.season
   set status = 'archived'
 where status = 'active'
   and id <> (
     select s.id
       from public.season s
      where s.status = 'active'
      order by s.year desc, s.created_at desc, s.id desc
      limit 1
   );

-- ---------------------------------------------------------------------------
-- (1b) Partial unique index — at most one season may be status='active'. All
--      indexed rows share the same value ('active'), so the uniqueness of that
--      value permits exactly one such row. Any second active insert/update now
--      fails with a unique_violation (23505).
-- ---------------------------------------------------------------------------
create unique index if not exists season_single_active
  on public.season (status)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- (1c) close_season() — archive the active season and open the next year.
--      REPLACES 0010's definition. Unchanged except the archival step now
--      archives EVERY active row (not just the newest) so a legacy >1-active
--      state can't strand older active rows; config is still carried forward
--      from the newest active row (v_old). Archival runs BEFORE the new active
--      insert so the (1b) index never sees two active rows.
-- ---------------------------------------------------------------------------
create or replace function public.close_season()
returns setof public.season
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old    public.season;
  v_new_id uuid;
begin
  if not (public.auth_is_admin() or auth.role() = 'service_role') then
    raise exception 'cerrar liga: solo un admin puede cerrar la temporada';
  end if;

  select * into v_old
  from public.season
  where status = 'active'
  order by year desc
  limit 1;

  if not found then
    raise exception 'cerrar liga: no hay temporada activa';
  end if;

  -- Archive (not delete) ALL active seasons — the invariant is single-active,
  -- but archive every active row defensively so nothing is left behind. Runs
  -- before the insert below so the partial unique index is never violated.
  update public.season set status = 'archived' where status = 'active';

  -- Open next year's active season, carrying the config forward from the
  -- newest (v_old) archived season. Players are global, so there is no roster
  -- to copy; the new season simply has no entries.
  insert into public.season (
    name, year, status,
    points_multiplier, bonus_final_table, bonus_top3, bonus_attendance,
    no_show_penalty, early_bird_bonus_chips, cancel_bands, payout_template,
    final_table_size_override
  ) values (
    'Liga ' || (v_old.year + 1), v_old.year + 1, 'active',
    v_old.points_multiplier, v_old.bonus_final_table, v_old.bonus_top3, v_old.bonus_attendance,
    v_old.no_show_penalty, v_old.early_bird_bonus_chips, v_old.cancel_bands, v_old.payout_template,
    v_old.final_table_size_override
  )
  returning id into v_new_id;

  return query select * from public.season where id = v_new_id;
end;
$$;

revoke all on function public.close_season() from public, anon;
grant execute on function public.close_season() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (2) leaderboard(season_id) — roster-at-0. REPLACES 0003's definition.
--     The ONLY change is the `roster` CTE: it now UNIONs the full league
--     roster when the season has NO entries yet, so a brand-new season returns
--     every player at 0 pts instead of an empty table. For a season that
--     already has entries the fallback branch produces zero rows, so the
--     roster (and therefore ordering + tiebreakers) is identical to before and
--     players with entries are never double-counted.
-- ---------------------------------------------------------------------------
create or replace function public.leaderboard(
  p_season_id uuid
) returns table (
  player_id     uuid,
  player_name   text,
  avatar_url    text,
  total_points  int,
  games_played  int,
  wins          int,
  podiums       int,
  form          text[]
)
language sql
stable
security definer
set search_path = public
as $$
  with roster as (
    select distinct e.player_id
    from public.entry e
    join public.tournament t on t.id = e.tournament_id
    where t.season_id = p_season_id
    union
    -- Roster-at-0: when the season has NO entries yet (fresh season / no
    -- fechas), fall back to the full league roster so every player appears at
    -- 0 pts. Players are global (no season_id). This branch is empty the moment
    -- the season has any entry, leaving non-empty seasons unchanged.
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
    where t.season_id = p_season_id and t.status = 'completed'
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
      row_number() over (
        partition by f.player_id order by f.scheduled_at desc, f.id desc
      ) as rn
    from finished f
    where f.final_position is not null
  ),
  form_agg as (
    select player_id, array_agg(tier order by rn) as form
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
    coalesce(fa.form, array[]::text[])
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
