-- ============================================================================
-- Poker Friends — seed data (slice 2)
-- One active season "Liga 2026" with the locked default config, ~11 Spanish-named
-- players, an 8-level blind structure, and three fechas (completed / live /
-- scheduled) with entries spanning every lifecycle state so the leaderboard,
-- live, and RSVP views all have data.
--
-- No auth users are bound here (auth_user_id stays NULL until first magic-link
-- login — that is slice 4). Fixed UUIDs keep the seed referentially stable.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Season (locked default config)
-- ---------------------------------------------------------------------------
insert into season (
  id, name, year, status, points_multiplier, bonus_final_table, bonus_top3,
  bonus_attendance, no_show_penalty, early_bird_bonus_chips, cancel_bands,
  payout_template, final_table_size_override
) values (
  'a5000000-0000-4000-8000-000000000001', 'Liga 2026', 2026, 'active',
  10, 5, 8, 2, -15, 2000,
  '[{"hours_before":24,"penalty":0},{"hours_before":12,"penalty":-5},{"hours_before":6,"penalty":-10},{"hours_before":0,"penalty":-15}]'::jsonb,
  '[0.60,0.28,0.12]'::jsonb,
  null
);

-- ---------------------------------------------------------------------------
-- Players (11; one admin = Carlos, one with an avatar = María)
-- ---------------------------------------------------------------------------
insert into player (id, name, email, avatar_url, is_admin) values
  ('b1000000-0000-4000-8000-000000000001', 'Carlos Jiménez',    'carlos.jimenez@example.com',   null,                              true),
  ('b1000000-0000-4000-8000-000000000002', 'María Rodríguez',   'maria.rodriguez@example.com',  'https://i.pravatar.cc/150?img=5', false),
  ('b1000000-0000-4000-8000-000000000003', 'José Vargas',       'jose.vargas@example.com',      null,                              false),
  ('b1000000-0000-4000-8000-000000000004', 'Ana Morales',       'ana.morales@example.com',      null,                              false),
  ('b1000000-0000-4000-8000-000000000005', 'Luis Castro',       'luis.castro@example.com',      null,                              false),
  ('b1000000-0000-4000-8000-000000000006', 'Andrés Solís',      'andres.solis@example.com',     null,                              false),
  ('b1000000-0000-4000-8000-000000000007', 'Gabriela Rojas',    'gabriela.rojas@example.com',   null,                              false),
  ('b1000000-0000-4000-8000-000000000008', 'Fernando Chaves',   'fernando.chaves@example.com',  null,                              false),
  ('b1000000-0000-4000-8000-000000000009', 'Diego Herrera',     'diego.herrera@example.com',    null,                              false),
  ('b1000000-0000-4000-8000-00000000000a', 'Laura Fernández',   'laura.fernandez@example.com',  null,                              false),
  ('b1000000-0000-4000-8000-00000000000b', 'Ricardo Mora',      'ricardo.mora@example.com',     null,                              false);

-- ---------------------------------------------------------------------------
-- Blind structure + 8 levels (ante mostly 0, one break)
-- ---------------------------------------------------------------------------
insert into blind_structure (id, name, season_id) values
  ('c2000000-0000-4000-8000-000000000001', 'Estructura Estándar', 'a5000000-0000-4000-8000-000000000001');

insert into blind_level (structure_id, level_number, small_blind, big_blind, ante, duration_seconds, is_break) values
  ('c2000000-0000-4000-8000-000000000001', 1,  25,  50,   0, 1200, false),
  ('c2000000-0000-4000-8000-000000000001', 2,  50,  100,  0, 1200, false),
  ('c2000000-0000-4000-8000-000000000001', 3,  75,  150,  0, 1200, false),
  ('c2000000-0000-4000-8000-000000000001', 4,  100, 200,  0, 1200, false),
  ('c2000000-0000-4000-8000-000000000001', 5,  0,   0,    0, 600,  true),   -- descanso
  ('c2000000-0000-4000-8000-000000000001', 6,  150, 300,  0, 1200, false),
  ('c2000000-0000-4000-8000-000000000001', 7,  200, 400,  25, 1200, false),
  ('c2000000-0000-4000-8000-000000000001', 8,  300, 600,  50, 1200, false);

-- ---------------------------------------------------------------------------
-- Tournaments (fechas): 1 completed (history → leaderboard), 1 live, 1 scheduled
-- ---------------------------------------------------------------------------
insert into tournament (
  id, season_id, name, scheduled_at, status, venue_lat, venue_lng, geofence_radius_m,
  buy_in, rebuy_amount, rebuy_until_level, starting_stack, ante_enabled,
  blind_structure_id, timer_mode, current_level, level_started_at, is_paused,
  paused_remaining_seconds, prize_pool_override, prizes, final_table_size, created_by
) values
  -- Fecha 1 — completed (feeds the leaderboard)
  ('d3000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001',
   'Fecha 1 - Apertura', now() - interval '30 days', 'completed',
   9.9281, -84.0907, 100, 20000, 20000, 6, 10000, false,
   'c2000000-0000-4000-8000-000000000001', 'auto', 8, null, false,
   null, null, null, 5, 'b1000000-0000-4000-8000-000000000001'),
  -- Fecha 2 — live (rebuy_until_level 6, starting_stack 10000, ante_enabled false)
  ('d3000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-000000000001',
   'Fecha 2 - Torneo en Vivo', now() - interval '1 hour', 'live',
   9.9281, -84.0907, 100, 20000, 20000, 6, 10000, false,
   'c2000000-0000-4000-8000-000000000001', 'auto', 3, now() - interval '5 minutes', false,
   null, null, null, 5, 'b1000000-0000-4000-8000-000000000001'),
  -- Fecha 3 — scheduled (future; exercises RSVP flow)
  ('d3000000-0000-4000-8000-000000000003', 'a5000000-0000-4000-8000-000000000001',
   'Fecha 3 - Próxima', now() + interval '7 days', 'scheduled',
   9.9281, -84.0907, 100, 20000, 20000, 6, 10000, false,
   'c2000000-0000-4000-8000-000000000001', 'auto', 1, null, false,
   null, null, null, null, 'b1000000-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------
-- Entries — Fecha 1 (completed): 10 finishers (positions 1..10) + 1 no-show.
-- Points per §5: (N-P)*10 + FT(+5 if pos<=5) + Top3(+8 if pos<=3) + Att(+2 if paid).
-- N = 10 finishers; no-show = season no_show_penalty (-15).
-- ---------------------------------------------------------------------------
insert into entry (
  tournament_id, player_id, status, rsvp_at, checked_in_at, check_in_geo_ok,
  early_bird, chips, paid, rebuys_count, final_position, made_final_table,
  eliminated_at, points_earned
) values
  ('d3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'winner',     now() - interval '31 days', now() - interval '30 days', true, true,  0, true, 0, 1,  true,  now() - interval '29 days 20 hours', 105),
  ('d3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', 'eliminated', now() - interval '31 days', now() - interval '30 days', true, false, 0, true, 0, 2,  true,  now() - interval '29 days 20 hours', 95),
  ('d3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000003', 'eliminated', now() - interval '31 days', now() - interval '30 days', true, false, 0, true, 0, 3,  true,  now() - interval '29 days 20 hours', 85),
  ('d3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000004', 'eliminated', now() - interval '31 days', now() - interval '30 days', true, false, 0, true, 0, 4,  true,  now() - interval '29 days 20 hours', 67),
  ('d3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000005', 'eliminated', now() - interval '31 days', now() - interval '30 days', true, false, 0, true, 1, 5,  true,  now() - interval '29 days 20 hours', 57),
  ('d3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000006', 'eliminated', now() - interval '31 days', now() - interval '30 days', true, false, 0, true, 0, 6,  false, now() - interval '29 days 21 hours', 42),
  ('d3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000007', 'eliminated', now() - interval '31 days', now() - interval '30 days', true, false, 0, true, 0, 7,  false, now() - interval '29 days 21 hours', 32),
  ('d3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000008', 'eliminated', now() - interval '31 days', now() - interval '30 days', true, false, 0, true, 0, 8,  false, now() - interval '29 days 21 hours', 22),
  ('d3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000009', 'eliminated', now() - interval '31 days', now() - interval '30 days', true, false, 0, true, 0, 9,  false, now() - interval '29 days 22 hours', 12),
  ('d3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-00000000000a', 'eliminated', now() - interval '31 days', now() - interval '30 days', true, false, 0, true, 0, 10, false, now() - interval '29 days 22 hours', 2),
  -- Ricardo confirmed but never checked in → no-show penalty
  ('d3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-00000000000b', 'no_show',    now() - interval '31 days', null, null, false, null, false, 0, null, false, null, -15);

-- ---------------------------------------------------------------------------
-- Entries — Fecha 2 (live): 6 playing, 2 eliminated, 1 checked_in, 1 confirmed,
-- 1 declined. final_table_size resolved to 5. points_earned NULL (not completed).
-- ---------------------------------------------------------------------------
insert into entry (
  tournament_id, player_id, status, rsvp_at, checked_in_at, check_in_geo_ok,
  early_bird, chips, paid, rebuys_count, final_position, made_final_table, eliminated_at
) values
  ('d3000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001', 'playing',    now() - interval '2 days', now() - interval '90 minutes', true,  true,  12000, true, 0, null, false, null),
  ('d3000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002', 'playing',    now() - interval '2 days', now() - interval '80 minutes', true,  false, 10000, true, 0, null, false, null),
  ('d3000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000003', 'playing',    now() - interval '2 days', now() - interval '75 minutes', true,  false, 10000, true, 0, null, false, null),
  ('d3000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000004', 'playing',    now() - interval '2 days', now() - interval '70 minutes', true,  false, 18000, true, 0, null, false, null),
  ('d3000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000005', 'playing',    now() - interval '2 days', now() - interval '65 minutes', true,  false, 22000, true, 1, null, false, null),
  ('d3000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000006', 'playing',    now() - interval '2 days', now() - interval '60 minutes', true,  false, 15000, true, 0, null, false, null),
  ('d3000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000007', 'eliminated', now() - interval '2 days', now() - interval '85 minutes', true,  false, 0,     true, 1, 8,    false, now() - interval '20 minutes'),
  ('d3000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000008', 'eliminated', now() - interval '2 days', now() - interval '55 minutes', true,  false, 0,     true, 0, 7,    false, now() - interval '5 minutes'),
  ('d3000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000009', 'checked_in', now() - interval '2 days', now() - interval '40 minutes', true,  false, 10000, false, 0, null, false, null),
  ('d3000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-00000000000a', 'confirmed',  now() - interval '2 days', null, null, false, null, false, 0, null, false, null),
  ('d3000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-00000000000b', 'declined',   now() - interval '2 days', null, null, false, null, false, 0, null, false, null);

-- ---------------------------------------------------------------------------
-- Entries — Fecha 3 (scheduled): pre-game RSVP states (invited / confirmed / declined)
-- ---------------------------------------------------------------------------
insert into entry (tournament_id, player_id, status, rsvp_at) values
  ('d3000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000001', 'confirmed', now() - interval '1 day'),
  ('d3000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000002', 'confirmed', now() - interval '1 day'),
  ('d3000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000003', 'confirmed', now() - interval '20 hours'),
  ('d3000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000007', 'confirmed', now() - interval '18 hours'),
  ('d3000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000009', 'confirmed', now() - interval '10 hours'),
  ('d3000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000006', 'declined',  now() - interval '22 hours'),
  ('d3000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-00000000000a', 'declined',  now() - interval '12 hours'),
  ('d3000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000004', 'invited', null),
  ('d3000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000005', 'invited', null),
  ('d3000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000008', 'invited', null),
  ('d3000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-00000000000b', 'invited', null);
