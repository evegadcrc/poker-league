-- ============================================================================
-- Poker Friends — LIVE SCORING (points populate on elimination, live LIGA)
--
-- Three gaps closed (all forward-fixes; 0009 / 0019 / 0027 / 0029 are NOT edited
-- in place — every function below is a plain create-or-replace of its LATEST
-- definition):
--
--   (1) fn_tournament_points derived N from the RANKED-so-far count
--       (`final_position is not null`) — correct only at completion, but wrong
--       mid-game (first-out gives N=1 → negative base). It is now derived from
--       the SEATED field (checked_in / playing / eliminated / winner), matching
--       the FE's playedCount()/pointsBreakdown() so DB and client agree. At
--       completion every seated player is eliminated/winner, so seated-N ==
--       old ranked-N → completed fechas score identically (regression-safe).
--       AND it is now actually CALLED on every bust: fn_eliminate_entry (→
--       eliminate + self_bust), undo_last_elimination, and add_rebuy each
--       recompute points so standings are live.
--
--   (2) leaderboard(uuid) filtered `t.status = 'completed'`, so a live fecha
--       added nothing to the Tabla. It now admits `('completed','live')` — a
--       live fecha's busted players (points now populated live) feed the
--       season standings; still-playing players (final_position null, points 0)
--       contribute nothing until they bust.
--
--   (3) complete_tournament's "confirmed ghost → no_show" flip is forward-fixed
--       to NULL the ghost's points_earned. WHY: live scoring now zeroes a still-
--       'confirmed' (not-seated) player via fn_tournament_points' branch (5).
--       complete_tournament's no_show branch COALESCEs on the existing value to
--       preserve an admin EXCUSED-0 — but a live-zeroed ghost would then also
--       read 0 and dodge the −15 penalty. Clearing points_earned on the flip
--       restores the pre-live-scoring invariant (ghost points NULL before the
--       engine runs) so genuine ghosts get −15 while excused no_shows (status
--       already 'no_show' before this flip) keep their admin-set 0. This is the
--       minimal change needed to keep COMPLETED-fecha scoring byte-identical.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) fn_tournament_points — REPLACES the 0019 scoring-v2 definition VERBATIM,
--     changing ONLY v_n: from the ranked-so-far count to the SEATED field size
--     (matches src/lib/fechas.ts playedCount). Every branch / chop averaging /
--     no_show + cancel coalesce is untouched. service_role only (writes scores).
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
  v_bmf       int;    -- bonus_final_table
  v_batt      int;    -- bonus_attendance
  v_noshow    int;    -- no_show_penalty (stored negative)
  v_bands     jsonb;  -- cancel_bands [{hours_before, penalty}]
  v_topbonus  jsonb;  -- top_finish_bonuses [20,15,10,5] (index 0 = 1st)
  v_n         int;    -- field size N (seated field)
begin
  select t.season_id, t.scheduled_at,
         s.points_multiplier, s.bonus_final_table,
         s.bonus_attendance, s.no_show_penalty, s.cancel_bands,
         s.top_finish_bonuses
    into v_season_id, v_sched, v_mult, v_bmf, v_batt, v_noshow, v_bands, v_topbonus
  from public.tournament t
  join public.season s on s.id = t.season_id
  where t.id = p_tournament_id;

  if v_season_id is null then
    raise exception 'fn_tournament_points: tournament % not found', p_tournament_id;
  end if;

  -- N = SEATED field size: everyone who took a seat (checked_in / playing /
  -- eliminated / winner). This matches src/lib/fechas.ts playedCount() so the
  -- live per-player breakdown (FE) and the engine (DB) agree during a live
  -- fecha; at completion every seated player is eliminated/winner, so this
  -- equals the old ranked (`final_position is not null`) count → identical.
  select count(*) into v_n
  from public.entry
  where tournament_id = p_tournament_id
    and status in ('checked_in', 'playing', 'eliminated', 'winner');

  -- (1) Regular finishers (not part of a chop): full v2 formula. The graduated
  --     top-4 bonus reads element (final_position − 1) of top_finish_bonuses.
  update public.entry e
     set points_earned =
           (v_n - e.final_position) * v_mult
         + case when e.made_final_table then v_bmf else 0 end
         + case when e.final_position between 1 and 4
                then coalesce((v_topbonus ->> (e.final_position - 1))::int, 0)
                else 0 end
         + case when e.paid then v_batt else 0 end
   where e.tournament_id = p_tournament_id
     and e.final_position is not null
     and e.chop_group is null;

  -- (2) Chop co-champions: average the v2 point-value across the group, then
  --     round once. Each member brings their own final_table / paid eligibility
  --     and their own graduated top-4 bonus.
  with grp as (
    select e.chop_group,
           round(avg(
               (v_n - e.final_position) * v_mult
             + case when e.made_final_table then v_bmf else 0 end
             + case when e.final_position between 1 and 4
                    then coalesce((v_topbonus ->> (e.final_position - 1))::int, 0)
                    else 0 end
             + case when e.paid then v_batt else 0 end
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

  -- (3) No-shows: −15, BUT preserve an admin-set value (excused 0 / already −15).
  update public.entry e
     set points_earned = coalesce(e.points_earned, v_noshow)
   where e.tournament_id = p_tournament_id
     and e.final_position is null
     and e.chop_group is null
     and e.status = 'no_show';

  -- (4) Cancellations: preserve a penalty already applied, else derive the band.
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

  -- (5) Everyone else: 0.
  update public.entry e
     set points_earned = 0
   where e.tournament_id = p_tournament_id
     and e.final_position is null
     and e.chop_group is null
     and e.status <> 'no_show'
     and e.cancelled_at is null;
end;
$$;

-- Grants (mirror 0019): internal writer → service_role only.
revoke all on function public.fn_tournament_points(uuid) from public, anon, authenticated;
grant execute on function public.fn_tournament_points(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- (2) fn_eliminate_entry — REPLACES the 0009 definition VERBATIM, adding a
--     single trailing `perform public.fn_tournament_points(v_tid)` so points
--     populate LIVE on every bust. Covers both eliminate + self_bust (they
--     delegate here). Grants unchanged (service_role only — internal helper).
-- ---------------------------------------------------------------------------
create or replace function public.fn_eliminate_entry(p_entry_id uuid)
returns uuid   -- the tournament id, so wrappers can return the standings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tid        uuid;
  v_status     public.entry_status;
  v_size       int;
  v_alive_incl int;
  v_remaining  int;
  v_alive_now  int;
begin
  select e.tournament_id, e.status, t.final_table_size
    into v_tid, v_status, v_size
  from public.entry e
  join public.tournament t on t.id = e.tournament_id
  where e.id = p_entry_id;

  if not found then
    raise exception 'eliminación: la inscripción % no existe', p_entry_id;
  end if;
  if v_status not in ('playing', 'checked_in') then
    raise exception 'eliminación: esta inscripción no está en juego';
  end if;

  -- total−1: count non-eliminated entries INCLUDING the busting player.
  select count(*) into v_alive_incl
  from public.entry
  where tournament_id = v_tid and status in ('playing', 'checked_in');

  update public.entry
     set status = 'eliminated', final_position = v_alive_incl, eliminated_at = now()
   where id = p_entry_id;

  v_remaining := v_alive_incl - 1;

  -- Exactly one left standing → winner at position 1.
  if v_remaining = 1 then
    update public.entry
       set status = 'winner', final_position = 1
     where tournament_id = v_tid and status in ('playing', 'checked_in');
  end if;

  -- Recompute made_final_table from current state (correct for both bust + undo).
  select count(*) into v_alive_now
  from public.entry
  where tournament_id = v_tid and status in ('playing', 'checked_in');

  update public.entry e
     set made_final_table = (
          (e.final_position is not null and e.final_position <= coalesce(v_size, -1))
       or (e.status in ('playing', 'checked_in') and v_alive_now <= coalesce(v_size, -1))
     )
   where e.tournament_id = v_tid;

  -- LIVE SCORING (mig 0030): recompute points now so a bust immediately shows
  -- its earned points (finisher terms) and everyone re-scores against the
  -- seated field. Covers eliminate + self_bust (both delegate here).
  perform public.fn_tournament_points(v_tid);

  return v_tid;
end;
$$;

-- ---------------------------------------------------------------------------
-- (3) undo_last_elimination — REPLACES the 0009 definition VERBATIM, adding a
--     `perform public.fn_tournament_points` before it returns the standings so
--     an undo reverts points too (the restored player → 0/playing, others
--     re-score against the smaller ranked set). Grants unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.undo_last_elimination(p_tournament_id uuid)
returns setof public.entry
language plpgsql
security definer
set search_path = public
as $$
declare
  v_size      int;
  v_last      uuid;
  v_alive_now int;
begin
  if not public.fn_is_tournament_admin(p_tournament_id) then
    raise exception 'deshacer: solo un admin puede deshacer eliminaciones';
  end if;

  select t.final_table_size into v_size
  from public.tournament t where t.id = p_tournament_id;

  -- Un-crown a just-made winner (they are alive again once we restore the bust).
  update public.entry
     set status = 'playing', final_position = null
   where tournament_id = p_tournament_id and status = 'winner';

  -- The most-recently eliminated entry.
  select e.id into v_last
  from public.entry e
  where e.tournament_id = p_tournament_id
    and e.status = 'eliminated'
    and e.eliminated_at is not null
  order by e.eliminated_at desc, e.final_position asc
  limit 1;

  if v_last is null then
    raise exception 'deshacer: no hay eliminaciones para revertir';
  end if;

  update public.entry
     set status = 'playing', final_position = null, eliminated_at = null
   where id = v_last;

  -- Recompute made_final_table for the restored state.
  select count(*) into v_alive_now
  from public.entry
  where tournament_id = p_tournament_id and status in ('playing', 'checked_in');

  update public.entry e
     set made_final_table = (
          (e.final_position is not null and e.final_position <= coalesce(v_size, -1))
       or (e.status in ('playing', 'checked_in') and v_alive_now <= coalesce(v_size, -1))
     )
   where e.tournament_id = p_tournament_id;

  -- LIVE SCORING (mig 0030): revert points to match the restored standings —
  -- the un-busted player drops to 0 (now playing), everyone else re-scores.
  perform public.fn_tournament_points(p_tournament_id);

  return query
    select * from public.entry
    where tournament_id = p_tournament_id
    order by final_position nulls first, eliminated_at nulls last;
end;
$$;

-- ---------------------------------------------------------------------------
-- (4) add_rebuy — REPLACES the 0029 definition VERBATIM (winner guard, no level
--     guard, eliminated-only, admin gate, set_prizes), adding a
--     `perform public.fn_tournament_points(v_tid)` after the reactivation update
--     so a rebought player recomputes to 0 (their final_position is cleared) and
--     everyone else re-scores against the new (unchanged seated) field. Grants
--     unchanged (authenticated + service_role; internal admin gate).
-- ---------------------------------------------------------------------------
create or replace function public.add_rebuy(p_entry_id uuid)
returns setof public.entry
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tid    uuid;
  v_status public.entry_status;
  v_stack  int;
begin
  select e.tournament_id, e.status, coalesce(t.starting_stack, 0)
    into v_tid, v_status, v_stack
  from public.entry e
  join public.tournament t on t.id = e.tournament_id
  where e.id = p_entry_id;

  if not found then
    raise exception 'recompra: la inscripción % no existe', p_entry_id;
  end if;
  if not public.fn_is_tournament_admin(v_tid) then
    raise exception 'recompra: solo un admin puede registrar recompras';
  end if;

  -- Rebuy = re-entry: never while the player is still playing.
  if v_status in ('playing', 'checked_in') then
    raise exception 'recompra: no se permite recompra mientras juega';
  end if;
  if v_status <> 'eliminated' then
    raise exception 'recompra: solo se puede recomprar tras una eliminación';
  end if;

  -- Winner guard (mig 0029): once the fecha is decided (someone crowned), a
  -- rebuy would resurrect a busted player after the night is over → reject.
  -- The blind-level cutoff that used to live here is intentionally removed:
  -- a rebuy is now allowed regardless of the current blind level.
  if exists (
    select 1 from public.entry e
    where e.tournament_id = v_tid and e.status = 'winner'
  ) then
    raise exception 'recompra: la fecha ya terminó (hay ganador), no se permite recompra';
  end if;

  update public.entry
     set status         = 'playing',
         final_position = null,
         eliminated_at  = null,
         rebuys_count   = rebuys_count + 1,
         chips          = v_stack
   where id = p_entry_id;

  -- LIVE SCORING (mig 0030): the rebought player's final_position was cleared →
  -- recompute so they drop to 0 (now playing) and everyone else re-scores.
  perform public.fn_tournament_points(v_tid);

  -- The pot just grew by this re-entry → refresh prizes (preserves overrides;
  -- no-ops to '[]' if the season template is empty). verify-ui Tier 4.
  perform public.set_prizes(v_tid);

  return query select * from public.entry where id = p_entry_id;
end;
$$;

-- Grants (mirror 0029): authenticated + service_role (internal admin gate).
revoke all on function public.add_rebuy(uuid) from public;
grant execute on function public.add_rebuy(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (5) leaderboard — REPLACES the 0027 definition VERBATIM (drop + recreate;
--     same return columns / roster / agg / form / order / grants), changing
--     ONLY the `finished` CTE filter from `t.status = 'completed'` to
--     `t.status in ('completed','live')` so the in-progress fecha contributes
--     to the Tabla. `and t.counts_for_league` is kept — standalone fechas still
--     excluded. Eliminated players' live points_earned feed total_points /
--     games_played / wins / podiums / form; still-playing players
--     (final_position null, points 0) contribute nothing until they bust.
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
      and t.status in ('completed', 'live')  -- LIVE SCORING (0030): include the in-progress fecha
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
-- (6) complete_tournament — REPLACES the LATEST (0012 security-hardening)
--     definition VERBATIM (its step 0b remainder-ranking, `pg_temp` search_path
--     and all guards are preserved), changing ONLY the confirmed-ghost flip
--     (step 1) to ALSO clear points_earned. This is required because live
--     scoring (above) now zeroes a still-'confirmed' (not-seated) player via
--     fn_tournament_points branch (5); without this reset, the no_show branch's
--     `coalesce(points_earned, −15)` would read that live 0 and the ghost would
--     dodge the penalty. Nulling on the flip restores the pre-live-scoring
--     invariant so genuine ghosts score −15 and admin EXCUSED no_shows (already
--     status 'no_show', untouched by this flip) keep their admin-set 0. Every
--     other step (chop, remainder ranking, resize, points, complete) is verbatim.
-- ---------------------------------------------------------------------------
create or replace function public.complete_tournament(
  p_tournament_id  uuid,
  p_chop_entry_ids uuid[] default null
)
returns setof public.tournament
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status public.tournament_status;
  v_k      int;
  v_group  int;
  v_size   int;
begin
  select t.status into v_status from public.tournament t where t.id = p_tournament_id;
  if not found then
    raise exception 'completar: la fecha % no existe', p_tournament_id;
  end if;
  if not public.fn_is_tournament_admin(p_tournament_id) then
    raise exception 'completar: solo un admin puede completar la fecha';
  end if;
  if v_status = 'completed' then
    raise exception 'completar: la fecha ya está completada';
  end if;

  -- (0) CHOP: the final K players split the top positions 1..K as co-champions.
  if p_chop_entry_ids is not null and array_length(p_chop_entry_ids, 1) >= 1 then
    v_k := array_length(p_chop_entry_ids, 1);

    if exists (
      select 1 from unnest(p_chop_entry_ids) cid
      where not exists (
        select 1 from public.entry e
        where e.id = cid
          and e.tournament_id = p_tournament_id
          and e.status in ('playing', 'checked_in', 'winner')
      )
    ) then
      raise exception 'chop: todos los jugadores del chop deben estar en juego en esta fecha';
    end if;

    select coalesce(max(e.chop_group), 0) + 1 into v_group
    from public.entry e where e.tournament_id = p_tournament_id;

    update public.entry e
       set chopped          = true,
           chop_group       = v_group,
           status           = 'winner',
           final_position   = arr.ord::int,
           made_final_table = true,
           eliminated_at    = null
      from (
        select u.cid, u.ord
        from unnest(p_chop_entry_ids) with ordinality as u(cid, ord)
      ) arr
     where e.id = arr.cid and e.tournament_id = p_tournament_id;

    -- (0b) Non-chopped players still in play rank BELOW the co-champions.
    --   Assign positions K+1, K+2, … (chip leader first) and eliminate them so
    --   completion never leaves an in-play entry at final_position NULL → 0 pts.
    with remaining as (
      select e.id,
             v_k + row_number() over (
               order by e.chips desc nulls last, e.created_at asc, e.id asc
             ) as pos
      from public.entry e
      where e.tournament_id = p_tournament_id
        and e.status in ('playing', 'checked_in')
        and e.chop_group is null
    )
    update public.entry e
       set status         = 'eliminated',
           final_position  = r.pos,
           eliminated_at   = now()
      from remaining r
     where e.id = r.id;
  end if;

  -- (1) confirmed-but-never-checked-in → no_show (ghosts; fn → −15). points_earned
  --     is cleared (mig 0030): live scoring may have zeroed the still-'confirmed'
  --     ghost via fn_tournament_points branch (5); the no_show branch COALESCEs on
  --     the existing value, so that live 0 would otherwise block the −15 penalty.
  update public.entry
     set status = 'no_show',
         points_earned = null
   where tournament_id = p_tournament_id
     and status = 'confirmed'
     and checked_in_at is null;

  -- (2) refresh mesa-final size from real turnout BEFORE points (slice-7 cadence).
  v_size := public.recompute_final_table_size(p_tournament_id);

  -- (2b) re-derive made_final_table from the FINAL size. At completion every
  --      seated player has a final_position, so "reached the final table" is
  --      exactly final_position ≤ size.
  update public.entry e
     set made_final_table = (e.final_position is not null and e.final_position <= v_size)
   where e.tournament_id = p_tournament_id;

  -- (3) points.
  perform public.fn_tournament_points(p_tournament_id);

  -- (4) completed.
  update public.tournament set status = 'completed' where id = p_tournament_id;

  return query select * from public.tournament where id = p_tournament_id;
end;
$$;

-- Grants (mirror 0012): SECURITY DEFINER with internal admin gate → authenticated
-- + service_role. CREATE OR REPLACE preserves privileges; re-asserted for clarity.
revoke all on function public.complete_tournament(uuid, uuid[]) from public, anon;
grant execute on function public.complete_tournament(uuid, uuid[]) to authenticated, service_role;
