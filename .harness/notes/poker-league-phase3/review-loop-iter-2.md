# Review iter 2 — poker-league-phase3 (fresh-context re-review of fix f279dc6)
Fix under review: `f279dc6` (fix(security): revoke anon execute on internal points writers + harden Phase-3 RPCs)
Diff: 17 files, +215/-17. Judged against iter-1 findings (main + security + data-migration lenses).
Verdict: FINDINGS (0 Critical, 0 required — all iter-1 items resolved; 1 Nit + 3 FYI)
Overall: **PHASE 3: APPROVED**

Verification was skeptical + empirical: psql introspection/functional probes against the LIVE-shape
local poker DB (`127.0.0.1:55322`, all in rolled-back txns, no commits), plus independent test runs.

## Prior-iteration resolutions verified (all RESOLVED)

- **iter-1 CRITICAL — `fn_tournament_points` + `recompute_final_table_size` anon/authenticated
  EXECUTE — RESOLVED.**
  - `0019_scoring_v2.sql:203` `revoke all on function public.fn_tournament_points(uuid) from public,
    anon, authenticated;` (+ `grant … to service_role`). `:221` `revoke execute on function
    public.recompute_final_table_size(uuid) from public, anon, authenticated;` (forward-fix for 0005,
    which is shipped and can't be edited in place). Signatures correct `(uuid)`.
  - psql `has_function_privilege` on the running DB: BOTH functions → anon=**f**, authenticated=**f**,
    service_role=**t**. (Introspection-confirmed, not just asserted.)
  - **No legit caller broken.** Every internal caller is `security definer`
    (`open_tournament` 0005:86/0013:46, `complete_tournament` 0009:665/0012:135, `check_in` 0007:46,
    `admin_check_in` 0007:137, `confirm_payment`/`add_rebuy` 0013) → executes as the function owner
    (`postgres`), which retains EXECUTE (verified `has_function_privilege(owner,…)=t`), so the revoke
    can't break the internal chain. FE grep: NO direct `.rpc('fn_tournament_points'|'recompute…')`
    outside tests; the two test callers (`points.test.ts:122`, `open_tournament.test.ts:163`) use the
    **service_role** client → unaffected. `admin.integration.test.ts` drives `complete_tournament`
    end-to-end (which internally invokes both writers) and passes.
  - Regression-guard test added (`security.integration.test.ts:203-221`) — and it is **effective**:
    empirically, `fn_tournament_points`/`recompute_final_table_size` on the test's real live, entry-less
    tournament SUCCEED (error=null) under a leaked grant, so `expect(error).not.toBeNull()` WOULD FAIL
    if the revoke were reverted (proven by granting anon in a rolled-back txn). Covers anon + a real
    authenticated non-admin member, both functions.

- **iter-1 required — cancelled live fecha still treated as live (FIX 2) — RESOLVED.**
  All three (and ONLY three) `status='live'` query sites now carry `.is('cancelled_at', null)`:
  `Live.tsx:72`, `Admin.tsx:437` (fetchConsole → blocks the complete path), `Calculadora.tsx:83`
  (odds-gate). Grep confirms no 4th live-query site was missed. Tests pass for all three
  (`Live.test.tsx` empty-state, `Admin.test.tsx` empty-state/no clock-grid, `Calculadora.test.tsx`
  stays-enabled). Happy path (non-cancelled live) still renders (65 route tests pass).

- **iter-1 required — "Eliminar fecha" offered on completed fechas (FIX 3) — RESOLVED.**
  `FechaDetail.tsx:663` `canDelete = cancelled || status === 'scheduled'`; button gated behind it
  (`:677`). Full contract pinned across all 4 states: scheduled→show (test :140), cancelled→show
  (:182-195), completed→hide (:199-204), live-uncancelled→hide (:208-213). Prop wiring correct
  (`cancelled = tournament.cancelled_at != null` :367 → passed :410).

- **iter-1 required/nit — 0022 policies lack drop-if-exists (FIX 4) — RESOLVED.**
  `0022:57` + `:62` add `drop policy if exists …` before each `create policy`; re-`db push` after a
  mid-file failure no longer wedges. Both policies present in the running DB (pg_policies).

- **iter-1 security required — admin-guard NULL-role fail-open (FIX 5) — RESOLVED (for the 4 new RPCs).**
  `delete_tournament` (0020:44), `add_guest_entry` (0021:172), `approve_request` (0022:136),
  `reject_request` (0022:183) now use `coalesce(auth.role(), '') = 'service_role'`. pg_get_functiondef
  confirms all 4 are coalesce-guarded in the running DB. Functionally PROVEN: a NULL-role authenticated
  JWT calling `delete_tournament` now raises `solo un admin` (previously entered the body / fail-open).

## New findings

- Nit: **`src/lib/security.integration.test.ts:205-208`** — the inline comment ("A tournament id that
  entering the DEFINER body would raise on … if we still see a not-found/domain error the guard LEAKED")
  is **factually wrong**: the test uses a REAL live entry-less tournament, and the DEFINER body SUCCEEDS
  (error=null) on it — that's precisely *why* the `error != null` assertion catches a re-grant. The test
  is sound, but the comment describes the opposite mechanism. Risk: a maintainer trusting the comment
  could swap `tournamentId` for a random/non-existent UUID, silently turning the test into a tautology
  (in-body not-found always errors regardless of grant). Fix the comment, and ideally tighten the
  assertion to the permission code (`expect(anonFn.error?.code).toBe('42501')`) so it's robust to the id.

- FYI: **`create_player` (0012)** still carries the raw `auth.role() = 'service_role'` NULL-role
  fail-open (pg_get_functiondef: "RAW auth.role()"). Consciously OUT OF SCOPE for this batch and tracked
  in `followups.md` (DEFINER-writer ACL + guard-idiom systemic audit). Not reachable via the normal
  PostgREST boundary (anon lacks EXECUTE; `authenticated` always carries role:"authenticated"). Accepted.

- FYI: **`delete_tournament` (0020)** remains ungated at the DB layer for `status='completed'` fechas —
  the fix is FE-only (which satisfies the iter-1 *required* finding, FE-scoped). The DB-level block was
  an iter-1 *Optional* (security lens); a service_role/direct-DB admin could still hard-delete a completed
  fecha. Admin-trusted, acceptable; note for the deferred hardening pass if belt-and-suspenders is wanted.

- FYI: `followups.md` cleanly records the two consciously-accepted iter-1 items not fixed here
  (v2 no-rescore — prod has 0 completed active-season fechas; `request_access` no rate-limit —
  private-league risk-accept). Both were QUESTIONS/security-required in iter-1; now explicitly accepted.

## Independent verification run
- psql (rolled-back): both-writer priv matrix, owner-retains-execute, NULL-role guard raises, both
  writers succeed-under-anon-grant (proving test efficacy). No commits.
- `vitest run` full suite: **389 passed | 1 skipped** (the skip is pre-existing `supabase.test.ts`
  env-gated, unrelated). `security.integration.test.ts` runs (not skipped): 10/10 pass.
  4 touched route suites: 65/65 pass. `npm run lint`: no errors (only pre-existing `no-thenable`
  warnings on test mocks — unchanged pattern). No test weakened; no over-revoke.

## Axes checked
correctness ✓ (all 5 fixes verified, full-contract tests) · readability ✓ (one stale comment, Nit) ·
architecture ✓ (idioms honored: revoke-from-public+anon+authenticated, coalesce guard, drop-if-exists) ·
security ✓ (touches-sensitive: YES — anon-callable RPC surface, 4 DEFINER RPCs, DEFINER-function grants,
RLS; the CRITICAL is closed & introspection-proven, guards hardened) · performance ✓ (no path changed)
