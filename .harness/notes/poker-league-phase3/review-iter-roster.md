# Security-lens review — block players + roster (mig 0023, commit dad75c6)
Scope: SECURITY ONLY. Diff = `git show dad75c6`; focus `supabase/migrations/0023_block_player.sql`.
Evidence: local Supabase (55322), all writes in a ROLLED-BACK tx (proof.sql) + catalog inspection.
Verdict: **ROSTER/BLOCK: APPROVED** — no new security regressions; block gating correct & proven.

## Per-check results

### 1. claim_player blocked gate — OK (proven)
- `0023:66-70` inserts `if v_player.blocked then return; end if;` AFTER the email-match
  `if not found` and BEFORE the `auth_user_id is null` bind. Correct position.
- psql T1: blocked player (`blk@test.local`) → **0 rows**. T1b: its `auth_user_id` stays
  **NULL** (no bind) → unblock-then-clean-first-login still works as documented.
- psql T2: control — a fresh unblocked player → 1 row + binds `auth_user_id`. So the gate
  is specific to blocked, not a blanket break.
- 0002 logic preserved verbatim: case-insensitive email match, already-bound-to-other refusal
  (`auth_user_id <> v_uid` raise), idempotent same-user return, `security definer`,
  `raise` on null uid. `prosecdef=t` confirmed in catalog. No way for a blocked user to bind.

### 2. set_player_blocked gating — OK (proven)
- Admin gate `auth_is_admin() OR coalesce(auth.role(),'')='service_role'` — NULL-role-safe
  coalesce matches the 0021 idiom (no fail-open).
- psql T3: non-admin block → **RAISED** "solo un admin". T3b: non-admin unblock-self →
  **RAISED** (a blocked/non-admin cannot self-unblock; gate rejects before any write).
- T4: admin blocks SELF → **RAISED** "no podés bloquearte". T5: admin blocks another admin →
  **RAISED** "no podés bloquear a otro admin". T6/T7: admin block+unblock normal → **SUCCESS**
  (blocked t→f round-trips). Unblock always allowed as designed.
- Params are `uuid`/`boolean` (typed) — no injection surface; body is a single parameterized
  `update ... where id = p_player_id`.
- Grants (catalog): anon=**f**, public=**f**, authenticated=t, service_role=t. The
  `revoke all ... from public, anon` landed. `search_path=public, pg_temp` (hardened). Correct.

### 3. Roster email exposure — FYI, PRE-EXISTING (not introduced by 0023)
- `read player` policy = `SELECT to authenticated using (true)` (only policy on player;
  catalog-confirmed). psql T8: a **non-admin** JWT SELECTs the full roster incl. **email**
  (20/20 rows+emails). psql T9: **anon** → 0 rows (RLS denies no-JWT). So any *authenticated*
  member — not just admins — can already read every member's email via the anon-key client.
- This dates to `0001` (`create policy "read player" ... using(true)`); `0012` deliberately kept
  read while dropping self-writes. **0023 changes no policy** — it only adds `player.blocked`
  (readable) and surfaces the existing roster in an admin-only *UI* (`Admin.tsx:189-190`
  `select id,name,email,is_admin,is_guest,blocked`). The DB gate is NOT admin-scoped, so this is
  a pre-existing exposure the new UI makes visible, not a new one. Accepted risk for a friends'
  league per the task note; flagged for awareness. If member emails should be admin-only, that is
  a separate hardening (admin-gated `list_players()` DEFINER RPC + tighten `read player`), out of
  scope for this diff.

### 4. Over-grant / regression — OK
- No policy dropped/weakened by 0023. `set_player_blocked` grants correct (no anon).
- FYI: `claim_player` is executable by anon/PUBLIC (catalog: anon=t, public=t). This is
  **pre-existing** — `0002` granted authenticated but never `revoke ... from public`, so PUBLIC's
  default execute survives; `0012` revoked anon on the *read* RPCs but not claim_player. 0023's
  `create or replace` preserves the existing ACL and re-grants authenticated → **no new anon
  grant**. Harmless: claim_player raises immediately when `auth.uid()` is null (anon has none), so
  no bind and no data leak. Could `revoke execute on claim_player from public, anon` for
  consistency with the 0012 idiom, but non-blocking.

## Findings
- Optional (hardening): `0023:46` — the claim_player forward-fix keeps `set search_path = public`
  (no `pg_temp`), unlike `set_player_blocked` (`public, pg_temp`) and the 0012/0021 DEFINER idiom.
  Since the function is being rewritten anyway, change to `set search_path = public, pg_temp` to
  pin pg_temp last (defense-in-depth vs. temp-object shadowing in a SECURITY DEFINER function).
  Practical exploitability via PostgREST is ~nil (callers can't CREATE TEMP through an RPC) and it
  matches original 0002, so non-blocking — but it's a free, convention-consistent hardening.
- Optional: `0023:88` — add `revoke execute on function public.claim_player() from public, anon;`
  to match 0012's read-RPC hardening (pre-existing anon-executable; harmless, gated by auth.uid()).
- FYI: block is a **login/bind gate, not session revocation**. `claim_player` re-runs on every app
  boot / session-restore (`auth.tsx:66,93-118`), so a blocked user is kicked to the unbound Login
  on their next reload/refresh. But a blocked non-admin with an already-open tab keeps their live
  JWT and can still read (RLS `using(true)`) and drive self-RPCs (update_own_profile/rsvp/… none
  check `blocked`) until reload. Matches the documented intent ("must not be able to log in/bind");
  if immediate lockout is ever required, admin must also revoke the Supabase auth session.

## Axes checked (focused lens)
security ✓ (touches-sensitive: YES — auth binding / login gate / admin moderation RPC / roster
email read). correctness/readability/architecture/performance — NOT in scope (other passes own them).
