-- ============================================================================
-- Poker Friends — Admin console RPCs (slice 12)
--
-- The live-game control surface: the clock, payment confirmation, re-entries,
-- eliminations (total−1), no-shows, chop/split, and tournament completion. All
-- of these WRITE game state, so every RPC is SECURITY DEFINER guarded to the
-- admin — global admin (`auth_is_admin()`) OR the tournament owner
-- (`tournament.created_by = auth_player_id()`) — with `service_role` admitted so
-- the integration suite can drive fixtures. `self_bust` is the sole exception:
-- the calling PLAYER busts their OWN entry (no admin needed).
--
-- ── PINNED ALGORITHMS (plan Approach → "Canonical algorithms"; the external
--    Google Doc is not readable by build agents, so these are authoritative) ──
--
--   ELIMINATION "total−1": on bust, final_position = the count of non-eliminated
--     entries INCLUDING the busting player (an in-play entry = status
--     playing|checked_in). Then the entry → 'eliminated'. When exactly ONE
--     remains, that player → 'winner' at final_position 1. Undo reverses the last
--     bust (and un-crowns a just-made winner) and restores the counts.
--
--   MESA FINAL: eliminate READS the STORED tournament.final_table_size (kept
--     fresh by check_in per the slice-7 cadence — this slice does NOT recompute
--     it during play). made_final_table is (re)derived from current state:
--       true ⇔ (final_position ≤ size)  OR  (still in-play AND in-play count ≤ size).
--     A full recompute (rather than an incremental set) makes eliminate AND undo
--     share one correct, idempotent rule.
--
--   CHOP / SPLIT (be-contract §Resolved 3): the final K players split the top K
--     positions as CO-CHAMPIONS — chopped=true + a shared chop_group, positions
--     1..K, status 'winner'. fn_tournament_points averages the §5 point-value of
--     positions 1..K so every chopper earns the same points, and the leaderboard
--     counts each as a win/champion (keyed off `chopped`).
--
--   COMPLETION cadence (slice-7 lesson, load-bearing): (0) apply any chop, (1)
--     flip confirmed-but-never-checked-in "ghosts" → no_show, (2) recompute
--     final_table_size from REAL turnout, (3) fn_tournament_points, (4) status →
--     completed. Recompute MUST run after the ghost flip and BEFORE points.
--
-- ── DOCUMENTED CHOICES (brief: pick the defensible option, document, proceed) ──
--   • clock 'resume' back-dates level_started_at to now − (dur − remaining) so the
--     running clock CONTINUES from the frozen remaining instead of restarting the
--     level (a naive reset-to-now would discard elapsed time). At level open the
--     frozen remaining equals the full duration, so this reduces to now().
--   • clock ±1 min shifts level_started_at by ∓60 s while running (remaining =
--     dur − (now − started)), or paused_remaining_seconds by ±60 s while paused.
--   • clock 'next_level' at the LAST level is a silent no-op so auto-advance
--     (admin writes next_level when the timer hits 0) cannot error-loop.
--   • clock 'edit_blinds' overrides the CURRENT level's row in the shared
--     blind_structure (Phase-1 structures are per-season), then touches the
--     tournament row so realtime subscribers refetch the levels.
--   • add_rebuy is RE-ENTRY: it grants a fresh starting_stack of chips.
--   • fn_tournament_points' no_show branch now COALESCEs (see its header) so an
--     admin-set excused no_show (0) survives completion instead of being
--     overwritten with −15.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- fn_is_tournament_admin(tournament_id) → boolean
--   The shared admin gate: global admin OR the tournament owner OR service_role.
--   Null-safe (created_by NULL never matches). SECURITY DEFINER so it can read
--   the tournament + the caller's player row past RLS.
-- ---------------------------------------------------------------------------
create or replace function public.fn_is_tournament_admin(p_tournament_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.auth_is_admin()
      or auth.role() = 'service_role'
      or exists (
           select 1 from public.tournament t
           where t.id = p_tournament_id
             and t.created_by is not null
             and t.created_by = public.auth_player_id()
         );
$$;

-- ---------------------------------------------------------------------------
-- clock(tournament_id, action, payload) → the updated tournament row
--   The admin is the SOLE clock writer. Actions: pause / resume / plus_min /
--   minus_min / next_level / prev_level / reset_level / edit_blinds.
-- ---------------------------------------------------------------------------
create or replace function public.clock(
  p_tournament_id uuid,
  p_action        text,
  p_payload       jsonb default '{}'::jsonb
)
returns setof public.tournament
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cur       int;
  v_started   timestamptz;
  v_paused    boolean;
  v_prs       int;
  v_structure uuid;
  v_dur       int;
  v_max_level int;
  v_remaining int;
  v_new_level int;
  v_new_dur   int;
begin
  if not public.fn_is_tournament_admin(p_tournament_id) then
    raise exception 'reloj: solo un admin puede controlar el reloj';
  end if;

  select t.current_level, t.level_started_at, t.is_paused,
         t.paused_remaining_seconds, t.blind_structure_id
    into v_cur, v_started, v_paused, v_prs, v_structure
  from public.tournament t
  where t.id = p_tournament_id;

  if not found then
    raise exception 'reloj: la fecha % no existe', p_tournament_id;
  end if;

  -- Current level duration (0 when there is no blind structure).
  select bl.duration_seconds into v_dur
  from public.blind_level bl
  where bl.structure_id = v_structure and bl.level_number = v_cur
  limit 1;
  v_dur := coalesce(v_dur, 0);

  select max(bl.level_number) into v_max_level
  from public.blind_level bl
  where bl.structure_id = v_structure;

  if p_action = 'pause' then
    -- Freeze: capture the live remaining seconds.
    if v_paused then
      v_remaining := coalesce(v_prs, v_dur);
    elsif v_started is null then
      v_remaining := v_dur;
    else
      v_remaining := greatest(0, v_dur - floor(extract(epoch from (now() - v_started)))::int);
    end if;
    update public.tournament
       set is_paused = true, paused_remaining_seconds = v_remaining
     where id = p_tournament_id;

  elsif p_action = 'resume' then
    -- Continue from the frozen remaining (back-date level_started_at).
    v_remaining := coalesce(v_prs, v_dur);
    update public.tournament
       set is_paused = false,
           level_started_at = now() - make_interval(secs => greatest(0, v_dur - v_remaining))
     where id = p_tournament_id;

  elsif p_action in ('plus_min', 'minus_min') then
    if v_paused then
      update public.tournament
         set paused_remaining_seconds = greatest(0,
               coalesce(v_prs, v_dur) + case when p_action = 'plus_min' then 60 else -60 end)
       where id = p_tournament_id;
    else
      update public.tournament
         set level_started_at = coalesce(v_started, now())
               + make_interval(secs => case when p_action = 'plus_min' then 60 else -60 end)
       where id = p_tournament_id;
    end if;

  elsif p_action = 'next_level' then
    v_new_level := v_cur + 1;
    -- Bounded: silent no-op at the last level (auto-advance safety).
    if v_max_level is null or v_new_level <= v_max_level then
      select bl.duration_seconds into v_new_dur
      from public.blind_level bl
      where bl.structure_id = v_structure and bl.level_number = v_new_level
      limit 1;
      update public.tournament
         set current_level = v_new_level,
             level_started_at = now(),
             is_paused = false,
             paused_remaining_seconds = coalesce(v_new_dur, 0)
       where id = p_tournament_id;
    end if;

  elsif p_action = 'prev_level' then
    v_new_level := greatest(1, v_cur - 1);
    select bl.duration_seconds into v_new_dur
    from public.blind_level bl
    where bl.structure_id = v_structure and bl.level_number = v_new_level
    limit 1;
    update public.tournament
       set current_level = v_new_level,
           level_started_at = now(),
           is_paused = false,
           paused_remaining_seconds = coalesce(v_new_dur, 0)
     where id = p_tournament_id;

  elsif p_action = 'reset_level' then
    update public.tournament
       set level_started_at = now(),
           is_paused = false,
           paused_remaining_seconds = v_dur
     where id = p_tournament_id;

  elsif p_action = 'edit_blinds' then
    if v_structure is null then
      raise exception 'reloj: la fecha no tiene estructura de blinds';
    end if;
    update public.blind_level bl
       set small_blind = coalesce((p_payload->>'small_blind')::int, bl.small_blind),
           big_blind   = coalesce((p_payload->>'big_blind')::int, bl.big_blind),
           ante        = case when p_payload ? 'ante'
                              then nullif(p_payload->>'ante', '')::int
                              else bl.ante end
     where bl.structure_id = v_structure and bl.level_number = v_cur;
    -- Touch the tournament row so realtime subscribers refetch the level table.
    update public.tournament set level_started_at = level_started_at where id = p_tournament_id;

  else
    raise exception 'reloj: acción desconocida "%"', p_action;
  end if;

  return query select * from public.tournament where id = p_tournament_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- confirm_payment(entry_id) → the entry row (paid + playing)
-- ---------------------------------------------------------------------------
create or replace function public.confirm_payment(p_entry_id uuid)
returns setof public.entry
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tid uuid;
begin
  select e.tournament_id into v_tid from public.entry e where e.id = p_entry_id;
  if not found then
    raise exception 'pago: la inscripción % no existe', p_entry_id;
  end if;
  if not public.fn_is_tournament_admin(v_tid) then
    raise exception 'pago: solo un admin puede confirmar pagos';
  end if;

  update public.entry set paid = true, status = 'playing' where id = p_entry_id;
  return query select * from public.entry where id = p_entry_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- add_rebuy(entry_id) → the reactivated entry row
--   RE-ENTRY only: valid solely for an ELIMINATED entry, while the rebuy period
--   is open (current_level ≤ rebuy_until_level). Rejected while the player is
--   still in play. Grants a fresh starting_stack of chips and bumps rebuys_count.
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
  v_cur    int;
  v_until  int;
  v_stack  int;
begin
  select e.tournament_id, e.status, t.current_level, t.rebuy_until_level,
         coalesce(t.starting_stack, 0)
    into v_tid, v_status, v_cur, v_until, v_stack
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
  -- rebuy_until_level null/0 → rebuys disabled; past the period → closed.
  if coalesce(v_until, 0) = 0 or v_cur > v_until then
    raise exception 'recompra: el período de recompra ya cerró';
  end if;

  update public.entry
     set status         = 'playing',
         final_position = null,
         eliminated_at  = null,
         rebuys_count   = rebuys_count + 1,
         chips          = v_stack
   where id = p_entry_id;

  return query select * from public.entry where id = p_entry_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- fn_eliminate_entry(entry_id) — INTERNAL total−1 core (no auth gate).
--   Shared by eliminate (admin) and self_bust (owner). Sets final_position, may
--   crown the winner, and recomputes made_final_table from current state.
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

  return v_tid;
end;
$$;

-- ---------------------------------------------------------------------------
-- eliminate(entry_id) → the tournament standings (setof entry)
--   Admin busts a player.
-- ---------------------------------------------------------------------------
create or replace function public.eliminate(p_entry_id uuid)
returns setof public.entry
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tid uuid;
begin
  select e.tournament_id into v_tid from public.entry e where e.id = p_entry_id;
  if not found then
    raise exception 'eliminación: la inscripción % no existe', p_entry_id;
  end if;
  if not public.fn_is_tournament_admin(v_tid) then
    raise exception 'eliminación: solo un admin puede eliminar jugadores';
  end if;

  perform public.fn_eliminate_entry(p_entry_id);
  return query
    select * from public.entry
    where tournament_id = v_tid
    order by final_position nulls first, eliminated_at nulls last;
end;
$$;

-- ---------------------------------------------------------------------------
-- self_bust(tournament_id) → the tournament standings (setof entry)
--   The CALLING player busts their own entry (no admin needed).
-- ---------------------------------------------------------------------------
create or replace function public.self_bust(p_tournament_id uuid)
returns setof public.entry
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid := public.auth_player_id();
  v_entry_id  uuid;
begin
  if v_player_id is null then
    raise exception 'self-bust: no sos miembro de la liga';
  end if;

  select e.id into v_entry_id
  from public.entry e
  where e.tournament_id = p_tournament_id and e.player_id = v_player_id;

  if not found then
    raise exception 'self-bust: no estás inscrito en esta fecha';
  end if;

  perform public.fn_eliminate_entry(v_entry_id);
  return query
    select * from public.entry
    where tournament_id = p_tournament_id
    order by final_position nulls first, eliminated_at nulls last;
end;
$$;

-- ---------------------------------------------------------------------------
-- undo_last_elimination(tournament_id) → the tournament standings (setof entry)
--   Reactivate the most-recently eliminated entry and restore the counts. If a
--   winner was just crowned, un-crown them too (the last action was the bust
--   that left one player standing).
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

  return query
    select * from public.entry
    where tournament_id = p_tournament_id
    order by final_position nulls first, eliminated_at nulls last;
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_no_show(entry_id, excused) → the entry row
--   excused → 0 points; not excused → season.no_show_penalty (stored −15).
-- ---------------------------------------------------------------------------
create or replace function public.mark_no_show(p_entry_id uuid, p_excused boolean)
returns setof public.entry
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tid    uuid;
  v_noshow int;
begin
  select e.tournament_id, s.no_show_penalty
    into v_tid, v_noshow
  from public.entry e
  join public.tournament t on t.id = e.tournament_id
  join public.season s on s.id = t.season_id
  where e.id = p_entry_id;

  if not found then
    raise exception 'no-show: la inscripción % no existe', p_entry_id;
  end if;
  if not public.fn_is_tournament_admin(v_tid) then
    raise exception 'no-show: solo un admin puede marcar no-shows';
  end if;

  update public.entry
     set status         = 'no_show',
         points_earned  = case when p_excused then 0 else v_noshow end,
         final_position = null,
         eliminated_at  = null
   where id = p_entry_id;

  return query select * from public.entry where id = p_entry_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- fn_tournament_points(tournament_id) — REPLACES the slice-5 definition.
--   Only the no_show branch (step 3) changes: it now COALESCEs on the existing
--   points_earned so an admin-set EXCUSED no_show (0, via mark_no_show) survives
--   completion instead of being overwritten with −15. A freshly-flipped ghost
--   (points_earned NULL) still gets the −15 penalty. Every other branch is
--   byte-for-byte the slice-5 logic (see 0003_points.sql for the full rationale).
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
  v_bmf       int;
  v_btop3     int;
  v_batt      int;
  v_noshow    int;
  v_bands     jsonb;
  v_n         int;
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

  select count(*) into v_n
  from public.entry
  where tournament_id = p_tournament_id and final_position is not null;

  -- (1) Regular finishers.
  update public.entry e
     set points_earned =
           (v_n - e.final_position) * v_mult
         + case when e.made_final_table   then v_bmf   else 0 end
         + case when e.final_position <= 3 then v_btop3 else 0 end
         + case when e.paid               then v_batt  else 0 end
   where e.tournament_id = p_tournament_id
     and e.final_position is not null
     and e.chop_group is null;

  -- (2) Chop co-champions: average the §5 point-value across the group.
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

-- ---------------------------------------------------------------------------
-- complete_tournament(tournament_id, chop_entry_ids) → the completed tournament
--   Optional chop_entry_ids = the final K players who split the top positions as
--   co-champions. See the header for the pinned completion cadence.
-- ---------------------------------------------------------------------------
create or replace function public.complete_tournament(
  p_tournament_id  uuid,
  p_chop_entry_ids uuid[] default null
)
returns setof public.tournament
language plpgsql
security definer
set search_path = public
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
  end if;

  -- (1) confirmed-but-never-checked-in → no_show (ghosts; fn → −15).
  update public.entry
     set status = 'no_show'
   where tournament_id = p_tournament_id
     and status = 'confirmed'
     and checked_in_at is null;

  -- (2) refresh mesa-final size from real turnout BEFORE points (slice-7 cadence).
  v_size := public.recompute_final_table_size(p_tournament_id);

  -- (2b) re-derive made_final_table from the FINAL size. At completion every
  --      seated player has a final_position, so "reached the final table" is
  --      exactly final_position ≤ size — this makes step (2)'s recompute
  --      load-bearing for the bonus_final_table term in the points below.
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

-- ---------------------------------------------------------------------------
-- Grants. Every admin RPC is SECURITY DEFINER with an internal admin gate, so
-- granting execute to authenticated is safe (non-admins are rejected inside);
-- service_role is admitted for the integration suite. The internal helpers
-- (fn_eliminate_entry) run only from the definer wrappers → service_role only.
-- fn_tournament_points keeps its slice-5 grant (service_role) — CREATE OR
-- REPLACE preserves privileges; re-asserted here for clarity.
-- ---------------------------------------------------------------------------
revoke all on function public.fn_is_tournament_admin(uuid)      from public;
revoke all on function public.clock(uuid, text, jsonb)          from public;
revoke all on function public.confirm_payment(uuid)             from public;
revoke all on function public.add_rebuy(uuid)                   from public;
revoke all on function public.fn_eliminate_entry(uuid)          from public;
revoke all on function public.eliminate(uuid)                   from public;
revoke all on function public.self_bust(uuid)                   from public;
revoke all on function public.undo_last_elimination(uuid)       from public;
revoke all on function public.mark_no_show(uuid, boolean)       from public;
revoke all on function public.complete_tournament(uuid, uuid[]) from public;

grant execute on function public.fn_is_tournament_admin(uuid)      to authenticated, service_role;
grant execute on function public.clock(uuid, text, jsonb)          to authenticated, service_role;
grant execute on function public.confirm_payment(uuid)             to authenticated, service_role;
grant execute on function public.add_rebuy(uuid)                   to authenticated, service_role;
grant execute on function public.fn_eliminate_entry(uuid)          to service_role;
grant execute on function public.eliminate(uuid)                   to authenticated, service_role;
grant execute on function public.self_bust(uuid)                   to authenticated, service_role;
grant execute on function public.undo_last_elimination(uuid)       to authenticated, service_role;
grant execute on function public.mark_no_show(uuid, boolean)       to authenticated, service_role;
grant execute on function public.complete_tournament(uuid, uuid[]) to authenticated, service_role;

grant execute on function public.fn_tournament_points(uuid) to service_role;
