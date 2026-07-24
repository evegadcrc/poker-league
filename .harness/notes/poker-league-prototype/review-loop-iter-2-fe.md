# Review iter 2 — poker-league-prototype (FE re-review: auth/core + presentational)
Diff: fix commit `caa1c92` (FE) over iter-1 baseline; backend fixes in `d143475`.
Scope: `src/routes/{Profile,Live,Admin,Fechas,Leaderboard,Login}.tsx`, `src/lib/useLoadable.ts`,
`src/routes/FechaDetail.tsx`, `src/App.css`, deleted `ScreenPlaceholder.tsx`, and changed/new tests.
Verdict: FINDINGS (1 new required regression; all prior Critical/required FE findings resolved)

Gates run: `vitest run` on the 6 affected files → 61/61 pass. `tsc -b --noEmit` → clean.

## Prior-iteration resolutions verified

### FE-core (review-loop-iter-1-fe-core.md)
- **[required] Live.tsx self_bust failure (iter-1 #Live:196-215)** — RESOLVED.
  `Live.tsx:112` adds `bustError` state; `:215-222` on RPC error sets `bustError`, `void load()`
  (rolls the optimistic drop back to server truth), and `return`s BEFORE `setReportedPosition`, so
  no false "reportado". `:319-334` renders the error note (`data-testid="bust-error"`) + keeps the
  report button (button visibility derives from reconciled `myEntry.status`). Test added
  (`Live.test.tsx:296-312`): asserts no `bust-reported`, `bust-error` shown, button remains. Good.
- **[required] useLoadable silent refetch + FechaDetail flicker (iter-1 #useLoadable:33)** —
  RESOLVED. `useLoadable.ts:12` `ReloadOptions{silent}`; `:36-40` a `silentNext` ref is set by
  `reload({silent:true})` and `:45-47` the effect reads+clears it, skipping the `loading` flip ONLY
  on that next run. First mount and real `deps` changes stay loud (silentNext defaults false).
  Abort guard (`active`, `:44/:49/:51-53`) preserved. FechaDetail rsvp/cancel/check-in/admin-check-in
  all switched to `reload({ silent: true })` (`:179,190,225,233`) → optimistic patch + celebration
  no longer wiped by a skeleton flash. Signature change didn't break callers (all `onClick={reload}`
  converted to `() => reload()`; `tsc` clean). Good.
- **[required] Admin auto-advance stall (iter-1 #Admin:271-290)** — PARTIAL. The permanent-stall is
  fixed (guard now latches on success only + retries), BUT the fix introduces a NEW regression —
  see "New findings → Admin auto-advance double-fire" below.
- **[required test gap] Admin auto-advance FE contract (iter-1 #Admin.test:73)** — RESOLVED.
  `Admin.test.tsx:232-289` adds a real-fixture suite (`setAutoExpired` via `setLive`, never dodges
  via manual mode): fires-once, paused-no-fire, manual-no-fire, and failed-retry-on-next-tick. Non-
  tautological. NB: none of these exercise a slow (>1s) successful RPC, which is exactly the window
  the new regression lives in — the tests pass because the mocked RPC resolves synchronously.
- **[required test gap] Live self_bust failure branch (iter-1 #Live.test:273)** — RESOLVED
  (per-RPC `rpcErrors` override + failure assertions, `Live.test.tsx:296-312`).
- **[required] statusPill full-enum (iter-1 #fechas.test:73)** — RESOLVED. `fechas.test.ts:73-91`
  now table-tests all 8 states as a `Record<EntryStatus,…>`. Good.
- **[security question] `is_admin` self-write RLS (iter-1 Critical)** — addressed backend-side in
  `d143475` (migration 0012 drops the player self-UPDATE policy; `update_own_profile` is now the only
  player write and cannot touch `is_admin`/`email`/`auth_user_id`). Out of FE lens to fully verify;
  the FE change below is consistent with it.

### FE-presentational (review-loop-iter-1-fe-ui.md)
- **[required] Profile avatar via RPC, not direct table write (implied by 0012)** — RESOLVED.
  `Profile.tsx:107-110` now calls `supabase.rpc('update_own_profile', { p_name: player.name,
  p_avatar_url: bustedUrl })`. Signature matches migration `0012_security_hardening.sql:43-46`
  (`update_own_profile(p_name text, p_avatar_url text)`) and `database.types.ts:930-931`
  (`Args: { p_avatar_url?; p_name? }`). Named args → order-independent; resending current name is a
  no-op under the RPC's `coalesce`. Success still patches auth context (`updatePlayer`, `:117`).
  Test rewritten (`Profile.test.tsx`): the `from()` table-write mock was REMOVED, so a regression to
  a direct write would throw; asserts the RPC name + `p_name`/`p_avatar_url`; adds a save-error case.
  Good.
- **[required] Fechas sorted by raw `scheduled_at` (iter-1 #Fechas:93)** — RESOLVED. `FechaCard`
  gains `scheduledAt` (raw ISO, `Fechas.tsx:43`); `buildCards` sets it (`:84`) and the tie-break sort
  now compares `a.scheduledAt.localeCompare(b.scheduledAt)` (`:100-103`) — ISO-8601 sorts
  lexicographically == chronologically. Multi-scheduled test added (`Fechas.test.tsx:118-155`:
  Aug 7 before Aug 23, the exact display-string bug). Good.
- **[required test] Login.test.tsx (iter-1 #Login)** — RESOLVED. New file, 5 states: idle,
  sent(+resend re-fires `signInWithOtp`), error(+Reintentar→idle), unbound no-player, unbound other.
  Non-tautological. Login.tsx also refactored (`sendLink` extracted) + adds the resend affordance
  (`:110-116`) the spec asked for. Good.
- **[required] dead ScreenPlaceholder removed (iter-1 #ScreenPlaceholder)** — RESOLVED. File deleted;
  grep for `ScreenPlaceholder` across `src/` is clean.
- **[required a11y] `.icon-btn` ≥44px (iter-1 #App.css:71)** — RESOLVED. `App.css:72-73` 38→44px.

## New findings

- **Admin.tsx:316-330 (auto-advance) — the stall fix introduces a level-skip double-fire when the
  `clock` RPC round-trip exceeds the 1s tick.** The level latch (`autoAdvancedLevel`) is now set only
  AFTER the awaited RPC resolves (`:328`); the only in-flight guard is the per-tick throttle
  `autoAttemptAt.current === now` (`:322`). `now` is bumped every second by the interval and is a dep
  of this effect (`:330`), so if a single `next_level` RPC takes longer than one tick: T0 fires it
  (in flight, unlatched); at T1 the effect re-runs, `state`/`remaining` are still level-N/0 (refetch
  not landed), the latch is still null, and `autoAttemptAt(T0) !== now(T1)` → it fires a SECOND
  `next_level`. `next_level` is increment-based (`0009_admin.sql:167` `v_new_level := v_cur + 1`), NOT
  idempotent, so the tournament advances two levels and skips level N's play. This triggers precisely
  in the slow-network / Kong-502 regime the fix targets (lessons.md "Slice 4"), and violates plan
  step 12's "fire next_level exactly once at 0". Recoverable (admin `prev_level`) and needs >1s
  latency, so required (not Critical), but it should not merge. **Fix:** latch BEFORE the await and
  release on failure, keeping the per-tick throttle:
  ```ts
  if (autoAttemptAt.current === now) return
  autoAttemptAt.current = now
  autoAdvancedLevel.current = tournament.current_level   // latch immediately → no in-flight double-fire
  void (async () => {
    const ok = await doClock('next_level')
    if (!ok) autoAdvancedLevel.current = null            // release → a later tick retries
  })()
  ```
  This keeps the stall fix (release-on-failure retries at ≤1/tick, no tight loop) while closing the
  double-fire window. Add a test that resolves the `clock` mock after a fake-timer tick and asserts
  `next_level` still fires exactly once.

- Optional: **Live.tsx:215-221 (doSelfBust) — double-failure corner.** If `self_bust` fails AND the
  reconcile `load()` also fails, `load` keeps the prior (optimistically `eliminated`) state
  (`:118`), so `canSelfBust` is false → the retry button is hidden and only the `bustError` text
  remains; the player can't re-report until a realtime entry event refetches. Narrow (needs two
  failures); consider reverting the optimistic entry patch inline on the error branch rather than
  relying solely on `load()`.

- Optional: **FechaDetail.tsx:176-179, 187-190 (doRsvp/doCancel) — still no user-facing feedback on
  RPC failure** (only `console.error` + a silent reconcile). Carried over from iter-1 (was Optional);
  the dead `if(error) reload(); else reload()` branch nit IS resolved. Unlike the check-in/self-bust
  paths, a failed RSVP silently reverts with no toast. Consider the Admin console's toast pattern.

- Nit/FYI: **Login.tsx:110-116, 122-128** — the new inline "Reenviar enlace" / "Reintentar"
  `.link-btn` controls are styled (`App.css:240`) but are inline text links inside a sentence, below
  the 44px tap-target bar. WCAG 2.5.5's inline exception applies, so informational only.

## Axes checked
correctness ✗ (new auto-advance double-fire/level-skip) · readability ✓ (dead code gone, branch nit
fixed, clear comments) · architecture ✓ (useLoadable silent mode is a clean additive change; callers
migrated) · security ✓ — touches-sensitive: YES (Profile now routes the only player write through the
`update_own_profile` SECURITY DEFINER RPC; magic-link resend unchanged origin; already routed to the
backend/security pass via 0012) · performance ✓ (small-scale; `now` dep re-runs are guard-bailed).
