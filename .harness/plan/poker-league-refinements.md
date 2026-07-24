---
task: poker-league-refinements
created: 2026-07-24
status: deferred-to-phase-2   # per product owner 2026-07-24 — NOT built now; Phase 1 ships first
builds_on: poker-league-prototype (Phase 1, shipped-ready on feat/poker-friends-phase1)
---

# Plan — Poker Friends, Phase 1.1 refinements

## Goal
Fix the broken close-season flow, move prize distribution to per-fecha (variable places, editable
live), handle simultaneous all-in busts, and apply small copy/currency fixes — per the 2026-07-24
decisions in `.harness/decisions.md`.

## Approach
Continue on `feat/poker-friends-phase1`. Backend changes as new migrations (0014+), reusing the
existing DEFINER-RPC + auto-materialize patterns. FE reuses existing components/tokens. Same gates
(build/test/lint; integration tests ISOLATED per the flaky-test lesson; serial suite). Ground any
Supabase specifics via /dh:docs if uncertain. After build: test → simplify → review-loop →
verify-ui (the prize editor, seasons list, and multi-bust UI are new) → ship.

## Steps
1. **season single-active + resilient read** — mig `0014`: partial unique index
   `season(status) where status='active'`; make `close_season` atomic (archive active, then insert
   the new active in one tx). `src/routes/Leaderboard.tsx`: replace `.eq('status','active').maybeSingle()`
   with a resilient read (active season, tolerate/repair edge). — *verify:* integration: close_season →
   exactly one active; a second active insert is rejected by the index; Leaderboard read never throws.
2. **leaderboard roster-at-0 for empty seasons** — mig `0014`: `leaderboard(season_id)` returns EVERY
   league player at 0 pts when the season has no tournaments/entries (so a fresh season shows the roster,
   not blank). — *verify:* integration: brand-new active season → all players rank at 0.
3. **Seasons list / history UI** — `src/routes/Seasons.tsx` (or fold into Liga): cards for seasons,
   **active on top**, archived below; tap a card → that season's Tabla (`Leaderboard` takes an optional
   season id). `close_season` success in `LeagueSettings` → navigate to the new active Tabla (not a blank
   screen). — *verify:* RTL: both cards render active-first; tapping routes to the right season; post-close
   navigation lands on the new active.
4. **Per-fecha prize distribution (schema + RPC)** — mig `0015`: add `tournament.payout_distribution jsonb`
   (variable `[{place,pct}]`); keep `season.payout_template` as the DEFAULT seed. `create_tournament`
   seeds the fecha's distribution from the league default, # of places scaled to expected turnout
   (~top 20-30%, min 3). `set_prizes` uses `tournament.payout_distribution` (fallback to season default).
   Auto-materialize (0013) unchanged in trigger points. — *verify:* integration: per-fecha distribution
   drives prizes; variable place count; override still preserved.
5. **Prize-distribution editor (Create-Fecha + Live admin)** — `CreateFecha.tsx`: edit places + %s
   (add/remove rows, must sum ~100%). `Admin.tsx` live console: an "Editar premios" that edits the
   DISTRIBUTION (not just amounts) and re-materializes; live view (`Live.tsx`) always shows the PROPOSED
   split. — *verify:* RTL: editor add/remove/validate; live edit re-materializes; proposed shown pre-final.
6. **Simultaneous multi-bust** — mig `0015`: extend elimination so the admin can mark 2+ players out on
   one hand: ordered (shortest-stack-first → worse position, sequential total−1) OR a **tie group** that
   splits those positions' points+money (reuse the chop/`chop_group` mechanism). `Admin.tsx`: multi-select
   eliminate + "empataron" (split) option. — *verify:* integration: 2 bust ordered → correct positions;
   dead-even → both split the two positions' points+money equally; leaderboard reflects it.
7. **Copy / currency / label** — `Live.tsx:428` per-player badge `Vivo`→`En juego`; `CreateFecha.tsx`
   money inputs show `₡`; admin player list `fichas`→`fichas iniciales` (clarify it's buy-in, not a live
   stack). — *verify:* RTL/snapshot; visual in verify-ui.

## Tests to add or update
- Integration (isolated): close_season single-active + index; roster-at-0; per-fecha distribution +
  variable places; multi-bust ordered + tie-split.
- FE (RTL): seasons list ordering + routing; prize-distribution editor (add/remove/sum); multi-bust UI;
  copy/currency.

## Risks & unknowns
- Prize model migration: existing fechas have no `payout_distribution` → backfill from season default in
  the migration so live/completed fechas keep working.
- Multi-bust tie-split reuses chop logic — ensure it composes with a later real chop at the final table.
- close_season index: if data currently violates single-active, the migration must repair first.
- Seasons UI is new (not in the approved prototype) → verify-ui pass before ship.

8. **Standalone fecha** — `tournament.counts_for_league bool default true`; Create-Fecha "cuenta para
   la liga" toggle (ON by default); points/leaderboard aggregation EXCLUDES fechas with
   counts_for_league=false (they run fully but don't touch the season standings). — *verify:* a
   standalone fecha completes + assigns positions/prizes but adds 0 to every player's season total.

## Out of scope
- Live per-hand chip tracking (fichas stays buy-in chips).
- Desktop (non-mobile-width) layout.
- Phase-2 (odds calculator incl. hand rankings, sound/notifications, gallery, learning).
