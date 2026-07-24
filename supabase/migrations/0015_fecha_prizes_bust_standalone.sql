-- ============================================================================
-- Poker Friends — Phase 2, step 4: per-FECHA prize distribution
-- (decisions.md 2026-07-24 (B): prize distribution moves per-LEAGUE → PER-FECHA.)
--
-- This migration file is SHARED with later Phase-2 steps (6 = simultaneous
-- multi-bust, 7 = standalone fecha `counts_for_league`), which APPEND their own
-- sections below this one. Keep additions in clearly-delimited blocks; do not
-- rewrite this header.
--
-- ── WHAT THIS SECTION DOES ──
--   • Adds `tournament.payout_distribution jsonb` — a variable-length array
--     `[{place:int, pct:numeric}]`. Each fecha now OWNS its payout split.
--   • Keeps `season.payout_template` (raw pct array, e.g. [0.60,0.28,0.12]) as
--     the DEFAULT SEED — it is NOT removed.
--   • `create_tournament` seeds the new fecha's `payout_distribution` from the
--     season template, with the number of paid PLACES scaled to expected
--     turnout (see the scaling rule below).
--   • `set_prizes` reads `tournament.payout_distribution` when present and FALLS
--     BACK to the season `payout_template` when the fecha has none. The existing
--     ₡5.000 rounding, the 1st-place-absorbs-remainder rule, and the manual
--     override path (`set_prizes_manual`) are all preserved unchanged.
--   • BACKFILL: existing `tournament` rows get `payout_distribution` populated
--     from their season's template (full template, unscaled) so live/completed
--     fechas keep producing identical amounts after this migration.
--
--   The 0013 auto-materialize trigger points (open_tournament / confirm_payment /
--   add_rebuy each calling set_prizes) are UNCHANGED — set_prizes is still the
--   single source of truth for the computation; only its INPUT source changed.
--
-- ── PLACES-SCALING RULE (create_tournament seed) ──
--   A fresh scheduled fecha has no entries yet, so "turnout" is an ESTIMATE:
--     expected_turnout = COALESCE(payload.expected_players, league roster size)
--   Paid places pay ~the top 25% of expected turnout (midpoint of the decided
--   20–30% band), never fewer than 3, and never MORE places than the season
--   template defines percentages for (we never invent pcts):
--     paid_places = LEAST( array_length(template),
--                          GREATEST(3, ceil(expected_turnout * 0.25)) )
--   The seed takes the first `paid_places` template pcts and RE-NORMALIZES them
--   to sum to 1.0 (so a subset of a longer template stays proportional; the
--   default top-3 template renormalizes to itself). set_prizes' absorber then
--   makes the materialized amounts sum to the pot EXACTLY regardless.
--   Admins fully edit places + pcts per fecha later (Phase-2 step 5) — this is
--   only the starting point.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Column: tournament.payout_distribution — [{place:int, pct:numeric}], nullable.
--   NULL means "no per-fecha split configured" → set_prizes falls back to the
--   season template. Populated by create_tournament (new fechas) + the backfill
--   below (existing fechas).
-- ---------------------------------------------------------------------------
alter table public.tournament
  add column if not exists payout_distribution jsonb;

-- ---------------------------------------------------------------------------
-- BACKFILL — existing fechas inherit the FULL season template as their
--   distribution (place = ordinal, pct = the template value), UNSCALED. Using
--   the full template (not the turnout-scaled subset) keeps set_prizes output
--   byte-identical to pre-migration behavior for these rows. Skips fechas whose
--   season has a null/empty template (set_prizes still no-ops to '[]' for them).
-- ---------------------------------------------------------------------------
update public.tournament t
   set payout_distribution = (
     select jsonb_agg(
              jsonb_build_object('place', x.ord::int, 'pct', x.val::numeric)
              order by x.ord
            )
     from jsonb_array_elements_text(s.payout_template) with ordinality as x(val, ord)
   )
  from public.season s
 where s.id = t.season_id
   and t.payout_distribution is null
   and s.payout_template is not null
   and jsonb_array_length(s.payout_template) > 0;

-- ---------------------------------------------------------------------------
-- create_tournament(payload jsonb) — REPLACES 0010's definition.
--   Unchanged except: (a) reads the season template + expected turnout, (b)
--   computes a turnout-scaled, renormalized payout_distribution (see header
--   rule), and (c) writes it into the new fecha's payout_distribution column.
--   Everything else (admin guard, active-season lookup, field defaults,
--   created_by) is preserved verbatim.
-- ---------------------------------------------------------------------------
create or replace function public.create_tournament(p_payload jsonb)
returns setof public.tournament
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season   uuid;
  v_id       uuid;
  v_template jsonb;
  v_tmpl_len int;
  v_expected int;
  v_places   int;
  v_dist     jsonb;
begin
  if not (public.auth_is_admin() or auth.role() = 'service_role') then
    raise exception 'nueva fecha: solo un admin puede crear fechas';
  end if;

  select s.id, s.payout_template into v_season, v_template
  from public.season s
  where s.status = 'active'
  order by s.year desc
  limit 1;

  if v_season is null then
    raise exception 'nueva fecha: no hay temporada activa';
  end if;

  -- Seed payout_distribution from the season template, scaling paid places to
  -- expected turnout (see header PLACES-SCALING RULE). Null/empty template →
  -- leave payout_distribution null (set_prizes falls back + no-ops to '[]').
  v_tmpl_len := coalesce(jsonb_array_length(v_template), 0);
  if v_tmpl_len > 0 then
    v_expected := coalesce(
      nullif(p_payload->>'expected_players', '')::int,
      (select count(*)::int from public.player)
    );
    v_places := least(
      v_tmpl_len,
      greatest(3, ceil(coalesce(v_expected, 0) * 0.25)::int)
    );

    with picked as (
      select x.ord::int as place, x.val::numeric as pct
      from jsonb_array_elements_text(v_template) with ordinality as x(val, ord)
      where x.ord <= v_places
    ),
    tot as (select nullif(sum(pct), 0) as s from picked)
    select jsonb_agg(
             jsonb_build_object(
               'place', p.place,
               'pct',   round(p.pct / coalesce(tot.s, 1), 4)
             )
             order by p.place
           )
      into v_dist
    from picked p cross join tot;
  end if;

  insert into public.tournament (
    season_id, name, scheduled_at, status,
    venue_lat, venue_lng, geofence_radius_m,
    buy_in, rebuy_amount, rebuy_until_level, starting_stack,
    ante_enabled, blind_structure_id, timer_mode, created_by,
    payout_distribution
  ) values (
    v_season,
    coalesce(nullif(p_payload->>'name', ''), 'Nueva fecha'),
    coalesce((p_payload->>'scheduled_at')::timestamptz, now()),
    'scheduled',
    nullif(p_payload->>'venue_lat', '')::numeric,
    nullif(p_payload->>'venue_lng', '')::numeric,
    coalesce(nullif(p_payload->>'geofence_radius_m', '')::int, 100),
    coalesce(nullif(p_payload->>'buy_in', '')::numeric, 0),
    nullif(p_payload->>'rebuy_amount', '')::numeric,
    nullif(p_payload->>'rebuy_until_level', '')::int,
    nullif(p_payload->>'starting_stack', '')::int,
    coalesce((p_payload->>'ante_enabled')::boolean, false),
    nullif(p_payload->>'blind_structure_id', '')::uuid,
    coalesce((p_payload->>'timer_mode')::public.timer_mode, 'auto'),
    public.auth_player_id(),
    v_dist
  )
  returning id into v_id;

  return query select * from public.tournament where id = v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- set_prizes(tournament_id) — REPLACES 0004's definition.
--   ONLY change: the percentage source. It now prefers the fecha's own
--   `payout_distribution` ([{place,pct}], ordered by place) and FALLS BACK to
--   the season `payout_template` (raw pct array) when the fecha has none
--   (null/empty). All downstream logic — ₡5.000 rounding, 1st-place absorbs the
--   remainder so Σ = pot EXACTLY, override preservation + absorber rebalancing,
--   the empty→'[]' no-op — is byte-for-byte the 0004 behavior.
-- ---------------------------------------------------------------------------
create or replace function public.set_prizes(p_tournament_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_step     constant numeric := 5000;    -- rounding granularity (₡5.000)
  v_pot      numeric;
  v_template jsonb;
  v_dist     jsonb;
  v_existing jsonb;
  v_pcts     numeric[];
  v_k        int;
  v_ovr      boolean[];
  v_ovr_amt  numeric[];
  v_amounts  numeric[];
  v_absorber int;                          -- lowest-numbered non-overridden pos
  v_others   numeric := 0;                 -- Σ of every slice except the absorber
  v_result   jsonb := '[]'::jsonb;
  i          int;
begin
  if not (public.auth_is_admin() or auth.role() = 'service_role') then
    raise exception 'set_prizes: admin only';
  end if;

  select t.prizes, t.payout_distribution, s.payout_template
    into v_existing, v_dist, v_template
  from public.tournament t
  join public.season s on s.id = t.season_id
  where t.id = p_tournament_id;

  if not found then
    raise exception 'set_prizes: tournament % not found', p_tournament_id;
  end if;

  v_pot := public.fn_pot(p_tournament_id);
  v_existing := coalesce(v_existing, '[]'::jsonb);

  -- PCT SOURCE: prefer the fecha's own payout_distribution (per-fecha split,
  -- decisions.md 2026-07-24 B); fall back to the season template when the fecha
  -- has no distribution (null / empty array).
  if v_dist is not null and jsonb_array_length(v_dist) > 0 then
    select coalesce(array_agg((e->>'pct')::numeric order by (e->>'place')::int),
                    array[]::numeric[])
      into v_pcts
    from jsonb_array_elements(v_dist) e;
  else
    select coalesce(array_agg(val::numeric order by ord), array[]::numeric[])
      into v_pcts
    from jsonb_array_elements_text(coalesce(v_template, '[]'::jsonb))
         with ordinality as x(val, ord);
  end if;

  v_k := array_length(v_pcts, 1);
  if v_k is null then       -- no pcts (empty distribution AND empty template)
    update public.tournament set prizes = '[]'::jsonb where id = p_tournament_id;
    return '[]'::jsonb;
  end if;

  -- Pass 1: read the override flag/amount for each position and pick the
  -- absorber (the lowest-numbered position that is NOT overridden).
  for i in 1 .. v_k loop
    v_ovr[i] := coalesce(
      (select (e->>'overridden')::boolean
         from jsonb_array_elements(v_existing) e
        where (e->>'position')::int = i limit 1), false);
    v_ovr_amt[i] := coalesce(
      (select (e->>'amount')::numeric
         from jsonb_array_elements(v_existing) e
        where (e->>'position')::int = i limit 1), 0);
    if not v_ovr[i] and v_absorber is null then
      v_absorber := i;
    end if;
  end loop;

  -- Pass 2: overridden slices keep their amount; every other non-absorber slice
  -- rounds to the nearest ₡5.000. Accumulate everything except the absorber.
  for i in 1 .. v_k loop
    if v_ovr[i] then
      v_amounts[i] := v_ovr_amt[i];
      v_others := v_others + v_amounts[i];
    elsif i = v_absorber then
      v_amounts[i] := 0;                    -- placeholder, set below
    else
      v_amounts[i] := round(v_pcts[i] * v_pot / v_step) * v_step;
      v_others := v_others + v_amounts[i];
    end if;
  end loop;

  -- The absorber takes the remainder so Σ amounts = pot EXACTLY.
  if v_absorber is not null then
    v_amounts[v_absorber] := v_pot - v_others;
  end if;

  for i in 1 .. v_k loop
    v_result := v_result || jsonb_build_object(
      'position',   i,
      'pct',        v_pcts[i],
      'amount',     v_amounts[i],
      'overridden', v_ovr[i]
    );
  end loop;

  update public.tournament set prizes = v_result where id = p_tournament_id;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. CREATE OR REPLACE preserves existing privileges; re-asserted here for
-- clarity (mirrors 0004 / 0010). Both are SECURITY DEFINER with an internal
-- admin gate, so granting execute to authenticated is safe.
-- ---------------------------------------------------------------------------
revoke all on function public.create_tournament(jsonb) from public, anon;
revoke all on function public.set_prizes(uuid)         from public, anon;

grant execute on function public.create_tournament(jsonb) to authenticated, service_role;
grant execute on function public.set_prizes(uuid)         to authenticated, service_role;

-- ============================================================================
-- Poker Friends — Phase 2, STEP 6: simultaneous multi-bust
-- (decisions.md 2026-07-24 (A): 2+ players out on ONE hand.)
--
-- Two modes, one RPC:
--   • ORDERED (p_tied=false): the admin lists the busted players shortest
--     starting-of-hand stack FIRST → worst finishing position. The app has no
--     live stacks, so ordering is admin-driven. Implemented as sequential
--     total−1 eliminations (fn_eliminate_entry per entry, in array order), which
--     is byte-identical to N separate eliminate() calls: the first listed takes
--     the highest (worst) position, and the lone survivor is crowned winner if a
--     bust leaves exactly one player standing.
--   • DEAD-EVEN TIE (p_tied=true): all K bust simultaneously (all-in even) and
--     SPLIT the positions they occupy — equal points AND equal money.
--
-- ⚠️ THE TRAP (be-contract caveat #3). A dead-even MID-FIELD tie must reuse ONLY
--    the `chop_group` POINTS-grouping (fn_tournament_points, 0003:112-129) so the
--    §5 points average out equally across the tied players. It must NOT reuse the
--    final-table chop completion path (complete_tournament, 0009:704-715), which
--    sets chopped=true / status='winner' / made_final_table=true. If a tie at,
--    say, 7th/8th set any of those, those players would be mislabeled
--    CO-CHAMPIONS — a gold form pill + a phantom win (leaderboard keys the
--    champion tier + `wins` off `final_position=1 OR chopped`, 0003:182-184).
--    So a dead-even bust sets `chop_group` + the correct final_position(s) only,
--    and leaves chopped / status='winner' FALSE; made_final_table is RE-DERIVED
--    from state (final_position ≤ size) exactly like fn_eliminate_entry — a
--    mid-field tie derives to FALSE, never forced true. Champion flags belong
--    ONLY to a real final-table chop (winner determination) in complete_tournament.
--
-- Money split (tie group): the summed prize amounts for the occupied positions,
--   divided equally among the tied players. Money is not persisted per entry
--   (it is display-derived from tournament.prizes[position].amount, split across
--   a shared chop_group), so the split lives in the FE helper `tieSplitMoneyEach`
--   (src/lib/admin.ts), mirroring the existing chop money-split rounding
--   (chopPreview): round(Σ amounts / K).
-- ============================================================================
create or replace function public.eliminate_multi(
  p_entry_ids uuid[],
  p_tied      boolean default false
)
returns setof public.entry
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tid        uuid;
  v_n          int;
  v_id         uuid;
  v_alive_incl int;
  v_group      int;
  v_size       int;
  v_alive_now  int;
begin
  v_n := coalesce(array_length(p_entry_ids, 1), 0);
  if v_n = 0 then
    raise exception 'eliminación múltiple: no se seleccionaron jugadores';
  end if;

  -- Resolve the tournament from the first entry; every entry must belong to it.
  select e.tournament_id into v_tid from public.entry e where e.id = p_entry_ids[1];
  if not found then
    raise exception 'eliminación múltiple: la inscripción % no existe', p_entry_ids[1];
  end if;
  if not public.fn_is_tournament_admin(v_tid) then
    raise exception 'eliminación múltiple: solo un admin puede eliminar jugadores';
  end if;

  -- All selected entries must be in THIS tournament AND still in play.
  if exists (
    select 1 from unnest(p_entry_ids) cid
    where not exists (
      select 1 from public.entry e
      where e.id = cid
        and e.tournament_id = v_tid
        and e.status in ('playing', 'checked_in')
    )
  ) then
    raise exception 'eliminación múltiple: todos los jugadores deben estar en juego en esta fecha';
  end if;

  if not p_tied then
    -- ORDERED: bust each in the given order (shortest stack FIRST → worst
    -- position). Sequential total−1 = N separate eliminations.
    foreach v_id in array p_entry_ids loop
      perform public.fn_eliminate_entry(v_id);
    end loop;
  else
    -- DEAD-EVEN TIE: the K tied players take the bottom K positions
    -- (v_alive_incl .. v_alive_incl−K+1) and share a NEW chop_group so
    -- fn_tournament_points averages their §5 points equally. They are NOT
    -- co-champions — see THE TRAP above: chopped / status='winner' stay FALSE.
    select count(*) into v_alive_incl
    from public.entry
    where tournament_id = v_tid and status in ('playing', 'checked_in');

    select coalesce(max(e.chop_group), 0) + 1 into v_group
    from public.entry e where e.tournament_id = v_tid;

    update public.entry e
       set status         = 'eliminated',
           chop_group     = v_group,
           final_position = (v_alive_incl - (arr.ord - 1))::int,
           eliminated_at  = now()
      from (
        select u.cid, u.ord
        from unnest(p_entry_ids) with ordinality as u(cid, ord)
      ) arr
     where e.id = arr.cid and e.tournament_id = v_tid;

    -- If the tie emptied all but one seat, crown that lone survivor at pos 1.
    if v_alive_incl - v_n = 1 then
      update public.entry
         set status = 'winner', final_position = 1
       where tournament_id = v_tid and status in ('playing', 'checked_in');
    end if;

    -- Re-derive made_final_table from current state (same rule as
    -- fn_eliminate_entry). A mid-field tie (final_position > size) → FALSE;
    -- never forced true.
    select t.final_table_size into v_size
    from public.tournament t where t.id = v_tid;

    select count(*) into v_alive_now
    from public.entry
    where tournament_id = v_tid and status in ('playing', 'checked_in');

    update public.entry e
       set made_final_table = (
            (e.final_position is not null and e.final_position <= coalesce(v_size, -1))
         or (e.status in ('playing', 'checked_in') and v_alive_now <= coalesce(v_size, -1))
       )
     where e.tournament_id = v_tid;
  end if;

  return query
    select * from public.entry
    where tournament_id = v_tid
    order by final_position nulls first, eliminated_at nulls last;
end;
$$;

revoke all on function public.eliminate_multi(uuid[], boolean) from public, anon;
grant execute on function public.eliminate_multi(uuid[], boolean) to authenticated, service_role;

-- ============================================================================
-- Poker Friends — Phase 2, STEP 7: standalone fecha (counts_for_league)
-- (plan step 7): a fecha may run fully — clock / eliminations / prizes — yet not
-- count toward the SEASON standings (a one-off / friendly). The per-fecha result
-- (positions, points_earned, prizes) still exists; only the season AGGREGATION
-- ignores it.
--
-- `counts_for_league boolean not null default true` — the `not null default true`
-- backfills EVERY existing row to true at migration time (existing fechas keep
-- counting), and new fechas default to counting unless the admin opts out in
-- Create-Fecha ("cuenta para la liga" toggle).
-- ============================================================================
alter table public.tournament
  add column if not exists counts_for_league boolean not null default true;

-- ---------------------------------------------------------------------------
-- leaderboard(season_id) — REPLACES 0014's definition. The ONLY change vs 0014
-- is the `finished` CTE: it now also filters `t.counts_for_league`, so a
-- standalone fecha (counts_for_league=false) contributes 0 to every player's
-- season total / games / wins / podiums / form. The roster CTE is unchanged
-- (players who only played a standalone fecha still appear at 0), and every
-- aggregate / ordering / tiebreaker below is byte-for-byte the 0014 logic.
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
      and t.counts_for_league            -- STEP 7: exclude standalone fechas
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
