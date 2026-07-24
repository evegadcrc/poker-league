# Review iter 3 — poker-league-prototype (FE focused re-review: auto-advance exactly-once)
Diff: fix commit `e8d46bf` over iter-2 baseline (`caa1c92`). Focused scope: `src/routes/Admin.tsx`
auto-advance `useEffect` (+ refs `autoAdvancedLevel`, `autoAttemptAt`, `doClock`) and the
`Admin.test.tsx` "auto-advance (single-writer clock)" describe block (in-flight test + `rpcImpl`).
Verdict: **CLEAN — APPROVE** (prior required finding RESOLVED; no new Critical/required).

Gates run: `vitest run Admin.test.tsx -t auto-advance` → 5/5 pass (3.4s, real timers).
Non-tautology proof: ran the NEW in-flight test against pre-fix `Admin.tsx` (caa1c92) in an isolated
git worktree → it FAILS `expected 3 to be 1` (fired 3× across ticks). Confirms the test pins the
exact regression. Working tree restored clean afterward.

## Prior-iteration resolution verified

- **iter-2 [required] "auto-advance double-fires next_level when the clock RPC round-trip exceeds the
  1s tick" (iter-2-fe.md → New findings #Admin.tsx:316-330) — RESOLVED.**
  `Admin.tsx:328` now latches `autoAdvancedLevel.current = tournament.current_level` BEFORE the
  `await` (line 329-332), and `:331` releases it to `null` ONLY on failure (`if (!ok)`). This is
  exactly the fix the iter-2 reviewer prescribed. Traced against the current code:
  - **In-flight across ticks:** T0 fires + latches N. Each subsequent 1s `now` tick re-runs the
    effect, but `:321 autoAdvancedLevel.current === tournament.current_level` (N) → early return →
    no second fire while the RPC is pending. Closed.
  - **Success + slow/absent realtime advance:** on `ok`, latch stays N (`:331` only clears on
    failure). Even if `current_level` is still N in state (realtime lag), `:321` blocks re-fire.
    When state later advances to N+1, `remaining > 0` (`:320`) for the fresh level blocks a
    premature fire; the latch (N) not matching N+1 is harmless. Fires N+1 only when it truly hits 0.
  - **Failure → retry (stall fix preserved):** `!ok` clears the latch to `null`; the `autoAttemptAt`
    per-tick throttle (`:322-323`) means the NEXT distinct `now` tick re-fires — ≤1 attempt/tick, no
    permanent 00:00 stall, no tight reconcile loop. The earlier stall fix is intact.
  - **Pause mid-flight:** `:319 is_paused` guard returns early on the pause tick; the latch persists;
    on resume the level has advanced (success) so `remaining > 0` blocks. No spurious fire.

## Interleaving analysis — can next_level still fire twice for one level?

No new interleaving fires twice under normal operation. The one residual is pre-existing and out of
scope (see FYI below): a *response-path* failure (server advanced but the client's response errored)
clears the latch and the retry advances again → one skipped level. This existed identically in the
iter-1/iter-2 stall fix (caa1c92 already retried on failure of a non-idempotent RPC); the
latch-before-await change does not introduce or worsen it — it strictly improves the request-pending
case (was multi-fire, now single). Fundamentally unfixable without server-side dedup/idempotency.

## New-regression scan (latch-before-await)

- Does latching before the await ever WRONGLY suppress a legitimate advance? **No.** The latch is
  released on every failure (`:331`), and on success it correctly blocks only the level just
  advanced. There is no code path where a level that has NOT been successfully advanced remains
  latched: latch is set to N and either (a) stays only when `doClock` returned `ok` (level advanced),
  or (b) is cleared to null on failure. No stall reintroduced.
- Unmount mid-flight: the async IIFE resolves after unmount and writes `autoAdvancedLevel.current`
  (a ref — harmless) and `doClock` runs `setBusy(false)` + `void load()` (→ `setState`) post-unmount.
  React 18 no-ops such updates without warning, and this behavior predates the latch change (it lives
  in `doClock`, untouched here). Not a regression. (FYI only.)

## Test quality (Admin.test.tsx:294-310)

- **Genuinely exercises a pending promise across real ticks.** No `vi.useFakeTimers` anywhere
  (`src/test/setup.ts` installs only a MemoryStorage; no timer faking). `h.rpcImpl.clock`
  (`:300-303`) returns a promise that resolves ONLY when the test calls `resolveClock`, so it stays
  in flight through the real `setTimeout(2200)` (`:306`) while Admin's real `setInterval(1000)`
  (`Admin.tsx:230`) bumps `now` ~2×. Asserts `nextLevelCalls() === 1` after the ticks (`:307`).
- **Also pins "success + no realtime advance".** The mock fixture never advances `current_level`
  (stays 1). After `resolveClock({error:null})` (`:308`), `doClock`'s `void load()` refetches the
  still-expired level-1 tournament and the effect re-runs — the final `waitFor(toBe(1))` (`:309`)
  proves the success-latch persists as the sole guard. Strong, non-tautological.
- **Proven to fail against pre-fix code** (worktree run: 3 ≠ 1). Not a rubber stamp.

## Findings

- Optional: **Admin.test.tsx:294-310** — the in-flight test only covers the SUCCESS branch of the
  latch (stays latched). The "in-flight FAILURE then release + retry" path is covered only by the
  synchronous-error test at `:282-292` (resolves immediately, no cross-tick pending). Consider a
  deferred-failure variant: keep the RPC pending, resolve with `{error}`, then assert a retry fires
  on a later tick — this would pin the `:331 if (!ok) ... = null` release under real in-flight timing.
- FYI: **Admin.tsx:280-292 / 316-333** — non-idempotent `next_level` + retry-on-failure means an
  ambiguous response failure (server committed, client saw error) can still skip one level. Recovery
  is the admin `prev_level`. Pre-existing, not introduced by this diff; noted for the record.
- FYI: **Admin.tsx:329-332** — the async IIFE + `doClock` may `setState` after unmount if the RPC is
  in flight at teardown; React 18 silently no-ops. Pre-existing to `doClock`. No action.

## Axes checked
correctness ✓ (exactly-once verified across in-flight / success-slow-realtime / failure-retry /
pause / unmount; test proven non-tautological by pre-fix worktree run) · readability ✓ (clear intent
comments at :324-327; refs documented at :213-218) · architecture ✓ (single-writer latch pattern
unchanged, minimal surface) · security ✓ — touches-sensitive: NO (no auth/input/secrets/URL/dep
change in scope) · performance ✓ (guard-bailed `now`-dep re-runs; single interval; no new fetch).

## Verdict
**APPROVE.** The iter-2 required double-fire regression is resolved in the committed code exactly as
prescribed (latch before await, release on failure); no new Critical/required. Remaining items are
one Optional test-coverage suggestion and two FYIs.
