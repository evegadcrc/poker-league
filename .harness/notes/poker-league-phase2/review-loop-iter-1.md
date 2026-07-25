# Review iter 1 — poker-league-phase2 (Track A)
Diff: main...84b4222, 29 files, +2861/-93
Verdict: FINDINGS

Scope reviewed: Track A steps 1–8 (migrations 0014–0015 + FE). Track B (steps 9–15)
is not in this diff. Cross-referenced against plan, decisions.md (2026-07-24 A–E),
and the prototype lessons (flaky integration test + 3 Phase-1 RLS escalations).

## Headline assessment
High-quality slice. The two things the dispatch flagged are both correct:
- **Co-champion trap (step 6):** the dead-even tie path sets `chop_group` + distinct
  `final_position` ONLY, and leaves `chopped`/`status='winner'` FALSE with
  `made_final_table` re-derived from state (0015:390-435). Verified against the
  leaderboard champion/win keys (`final_position=1 OR chopped`, 0003/0014:180-184) and
  covered by three integration tests (mid-field tie NOT champion; ordered; composes
  with a later real chop). Trap avoided.
- **close_season single-active invariant (step 1):** genuinely enforced — repair-all
  (0014:33-42) → partial unique index (0014:50-52) → `close_season` now archives ALL
  active rows before the insert (0014:89), not `order by year desc limit 1`. Tested:
  exactly-one-active after close, second-active insert rejected (23505), roster-at-0.

## Findings

- **src/routes/Admin.tsx:561,1131-1141 + supabase/migrations/0015_fecha_prizes_bust_standalone.sql:390-418**
  — `MultiBustSheet` lets the admin select the ENTIRE in-play field (buttons enable at
  `k >= 2`, with no upper bound vs `inPlay.length`). Two broken cases result:
  (a) **TIE mode with k == in-play count** (e.g. heads-up both all-in dead even): the SQL
  assigns distinct positions 1..N with a shared `chop_group` but `chopped=false` /
  `status='eliminated'` (the winner-crown branch `v_alive_incl - v_n = 1` is skipped when
  the field is emptied). Points are averaged equal and money splits equal, BUT the
  leaderboard counts ONLY the pos-1 player as a win/champion (`final_position=1`) — the
  co-tied player gets `podium`, not `champion`. Asymmetric result for a symmetric input,
  contradicting decisions.md (A) "share points+money equally"; and no `winner` row exists.
  (b) **ORDERED mode with all selected**: sequential `fn_eliminate_entry` crowns the last
  survivor `winner`, then the final loop iteration calls `fn_eliminate_entry` on that now-
  'winner' row → raises 'no está en juego' → whole tx rolls back with a generic error toast.
  Fix: gate both buttons to require ≥1 survivor — disable when `k >= inPlay.length`. A genuine
  final-table / heads-up chop must go through Complete + chop (`complete_tournament`), which
  is the path that legitimately sets co-champion flags. This keeps `eliminate_multi` strictly
  mid-field, exactly as plan step 6 scopes it.

- Optional: **supabase/migrations/0015_...sql:357-382** (`eliminate_multi`) — no distinct/dedup
  guard on `p_entry_ids`. A duplicated id (reachable only by a direct authenticated API call —
  the FE builds ids from a `Set`) makes `v_n = array_length` overcount vs the distinct rows
  actually updated, mis-deriving the winner-crown test and positions. Admin-gated + FE-safe →
  low severity. Consider `array_agg(distinct …)` or an explicit guard.

- Optional: **src/routes/admin/CreateFecha.tsx:138-150** — `counts_for_league` and the edited
  distribution are persisted in a SECOND, non-transactional `.update()` after
  `create_tournament`. On failure (comment: "non-blocking") the fecha silently counts for the
  league and keeps the turnout-seeded distribution, and there is NO live-admin UI to toggle
  `counts_for_league` afterward (only prizes are live-editable via `EditPrizesSheet`). Consider
  a failure toast, or exposing the standalone toggle in the live console.

- Nit: **src/lib/live.ts:134-143** (`proposedPrizes`) — clamps the 1st-place absorber with
  `Math.max(0, …)`, so in a tiny-pot edge (rounded lower places exceed the pot) the PREVIEW
  won't sum to the pot, unlike the SQL `set_prizes` absorber (exact remainder, may go negative).
  Display-only preview; harmless divergence.

- FYI: **supabase/migrations/0015_...sql:225-235,245-285** (`set_prizes`) — pcts are read
  ordered by `place` but assigned to sequential positions `1..v_k`; a non-contiguous
  `payout_distribution` (e.g. places [1,3]) would silently remap place 3 → position 2. Every
  current writer produces contiguous places (editor `place=index+1`, `create_tournament`
  ordinality, backfill ordinality), so not reachable today — noting for any future writer.

- FYI: **src/lib/admin_crud.integration.test.ts** — the migration REPAIR path (0014:33-42,
  archive-all-but-newest on pre-existing >1-active) is NOT auto-exercised: duplicates can't be
  injected once the partial unique index exists (test (c) acknowledges this). The repair only
  runs at migration-apply time over the seed; the coverage gap is inherent. Plan step 1's
  "repair path" verify bullet is therefore manual-only. Not a defect.

- FYI (security, pre-existing / out of scope): the FE direct `.update()` of
  `payout_distribution` / `counts_for_league` (Admin.tsx `saveDistribution`, CreateFecha) is
  governed by RLS "admin update tournament" (0001:215) = `auth_is_admin() OR created_by = self`.
  Only admins can create fechas, so `created_by` is always an admin → no non-admin write path is
  introduced. Note RLS cannot restrict COLUMNS, so any admin/creator `.update()` could also touch
  `buy_in` / `prize_pool_override`; acceptable since admins are trusted, but the new FE write
  pattern leans on that trust (this policy predates the diff).

## Prior-iteration resolutions verified
N/A (iteration 1).

## Prior-lessons check
- Flaky-integration-test lesson: HONORED. New integration suites use throwaway seasons, the
  archive-active-then-restore dance for the single-active slot (fecha_prizes + admin_crud),
  unique `RUN` ids, `afterAll` teardown, and rely on serial `fileParallelism:false`. No new
  global-state mutation without restore.
- Phase-1 RLS privilege-escalation lessons (×3): NOT re-introduced. All new/modified DEFINER
  functions (`close_season`, `create_tournament`, `set_prizes`, `eliminate_multi`, `leaderboard`)
  gate admin (`auth_is_admin() or service_role`, or `fn_is_tournament_admin`) and
  `revoke all from public, anon` + `grant execute to authenticated, service_role`.

## Contract-pinning check (tests)
- Per-fecha prizes: full set covered — per-fecha-drives, variable place count (5 places),
  null→template fallback, backfill-equivalence, manual-override-wins, create_tournament scaling
  (small floored to min 3, large capped to template length, renormalized). Good.
- Multi-bust: ordered (shortest→worst, no chop_group), mid-field tie (chop_group set, NOT
  champion, wins=0/podiums=0/form='out', money split equal), tie composes with later real chop.
  Missing: the k==in-play (field-emptying) tie case — see required finding above.
- Standalone fecha: league vs standalone in same season, same players — per-fecha points
  identical, season aggregation excludes standalone. Good.
- FE: Seasons active-first + newest-year + routing + empty; PrizeDistributionEditor
  add/remove/sum-validation across the set; tieSplitMoneyEach unit (2-way/3-way/unpaid/empty).

## Security-sensitive areas (route to security pass)
YES — this diff touches: (1) RLS-governed FE writes to `tournament` (payout_distribution,
counts_for_league); (2) money-handling DEFINER RPCs (`set_prizes`, `create_tournament`);
(3) a NEW authenticated-callable elimination RPC (`eliminate_multi`). No auth/crypto/secrets,
file upload/serving, user-supplied URLs (no SSRF surface), or new third-party deps.
Recommend the security pass confirm `eliminate_multi`'s admin gate and the RLS column-scope note.

## Performance
No hot-path regression. `leaderboard` adds one correlated NOT-EXISTS in the roster UNION (once
per call, season-scoped) — negligible at friends-league scale. `eliminate_multi` does a few
tournament-scoped full updates (bounded by field size, ~tens), same pattern as `fn_eliminate_entry`.
No N+1, no unpaginated list endpoint, no render-heavy addition. No deeper `performance` lens needed.

## Axes checked
correctness ✓ (1 required edge-case) · readability ✓ · architecture ✓ (matches DEFINER-RPC + RLS
pattern) · security ✓ (touches-sensitive: yes — RLS writes + money/elimination DEFINER RPCs) ·
performance ✓
