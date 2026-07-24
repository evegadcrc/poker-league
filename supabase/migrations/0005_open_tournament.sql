-- ============================================================================
-- Poker Friends — open_tournament (scheduled → live) + final-table sizing (slice 7)
--
-- Opening a tournament is the pre-game → game-day gate (spec §"Check-in"): the
-- admin flips Upcoming → Live, which (a) unlocks geofenced check-in for confirmed
-- players and (b) LOCKS RSVP/cancel (rejection of rsvp/cancel once status<>scheduled
-- is enforced by slice-9's rsvp/cancel_rsvp RPCs — NOT here; this slice only makes
-- the status transition those RPCs check against).
--
-- ── TIMER-INIT CHOICE: open PAUSED at level 1 ──────────────────────────────
-- Opening merely ENABLES check-in (spec: "Admin opens the Tournament … Confirmed
-- players may Check-in"). Cards are not in the air yet — players are still
-- arriving, checking in, and handing over buy-ins. If the level-1 countdown ran
-- from the open moment (is_paused=false), level 1 would burn down during check-in.
-- So we initialize current_level=1, level_started_at=now(), is_paused=TRUE, and
-- cache paused_remaining_seconds = level-1 duration (from the blind structure, if
-- any) so the live view (slice 11) renders the correct frozen starting time
-- (remaining = is_paused ? paused_remaining_seconds : dur − (now − started_at)).
-- The admin (sole clock writer) taps resume via slice-12's `clock` RPC when play
-- actually begins; that action clears is_paused and re-bases level_started_at.
--
-- ── final_table_size CADENCE (option (a): stored value, kept fresh) ─────────
-- The two-tier mesa final (fn_final_table_size: ≤10 checked-in → 5, else 10;
-- season override wins) depends on ACTUAL TURNOUT, but at open few/no players have
-- checked in — a value frozen at open would be wrong. We keep ONE stored column
-- (tournament.final_table_size) and refresh it on every event that changes the
-- checked-in count, via the helper recompute_final_table_size():
--   • open_tournament (here)      → stores the PROVISIONAL value (turnout so far,
--                                    typically 0 checked-in → 5, or the override).
--   • slice-10  check_in          → MUST call recompute_final_table_size(id) after
--                                    each successful check-in so the stored size
--                                    tracks turnout as players arrive.
--   • slice-12  complete_tournament → MUST call recompute_final_table_size(id) once
--                                    (after auto-flipping confirmed-but-never-checked-in
--                                    entries to no_show) so the final size reflects
--                                    real turnout before points/made_final_table.
-- Slice-12's eliminate flow reads the stored column to set entry.made_final_table
-- when alive ≤ size — it relies on check_in having kept it fresh. Turnout is
-- measured as entries with checked_in_at IS NOT NULL (stable across the
-- checked_in→playing→eliminated→winner transitions).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- recompute_final_table_size(tournament_id) → int
--   Recounts checked-in entries, resolves the two-tier size via
--   fn_final_table_size, writes tournament.final_table_size, returns it.
--   Internal helper (no auth guard): called only from SECURITY DEFINER RPCs
--   (open_tournament here; check_in / complete_tournament in slices 10/12) and
--   from the integration suite via service_role. Locked to service_role.
-- ---------------------------------------------------------------------------
create or replace function public.recompute_final_table_size(p_tournament_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_size int;
begin
  select public.fn_final_table_size(
           (select count(*)::int from public.entry e
             where e.tournament_id = p_tournament_id and e.checked_in_at is not null),
           t.season_id)
    into v_size
  from public.tournament t
  where t.id = p_tournament_id;

  if not found then
    raise exception 'recompute_final_table_size: tournament % not found', p_tournament_id;
  end if;

  update public.tournament set final_table_size = v_size where id = p_tournament_id;
  return v_size;
end;
$$;

-- ---------------------------------------------------------------------------
-- open_tournament(tournament_id) → the updated tournament row
--   Admin-only (global admin OR the tournament owner OR service_role for tests).
--   Asserts status='scheduled', flips it to 'live', initializes the clock
--   (paused at level 1), and stores the provisional final_table_size.
-- ---------------------------------------------------------------------------
create or replace function public.open_tournament(p_tournament_id uuid)
returns setof public.tournament
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created_by  uuid;
  v_status      public.tournament_status;
  v_level1_secs int;
begin
  select t.created_by, t.status,
         (select bl.duration_seconds
            from public.blind_level bl
           where bl.structure_id = t.blind_structure_id
             and bl.level_number = 1
           limit 1)
    into v_created_by, v_status, v_level1_secs
  from public.tournament t
  where t.id = p_tournament_id;

  if not found then
    raise exception 'open_tournament: tournament % not found', p_tournament_id;
  end if;

  -- Admin-only. The created_by clause is null-guarded so an unauthenticated /
  -- non-admin caller can never slip through on NULL = NULL logic.
  if not (
       public.auth_is_admin()
    or (v_created_by is not null and v_created_by = public.auth_player_id())
    or auth.role() = 'service_role'
  ) then
    raise exception 'open_tournament: admin only';
  end if;

  -- Only a scheduled tournament may be opened (reject live / completed clearly).
  if v_status <> 'scheduled' then
    raise exception
      'open_tournament: tournament % is %, only a scheduled tournament can be opened',
      p_tournament_id, v_status;
  end if;

  -- Flip to live + initialize the clock PAUSED at level 1 (see header).
  update public.tournament
     set status                   = 'live',
         current_level            = 1,
         level_started_at         = now(),
         is_paused                = true,
         paused_remaining_seconds = v_level1_secs
   where id = p_tournament_id;

  -- Store the provisional final-table size from current turnout (kept fresh by
  -- slices 10/12 — see the CADENCE note in the header).
  perform public.recompute_final_table_size(p_tournament_id);

  return query select * from public.tournament where id = p_tournament_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants.
--   * recompute_final_table_size WRITES the resolved size → service_role only
--     (mirrors fn_tournament_points). Slices 10/12's SECURITY DEFINER RPCs call
--     it internally as their definer, so they need no authenticated grant.
--   * open_tournament: SECURITY DEFINER with an internal admin guard, so granting
--     execute to authenticated is safe (non-admins are rejected inside);
--     service_role for the integration suite.
-- ---------------------------------------------------------------------------
revoke all on function public.recompute_final_table_size(uuid) from public;
grant execute on function public.recompute_final_table_size(uuid) to service_role;

revoke all on function public.open_tournament(uuid) from public;
grant execute on function public.open_tournament(uuid) to authenticated, service_role;
