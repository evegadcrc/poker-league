-- ============================================================================
-- Poker Friends — Phase 1 initial schema (slice 2)
-- Tables + enums + RLS per .harness/design/poker-league-prototype/be-contract.md
-- Transactional / derived RPCs (points, pot, open, check_in, clock, …) are added
-- in later slices as SECURITY DEFINER functions — NOT here. This slice is
-- schema + row-level-security + the auth helper functions the policies rely on.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type tournament_status as enum ('scheduled', 'live', 'completed');
create type entry_status as enum (
  'invited', 'confirmed', 'declined', 'checked_in',
  'no_show', 'playing', 'eliminated', 'winner'
);
create type season_status as enum ('active', 'archived');
-- timer_mode is typed enum(auto|manual) in the contract data model.
create type timer_mode as enum ('auto', 'manual');

-- ---------------------------------------------------------------------------
-- player  (a League member; auth_user_id binds to the Supabase auth user on
--          first magic-link login — nullable until then)
-- ---------------------------------------------------------------------------
create table player (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique,                 -- matched against auth.uid() in RLS
  name          text not null,
  email         text not null unique,
  avatar_url    text,                         -- null → initials fallback
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- season  (a.k.a. League) — one active at a time; holds points/bonus config.
--   NOTE: final_table_size is DERIVED per-tournament (two-tier at open), so the
--   season only carries an optional override (final_table_size_override).
-- ---------------------------------------------------------------------------
create table season (
  id                        uuid primary key default gen_random_uuid(),
  name                      text not null,
  year                      int not null,
  status                    season_status not null default 'active',
  points_multiplier         int not null default 10,
  bonus_final_table         int not null default 5,
  bonus_top3                int not null default 8,
  bonus_attendance          int not null default 2,
  no_show_penalty           int not null default -15,      -- season-points, negative
  early_bird_bonus_chips    int not null default 2000,     -- flat chip bonus
  -- graduated late-cancel bands: [{hours_before, penalty}], keys per contract data model
  cancel_bands              jsonb not null default
    '[{"hours_before":24,"penalty":0},{"hours_before":12,"penalty":-5},{"hours_before":6,"penalty":-10},{"hours_before":0,"penalty":-15}]'::jsonb,
  payout_template           jsonb not null default '[0.60,0.28,0.12]'::jsonb,  -- top-3 %
  final_table_size_override int,                            -- null → two-tier default (5/10)
  created_at                timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- blind_structure / blind_level
-- ---------------------------------------------------------------------------
create table blind_structure (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  season_id  uuid references season(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table blind_level (
  id               uuid primary key default gen_random_uuid(),
  structure_id     uuid not null references blind_structure(id) on delete cascade,
  level_number     int not null,
  small_blind      int not null,
  big_blind        int not null,
  ante             int,                       -- nullable; ignored when ante_enabled=false
  duration_seconds int not null,
  is_break         boolean not null default false,
  unique (structure_id, level_number)
);

-- ---------------------------------------------------------------------------
-- tournament  (a.k.a. Fecha / game night)
-- ---------------------------------------------------------------------------
create table tournament (
  id                        uuid primary key default gen_random_uuid(),
  season_id                 uuid not null references season(id) on delete cascade,
  name                      text not null,
  scheduled_at              timestamptz not null,          -- drives early-bird + cancel bands
  status                    tournament_status not null default 'scheduled',
  venue_lat                 numeric,                        -- geofence center
  venue_lng                 numeric,
  geofence_radius_m         int not null default 100,
  buy_in                    numeric not null default 0,
  rebuy_amount              numeric,
  rebuy_until_level         int,                            -- null/0 → no rebuys
  starting_stack            int,
  ante_enabled              boolean not null default false, -- "usually no ante"
  blind_structure_id        uuid references blind_structure(id),
  timer_mode                timer_mode not null default 'auto',
  current_level             int not null default 1,
  level_started_at          timestamptz,
  is_paused                 boolean not null default false,
  paused_remaining_seconds  int,
  prize_pool_override       numeric,                        -- null → pot auto-computed
  prizes                    jsonb,                          -- [{position, pct, amount}]
  final_table_size          int,                            -- resolved (two-tier) at open
  created_by                uuid references player(id),     -- owner; used by admin RLS clause
  created_at                timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- entry  (one Player's participation record per Tournament)
-- ---------------------------------------------------------------------------
create table entry (
  id               uuid primary key default gen_random_uuid(),
  tournament_id    uuid not null references tournament(id) on delete cascade,
  player_id        uuid not null references player(id) on delete cascade,
  status           entry_status not null default 'invited',
  rsvp_at          timestamptz,
  cancelled_at     timestamptz,
  checked_in_at    timestamptz,
  check_in_geo_ok  boolean,                    -- false when admin-overridden without GPS
  early_bird       boolean not null default false,
  chips            int,                        -- starting_stack (+ early-bird bonus, + rebuys)
  paid             boolean not null default false,
  rebuys_count     int not null default 0,
  final_position   int,                        -- assigned on elimination (total-1 flow)
  made_final_table boolean not null default false,
  eliminated_at    timestamptz,
  points_earned    int,                        -- computed at completion (incl. penalties)
  chopped          boolean not null default false,   -- co-champion via chop/split
  chop_group       int,                              -- chop cohort marker (null = no chop)
  created_at       timestamptz not null default now(),
  unique (tournament_id, player_id)
);

-- Helpful indexes for the FK lookups the views/RPCs will hit.
create index idx_tournament_season on tournament(season_id);
create index idx_blind_level_structure on blind_level(structure_id);
create index idx_entry_tournament on entry(tournament_id);
create index idx_entry_player on entry(player_id);

-- ============================================================================
-- Auth helper functions (SECURITY DEFINER → bypass RLS to inspect the caller's
-- player row without recursive policy evaluation). Standard Supabase pattern.
-- ============================================================================
create or replace function public.auth_player_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.player where auth_user_id = auth.uid();
$$;

create or replace function public.auth_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.player where auth_user_id = auth.uid()), false);
$$;

grant execute on function public.auth_player_id() to anon, authenticated;
grant execute on function public.auth_is_admin() to anon, authenticated;

-- ============================================================================
-- Row-Level Security
--   * authenticated SELECT on every read table
--   * a player may INSERT/UPDATE/DELETE only their OWN player row + OWN entries
--     (matched via player.auth_user_id = auth.uid())
--   * admin (is_admin OR tournament.created_by = the caller's player) may write
--     tournaments / seasons / blind structures / blind levels
-- Anon (no JWT) matches no policy → all access denied.
-- ============================================================================
alter table player          enable row level security;
alter table season          enable row level security;
alter table tournament      enable row level security;
alter table blind_structure enable row level security;
alter table blind_level     enable row level security;
alter table entry           enable row level security;

-- ---- authenticated read on all tables --------------------------------------
create policy "read player"          on player          for select to authenticated using (true);
create policy "read season"          on season          for select to authenticated using (true);
create policy "read tournament"      on tournament      for select to authenticated using (true);
create policy "read blind_structure" on blind_structure for select to authenticated using (true);
create policy "read blind_level"     on blind_level     for select to authenticated using (true);
create policy "read entry"           on entry           for select to authenticated using (true);

-- ---- player: self-write on own player row ----------------------------------
create policy "player self insert" on player for insert to authenticated
  with check (auth_user_id = auth.uid());
create policy "player self update" on player for update to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());
create policy "player self delete" on player for delete to authenticated
  using (auth_user_id = auth.uid());

-- ---- entry: self-write on own entries (rsvp / cancel / check-in / self-bust)
create policy "entry self insert" on entry for insert to authenticated
  with check (player_id = public.auth_player_id());
create policy "entry self update" on entry for update to authenticated
  using (player_id = public.auth_player_id())
  with check (player_id = public.auth_player_id());
create policy "entry self delete" on entry for delete to authenticated
  using (player_id = public.auth_player_id());

-- ---- admin: write tournaments (owner OR global admin) ----------------------
create policy "admin insert tournament" on tournament for insert to authenticated
  with check (public.auth_is_admin() or created_by = public.auth_player_id());
create policy "admin update tournament" on tournament for update to authenticated
  using (public.auth_is_admin() or created_by = public.auth_player_id())
  with check (public.auth_is_admin() or created_by = public.auth_player_id());
create policy "admin delete tournament" on tournament for delete to authenticated
  using (public.auth_is_admin() or created_by = public.auth_player_id());

-- ---- admin: write seasons --------------------------------------------------
create policy "admin insert season" on season for insert to authenticated
  with check (public.auth_is_admin());
create policy "admin update season" on season for update to authenticated
  using (public.auth_is_admin()) with check (public.auth_is_admin());
create policy "admin delete season" on season for delete to authenticated
  using (public.auth_is_admin());

-- ---- admin: write blind structures + levels --------------------------------
create policy "admin insert blind_structure" on blind_structure for insert to authenticated
  with check (public.auth_is_admin());
create policy "admin update blind_structure" on blind_structure for update to authenticated
  using (public.auth_is_admin()) with check (public.auth_is_admin());
create policy "admin delete blind_structure" on blind_structure for delete to authenticated
  using (public.auth_is_admin());

create policy "admin insert blind_level" on blind_level for insert to authenticated
  with check (public.auth_is_admin());
create policy "admin update blind_level" on blind_level for update to authenticated
  using (public.auth_is_admin()) with check (public.auth_is_admin());
create policy "admin delete blind_level" on blind_level for delete to authenticated
  using (public.auth_is_admin());
