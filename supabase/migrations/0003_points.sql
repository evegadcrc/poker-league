-- ============================================================================
-- Poker Friends — Points engine + leaderboard (slice 5)
--
-- Correctness-critical scoring. Pinned rules (source of truth = the plan's
-- "Approach → Canonical algorithms" block + be-contract "Resolved" items, since
-- the external Google Doc is not available to build agents):
--
--   Points §5:  Puntos = (N − P) × multiplier
--                        + bonus_final_table [if made_final_table]
--                        + bonus_top3        [if final_position ≤ 3]
--                        + bonus_attendance  [if paid]
--               minus penalties (no-show / late-cancel bands).
--
--   Chop:       each member of a chop_group gets round(Σ point-value(pos)/K),
--               and every chopper is a co-champion (título) — wins/form count
--               them as champion via entry.chopped.
--
--   Mesa final: two-tier — 5 when checked-in ≤ 10, else 10; season override wins.
--
-- N / P DEFINITIONS (documented per the slice brief):
--   N = the field size = COUNT of entries in the tournament that actually took a
--       seat and were ranked, i.e. entries with a non-null `final_position`
--       (statuses playing→eliminated/winner, plus chopped co-champions). No-shows,
--       cancellations, declines and non-participants are NOT part of N (they never
--       played), so they do not inflate everyone else's (N − P) base.
--   P = the entry's `final_position` (1 = champion … N = last to bust).
--   ⇒ winner (P=1) earns (N−1)×mult base; last place (P=N) earns 0 base.
--
-- SIGN CONVENTION: season.no_show_penalty and season.cancel_bands[].penalty are
--   stored ALREADY-SIGNED negative (-15, 0/-5/-10/-15). points_earned is assigned
--   the stored value DIRECTLY (not negated) so a no-show yields -15, matching the
--   spec's "no-show = −15". (The brief's "−no_show_penalty" phrasing assumed a
--   positive magnitude; the schema comment pins it negative.)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- fn_final_table_size(checked_in, season_id) → int
--   Two-tier mesa final: 5 when ≤10 checked in, else 10. A non-null
--   season.final_table_size_override always wins.
-- ---------------------------------------------------------------------------
create or replace function public.fn_final_table_size(
  p_checked_in int,
  p_season_id  uuid
) returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select final_table_size_override from public.season where id = p_season_id),
    case when p_checked_in <= 10 then 5 else 10 end
  );
$$;

-- ---------------------------------------------------------------------------
-- fn_tournament_points(tournament_id)
--   Computes and writes entry.points_earned for EVERY entry of the tournament.
--   Idempotent: re-running with unchanged inputs yields the same values.
-- ---------------------------------------------------------------------------
create or replace function public.fn_tournament_points(
  p_tournament_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season_id uuid;
  v_sched     timestamptz;
  v_mult      int;
  v_bmf       int;   -- bonus_final_table
  v_btop3     int;   -- bonus_top3
  v_batt      int;   -- bonus_attendance
  v_noshow    int;   -- no_show_penalty (stored negative)
  v_bands     jsonb; -- cancel_bands [{hours_before, penalty}]
  v_n         int;   -- field size N (finishers)
begin
  select t.season_id, t.scheduled_at,
         s.points_multiplier, s.bonus_final_table, s.bonus_top3,
         s.bonus_attendance, s.no_show_penalty, s.cancel_bands
    into v_season_id, v_sched, v_mult, v_bmf, v_btop3, v_batt, v_noshow, v_bands
  from public.tournament t
  join public.season s on s.id = t.season_id
  where t.id = p_tournament_id;

  if v_season_id is null then
    raise exception 'fn_tournament_points: tournament % not found', p_tournament_id;
  end if;

  -- N = number of ranked finishers (entries with a final_position).
  select count(*) into v_n
  from public.entry
  where tournament_id = p_tournament_id and final_position is not null;

  -- (1) Regular finishers (not part of a chop): full §5 formula.
  update public.entry e
     set points_earned =
           (v_n - e.final_position) * v_mult
         + case when e.made_final_table          then v_bmf   else 0 end
         + case when e.final_position <= 3        then v_btop3 else 0 end
         + case when e.paid                       then v_batt  else 0 end
   where e.tournament_id = p_tournament_id
     and e.final_position is not null
     and e.chop_group is null;

  -- (2) Chop co-champions: average the §5 point-value of each group member's
  --     finishing position (each member brings their own final_table/paid
  --     eligibility), then round once. Every member gets the same value.
  --     The chop occupies the top K positions, so this equals
  --     round(Σ point-value(positions 1..K) / K) per the pinned rule.
  with grp as (
    select e.chop_group,
           round(avg(
               (v_n - e.final_position) * v_mult
             + case when e.made_final_table   then v_bmf   else 0 end
             + case when e.final_position <= 3 then v_btop3 else 0 end
             + case when e.paid               then v_batt  else 0 end
           ))::int as pts
    from public.entry e
    where e.tournament_id = p_tournament_id
      and e.chop_group is not null
    group by e.chop_group
  )
  update public.entry e
     set points_earned = grp.pts
    from grp
   where e.tournament_id = p_tournament_id
     and e.chop_group = grp.chop_group;

  -- (3) No-shows (confirmed-but-ghosted): the season no-show penalty (−15).
  update public.entry e
     set points_earned = v_noshow
   where e.tournament_id = p_tournament_id
     and e.final_position is null
     and e.chop_group is null
     and e.status = 'no_show';

  -- (4) Cancellations: preserve a penalty already applied at cancel time; else
  --     derive the graduated late-cancel band from (scheduled_at − cancelled_at).
  --     Falls back to the most-severe band if the cancel is at/after start.
  update public.entry e
     set points_earned = coalesce(
       e.points_earned,
       coalesce(
         (select (b->>'penalty')::int
            from jsonb_array_elements(v_bands) b
           where extract(epoch from (v_sched - e.cancelled_at)) / 3600.0
                 >= (b->>'hours_before')::numeric
           order by (b->>'hours_before')::numeric desc
           limit 1),
         (select (b->>'penalty')::int
            from jsonb_array_elements(v_bands) b
           order by (b->>'hours_before')::numeric asc
           limit 1)
       )
     )
   where e.tournament_id = p_tournament_id
     and e.final_position is null
     and e.chop_group is null
     and e.status <> 'no_show'
     and e.cancelled_at is not null;

  -- (5) Everyone else (invited / declined-early / confirmed-no-action /
  --     non-participants): 0 points.
  update public.entry e
     set points_earned = 0
   where e.tournament_id = p_tournament_id
     and e.final_position is null
     and e.chop_group is null
     and e.status <> 'no_show'
     and e.cancelled_at is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- leaderboard(season_id)
--   Per-player standings over COMPLETED tournaments of the season.
--   Roster (any player with an entry in any tournament of the season) always
--   appears — a player with no completed games shows at 0 pts / empty form.
--   form = last-5 result tiers, MOST-RECENT FIRST (index 0 = latest game):
--     champion = final_position=1 OR chopped co-champion
--     podium   = final_position 2–3
--     final    = made_final_table
--     out      = else   (only played games — final_position not null — form here)
--   Ordered by tiebreakers: points → wins → podiums → most-recent finish.
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

-- ---------------------------------------------------------------------------
-- Grants.
--   * fn_tournament_points WRITES scores → locked down to service_role only.
--     Slice 12's admin complete_tournament RPC (SECURITY DEFINER, owned by the
--     migration role) calls it internally, so it needs no authenticated grant.
--   * leaderboard / fn_final_table_size are read helpers → authenticated + tests.
-- ---------------------------------------------------------------------------
revoke all on function public.fn_tournament_points(uuid) from public;
grant execute on function public.fn_tournament_points(uuid) to service_role;

grant execute on function public.fn_final_table_size(int, uuid) to authenticated, service_role;
grant execute on function public.leaderboard(uuid)             to authenticated, service_role;
