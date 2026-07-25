# Review iter 1 — poker-league-phase2 (UI-refinement batch 2.1)
Diff: d012827..HEAD, 31 code+test+SQL files (of 62 incl. .harness/ui-verify), +1827/-117
Verdict: FINDINGS

Gates run locally: `npm run build` ✓ · `npm test` ✓ (349 passed / 1 integration skipped, no service key) ·
`npm run lint` ✓ (only pre-existing `unicorn/no-thenable` warnings in test supabase mocks).

## Findings

### Correctness
- **`src/lib/admin.ts:114` — `chopAdjustedPrizes` skips non-`chopped` tie groups → wrong Premios money after a dead-even multi-bust.**
  The guard `if (!f.chopped || … || f.chop_group == null) continue` only pools **final-table chops** (`chopped=true`).
  A **dead-even mid-field tie** (`eliminate_multi(p_tied=true)`, mig 0015) sets `chop_group` but leaves `chopped=false`
  by design (the anti-mislabel "TRAP", decision 2026-07-24 #3). That path IS reachable from the FE (`src/routes/Admin.tsx:725`
  calls `eliminate_multi` with `p_tied`), and a tie can occupy **paid** positions — e.g. 3 alive, 2 tie → positions 2 & 3,
  survivor crowned 1º (0015 assigns `v_alive_incl-(ord-1)`). On the completed FechaDetail, `chopAdjustedPrizes` then leaves
  2º and 3º at their **full template** amounts instead of each showing `round((amount₂+amount₃)/2)`. This contradicts decision
  2026-07-24 (A) "share points+money equally" — points split correctly (via `chop_group` in `fn_tournament_points`), but the
  **money display over-states each tied player's payout**. `tieSplitMoneyEach` was built exactly for this (its own doc says
  "the tied players (who share a chop_group) all render this same amount") yet nothing wires it in — its only caller is
  `chopAdjustedPrizes`, which filters ties out. Fix: pool by `chop_group` regardless of `chopped` — change the guard to
  `if (f.final_position == null || f.chop_group == null) continue`. Safe for final-table chops (they also carry `chop_group`).
  Add a `chopAdjustedPrizes` test case with `chopped:false, chop_group:N` at paid positions (currently only `chopped:true`
  cases exist — admin.test.ts:107-129 — so the tie branch is untested; the test set is a proper subset of the contract's
  `{final-table chop, dead-even tie}` input set).

### Readability / Architecture
- Consider: `src/routes/admin/CreateFecha.tsx:87` — `fmtMoney` is a byte-identical re-implementation of
  `formatMiles` (`src/lib/format.ts:12`, added in this same batch: same `String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')`).
  `formatMiles` even rounds (`Math.round`) which is strictly safer. Import `formatMiles` instead of the local copy so the
  fecha inputs and the Live scoreboard/FechaDetail share one grouping function. Emphasis asked "formatMiles used consistently?" —
  it's used in Live.tsx + FechaDetail.tsx but CreateFecha forks its own.
- Optional: `src/routes/admin/CreateFecha.tsx:120,388` — the "Bonus stack" and "Máx recompras por jugador" inputs are
  captured, editable, and persisted to the `pf-fecha-defaults` localStorage bag, but **never submitted** to `create_tournament`
  (payload at :210-222 omits them; there's no `bonus_stack`/`max_rebuys` tournament column — confirmed in database.types.ts and
  documented at :38-42). So editing them has zero effect on the created fecha. Documented as intentional, but the UX presents
  them as fecha settings. Consider a hint that they're saved defaults only, or defer the fields until a column exists.

### Positives verified (not findings)
- `PrizeList` (src/components/PrizeList.tsx) is correctly shared: Live.tsx dropped its local `Premios` fn and both surfaces
  now render one component (Live = `colonesCompact`, FechaDetail = `₡{formatMiles}` via `formatAmount`). No duplicate variant.
- `pointsExample` (fechas.ts:259) matches §5: base `(N−P)×mult` + top3(P≤3) + mesa-final + asistencia; the info-card worked
  example renders real numbers (10 players, 3º → 70+8+5+2 = 85) and FechaDetail.test.tsx:143 asserts "85 pts". Penalty term is
  correctly excluded from a finisher's example (shown only in "Bonos de esta fecha"). Winner base `(N−1)×mult` correct.
- Completed-fecha place/points/medals (FechaDetail.tsx:740-799): chopped co-champions share `1º` (place forced to 1, champ
  accent, no runner-up medal); 2º silver / 3º bronze / 4º+ none; no-show shows "No Show" + signed penalty. Well tested
  (FechaDetail.test.tsx:248-368).
- CreateFecha money inputs (d): `parseMoney` strips non-digits → raw integer in state; submit sends the **integer**
  (`buy_in: buyIn`, not the formatted string). rebuy/stack `=== 0 ? null` handling sane.
- Calculadora gate (e): one-shot mount query `status=live AND odds_enabled=false`, `.limit(1).maybeSingle()` (limit(1)
  avoids the multi-row maybeSingle error), **fail-open** to `enabled` on any error. Both states tested
  (Calculadora.test.tsx:158-178). `'loading'` never flashes the disabled panel.
- FormPills (f): `form`+`positions` zipped BEFORE `.reverse()` so tier/number pairing survives newest-on-right; RPC arrays
  not mutated. Aligned by construction in mig 0018 (`array_agg(... order by rn)` from the same CTE). Tested end-to-end.

### Security (touches-sensitive: YES)
- FYI: the new direct client writes — `ScheduleEditor` `.update({scheduled_at})` (FechaDetail.tsx:485), Admin console
  `.update({odds_enabled})` (Admin.tsx), CreateFecha `.update({counts_for_league, odds_enabled, payout_distribution})` —
  all ride the **admin-only** tournament UPDATE policy from mig 0017 (`using/with check auth_is_admin()`, row-level so every
  column incl. scheduled_at/odds_enabled is covered). Verified 0017 dropped the prior admin-OR-owner policy. No non-admin write
  path. CoverControl uploads to the `gallery` bucket under the admin's own player-id folder (RLS-matching). Route to the
  dedicated security lens for the storage-bucket RLS depth, but nothing obvious is exposed.

### Performance
- Calculadora gate is a single indexed one-shot query on mount — not a hot path, no N+1. Equity compute is debounced (250ms)
  and off-thread (worker). No new list endpoints/loops. FYI: `dist` main chunk is 593 kB (pre-existing chunk-size warning,
  not introduced here).

### Cosmetic (author's discretion)
- Consider: `src/components/FormPills.tsx:67` + mig 0018 (`f.final_position as pos`) — a final-table **chopped co-champion**
  has `final_position` 2..K (distinct, via `WITH ORDINALITY`, 0009:708), so the leaderboard form pill renders a **gold
  "champion" pill showing "2"** while FechaDetail normalizes every co-champion to `1º`. Minor inconsistency; the number is
  their true ordinality but reads oddly next to the "co-champions share 1º" treatment. points.test.ts:237 asserts the tier
  (`['champion']`) but not `form_positions` for choppers, so this isn't pinned. If you want consistency, emit `1` for chopped
  rows (or drop the number on champion-tier chops).
- Nit: `src/routes/Live.tsx:461` — the `Pendiente Pago` badge renders on **every** unpaid StandingRow, including
  eliminated/out (and an unpaid winner) rows, not just alive players. Probably fine (the pot still needs their cash), but if
  the intent is "who still owes at the table", gate it on `alive`.
- FYI: mig 0018 `drop function … leaderboard(uuid)` + recreate is the only way to widen the return TABLE; `odds_enabled`
  added `not null default true` (backfills existing rows). Grants re-asserted. No dependent objects claimed. Data-migration
  lens owns the deep pass.

## Axes checked
correctness ✗ (tie-money display gap) · readability ✓ (minor dup) · architecture ✓ (PrizeList shared cleanly) ·
security ✓ (touches-sensitive: yes — tournament UPDATE + storage; admin-RLS via 0017 verified) · performance ✓
