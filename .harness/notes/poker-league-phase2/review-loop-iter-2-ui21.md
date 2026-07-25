# Review iter 2 — poker-league-phase2 (UI-refinement batch 2.1, re-review of fix 5e55d27)
Diff under review: `git show 5e55d27` — 5 files, +56/-23 (code: admin.ts, admin.test.ts, CreateFecha.tsx; doc: 0018 header, followups.md)
Verdict: CLEAN — iter-1 required finding RESOLVED, no regression, no new required/critical.

Gate run: `npx vitest run src/lib/admin.test.ts` → 19 passed (incl. the new tie case). (Full suite not re-run; change is localized to a pure fn + a doc comment + a byte-equivalent input-formatter swap.)

## Prior-iteration resolutions verified (iter-1)
- **iter-1 #1 (REQUIRED) — `chopAdjustedPrizes` skipped non-`chopped` tie groups → RESOLVED** at `src/lib/admin.ts:126`.
  The guard is now `if (f.final_position == null || f.chop_group == null) continue` — the `!f.chopped` clause is gone.
  Pooling keys off `chop_group` + `final_position` for ANY finisher, so a `chopped=false` group at paid places 2º/3º is
  pooled and each member renders `tieSplitMoneyEach = round(Σ amounts / K)` instead of the full template amount. Directly
  satisfies decision 2026-07-24 (A) "split points + money equally." The wired path (`FechaDetail.tsx:330`
  `chopAdjustedPrizes(prizes, entries)`) now benefits — `tieSplitMoneyEach` finally has a live caller for the tie branch.

- **No champion-chop regression — CONFIRMED.** Final-table choppers carry `chopped=true` AND `chop_group`. Under the OLD
  guard `!f.chopped` was `false` → not skipped → pooled. Under the NEW guard they still have non-null final_position +
  chop_group → still pooled. Same code path, same `tieSplitMoneyEach` split. The existing `chopped:true` test
  (`admin.test.ts:107-117`, 1º+2º pool → 65k each) still passes unchanged, and the independent-group `chopped:true` case
  (`admin.test.ts:135-145`) still passes. Champion / co-champion money is byte-for-byte identical to before.

- **New test is real, not a stub — CONFIRMED** (`admin.test.ts:119-133`). Asserts a `chopped:false` group sharing
  `chop_group:3` at positions 2/3 pays each `round((50k+30k)/2)=40k`, AND that the non-tied 1º is unaffected at 80k
  (template). Both a positive (split applied) and a negative (untouched place) assertion — pins the exact contract the
  iter-1 finding named. Would fail against the pre-fix code (old guard would leave 2º=50k/3º=30k).

- **iter-1 Consider (fmtMoney dup) — also RESOLVED** (bonus). `CreateFecha.tsx` drops its local `fmtMoney` and imports the
  shared `formatMiles` (`src/lib/format.ts:12`). Behavior-equivalent for these inputs: money state is produced by
  `parseMoney` (integer), so `formatMiles`'s extra `Math.round` is a no-op; same grouping regex. Strictly safer, one helper.

## New findings (this diff)
- **Optional/FYI:** `src/lib/admin.ts:135` (via `tieSplitMoneyEach`) — a tie group that STRADDLES the pay line (e.g. a
  dead-even bust taking positions 3 & 4 when only top-3 pays) pools `(30k + 0)/2 = 15k` each. The paid row (pos 3) then
  correctly shows the per-head 15k, but the unpaid tied member (pos 4) also receives 15k with NO row in the per-place
  Premios list — so the visible Premios total (15k) understates the disbursed-to-tied total (30k). This is inherent to a
  per-paid-place list, is arguably MORE correct than pre-fix (which showed pos 3 = full 30k), and is not introduced by this
  change. Untested edge. If product wants the split visible, surface tied unpaid members explicitly. Not a blocker.
- **FYI (pre-existing, shared with `chopPreview`):** `round(Σ/K)` per head is not exact for indivisible pools
  (e.g. 3-way 140k → 46 667 ×3 = 140 001, +1 colón vs pooled). Rounding is sane and consistent with the chop-preview path;
  no change here. Money conservation for the primary fix case (2-way, 80k → 40k+40k) is exact.
- No other behavior changed: `admin.ts` diff is the single guard line + comments; `tieSplitMoneyEach` untouched; the 0018
  edit and followups.md edit are documentation only. A finisher with `chop_group` but an unpaid `final_position` maps to no
  prize row (position absent from `prizes`) → no phantom rows, paid places unaffected (`tieSplitMoneyEach` unpaid-split-₡0
  case tested at `admin.test.ts:76-79`).

## Axes checked
correctness ✓ (iter-1 gap closed, champion path preserved, new test pins the tie contract) ·
readability ✓ (dedup to `formatMiles`; comment now explains the chopped-agnostic pooling) ·
architecture ✓ (no new abstraction; `tieSplitMoneyEach` now correctly wired) ·
security ✓ (touches-sensitive: no — pure display fn + input formatter, no auth/query/IO change) ·
performance ✓ (same O(finishers) map build; no new query/loop)
