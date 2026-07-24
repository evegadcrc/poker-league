-- ============================================================================
-- Poker Friends — Admin CRUD + season rollover (slice 13)
--
--   create_tournament(payload)   → insert a scheduled fecha in the ACTIVE season
--   update_season_config(payload)→ patch the active season's config fields
--   close_season()               → archive the active season, open next year's
--
-- All three WRITE league-level state, so each is SECURITY DEFINER guarded to an
-- admin: global admin (`auth_is_admin()`) with `service_role` admitted so the
-- integration suite can drive fixtures. Unlike the slice-12 console RPCs there
-- is no per-tournament owner check — create/season config are league-wide, not
-- tied to one fecha, so `fn_is_tournament_admin` (which needs a tournament id)
-- does not apply; the gate is `auth_is_admin() OR service_role`.
--
-- ── DOCUMENTED CHOICES ──
--   • "Active season" = the single season with status='active' (order by year
--     desc as a tiebreaker). All three RPCs raise if none exists.
--   • create_tournament always inserts status='scheduled'; created_by =
--     auth_player_id() (NULL under service_role — the column is nullable and the
--     admin RLS owner-clause simply never matches, which is fine for a definer
--     insert). Missing fields fall back to schema-aligned defaults (geofence
--     100 m, buy_in 0, ante off, timer auto).
--   • update_season_config uses coalesce(nullif(...)) per field so a payload
--     patches only the keys it carries; final_table_size_override is special-
--     cased on `payload ? key` so it can be explicitly cleared to NULL (→ the
--     two-tier 5/10 default). cancel_bands / payout_template are jsonb, copied
--     whole when present.
--   • close_season is IRREVERSIBLE: the old season is ARCHIVED (status flipped),
--     never deleted, and a fresh active season for year+1 is created carrying the
--     config forward. Players are GLOBAL (player has no season_id) so the roster
--     needs no copy; the new season simply has zero entries → every player sits
--     at 0 points on the leaderboard. There is no undo RPC.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- create_tournament(payload jsonb) → the inserted tournament row
-- ---------------------------------------------------------------------------
create or replace function public.create_tournament(p_payload jsonb)
returns setof public.tournament
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season uuid;
  v_id     uuid;
begin
  if not (public.auth_is_admin() or auth.role() = 'service_role') then
    raise exception 'nueva fecha: solo un admin puede crear fechas';
  end if;

  select s.id into v_season
  from public.season s
  where s.status = 'active'
  order by s.year desc
  limit 1;

  if v_season is null then
    raise exception 'nueva fecha: no hay temporada activa';
  end if;

  insert into public.tournament (
    season_id, name, scheduled_at, status,
    venue_lat, venue_lng, geofence_radius_m,
    buy_in, rebuy_amount, rebuy_until_level, starting_stack,
    ante_enabled, blind_structure_id, timer_mode, created_by
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
    public.auth_player_id()
  )
  returning id into v_id;

  return query select * from public.tournament where id = v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- update_season_config(payload jsonb) → the updated active season row
--   Patches only the keys present in the payload (multiplier, three bonuses,
--   no_show_penalty, early_bird_bonus_chips, cancel_bands, payout_template,
--   final_table_size_override, plus the season name).
-- ---------------------------------------------------------------------------
create or replace function public.update_season_config(p_payload jsonb)
returns setof public.season
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not (public.auth_is_admin() or auth.role() = 'service_role') then
    raise exception 'liga: solo un admin puede editar la temporada';
  end if;

  select s.id into v_id
  from public.season s
  where s.status = 'active'
  order by s.year desc
  limit 1;

  if v_id is null then
    raise exception 'liga: no hay temporada activa';
  end if;

  update public.season s set
    name                   = coalesce(nullif(p_payload->>'name', ''), s.name),
    points_multiplier      = coalesce(nullif(p_payload->>'points_multiplier', '')::int, s.points_multiplier),
    bonus_final_table      = coalesce(nullif(p_payload->>'bonus_final_table', '')::int, s.bonus_final_table),
    bonus_top3             = coalesce(nullif(p_payload->>'bonus_top3', '')::int, s.bonus_top3),
    bonus_attendance       = coalesce(nullif(p_payload->>'bonus_attendance', '')::int, s.bonus_attendance),
    no_show_penalty        = coalesce(nullif(p_payload->>'no_show_penalty', '')::int, s.no_show_penalty),
    early_bird_bonus_chips = coalesce(nullif(p_payload->>'early_bird_bonus_chips', '')::int, s.early_bird_bonus_chips),
    cancel_bands           = coalesce(p_payload->'cancel_bands', s.cancel_bands),
    payout_template        = coalesce(p_payload->'payout_template', s.payout_template),
    final_table_size_override = case
        when p_payload ? 'final_table_size_override'
          then nullif(p_payload->>'final_table_size_override', '')::int
          else s.final_table_size_override
      end
  where s.id = v_id;

  return query select * from public.season where id = v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- close_season() → the NEW active season row
--   Archives the active season and opens the next year, carrying the config
--   forward. Irreversible — the old season is archived, never deleted, and the
--   new season starts with zero entries (roster is global → 0 points for all).
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

  -- Archive (not delete) — the old season stays as read-only history.
  update public.season set status = 'archived' where id = v_old.id;

  -- Open next year's active season, carrying the config forward. Players are
  -- global, so there is no roster to copy; the new season simply has no entries.
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

-- ---------------------------------------------------------------------------
-- Grants. Each RPC is SECURITY DEFINER with an internal admin gate, so granting
-- execute to authenticated is safe (non-admins are rejected inside);
-- service_role is admitted for the integration suite.
-- ---------------------------------------------------------------------------
revoke all on function public.create_tournament(jsonb)    from public;
revoke all on function public.update_season_config(jsonb) from public;
revoke all on function public.close_season()              from public;

grant execute on function public.create_tournament(jsonb)    to authenticated, service_role;
grant execute on function public.update_season_config(jsonb) to authenticated, service_role;
grant execute on function public.close_season()              to authenticated, service_role;
