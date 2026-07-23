---
task: poker-league-prototype
status: approved        # draft → approved → consumed-by-plan
derived_from: prototype
created: 2026-07-23T17:53:19Z
approved: 2026-07-23
---

# BE contract — poker-league-prototype

Derived from the approved UI in `prototype/index.html`. Backend = **Supabase** (Postgres +
Auth + Realtime + Storage), so "endpoints" are Postgres tables (via PostgREST), **RPC functions**
for transactional/derived flows, **Realtime channels**, and **Storage buckets** — not a custom
HTTP server. Only fields/operations the UI actually consumes are listed.

## Data model

```
player:                                  # source: leaderboard, profile, attendance, admin
  id           uuid pk
  auth_user_id uuid  (nullable until first magic-link login)
  name         text
  email        text unique
  avatar_url   text  (null → initials fallback)   # source: av() in Tabla/attendance/profile
  is_admin     bool                               # source: role gating

season (a.k.a. league):                  # source: topbar season, league settings
  id                 uuid pk
  name               text           # "Liga 2026"
  year               int
  status             enum(active|archived)         # one active at a time
  points_multiplier  int            # default 10
  bonus_final_table  int
  bonus_top3         int
  bonus_attendance   int
  final_table_size   int            # default 8
  no_show_penalty    int            # season-points, negative; ghosting = max (see rules)
  early_bird_bonus_chips int        # flat, e.g. 2000
  cancel_bands       jsonb          # [{hours_before, penalty}] graduated late-cancel
                                    #   default: >24→0, 24–12→-5, 12–6→-10, <6→-15

tournament (a.k.a. fecha):               # source: fecha card/detail, live view, admin
  id                    uuid pk
  season_id             uuid fk
  name                  text
  scheduled_at          timestamptz          # start time (drives early-bird + cancel bands)
  status                enum(scheduled|live|completed)
  venue_lat             numeric              # geofence center
  venue_lng             numeric
  geofence_radius_m     int                  # default 100
  buy_in                numeric
  rebuy_amount          numeric
  rebuy_until_level     int                  # rebuy period end (null/0 = no rebuys)
  starting_stack        int
  ante_enabled          bool                 # default false ("usually no ante")
  blind_structure_id    uuid fk
  timer_mode            enum(auto|manual)    # default auto
  current_level         int
  level_started_at      timestamptz
  is_paused             bool
  paused_remaining_seconds int
  prize_pool_override   numeric              # null → pot auto-computed
  prizes                jsonb                # [{position, pct, amount}] editable late

blind_structure: id, name, season_id
blind_level:     id, structure_id, level_number, small_blind, big_blind,
                 ante (nullable/ignored when tournament.ante_enabled=false),
                 duration_seconds, is_break

entry (per player per tournament):       # source: attendance list, admin mgmt, standings
  id              uuid pk
  tournament_id   uuid fk
  player_id       uuid fk
  status          enum(invited|confirmed|declined|checked_in|no_show|playing|eliminated|winner)
  rsvp_at         timestamptz
  cancelled_at    timestamptz
  checked_in_at   timestamptz
  check_in_geo_ok bool          # false when admin-overridden without GPS
  early_bird      bool          # checked in before scheduled_at
  chips           int           # starting_stack (+ early_bird bonus, + rebuys)
  paid            bool
  rebuys_count    int
  final_position  int           # assigned on elimination (total−1 flow)
  made_final_table bool
  eliminated_at   timestamptz
  points_earned   int           # computed at completion (incl. penalties)
  unique(tournament_id, player_id)

# Phase 2 (out of scope here, listed for schema awareness):
gallery_photo, learning_content
```

### Derived / aggregated (views or RPC — the UI reads these, doesn't compute them)

```
leaderboard_row:            # source: Tabla
  player{id,name,avatar_url}, total_points, games_played, wins, podiums,
  form: tier[]  (last 5)  where tier ∈ champion|podium|final|out
      champion = final_position==1 · podium = 2–3 · final = made_final_table · out = else

live_standing:              # source: En Vivo standings
  entry ordered by: alive first, then eliminated by final_position asc

pot:  COALESCE(prize_pool_override, paid_count*buy_in + sum(rebuys_count)*rebuy_amount)
remaining_seconds (client-computed): is_paused ? paused_remaining_seconds
                                     : level_duration − (now − level_started_at)
```

## Endpoints (Supabase: tables / RPC / realtime / storage)

| Kind | Name | Request | Response | Used by |
|---|---|---|---|---|
| Auth | magic-link sign-in | email | session | Login |
| Table | `season` (read, one active) | — | season+config | topbar, league settings, leaderboard |
| RPC | `leaderboard(season_id)` | season_id | `leaderboard_row[]` | Tabla |
| RPC | `player_profile(player_id)` | player_id | points history + form + bests | Perfil |
| Table | `tournament` (read, by season) | — | `tournament[]` | Fechas list, cards |
| Table | `tournament` (read one) | id | tournament + entries | Fecha detail, En Vivo, Admin |
| RPC | `rsvp(tournament_id, 'confirm'|'decline')` | ids | entry | Voy / No voy |
| RPC | `cancel_rsvp(tournament_id)` | id | entry + penalty applied | Cancelar (graduated) |
| RPC | `check_in(tournament_id, lat, lng)` | ids+geo | entry (early_bird, chips) | Hacer check-in |
| RPC | `admin_check_in(entry_id)` | id | entry | admin GPS override |
| RPC | `confirm_payment(entry_id)` | id | entry (playing) | admin Confirmar pago |
| RPC | `mark_no_show(entry_id)` | id | entry | admin Marcar no-show |
| RPC | `add_rebuy(entry_id)` | id | entry (reactivated) | admin Reactivar (out only) |
| RPC | `eliminate(entry_id)` / `self_bust(tournament_id)` | id | standings | Eliminar / Estoy fuera |
| RPC | `undo_last_elimination(tournament_id)` | id | standings | admin Undo |
| RPC | `clock(tournament_id, action, payload)` | pause/resume/±sec/next/prev/reset | timer state | admin clock |
| RPC | `set_prizes(tournament_id, payouts[])` | id+payouts | tournament | Editar premios |
| RPC | `open_tournament(id)` / `complete_tournament(id)` | id | tournament (+ points computed) | admin |
| RPC | `create_tournament(payload)` | fecha fields | tournament | Nueva fecha |
| RPC | `update_season_config(payload)` | config | season | Liga settings |
| RPC | `close_season()` | — | new active season | Cerrar liga actual |
| Realtime | channel `tournament:{id}` | — | timer/status/prizes changes | En Vivo, Admin |
| Realtime | channel `entries:{tournament_id}` | — | status/standings changes | En Vivo, Admin |
| Storage | bucket `avatars` | image | url | profile photo upload |
| RPC | `season_summary_text(...)` | scope | formatted string | WhatsApp copy (stage 1) |

RLS (from spec §9): authenticated read on season/tournament/entry/leaderboard; a player writes
only their own rsvp/cancel/check_in/self_bust/avatar; admin (is_admin or tournament owner) for all
admin RPCs. Timer: admin device is the single writer for level advance.

## States the UI relies on

- **Loading** — leaderboard/lists → skeleton rows; timer shows last-known value while realtime
  reconnects (never blank).
- **Empty** — no upcoming fechas → friendly empty + (admin) "Nueva fecha"; new season → roster at
  0 pts; no players → invite prompt.
- **Error** — magic-link fail → resend; check-in out-of-range/denied → message + "Pedir al admin";
  realtime drop → subtle "reconnecting"; RPC failure → toast + idempotent retry (no double-apply,
  esp. eliminate / confirm_payment / add_rebuy).
- **Success** — confirm / check-in / pay / eliminate give immediate friendly feedback; early-bird
  surfaces a celebratory "+2.000 fichas" moment.
- **Intermediate** — entry status pills reflect the exact lifecycle state everywhere the player
  list renders; optimistic self-bust placement reconciled by admin.

## Resolved (planning phase, 2026-07-23)

1. **Points vs prizes = separate systems.** Season **points** rank the leaderboard (§5 formula).
   Cash **prizes** split the pot independently.
2. **Prize distribution = % template, auto-computed then ROUNDED to clean amounts, admin-editable
   late.** Season holds a `payout_template` (e.g. top-3 `[0.60,0.28,0.12]`). App computes each
   payout from the live pot and rounds (to nearest ₡1.000; ₡39.2K→₡40K), then admin may override
   any amount once the pot is final. Stored per-tournament in `tournament.prizes` (jsonb).
3. **Chop / split (deal).** Admin can end a tournament with the final K players splitting:
   - Money: the summed prize amounts for positions 1..K, divided equally (rounded), admin-adjustable.
   - Points: the summed §5 point-values for positions 1..K, divided equally → each chopper gets the
     same points.
   - Record: **co-champions** — every chopper who split the top gets a título/win + gold Campeón form
     pill. (New `entry.chopped bool` + `chop_group` marker; completion honors it.)
4. **"Won't attend" (admin no-show) = per-case.** `mark_no_show(entry_id, excused bool)` — excused
   → 0 penalty; not excused → the ghost penalty (−15).
5. **Dynamic mesa final (two-tier).** `final_table_size` = **5 when checked-in players ≤ 10, else 10**
   (computed at open/completion; `made_final_table` set accordingly). Overridable per season.
6. **Config defaults (season):** multiplier ×10 · bonus_final_table +5 · bonus_top3 +8 ·
   bonus_attendance +2 · no_show_penalty −15 · cancel_bands 0/−5/−10/−15 · early_bird_bonus_chips
   2000 · rebuy_until_level 6 · geofence_radius_m 100. All editable in League settings.
7. **Season tiebreakers:** points → wins → podiums → most-recent finish.
8. **Prizes storage:** `tournament.prizes` jsonb (payout_template lives on `season`).
9. **Auth ↔ player:** admin pre-creates player rows (name/email); first magic-link login binds
   `auth_user_id` by matching email; player can set display name + avatar on first login.

### Data-model deltas from the above
```
season       += payout_template jsonb   # e.g. [0.60,0.28,0.12]
                won_show_excusable bool  # (per-case is always allowed; no config needed)
entry        += chopped bool, chop_group int|null
# final_table_size becomes DERIVED at open/completion (two-tier), not a stored constant
```

## Out of scope (this contract / Phase 1)

- Memorable-hands gallery, tournament-history full-bleed covers, learning section (Phase 2).
- Native WhatsApp send/integration — stage 1 is copy-paste text only.
- PWA offline, push notifications, i18n/English toggle (Phase 3).
- Payment processing — buy-ins are cash; app records admin confirmation only.
