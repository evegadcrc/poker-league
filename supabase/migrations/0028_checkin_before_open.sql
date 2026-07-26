-- ============================================================================
-- Poker Friends — allow check-in BEFORE the fecha is opened (forward-fix of 0007)
--
-- People arrive at the venue before the admin flips the fecha live, so a
-- confirmed player must be able to check in while the fecha is still SCHEDULED
-- (not only once it is live). This `create or replace`s BOTH check_in and
-- admin_check_in from 0007 (do NOT edit 0007), changing ONLY the status gate:
--
--   • check-in is now allowed when tournament.status IN ('scheduled','live')
--     AND tournament.cancelled_at IS NULL,
--   • a COMPLETED fecha still rejects (the night is over), and
--   • a CANCELLED fecha (cancelled_at set, whatever the status) still rejects.
--
-- EVERYTHING else is copied verbatim from 0007: the confirmed-entry check, the
-- inline haversine geofence, the early-bird logic (now() < scheduled_at → chip
-- bonus), the stack/chips calc, check_in_geo_ok handling, the recompute of
-- final_table_size, admin_check_in's admin gate, and the grants (SECURITY
-- DEFINER + pinned search_path, revoke from public, grant authenticated +
-- service_role). Signatures are unchanged so `create or replace` binds cleanly.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- check_in(tournament_id, lat, lng) → the caller's checked-in entry row
--   Player-facing. Caller = auth_player_id(). Requires status IN
--   ('scheduled','live') and not cancelled, a confirmed entry, and GPS within
--   geofence_radius_m of the venue.
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

  -- Early bird = arrived before the scheduled start → flat chip bonus.
  v_early_bird := now() < v_scheduled_at;

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
-- admin_check_in(entry_id) → the checked-in entry row
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

  v_early_bird := now() < v_scheduled_at;

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
-- ---------------------------------------------------------------------------
revoke all on function public.check_in(uuid, double precision, double precision) from public;
grant execute on function public.check_in(uuid, double precision, double precision)
  to authenticated, service_role;

revoke all on function public.admin_check_in(uuid) from public;
grant execute on function public.admin_check_in(uuid) to authenticated, service_role;
