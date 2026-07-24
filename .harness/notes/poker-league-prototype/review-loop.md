# Review loop — poker-league-prototype
Iterations: 3 (3-reviewer panel: backend/security, FE-core, FE-ui)
Final: APPROVED

Pre-flight: diff far exceeds the single-reviewer bound (~14K reviewable LOC, greenfield Phase-1
build from an approved plan — not splittable into stacked PRs after the fact). Used the skill's
PANEL mechanism (security + data-migration + correctness triggers), scoping fresh reviewers by
risk area and running them in parallel. Findings promoted when flagged by ≥2 reviewers.

## Resolved
- **Critical (security, backend + FE agreed):** `player` self-UPDATE RLS had no column guard →
  any player could set `is_admin=true` = full admin escalation. Dropped the policy (players →
  SELECT only). mig 0012 (d143475). Verified iter-2 with a non-tautological RLS test (asserts 42501).
- **Critical (security):** `player` self-INSERT/DELETE + open-signup → stranger self-inserts an admin
  row. Dropped. (d143475)
- **Critical (security):** `entry` self-INSERT/UPDATE/DELETE → player could rewrite paid/chips/
  final_position/points_earned/status, bypassing geofence+payment and inflating the leaderboard.
  Dropped (all entry writes go through DEFINER RPCs). (d143475)
- **Required (security):** anon/PUBLIC could exec read RPCs (leaderboard/player_profile/fn_pot/
  fn_final_table_size) → revoked, granted authenticated only. (d143475)
- **Required:** admin `create_player` RPC added (restores path lost by dropping self-insert);
  `update_own_profile` RPC added; Profile screen repointed off the now-blocked direct table write. (d143475/caa1c92)
- **Required:** `complete_tournament` chop stranded >K in-play players at 0 → they now get positions
  K+1.. . (d143475)
- **Required:** SECURITY DEFINER functions had unpinned search_path → pinned `public, pg_temp`. (d143475)
- **Required:** seed Fecha-2 live positions off-by-one (collided at rank 7) → fixed 8/7→9/8. (d143475)
- **Required (FE):** Live self_bust failure left a false "reportado" → rollback + error + retry. (caa1c92)
- **Required (FE):** `useLoadable.reload()` flashed the skeleton on optimistic reconcile → added a
  silent refetch mode; FechaDetail reconciles use it; abort-guard preserved. (caa1c92)
- **Required (FE):** Fechas sorted by the localized display string → sort by raw `scheduled_at`. (caa1c92)
- **Required (FE):** `.icon-btn` 38px < 44px a11y bar → 44px; removed dead `ScreenPlaceholder`. (caa1c92)
- **Required (FE test gaps):** added tests — statusPill all 8 states, self_bust error path, Login
  states, auto-advance real-fixture ×4 (+ deferred-RPC in-flight). (caa1c92, e8d46bf)
- **Required (FE regression, iter-2→3):** the auto-advance stall fix double-fired `next_level` when
  the clock RPC was in flight across a tick → latch BEFORE the await, release on failure. Verified
  by a deferred-RPC test the reviewer confirmed fails against the pre-fix code. (e8d46bf)

## Deferred (Optional/FYI → followups.md, non-blocking)
- create_player: no dup-email guard; not yet wired into admin UI.
- security integration test omits an anon-reject assertion for fn_pot.
- non-chop EARLY completion can strand in-play players at 0 pts (normal completion ends at
  one-remaining; add a guard/UX later).
- auto-advance: ambiguous response-failure of the non-idempotent `next_level` could skip a level
  (pre-existing; a request-id/idempotency-key would close it).
- add a deferred-FAILURE variant of the in-flight auto-advance test.

## Verdict
Backend/security: APPROVE (clean, iter 2). Frontend: APPROVE (iter 3). Tests 196 passed / 1 skipped;
build + lint green. Ready for /dh:ship (human gate).
