-- ============================================================================
-- Poker Friends — geofenced check-in + early-bird bonus + admin override (slice 10)
--
-- Game-day arrival gate (spec §"Check-in"). Once the admin OPENS a fecha
-- (open_tournament flips scheduled → live, slice 7), a confirmed player who is
-- physically at the venue can check in from their phone. Check-in:
--   • requires the fecha to be LIVE (rejected otherwise — the door isn't open),
--   • requires the caller to hold a confirmed (or already checked-in) entry,
--   • validates the phone's GPS coordinates against the venue via an inline
--     haversine (no PostGIS): distance ≤ tournament.geofence_radius_m,
--   • stamps checked_in_at + status='checked_in' + check_in_geo_ok=true, and
--   • grants the early-bird chip bonus when the player arrives before the
--     scheduled start (chips = starting_stack + season.early_bird_bonus_chips;
--     otherwise chips = starting_stack, early_bird=false).
--
-- ── final_table_size CADENCE (slice-7 DEPENDENCY) ──────────────────────────
-- The two-tier mesa-final size tracks ACTUAL turnout (checked-in count). Every
-- successful check-in changes that count, so BOTH RPCs here MUST call
-- recompute_final_table_size(tournament_id) after flipping the entry — exactly
-- as open_tournament (slice 7) documented. Slice-12 eliminate reads the stored
-- tournament.final_table_size and relies on check-in having kept it fresh.
--
-- ── admin_check_in(entry_id) — GPS-failed override ─────────────────────────
-- Indoor GPS is flaky. When a player can't get a fix, the admin registers them
-- manually. Same effects (checked_in, early-bird by time, recompute) but
-- check_in_geo_ok=FALSE and the distance test is skipped. Admin-only
-- (global admin OR the tournament owner OR service_role for tests).
--
-- Both are SECURITY DEFINER with an internal auth gate, so granting execute to
-- authenticated is safe; service_role is admitted so the integration suite can
-- drive fixtures. The acting player in check_in is always auth_player_id().
-- ============================================================================

-- ---------------------------------------------------------------------------
-- check_in(tournament_id, lat, lng) → the caller's checked-in entry row
--   Player-facing. Caller = auth_player_id(). Requires status='live', a
--   confirmed entry, and GPS within geofence_radius_m of the venue.
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

  select t.status, t.scheduled_at, t.venue_lat::double precision,
         t.venue_lng::double precision, t.geofence_radius_m,
         coalesce(t.starting_stack, 0), s.early_bird_bonus_chips
    into v_status, v_scheduled_at, v_venue_lat, v_venue_lng,
         v_radius, v_stack, v_bonus
  from public.tournament t
  join public.season s on s.id = t.season_id
  where t.id = p_tournament_id;

  if not found then
    raise exception 'check_in: la fecha % no existe', p_tournament_id;
  end if;

  -- The door only opens once the admin makes the fecha live.
  if v_status <> 'live' then
    raise exception 'check_in: el torneo aún no está abierto';
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
  v_stack         int;
  v_bonus         int;
  v_entry_status  public.entry_status;
  v_early_bird    boolean;
begin
  select e.tournament_id, e.status, t.created_by, t.status, t.scheduled_at,
         coalesce(t.starting_stack, 0), s.early_bird_bonus_chips
    into v_tournament_id, v_entry_status, v_created_by, v_status,
         v_scheduled_at, v_stack, v_bonus
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

  if v_status <> 'live' then
    raise exception 'admin_check_in: el torneo aún no está abierto';
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
