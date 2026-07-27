-- ============================================================================
-- Poker Friends — CHECK-IN AS A BONUS-ONLY ACTION (forward-fix of 0028 + 0030)
--
-- New product model: checking in ONLY determines the early-bird chip bonus and
-- an "on time" marker. It never removes a player from the fecha, and NOT
-- checking in is NOT a penalty — only an admin's `mark_no_show` sets no_show.
--
--   • On time  = checked in while the fecha is PRE-LIVE (tournament.status =
--                'scheduled', i.e. before the admin opened it) → early-bird
--                chip bonus + "A tiempo".
--   • Late     = checked in while status = 'live' → NO bonus, no "A tiempo".
--
-- Three plain `create or replace`s of the LATEST definitions (0028 / 0030 are
-- NOT edited in place). Only the changes below differ from those defs:
--
--   (1) check_in        — early-bird rule now `v_status = 'scheduled'` (pre-live)
--                         instead of `now() < scheduled_at`. Grants/geofence/
--                         status gate/chips/recompute all verbatim from 0028.
--   (2) admin_check_in  — same early-bird redefinition; rest verbatim from 0028.
--   (3) complete_tournament — the "confirmed-but-never-checked-in → no_show"
--                         flip (step 1) is REMOVED. A confirmed player who never
--                         checked in now stays 'confirmed' and simply scores 0
--                         via fn_tournament_points branch (5); only an admin's
--                         mark_no_show applies the −15. Everything else (chop,
--                         remainder ranking step 0b, resize, made_final_table
--                         re-derive, fn_tournament_points, status='completed',
--                         pinned search_path, grants) is verbatim from 0030.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) check_in(tournament_id, lat, lng) — copy of 0028, early-bird rule only.
--   On time ⇔ checked in before the admin opened the fecha (status='scheduled').
-- ---------------------------------------------------------------------------
create or replace function public.check_in(
  p_tournament_id uuid,
  p_lat double precision,
  p_lng double precision
)
returns setof public.entry
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id    uuid := public.auth_player_id();
  v_status       public.tournament_status;
  v_scheduled_at timestamptz;
  v_cancelled_at timestamptz;
  v_venue_lat    double precision;
  v_venue_lng    double precision;
  v_radius       int;
  v_stack        int;
  v_bonus        int;
  v_entry_status public.entry_status;
  v_early_bird   boolean;
  v_dist         double precision;
  v_a            double precision;
  v_r            constant double precision := 6371000; -- earth radius (metres)
begin
  if v_player_id is null then
    raise exception 'check_in: no sos miembro de la liga';
  end if;

  select t.status, t.scheduled_at, t.cancelled_at, t.venue_lat::double precision,
         t.venue_lng::double precision, t.geofence_radius_m,
         coalesce(t.starting_stack, 0), s.early_bird_bonus_chips
    into v_status, v_scheduled_at, v_cancelled_at, v_venue_lat, v_venue_lng,
         v_radius, v_stack, v_bonus
  from public.tournament t
  join public.season s on s.id = t.season_id
  where t.id = p_tournament_id;

  if not found then
    raise exception 'check_in: la fecha % no existe', p_tournament_id;
  end if;

  -- The door opens once the fecha is scheduled (people arrive before the admin
  -- flips it live) and stays open while live; a completed fecha rejects.
  if v_status not in ('scheduled', 'live') then
    raise exception 'check_in: el torneo aún no está abierto';
  end if;

  -- A cancelled fecha can no longer be checked into, whatever its status.
  if v_cancelled_at is not null then
    raise exception 'check_in: la fecha fue cancelada';
  end if;

  select e.status into v_entry_status
  from public.entry e
  where e.tournament_id = p_tournament_id and e.player_id = v_player_id;

  if not found or v_entry_status not in ('confirmed', 'checked_in') then
    raise exception 'check_in: no estás confirmado para esta fecha';
  end if;

  if v_venue_lat is null or v_venue_lng is null then
    raise exception 'check_in: la sede no tiene ubicación configurada';
  end if;

  -- Inline haversine (metres) — venue ↔ phone. No PostGIS; approximate but
  -- more than accurate enough at the ~100 m geofence scale.
  v_a := sin(radians(p_lat - v_venue_lat) / 2) ^ 2
       + cos(radians(v_venue_lat)) * cos(radians(p_lat))
       * sin(radians(p_lng - v_venue_lng) / 2) ^ 2;
  v_dist := 2 * v_r * asin(least(1, sqrt(v_a)));

  if v_dist > v_radius then
    raise exception 'check_in: estás fuera de la sede';
  end if;

  -- Early bird = checked in while the fecha is still PRE-LIVE (scheduled, before
  -- the admin opened it) → flat chip bonus + "A tiempo". A late check-in (status
  -- already 'live') earns no bonus.
  v_early_bird := (v_status = 'scheduled');

  update public.entry
     set status          = 'checked_in',
         checked_in_at   = now(),
         check_in_geo_ok = true,
         early_bird      = v_early_bird,
         chips           = v_stack + case when v_early_bird then v_bonus else 0 end
   where tournament_id = p_tournament_id and player_id = v_player_id;

  -- Keep the stored mesa-final size fresh as turnout grows (slice-7 contract).
  perform public.recompute_final_table_size(p_tournament_id);

  return query
    select * from public.entry
    where tournament_id = p_tournament_id and player_id = v_player_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- (2) admin_check_in(entry_id) — copy of 0028, same early-bird redefinition.
--   Admin override for a failed GPS fix. Skips the distance check, sets
--   check_in_geo_ok=false, otherwise identical effects (early-bird + recompute).
-- ---------------------------------------------------------------------------
create or replace function public.admin_check_in(p_entry_id uuid)
returns setof public.entry
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_created_by    uuid;
  v_status        public.tournament_status;
  v_scheduled_at  timestamptz;
  v_cancelled_at  timestamptz;
  v_stack         int;
  v_bonus         int;
  v_entry_status  public.entry_status;
  v_early_bird    boolean;
begin
  select e.tournament_id, e.status, t.created_by, t.status, t.scheduled_at,
         t.cancelled_at, coalesce(t.starting_stack, 0), s.early_bird_bonus_chips
    into v_tournament_id, v_entry_status, v_created_by, v_status,
         v_scheduled_at, v_cancelled_at, v_stack, v_bonus
  from public.entry e
  join public.tournament t on t.id = e.tournament_id
  join public.season s on s.id = t.season_id
  where e.id = p_entry_id;

  if not found then
    raise exception 'admin_check_in: la inscripción % no existe', p_entry_id;
  end if;

  -- Admin-only (owner OR global admin OR service_role for tests). Null-guarded
  -- so an unauthenticated / non-admin caller never slips through NULL = NULL.
  if not (
       public.auth_is_admin()
    or (v_created_by is not null and v_created_by = public.auth_player_id())
    or auth.role() = 'service_role'
  ) then
    raise exception 'admin_check_in: solo un admin puede registrar el check-in';
  end if;

  -- Open while scheduled or live (early arrivals); completed rejects.
  if v_status not in ('scheduled', 'live') then
    raise exception 'admin_check_in: el torneo aún no está abierto';
  end if;

  -- A cancelled fecha can no longer be checked into, whatever its status.
  if v_cancelled_at is not null then
    raise exception 'admin_check_in: la fecha fue cancelada';
  end if;

  if v_entry_status not in ('confirmed', 'checked_in') then
    raise exception 'admin_check_in: la inscripción no está confirmada';
  end if;

  -- Early bird = registered while the fecha is still PRE-LIVE (scheduled) →
  -- chip bonus + "A tiempo"; a live-time registration earns no bonus.
  v_early_bird := (v_status = 'scheduled');

  update public.entry
     set status          = 'checked_in',
         checked_in_at   = now(),
         check_in_geo_ok = false,           -- GPS bypassed → geo not verified
         early_bird      = v_early_bird,
         chips           = v_stack + case when v_early_bird then v_bonus else 0 end
   where id = p_entry_id;

  perform public.recompute_final_table_size(v_tournament_id);

  return query select * from public.entry where id = p_entry_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Both SECURITY DEFINER with an internal auth gate → authenticated is
-- safe (the gate rejects inside); service_role for the integration suite.
-- (Mirrors 0028 verbatim.)
-- ---------------------------------------------------------------------------
revoke all on function public.check_in(uuid, double precision, double precision) from public;
grant execute on function public.check_in(uuid, double precision, double precision)
  to authenticated, service_role;

revoke all on function public.admin_check_in(uuid) from public;
grant execute on function public.admin_check_in(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (3) complete_tournament — copy of 0030 VERBATIM, with the confirmed-ghost →
--   no_show flip (old step 1) REMOVED. Not checking in must not auto-penalize:
--   a confirmed-no-position entry now scores 0 via fn_tournament_points branch
--   (5) and stays 'confirmed' until an admin runs mark_no_show. Every other step
--   (chop, remainder ranking step 0b, resize, made_final_table re-derive, points,
--   status='completed'), the pinned search_path and the grants are verbatim.
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

  -- (1) refresh mesa-final size from real turnout BEFORE points (slice-7 cadence).
  --   NOTE (mig 0031): the old "confirmed-but-never-checked-in → no_show" flip is
  --   intentionally GONE. Not checking in is no longer a penalty — such an entry
  --   stays 'confirmed' and scores 0 via fn_tournament_points branch (5). Only an
  --   admin's mark_no_show applies the −15.
  v_size := public.recompute_final_table_size(p_tournament_id);

  -- (1b) re-derive made_final_table from the FINAL size. At completion every
  --      seated player has a final_position, so "reached the final table" is
  --      exactly final_position ≤ size.
  update public.entry e
     set made_final_table = (e.final_position is not null and e.final_position <= v_size)
   where e.tournament_id = p_tournament_id;

  -- (2) points.
  perform public.fn_tournament_points(p_tournament_id);

  -- (3) completed.
  update public.tournament set status = 'completed' where id = p_tournament_id;

  return query select * from public.tournament where id = p_tournament_id;
end;
$$;

-- Grants (mirror 0030 / 0012): SECURITY DEFINER with internal admin gate →
-- authenticated + service_role. CREATE OR REPLACE preserves privileges;
-- re-asserted for clarity.
revoke all on function public.complete_tournament(uuid, uuid[]) from public, anon;
grant execute on function public.complete_tournament(uuid, uuid[]) to authenticated, service_role;
