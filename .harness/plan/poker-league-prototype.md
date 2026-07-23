---
task: poker-league-prototype
created: 2026-07-23
status: approved
---

# Plan — Poker Friends, Phase 1 (React + Vite + Supabase)

## Goal
Build the Phase 1 "Poker Friends" mobile PWA (auth → season/fecha CRUD → RSVP → geofenced
check-in → live clock → admin console → leaderboard) per `.harness/specs/poker-league-prototype.md`
and `.harness/design/poker-league-prototype/be-contract.md`, reproducing the approved prototype's
Sports-Almanac + Neón look.

## Approach
- **Stack:** React + Vite + TypeScript, **Tailwind** for layout/utilities + **CSS custom
  properties** for the design tokens (port the three themes verbatim from the prototype — it is the
  visual source of truth), **shadcn/ui** only for a few primitives (Dialog/Sheet, Select). Supabase
  = Postgres + Auth (magic link) + Realtime + Storage. Test: **Vitest** + React Testing Library (FE)
  and a **Vitest integration suite against local Supabase** for SQL/RPC logic.
- **Backend is mostly SQL:** tables + RLS + `plpgsql` RPC functions. Points, pot, payouts, chop,
  dynamic mesa-final, open, and completion all live in DB functions so they're atomic and testable.
- **Timer is state-based** (store level_started_at/is_paused/paused_remaining_seconds; clients
  compute display; admin device is the sole writer). When `timer_mode='auto'`, the *admin client*
  writes the next level at 0 (one writer); `manual` waits for an admin tap. Never broadcast ticks.
- **Geofence:** `check_in` RPC validates distance with an inline haversine in plpgsql (no PostGIS).
- **Canonical algorithms defined here (source-of-truth §-numbers live in the external Google Doc,
  which build agents cannot read — so pin them in-plan):**
  - **Elimination "total−1":** on bust, `final_position` = current count of non-eliminated entries
    *including the busting player*; then mark eliminated. When exactly one remains → that player gets
    `final_position=1` (winner). Undo reverses the last bust and restores counts.
  - **Prize rounding:** each slice = `round(pct × pot to nearest ₡5.000)`; then the **1st-place slice
    absorbs the remainder** so payouts sum exactly to the pot. Example: pot ₡140.000, template
    60/28/12 → raw 84.0/39.2/16.8K → rounded 85/40/15K = ₡140.000. Admin may override any amount.
  - **Mesa final (two-tier, resolved at open):** `final_table_size` = 5 when checked-in ≤ 10, else 10;
    overridable by `season.final_table_size_override`. Stored on the tournament at open;
    `made_final_table` is set during play when alive ≤ that size.
  - **Points §5:** `(N − P) × multiplier + bonus_final_table[if made_final_table] + bonus_top3[if
    P≤3] + bonus_attendance[if paid]`, then minus penalties (no-show/late-cancel). Chop: for a
    chop_group of K, each member gets `round(Σ points_for_positions_1..K / K)` and is a co-champion.
- **RLS lives in the backend contract** (`be-contract.md:139-141`), not the Google Doc — step 2
  enumerates concrete per-table + per-RPC policies from that sketch.
- **Integration tests require a running local stack:** `supabase start` is a precondition for every
  step whose verify hits the DB (5,6,7,9,10,12,13,14).
- **Ground version-sensitive Supabase surfaces via `/dh:docs` at build time** — magic-link auth
  (step 4), RLS (step 2), Realtime channels (step 11), Storage upload (step 14).
- Build follows spec §10 order. Each step below is one dispatchable slice (files + change + verify).

## Steps

1. **Scaffold app + design system.** Vite React-TS app at repo root; Tailwind + PostCSS; port
   prototype themes into `src/styles/tokens.css` (`:root`/`[data-theme=dark|neon]`) + `ThemeProvider`
   (`src/lib/theme.tsx`, 3-way cycle + localStorage); load Bricolage Grotesque + Archivo; shadcn init;
   Vitest setup. Replace `CLAUDE.md` Commands with real verified invocations. — *verify:* `npm run
   build` passes; `npm run dev` renders a themed shell; `npm test` runs; contrast AA spot-check in all
   3 themes.
2. **DB schema + RLS + seed.** `supabase/migrations/0001_init.sql`: enums + tables (player, season,
   tournament, blind_structure, blind_level, entry) per contract incl. `season.payout_template`,
   `season.final_table_size_override`, `entry.chopped/chop_group`, `tournament.final_table_size`
   (resolved), `tournament.prizes` jsonb, **`tournament.created_by uuid references player`** (owner,
   used by the admin RLS clause below). **RLS from be-contract.md:139-141**, enumerated concretely:
   authenticated `select` on all read tables; player may insert/update/delete only their own `entry`
   (rsvp/cancel/check_in/self_bust) and own `player` row/avatar; every admin RPC (`SECURITY DEFINER`)
   asserts `is_admin OR tournament.created_by = auth.uid()`. `supabase/seed.sql`: 1 active season
   (defaults in contract §6), ~11 players, a blind structure, one `scheduled` fecha (to exercise the
   open→live flow) AND one `live` fecha with entries across lifecycle states. — *verify:* `supabase db
   reset` applies clean; per-table `select count(*)` returns seed rows; an anon client cannot update
   another player's entry (RLS test).
3. **Supabase client + types + env.** `src/lib/supabase.ts`; `src/lib/database.types.ts` via
   `supabase gen types`; `.env.example` (URL + anon key); `.env*` gitignored (already). — *verify:*
   dev-only `select` from `season` returns the seed row; typecheck passes.
4. **Auth (magic link) + roles.** `src/lib/auth.tsx` (session context + persist), `src/routes/Login.tsx`
   (POKER FRIENDS emblem, email → `signInWithOtp`); first login binds `player.auth_user_id` by
   matching email + captures name/avatar; route guard + `useRole()` (is_admin). `/dh:docs` magic-link
   first. — *verify:* local inbucket magic-link logs in; session persists across reload; non-admin
   cannot reach admin routes (RTL/route test).
5. **Points + leaderboard SQL.** `fn_final_table_size(checked_in int, season_id)` (≤10→5 else 10,
   honoring `final_table_size_override`); `fn_tournament_points(tournament_id)` (§5 formula per
   Approach, incl. penalties, **chop averaging + co-champion titles**); `leaderboard(season_id)`
   (totals, games/wins/podiums, last-5 **form tiers keyed off `chopped`/`final_position`** so a
   co-champion shows Campeón, tiebreakers points→wins→podiums→most-recent). — *verify:* Vitest
   integration: solo win; podium; no-show −15; each late-cancel band; chop 1º+2º (equal pts, BOTH
   Campeón); mesa-final 5-vs-10 threshold.
6. **Pot + prizes SQL.** `fn_pot(tournament_id)` (COALESCE override, paid·buy_in + rebuys·rebuy_amount);
   `set_prizes(tournament_id)` computes from `season.payout_template`×pot, **rounds per Approach
   (nearest ₡5.000, 1st absorbs remainder to equal pot)**, writes `tournament.prizes`; admin override
   path preserves overridden amounts. — *verify:* integration: pot math; 60/28/12 on ₡140K →
   85/40/15K summing to 140K; manual override persists across recompute.
7. **`open_tournament(id)` RPC (scheduled→live).** New: flips `status` scheduled→live; **locks RSVP
   and cancel** (later writes rejected); resolves + stores `tournament.final_table_size` via
   `fn_final_table_size(count of checked-in… )` (recompute allowed as more check in); admin-only.
   Steps 10 (check-in) and 9 (RSVP) depend on this transition. — *verify:* integration: open flips
   status + sets final_table_size; a `cancel_rsvp` after open is rejected; check-in allowed only when
   live.
8. **Leaderboard screen (Tabla).** `src/routes/Leaderboard.tsx` + `PlayerRow`, `FormPills`, `Legend`,
   `Avatar` (photo|initials); consumes `leaderboard` RPC; themed. — *verify:* renders seed leaderboard
   with correct ranks/points/form; RTL asserts row order + form tiers (incl. a co-champion pill).
9. **Fechas list + Fecha detail + RSVP.** `src/routes/Fechas.tsx`, `FechaDetail.tsx`; `rsvp` +
   `cancel_rsvp` RPCs (cancel applies graduated band penalty by `now` vs `scheduled_at`; **rejected
   once status=live** per step 7); attendance grouped by status with counts + pills. — *verify:*
   confirm→confirmed; cancel at 9h→−10 recorded; cancel after open→rejected (integration); grouping
   renders (RTL).
10. **Geofenced check-in.** `check_in(tournament_id, lat, lng)` RPC (**requires status=live**; inline
    haversine vs venue ±radius; sets checked_in, early_bird if before scheduled_at, adds bonus chips);
    `admin_check_in(entry_id)` override; FE geolocation prompt + success/out-of-range/denied states +
    "+2.000 fichas" moment. — *verify:* integration: inside→ok+early_bird+chips; outside→rejected; not
    live→rejected; admin override works.
11. **Live view + realtime.** `src/routes/Live.tsx`: state-based timer (client computes remaining),
    blinds (hide ante when `ante_enabled=false`), pot, remaining, Premios, live standings; subscribe
    `tournament:{id}` + `entries:{id}`. `/dh:docs` Realtime channels first. — *verify:* timer computes
    from seed state; a DB update to level state pushes to client (integration/manual); RTL ante-hidden.
12. **Admin console (live).** `src/routes/Admin/Console.tsx`: `clock` RPC actions
    pause/resume/±1min/next/prev/reset **+ edit_blinds** (on-the-fly SB/BB/ante override), admin sole
    writer; **auto-advance:** when `timer_mode='auto'` the admin client writes the next level at 0.
    `confirm_payment`; `add_rebuy` (**eliminated-only** → reactivate); `eliminate`/`self_bust`
    (**total−1 per Approach**) + `undo_last_elimination`; `mark_no_show(entry_id, excused bool)`;
    `complete_tournament` which **first auto-transitions confirmed-but-never-checked-in entries →
    no_show** (so ghosts get −15), then runs `fn_tournament_points`; **chop flow** (select final K →
    split money+points, co-champions). — *verify:* integration: eliminate assigns remaining-count incl
    self; alive==1→winner; undo restores; rebuy blocked while playing; ghost auto-flipped to no_show
    at completion → −15; chop splits per step 5; edit_blinds persists; auto-advance writes the next
    level at 0 when `timer_mode='auto'` (RTL/manual check).
13. **Admin CRUD + season rollover.** `Admin/CreateFecha.tsx` (name/date/venue+geo/buy-in/rebuy+period/
    stack/blinds/ante toggle/early-bird), `Admin/LeagueSettings.tsx` (config editor incl.
    payout_template + final_table_size_override); `close_season()` RPC (archive active, open next year,
    carry roster, reset points) behind a confirm modal — **no undo; old season archived, not deleted
    (state this in the modal).** — *verify:* create inserts tournament with geo; close_season archives
    + creates new active season, roster carried, points 0 (integration); settings persist.
14. **Profile + avatar upload.** `src/routes/Profile.tsx`: `player_profile` RPC (points history, form,
    bests); avatar upload to Storage `avatars` bucket → `player.avatar_url`. `/dh:docs` Storage first.
    — *verify:* profile renders seed history/form; upload returns a public URL and updates the row
    (integration).
15. **Self-report bust + WhatsApp summary.** Player "Estoy fuera" (optimistic `self_bust`, admin can
    reorder); admin `season_summary_text`/fecha summary → copy-to-clipboard sheet. — *verify:*
    self_bust sets position; summary string matches expected format (unit); clipboard copy invoked
    (RTL mock).
16. **States + PWA polish.** Loading skeletons, empty/error states per screen (magic-link fail,
    geofence denied, realtime reconnect, RPC failure idempotency — no double-apply on eliminate/
    confirm_payment/add_rebuy), manifest + installable PWA. — *verify:* each state renders (RTL);
    `npm run build` emits PWA assets; Lighthouse PWA sanity.

## Tests to add or update
- Integration (local Supabase, `supabase start` running): points incl. chop + penalties + ghost
  auto-no-show (5,12); pot/payout rounding→pot (6); open/RSVP-lock (7,9); check-in geofence + live-gate
  (10); eliminate/undo/rebuy/chop/edit_blinds (12); season rollover (13); avatar upload (14).
- FE (Vitest + RTL): leaderboard order/form incl. co-champion (8), attendance grouping (9), ante-hidden
  live (11), admin action gating by role (4/12), per-screen states (16).

## Risks & unknowns
- **Chop/split UI was not in the approved prototype** — its admin flow (select final K, preview
  money+points split, confirm) is new in step 12; consider a quick `/dh:verify-ui` pass on it.
- **Supabase API drift** — magic-link, RLS, Realtime v2 channel API, Storage, `gen types` change across
  versions; each relevant step `/dh:docs` first. Prior lessons: none recorded (greenfield).
- **Geofence reliability** — indoor GPS is flaky; mitigated by admin manual check-in (step 10). Inline
  haversine is approximate but fine at 100 m.
- **Two-tier mesa-final cliff** (10 vs 11 players) is intentional per user but odd near the boundary.
- **`close_season` is irreversible** (no undo RPC); the old season is archived not deleted, and the
  confirm modal must say so (step 13).
- **CLAUDE.md commands are unverified placeholders** — step 1 must replace them with run-verified
  commands or the ship pre-flight can't trust them.
- **Canonical §-numbered rules live in the external Google Doc** (not in-repo); this plan pins the
  load-bearing ones (elimination, rounding, mesa-final, points) in Approach so build agents don't need
  the Doc. Any further §-reference must be inlined before dispatch.

## Out of scope (Phase 1)
- Memorable-hands gallery, tournament-history full-bleed covers, learning section (Phase 2).
- Native WhatsApp send (stage-1 copy only), push notifications, i18n/English toggle, offline sync
  beyond installable PWA shell (Phase 3).
- Payment processing (buy-ins are cash; app records admin confirmation only).
