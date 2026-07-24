---
task: poker-league-phase2
created: 2026-07-24
status: approved
builds_on: poker-league-prototype (Phase 1, shipped — PR #1 open on feat/poker-friends-phase1)
supersedes: poker-league-refinements
design_skipped: Track B (odds calc, sound, gallery/history/learning) — per product-owner
  directive 2026-07-24 (no grill/design time). UX/engine calls made in-plan; flagged in Risks.
---

# Plan — Poker Friends, Phase 2

## Goal
Fix the shipped `close_season` bug and land the deferred refinements (Track A), then add the
three deferred feature areas (Track B): a client-side odds/hand calculator, sound &
notifications, and a media/learning layer (gallery, history covers, learning + hand rankings).

## Approach
Continue from the Phase-1 base on a new branch `feat/poker-friends-phase2`. **Recommend merging
PR #1 → `main` first** so Phase 2 branches off `main` (clean history); if not merged, branch off
`feat/poker-friends-phase1` (the work stacks). Backend changes are new migrations (0014+), reusing
the existing DEFINER-RPC + auto-materialize patterns and the flaky-test lesson (integration tests
ISOLATED — throwaway season + teardown — and serial via `fileParallelism:false`). FE reuses the
existing 3-theme token system, components, toast, and Realtime subscriptions. Track B feature UX
was NOT run through `/dh:design` (owner opted out); the card-picker layout, Web-Audio synth
approach, and gallery scope are documented decisions below and must survive `/dh:verify-ui`.

Track A first (unblocks the shipped bug + honors 2026-07-24 product decisions), then Track B.
Gates each slice: `npm run build` (tsc -b + vite) · `npm test` (vitest) · `npm run lint` (oxlint).
Integration slices require a clean `supabase db reset` before the final gate.

## Steps

### Track A — refinements + bug fix (migrations 0014–0015 + FE)

1. **`supabase/migrations/0014_season_integrity.sql`** — add partial unique index
   `create unique index on season(status) where status='active'`; **repair** any pre-existing
   >1-active rows first so the index can be created; guarantee single-active going forward. NOTE:
   `close_season` (0010_admin_crud.sql:146) is ALREADY a single-tx plpgsql fn — do NOT "make it
   atomic" / no-op. Its real latent defect is `order by year desc limit 1` (0010:163-164), which
   archives only the newest active row when >1 exist — fix it to archive ALL active rows (the index
   then makes >1-active impossible anyway). — *verify:* integration (isolated): close_season →
   exactly one active; a second active insert is rejected by the index; migration applies cleanly on
   a db pre-seeded with a duplicate-active (repair path).

2. **`0014_season_integrity.sql` (same migration) + `src/routes/Leaderboard.tsx`** — `leaderboard(season_id)`
   returns EVERY league player at 0 pts when the season has no tournaments/entries; replace the
   Leaderboard read's `.eq('status','active').maybeSingle()` with a resilient active-season read that
   never throws on 0/>1 rows. — *verify:* integration: brand-new active season → all players rank at 0;
   RTL: Leaderboard renders roster (not blank) with no active fecha.

3. **`src/routes/Seasons.tsx` (new) + nav + `src/routes/Leaderboard.tsx`** — seasons list: active card
   on top, archived below; tap a card → that season's Tabla (`Leaderboard` takes an optional
   `seasonId`). `close_season` success in `src/routes/admin/LeagueSettings.tsx` navigates to the new
   active Tabla (not a blank screen). — *verify:* RTL: active-first ordering; tap routes to the right
   season; post-close navigation lands on the new active season.

4. **`supabase/migrations/0015_fecha_prizes_bust_standalone.sql` + `src/lib/*`** — add
   `tournament.payout_distribution jsonb` (variable `[{place,pct}]`); keep `season.payout_template` as
   the DEFAULT seed. `create_tournament` seeds the fecha's distribution from the league default with
   # of paid places scaled to expected turnout (~top 20–30%, min 3). `set_prizes` reads
   `tournament.payout_distribution` (fallback to season default). Backfill existing fechas from the
   season default in-migration. Auto-materialize trigger points (mig 0013) unchanged. — *verify:*
   integration: per-fecha distribution drives prizes; variable place count; existing fechas keep
   working; manual override still preserved.

5. **`src/routes/admin/CreateFecha.tsx` + `src/routes/Admin.tsx` + `src/routes/Live.tsx`** — prize-distribution
   editor: edit places + %s (add/remove rows, must sum ~100%) in Create-Fecha AND the live admin
   console; live edit re-materializes prizes; `Live.tsx` always shows the PROPOSED split (even
   pre-final). **Persistence:** no new RPC — the admin `.update()`s `tournament.payout_distribution`
   directly (existing admin update-tournament RLS policy, 0001:215), then calls the step-4-modified
   `set_prizes` to re-materialize. — *verify:* RTL: editor add/remove/sum-validation; live edit
   re-materializes; proposed split shown pre-final.

6. **`0015_*.sql` (same migration) + `src/routes/Admin.tsx`** — simultaneous multi-bust: admin marks
   2+ players out on one hand — ordered (shortest-stack-first → worse position, sequential total−1)
   OR a dead-even **tie group** that splits those positions' points+money. **Trap:** reuse ONLY the
   `chop_group` points-grouping (`fn_tournament_points`, 0003:113-129) for the split — do NOT reuse
   the final-table chop path (0009:704-715) which sets `chopped=true` / `status='winner'` /
   `made_final_table=true`. A dead-even bust at e.g. 7th/8th must set `chop_group` (for the points
   split) but must NOT flag `chopped`/`winner`, or those players get mislabeled co-champions (gold
   form pill + phantom win via 0003:182-184). Admin UI: multi-select eliminate + "empataron" (split)
   option. — *verify:* integration: 2 bust ordered → correct positions; dead-even → both split the two
   positions' points+money equally AND are NOT counted as wins/champions (no gold form pill); tie-split
   still composes with a later real chop at the final table.

7. **`0015_*.sql` (same migration) + `src/routes/admin/CreateFecha.tsx` + points aggregation** — standalone
   fecha: `tournament.counts_for_league bool default true`; Create-Fecha "cuenta para la liga" toggle
   (ON by default). Points/leaderboard aggregation EXCLUDES fechas with `counts_for_league=false`
   (they run fully — clock/eliminations/prizes — but add 0 to season standings). — *verify:*
   integration: a standalone fecha completes + assigns positions/prizes but adds 0 to every player's
   season total.

8. **`src/routes/Live.tsx` + `src/routes/admin/CreateFecha.tsx` + `src/routes/Admin.tsx`** — copy/currency:
   live per-player badge `Vivo`→`En juego`; `₡` prefix on Create-Fecha money inputs; admin player-list
   `fichas`→`fichas iniciales` (clarify it's buy-in chips, not a live stack). — *verify:* RTL/snapshot;
   visual in verify-ui.

### Track B — new features

9. **`src/lib/poker/{evaluator.ts,equity.ts}` + `equity.worker.ts` (new) + tests** — pure 7-card hand
   evaluator (rank a best-5-of-7) + Monte-Carlo equity estimator (win/tie %), run in a Web Worker so
   the UI never blocks. No backend. **Seed the MC RNG** (deterministic, injectable) so the
   known-equity fixtures can't flake — the project carries a flaky-test lesson; alternatively route
   fixture assertions through the exact-enumeration path. — *verify:* unit tests against KNOWN
   equities (tolerance ±1.5%): AA vs KK preflop ≈ 82/18; AKs vs 22 ≈ 46/54 (coin-flip); a made flush
   beats a straight; enumeration path exact for river (0 unknowns). `npm test` green.

10. **`src/routes/Calculadora.tsx` (new) + route + nav entry** — visual card picker (rank×suit grid,
    ♠♥♦♣ colored per theme), slots for **Tu mano** (2), **Mesa** (flop 3 / turn / river), **# de
    rivales**; tap-to-fill / tap-to-clear; used/duplicate cards disabled; live "cartas restantes"
    count; results show win % / tie % (+ outs where meaningful) from the worker. Spanish copy,
    Sports-Almanac + Neón styling. — *verify:* RTL: fill hand+board → results render; duplicate card
    disabled; clear works; worker result plumbs to UI (mock the worker in test). verify-ui visual pass.

11. **`src/components/HandRankings.tsx` (new, native themed) + `src/routes/Aprende.tsx` (new) + nav** —
    poker hand-rankings reference (Royal Flush → High Card, best→worst) rendered as native card/suit
    glyphs + Spanish labels (NOT a raster image; crisp + theme-aware in all 3 themes). Shown on the
    Calculadora page AND a Learning section (static curated Spanish content: rules + rankings; no
    backend). — *verify:* RTL: 10 ranking rows in order; renders in all 3 themes; reused by both
    Calculadora and Aprende. verify-ui visual pass across themes.

12. **`src/lib/sound.ts` (new) + a mute/volume control in Profile/settings** — sound engine using the
    **Web Audio API to synthesize** the cues (oscillator-based beep/chime — no binary audio assets,
    tiny, theme-agnostic): final-seconds warning + level-change chime + start + elimination. Mute +
    volume persisted (`localStorage` key `pf-sound`); respects device silent where the platform
    exposes it; audio context resumed on first user gesture. — *verify:* unit: mute state persists;
    triggers are no-ops when muted; RTL: settings toggle. (Audio output itself is manual/verify-ui.)

13. **`src/routes/Live.tsx` + `src/routes/Admin.tsx` + Realtime handlers** — wire sound + notifications
    to STATE CHANGES (not per tick, per §8): fire on level advance, tournament open (check-in
    available), and elimination ("X quedó fuera"). In-app toasts always; optional **local**
    notifications via the Notification API (permission-gated) so alerts reach players with the screen
    off. Non-admin clients trigger off the existing Realtime subscription events. (Server/web-push =
    Phase 3, out of scope.) — *verify:* RTL: a simulated level-advance/open/elimination event fires the
    sound trigger once (spy) and shows a toast; no trigger on a pure tick. Manual: audible in verify-ui.

14. **`supabase/migrations/0016_gallery.sql` + `gallery` Storage bucket + `src/routes/Galeria.tsx` (new)** —
    `gallery_photo` table (tournament_id, uploader, storage path, created_at) + a `gallery` bucket with
    RLS (any authed league player uploads; admin deletes; SELECT for league members). Per-fecha photo
    grid, lazy-loaded. — *verify:* integration: upload row + RLS (non-member can't read; non-admin can't
    delete others'); RTL: grid renders, lazy-load attribute present.

15. **`0016_gallery.sql` (same migration) + `src/routes/Fechas.tsx`/history list** — tournament history
    full-bleed cover cards: add `tournament.cover_url`; the history/past-fechas list renders full-bleed
    cover cards (fallback to a themed gradient when no cover). Admin sets the cover from the fecha view.
    — *verify:* RTL: card renders full-bleed with cover; gradient fallback when null. verify-ui visual.

## Backend contract additions (design was skipped — contract captured here)
- `season`: partial unique index on `status='active'`.
- `tournament`: `+ payout_distribution jsonb`, `+ counts_for_league bool default true`, `+ cover_url text`.
- `gallery_photo`: `id, tournament_id fk, uploader_id fk, storage_path text, created_at` + `gallery` bucket.
- RPCs touched: `close_season` (atomic), `create_tournament` (seed distribution + counts_for_league),
  `set_prizes` (read per-fecha distribution), elimination RPCs (multi-bust ordering + tie split),
  points/leaderboard aggregation (exclude standalone). No new endpoints for odds calc / sound (client-only).

## Tests to add or update
- Integration (isolated + serial): season single-active + index + duplicate-repair; roster-at-0;
  per-fecha distribution + variable places + backfill; multi-bust ordered + tie-split + chop compose;
  standalone-fecha zero-league-points; gallery upload + RLS.
- FE (RTL): seasons list ordering + routing; prize editor (add/remove/sum); copy/currency; Calculadora
  fill/clear/duplicate + result plumb; HandRankings order + 3-theme render; sound mute-persist + trigger
  spies; gallery grid + lazy-load; history cover card + fallback.
- Poker engine (unit): known-equity fixtures (AA vs KK, coin-flips), evaluator ranking correctness,
  exact enumeration on the river.

## Risks & unknowns
- **PR #1 not merged.** Phase 2 needs all Phase-1 code. Recommend merging PR #1 to `main` before build;
  otherwise Phase 2 stacks on the Phase-1 branch and grows that PR. Decide at `/dh:run` start.
- **Diff size.** Full Phase 2 (2 tracks, 3 migrations, ~15 slices) will exceed `/dh:review-loop`'s
  ~1000-line single-PR gate. Plan to run `/dh:run --steps` in chunks (e.g. Track A, then Track B) and
  review-loop per track / per feature, OR ship as stacked PRs. Not a blocker to planning.
- **Shared migration files couple steps** — 0014 (steps 1–2), 0015 (steps 4/6/7), 0016 (steps 14–15).
  Steps sharing a file must land together, in order (6 and 7 assume step 4 created 0015 with the new
  columns). When chunking `/dh:run --steps`, split **per-migration, sequential** — never dispatch
  same-file steps to independent parallel agents expecting separate files.
- **Track B skipped design/grill** (owner directive). Card-picker layout, Web-Audio synth cues, gallery
  scope, and learning content are in-plan decisions — must pass `/dh:verify-ui` before ship; expect
  visual iteration. If the odds-calc UX needs rework, it re-enters via `/dh:design`.
- **Monte-Carlo accuracy vs. speed.** Iteration count trades accuracy for latency; fix a default
  (e.g. 50k samples) and cap; enumerate exactly when unknowns are few (turn/river). Worker prevents jank.
- **Notification API permissions** vary by browser/PWA install state; degrade gracefully to toasts.
- **Multi-bust tie-split** reuses chop logic — must compose with a real final-table chop later (tested).
- **close_season index migration** must repair any current >1-active data before creating the index.

## Out of scope (Phase 3)
- Server/web push notifications; PWA full offline; i18n/English toggle.
- Live per-hand chip tracking (fichas stays buy-in chips); desktop (non-mobile) layout.
- Payment processing (buy-ins stay cash + admin confirmation).
- Specific-opponent-hands mode in the odds calc beyond "# de rivales" (random opponents) — add later if wanted.
