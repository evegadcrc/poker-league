# Review iter 2 — poker-league-prototype (BACKEND re-review, security + data-migration lenses)
Diff: d143475 (RLS hardening) + caa1c92 (FE) on feat/poker-friends-phase1
Backend scope: `supabase/migrations/0012_security_hardening.sql`, `supabase/seed.sql`,
`src/lib/security.integration.test.ts`, changed `admin`/`profile` integration tests, plus
regression scan of the FE writes affected by the dropped policies.
Verdict: **CLEAN — APPROVE** (all 3 Criticals + all required from iter-1 genuinely resolved in code;
no new Critical/required).

## Prior-iteration resolutions verified (against current code, not chat)

### Critical

- **iter1 Critical #1 — player self-UPDATE is_admin escalation → RESOLVED.**
  `0012:24` drops `"player self update"` (name matches `0001_init.sql:197`). After 0012 the only
  policy on `player` is `"read player"` (SELECT, `0001:187`) — no UPDATE policy → RLS default-deny.
  Verified there is no broad admin-UPDATE policy on `player` that could re-open the hole (only the
  three self-* drops; admin writes go through SECURITY DEFINER RPCs that bypass RLS). Column grants
  are now moot because the row is default-deny for writes. Test `security.integration.test.ts:117`
  signs in a *real* authenticated member, attempts `update({is_admin:true})`, asserts 0 rows AND
  re-reads server-truth `is_admin=false` — genuine, not tautological.

- **iter1 Critical #2 — stranger self-provisions an admin `player` row → RESOLVED.**
  `0012:23` drops `"player self insert"` and `0012:25` drops `"player self delete"` (names match
  `0001:195/200`). No INSERT policy → 42501. Test `security.integration.test.ts:133` asserts
  `error.code==='42501'` and `count===0`. Onboarding replaced by the admin-gated `create_player`
  RPC (below) — so dropping self-insert does not strand the flow.

- **iter1 Critical #3 — arbitrary `entry` self-mutation (paid/chips/points/final_position/status)
  → RESOLVED.** `0012:33-35` drop `"entry self insert/update/delete"` (names match
  `0001:204/206/209`); only `"read entry"` (SELECT, `0001:192`) remains. Test
  `security.integration.test.ts:151` attempts the full-column rewrite from a real member session,
  asserts 0 rows + server-truth untouched on all five columns. Every player entry write still goes
  through the DEFINER RPCs (rsvp/cancel_rsvp/check_in/self_bust), which bypass RLS.

### Required

- **iter1 req — admin onboarding path (create_player) → RESOLVED (backend).**
  `0012:75-94` adds `create_player(text,text)` SECURITY DEFINER, `search_path=public,pg_temp`,
  internal guard `auth_is_admin() OR service_role`, forces `is_admin=false`, `revoke public,anon` +
  `grant authenticated,service_role` (`0012:115-117`). Test `security.integration.test.ts:220`
  proves non-admin→rejected, admin→allowed & created row `is_admin=false`. Mirrors the other admin
  RPCs' guard shape. (FE wiring is a separate concern — see FYI below.)

- **iter1 req — anon can execute the SECURITY DEFINER read RPCs → RESOLVED.**
  `0012:102-110` `revoke all ... from public, anon` then `grant ... to authenticated, service_role`
  on `leaderboard(uuid)`, `player_profile(uuid,uuid)`, `fn_pot(uuid)`, `fn_final_table_size(int,uuid)`.
  All four signatures verified against their definitions (0003:41/188, 0004:47, 0011:28) — no
  signature typo that would error the migration. Test `security.integration.test.ts:185` calls
  `leaderboard` + `player_profile` from a session-less anon client and asserts `error != null`.

- **iter1 req — complete_tournament chop strands >K in-play players → RESOLVED.**
  `0012:129-233` REPLACES 0009's definition. New step (0b) `0012:187-205`: after choppers take
  positions 1..K (status winner), the remaining in-play non-choppers
  (`status in ('playing','checked_in') and chop_group is null`) are eliminated into positions
  K+1.. ordered by `chips desc nulls last, created_at, id`. Traced positional integrity: choppers
  1..K, remaining K+1..K+R, and any pre-chop eliminated players occupy the top S-E+1..S positions
  (total−1 assigns highest positions to earliest busts) → **no collision, no NULL/0-pt strand.**
  `entry.created_at` exists (`0001:133`) so the ORDER BY is valid. Integration test
  `admin.integration.test.ts` (chop 2 with 3 in play) asserts remainder = positions [3,4,5], status
  eliminated, and `points_earned != 0` (proves scored, not stranded). Genuine.

- **iter1 req — seed Fecha-2 positions off-by-one → RESOLVED.**
  `seed.sql:124-125` now seeds the two eliminated entries at final_position 9 and 8 (was 8/7).
  Fecha 2 has 9 seated players (6 playing + 2 eliminated + 1 checked_in; confirmed=00a never
  checked in, declined=00b). `fn_eliminate_entry` (`0009:339-344`) sets
  `final_position = count(status in ('playing','checked_in'))` = 7 for the next bust → fills 7,6,…,1
  with no collision against the existing 9/8. Consistent with total−1 over 9 seated. Demo path
  open→live→eliminate no longer collides.

- **iter1 (task-list) — search_path pinned on the new/replaced DEFINER functions → CONFIRMED.**
  `update_own_profile`, `create_player`, and the replaced `complete_tournament` all set
  `search_path = public, pg_temp` (0012:50/79/136) — an upgrade over 0009's `public`.

### FE regression from the dropped policies — HANDLED
- Profile self-write migrated to the RPC: `Profile.tsx:107` now calls `rpc('update_own_profile')`;
  no direct `from('player').update()` remains in `src/` (grep-verified). `profile.integration.test.ts`
  updated to use the RPC (was a direct table update that would now silently return 0 rows).
- All 4 residual `from('entry')` call sites (Fechas:128, FechaDetail:95, Live:82, Admin:167) are
  `.select()` reads — permitted by the surviving `"read entry"` policy. No write path broken.
- Admin.tsx routes every mutation through RPCs (clock/confirm_payment/add_rebuy/undo/eliminate/
  mark_no_show/complete_tournament) — no direct player/entry writes to break.
- `claim_player` (first-login bind) is SECURITY DEFINER (`0002:21`) → bypasses RLS, unaffected by
  the dropped self-update policy.
- Test teardown safe: `season`→`tournament`→`entry` and `player`→`entry` FKs are ON DELETE CASCADE
  (`0001:65/86/116/117`), so `afterAll` season+player deletes don't leak or error.

## New findings (all non-blocking)

- **Optional: `security.integration.test.ts:185` — anon-rejection test covers `leaderboard` +
  `player_profile` but not `fn_pot`.** `fn_pot` is also a data-leak vector revoked at `0012:104`;
  add it to the anon-rejection case to pin the whole revoke set. (`fn_final_table_size` is an
  internal helper — lower value.)

- **Optional: `0012:75-94` `create_player` has no duplicate-email guard.** A repeat email hits the
  raw `player.email` unique-constraint error (Postgres 23505) instead of a localized Spanish message
  like the sibling RPCs. Cosmetic; consider a pre-check + friendly `raise`.

- **FYI: `create_player` RPC exists but is not wired into the FE.** `grep` finds `create_player`
  only in the test + `database.types.ts`; `Admin.tsx` has no "add member" action. The iter-1
  required finding was scoped to *the RPC* (the backend gate), which is resolved — but admins
  currently onboard members only via seed/direct RPC, not UI. Confirm that's acceptable for Phase 1
  (seed provides the demo roster) or file a FE follow-up.

- **FYI: non-chop completion still strands in-play players at 0 pts.** Step (0b) only runs inside the
  chop branch (`0012:156`). If an admin `complete_tournament` with `p_chop_entry_ids=null` while
  entries are still `playing`/`checked_in`, those keep `final_position=NULL` → 0 pts (unchanged from
  0009). iter-1 only flagged the chop path; normal flow crowns a winner via total−1 before
  completion, so this is latent. Consider mirroring 0b for the non-chop path or blocking completion
  while >1 alive and no chop.

- **FYI: iter-1 Optional/Consider items remain open (all were non-blocking):** checked_in counts as
  "alive" in total−1 (0009:341); no `FOR UPDATE` on concurrent busts; no single-active-season
  constraint; `close_season` orphans unfinished fechas; `undo_last_elimination`/`confirm_payment`
  lack a tournament-status guard; `auth.role()='service_role'` is deprecated (used again at
  `0012:84`). None reopened by 0012.

- **Nit: `admin.integration.test.ts` chop test uses `points_earned != 0`** — a loose assertion that
  relies on positions 3–5 scoring positive at this field size. Correct here; asserting the exact
  §5 value would be stronger.

## Axes checked
correctness ✓ (chop-strand traced for collision-freedom; seed total−1 re-derived; new RPCs behave) ·
readability ✓ (clear header comments, matches existing RPC style, no dead code) ·
architecture ✓ (RLS now default-deny writes + DEFINER-RPC-only mutation; onboarding path restored) ·
security ✓ (touches-sensitive: **YES** — RLS authz on player+entry, anon exec on read RPCs, new
admin/self-write RPCs; all closed. avatar_url still free-text but rendered as img-src, pre-existing
low risk) ·
performance ✓ (unchanged scale; step-0b CTE is a single indexed update over one tournament's entries)

## Verdict
**APPROVE.** All 3 iter-1 Criticals and all 5 iter-1 required findings are resolved in the committed
code with genuine (non-tautological) tests. No new Critical/required. Remaining items are
Optional/FYI/Nit.
