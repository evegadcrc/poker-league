# Review loop — poker-league-phase3

Prod-bound batch (scoring v2 + fecha cancel/delete + guests + access-request flow). Reviewed as a
panel (five-axis + security + data-migration) because it changes the LIVE points engine, adds RLS,
and touches auth. Range `main...HEAD` (30 files, +2989/-198, migrations 0019–0022).

## Final: APPROVED (2 iterations)

### Resolved
- **CRITICAL (security, proven):** `fn_tournament_points` + `recompute_final_table_size` (DEFINER
  *writers*) were executable by the shipped anon key — an unauthenticated caller could overwrite
  `points_earned` / admin overrides. (Pre-existing from Phase 1; `revoke from public` doesn't strip
  anon/authenticated.) Fixed in mig 0019: `revoke execute … from public, anon, authenticated` on both;
  psql-proven anon=f / authenticated=f / service_role=t; legit DEFINER callers intact. Commit `f279dc6`.
- **Required:** cancelling a LIVE fecha wasn't honored (Live/Admin/Calculadora ignored `cancelled_at`)
  → cancelled game still played + could inject points — fixed (`.is('cancelled_at', null)`).
- **Required:** "Eliminar fecha" was offered on COMPLETED fechas (misclick nukes results+gallery) —
  gated to scheduled/cancelled only.
- **Required:** mig 0022 policies lacked `drop policy if exists` (re-`db push` would wedge the live DB)
  — guards added.
- **Required (cheap):** admin-guard NULL-`auth.role()` fail-open — hardened with coalesce in the 4 new RPCs.

### Verified clean by the panel
- scoring-v2 engine EXACT on all canonical fixtures (140/100/60/90/60/−15); FE preview == engine (no
  drift); guest `leaderboard` recreate byte-identical to 0018 except `where not p.is_guest`; all new
  DEFINER RPCs admin-gated + search_path pinned; `signup_request` RLS solid (anon 42501, non-admin 0
  rows); `request_access` no dynamic SQL; migrations apply cleanly on current prod state (active season
  + 1 admin, 0 fechas); no history rewrite.

### Accepted / deferred → followups.md
- v2 doesn't rescore already-completed active-season fechas (moot — prod has 0 completed).
- `request_access` no rate-limit (accepted for a private friends' league; admin reviews every request).
- Systemic DEFINER-writer ACL + NULL-role guard audit (e.g. 0012's create_player) — good follow-up.
- Nit: a stale comment in `security.integration.test.ts` (test is sound).

## Next: deploy to prod (merge → backup → db push 0019-0022 → redeploy FE → seed test live fecha).
