# Review iter 1 (FOCUSED LENS: security) — poker-league-phase3
Diff: `main...HEAD` (4dd331f), 30 files, +2989/-198
Lens: SECURITY ONLY (other axes owned by another pass). Target migs: 0019/0020/0021/0022.
Verdict: FINDINGS (1 Critical)

All claims below verified against local Supabase (`postgresql://postgres@127.0.0.1:55322`)
via rolled-back txns using `set local role` + `set local request.jwt.claims` to simulate
the anon / non-admin-authenticated / service_role PostgREST boundaries. No mutations committed.

## Findings

### Critical
- **`supabase/migrations/0019_scoring_v2.sql:184-185` — `fn_tournament_points` (SECURITY
  DEFINER, writes `entry.points_earned`) is EXECUTE-able by `anon` AND `authenticated`.**
  The grant block re-asserts `revoke all ... from public; grant ... to service_role` and the
  header claims "service_role only" — but that is EMPIRICALLY FALSE. `revoke ... from public`
  does NOT strip the *explicit* `anon`/`authenticated` grants that Supabase's default
  privileges attach to a public function at first CREATE (0003); CREATE OR REPLACE (0009,
  0019) preserves them. ACL: `anon=X | authenticated=X | service_role=X`.
  - PROVEN authz bypass: as `anon`, `perform fn_tournament_points('000…000')` returned the
    function's own `P0001 tournament not found` — i.e. it entered the DEFINER body — NOT
    `42501 permission denied`.
  - PROVEN write impact: on completed fecha `d3000000-…-0001`, an admin override
    (`points_earned=99999`, pos 1) was RESET to the computed `90` by an **unauthenticated
    `anon`** call to `fn_tournament_points`. `has_function_privilege('anon',…,'execute')=t`.
  - Impact: any holder of the *shipped anon key* (no login needed) can force score
    recomputation on any tournament → clobber admin manual point overrides on completed
    fechas (season-standings tampering) and force partial/premature scoring on live fechas.
    Recompute is deterministic (cannot inject arbitrary values), but it is an unauthorized
    WRITE that bypasses the intended gate → Critical per the lens's write-severity rule.
  - FIX: `revoke all on function public.fn_tournament_points(uuid) from public, anon,
    authenticated;` (keep the `grant … to service_role`). This is exactly why 0012/0017 wrote
    `revoke … from public, anon` — the `revoke-from-public-only` idiom leaks role grants.
  - BLAST RADIUS (out of diff, FYI): `recompute_final_table_size` (0005) is the *same class* —
    SECURITY DEFINER, **no internal auth guard**, writes `tournament.final_table_size`, and is
    anon-executable (`anon=t`). Same fix. (Guarded DEFINER writers `add_rebuy`/`confirm_payment`/
    `eliminate` are also anon-EXECUTE but stay protected by their internal `fn_is_tournament_admin`
    check, since anon's PostgREST JWT carries role='anon' → guard blocks.)

### Required
- **`supabase/migrations/0022_access_requests.sql:68-112` — `request_access` is an
  unauthenticated, unbounded INSERT with no rate limit / captcha / email-format validation.**
  Anyone with the public anon key can flood `signup_request` with unlimited *unique-email*
  rows (the `unique(email)` only dedupes exact repeats; `a1@x`, `a2@x`, … all insert) →
  row/storage exhaustion on a public endpoint. PROVEN it stores arbitrary strings verbatim:
  `request_access("ROBERT'); DROP TABLE public.signup_request;--@x.com")` returned `pending`
  and stored that literal as `email` (the DROP did NOT execute — table intact, injection-SAFE:
  parameterized + pinned search_path + no dynamic SQL). Add rate-limiting / a lightweight
  captcha (Turnstile) and validate the email format, OR record it as an explicitly accepted
  risk in `.harness/decisions.md` (it is not currently noted there).
- **Admin-guard fail-open on NULL role — `0020:42`, `0021:170`, `0022:131`, `0022:174`**
  (and pre-existing `0012` `create_player`). `if not (public.auth_is_admin() or auth.role() =
  'service_role')` evaluates to NULL when `auth.role()` is NULL (JWT lacks a `role` claim),
  and plpgsql treats `if NULL` as false → the `raise` is SKIPPED → guard FAILS OPEN. PROVEN:
  with `request.jwt.claims = '{"sub":"…"}'` (no role), `delete_tournament` entered its body
  (`la fecha … no existe`) instead of raising `solo un admin`. NOT reachable via the normal
  PostgREST boundary — anon lacks EXECUTE on these RPCs, and the `authenticated` DB role always
  carries `role:"authenticated"` → `auth.role()` non-null → guard blocks (PROVEN below).
  Latent/defense-in-depth, but it is a guard that fails open and is replicated across every new
  admin RPC. Harden: `coalesce(auth.role(),'') = 'service_role'`.

### Optional
- Optional: **`0022_access_requests.sql:83-107` — membership+rejection enumeration oracle.**
  `request_access` returns `member` / `pending` / `rejected` to anon, letting anyone probe
  whether an email is a league member or was admin-rejected. Documented in-migration as
  "acceptable"; NOT risk-accepted in decisions.md. Low sev for a friends' league, but a public
  anon endpoint. Consider a uniform response (decide send-link server-side) or accept+document.
- Optional: **`0020_fecha_cancel_delete.sql:35-54` — no guard against deleting a completed
  league fecha.** Scoping is correct (gallery_photo/entry/tournament all filtered by the single
  `p_id` — VERIFIED, no arbitrary-data deletion), but nothing blocks hard-deleting a
  `status='completed' AND counts_for_league` fecha → irreversible loss of entries + season
  points, no soft-delete/confirm at the DB layer. Admin-trusted, but the "created by mistake"
  intent is unenforced. Consider blocking delete of completed+counted fechas (require cancel).
- Optional: **`0019_scoring_v2.sql:69` — `set search_path = public` omits `pg_temp`** while
  every other Phase-3 DEFINER pins `public, pg_temp`. All object refs are schema-qualified so
  temp-shadowing isn't currently exploitable; align for consistency/defense-in-depth (more
  relevant once the Critical's anon exposure is closed).

### FYI
- FYI: **`request_access` TOCTOU** — two concurrent first-time calls for the same new email
  both pass the `not found` check; the second INSERT hits `unique(email)` → unhandled
  exception (caller gets an error, not `pending`). Cosmetic. `on conflict (email) do nothing`.
- FYI: Verified-clean surfaces —
  - `add_guest_entry` creates `is_guest=true` player; `is_admin` correctly defaults false
    (0001:31); synthetic `guest+<uuid>@local` email is non-deliverable/non-claimable → no
    escalation.
  - `approve_request` routes creation through `create_player` → `is_admin=false` — approve
    cannot mint an admin. Only reads the request's own (admin-reviewed) email.
  - EXECUTE ACLs: `approve_request`/`reject_request`/`add_guest_entry`/`delete_tournament`/
    `leaderboard` all `anon=f` (VERIFIED `has_function_privilege`); `request_access` `anon=t`
    (intended). Only `request_access` is anon-callable among the new RPCs.
  - `signup_request` RLS sound: anon fully blocked (`revoke all … from anon` → `42501 permission
    denied`), authenticated non-admin SELECT returns 0 rows (no enumeration via the table),
    INSERT denied (`42501`), UPDATE/DELETE affect 0 rows, victim row survives (all VERIFIED).
  - Realistic non-admin authenticated JWT (`role:authenticated`, random sub): `approve_request`
    / `delete_tournament` / `add_guest_entry` all correctly raise `solo un admin` (VERIFIED).
  - `leaderboard` (0021): SECURITY DEFINER + `search_path` pinned + `revoke … from public, anon`
    → anon NOT re-opened (VERIFIED `anon→leaderboard=f`). Guest exclusion is a projection filter,
    no security impact.
  - `seed.sql` diff: scoring-v2 test data only; no secrets/credentials; it is a local seed, not
    a migration (not applied by `db push`).

## Route to deeper security pass
- Anon-callable RPC surface (`request_access`): rate-limit / abuse review.
- Function-grant hardening: `fn_tournament_points` + `recompute_final_table_size` (service_role-
  only DEFINER writers currently anon/authenticated-executable) — systemic `revoke-from-public`
  leak; audit ALL DEFINER writers' ACLs, not just the two named.
- Admin-guard `auth.role()` NULL fail-open idiom (codebase-wide, incl. 0012).

## Axes checked
correctness — (not this lens) · readability — (not this lens) · architecture — (not this lens) ·
security ✗ (touches-sensitive: YES — anon-callable RPC, new RLS table, 4 admin DEFINER RPCs,
DEFINER-function grant leak) · performance — (not this lens)
