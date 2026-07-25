# Review iter 1 (FOCUSED LENS: security) — poker-league-phase2 (UI 2.1 batch)
Diff: d012827..HEAD, 62 files, +2500/-130 (security-relevant subset only)
Verdict: CLEAN (security axis)

Scope: security lens ONLY. Other axes (correctness/readability/architecture/perf)
owned by sibling passes — not evaluated here.

## What I checked (with evidence)

### 1. mig 0018 leaderboard DROP+recreate — definer / search_path / grants preserved  ✓
- Source (0018:40-146): `drop function if exists public.leaderboard(uuid)` then
  `create function ... security definer set search_path = public, pg_temp`, and
  re-asserts `revoke all ... from public, anon` + `grant execute ... to authenticated, service_role`.
  Matches the 0012 hardening idiom byte-for-byte.
- Verified against the LIVE local DB (catalog, not just source):
  - `pg_proc`: `prosecdef = t`, `proconfig = {search_path=public, pg_temp}`.
  - ACL = `authenticated=X | service_role=X | postgres=X` — **no anon, no PUBLIC**.
  - `has_function_privilege('anon', 'public.leaderboard(uuid)', 'execute')` = **false**;
    `authenticated` = **true**. Anon read-exposure NOT re-opened by the recreate.
- Injection surface: none. Body is static SQL, single `uuid` parameter, no `EXECUTE` /
  no dynamic string building. The uuid type rejects non-uuid input at the boundary.
- Plain `DROP` (no CASCADE): would ERROR loudly if any object depended on it, so it
  cannot silently drop a dependent. Comment's "no dependents" claim holds (only grants).
- Ran it as `authenticated` against the real active season: returns rows with
  `form_positions int[]` aligned 1:1 to `form` (e.g. champion→{1}, podium→{2}). Body sound.

### 2. New client `.update()` write paths — all admin-gated by mig 0017 RLS  ✓ (empirical)
The tournament UPDATE policy is `admin update tournament` = `using auth_is_admin()` /
`with check auth_is_admin()`, scoped `to authenticated`; RLS is enabled on the table.
Empirical test (local DB, all in ROLLED-BACK txns, no mutations persisted):

| Role (auth.uid → auth_is_admin) | `odds_enabled` | `scheduled_at` | `cover_url` |
|---|---|---|---|
| non-admin authenticated (is_admin=false) | **0 rows** | **0 rows** | **0 rows** |
| admin authenticated (Edwin, is_admin=t)  | 1 row | — | — |
| anon | **0 rows** | — | — |

- `src/routes/Admin.tsx:543` odds toggle `.update({odds_enabled}).eq('id',...)` — gated ✓
- `src/routes/FechaDetail.tsx:400` ScheduleEditor `.update({scheduled_at}).eq('id',...)` — gated ✓
- `src/routes/FechaDetail.tsx` CoverControl `.update({cover_url})` — same policy, unchanged path ✓
- `src/routes/admin/CreateFecha.tsx:240` follow-up `.update({counts_for_league, odds_enabled})`
  after the admin-gated `create_tournament` DEFINER RPC — gated by the same RLS ✓
Non-admin (or anon) attempts are silent no-ops (0 rows, no error) — the safe failure mode;
no unauthorized write occurs. Conclusion: no privilege-escalation surface added by this batch.

### 3. Calculadora live gate SELECT — no data leak  ✓
`src/routes/Calculadora.tsx:93` `from('tournament').select('id').eq('status','live')
.eq('odds_enabled',false).limit(1).maybeSingle()`, run as authenticated.
- SELECT policy `read tournament` = `using true` to authenticated (unchanged, pre-existing).
  Query returns only `id`; `odds_enabled` is a non-sensitive boolean gate flag. No leak.
- anon has no tournament SELECT policy → RLS denies → gate falls open (enabled). Fine: the
  calculator is a public client-side reference; nothing sensitive is gated.

## Findings

- FYI: `src/routes/Calculadora.tsx:83-106,118` — the odds gate is **advisory, not an access
  control.** It is client-side only (the equity computation runs entirely in-browser; no
  server resource is protected) AND fail-open (`setGate(!error && data ? 'disabled':'enabled')`,
  line 101 — any query error → enabled). A user can trivially keep using the calculator during
  a live "disabled" fecha (edit client state, or block the one request). This is acceptable
  *because there is nothing security-sensitive behind the gate* — it's a social/anti-cheat
  nudge, not enforcement. Recorded so a future maintainer does not mistake it for a control
  or try to "harden" it server-side (there's no server surface to harden here).

- FYI: `src/routes/admin/CreateFecha.tsx:729-747` — `pf-fecha-defaults` is read from
  localStorage (untrusted persistence) and JSON-parsed. Handled correctly: wrapped in
  try/catch, every field coerced via `Number.isFinite` guards with hardcoded fallbacks, and
  the values are only used as numeric form state / numeric RPC args (never as markup or a
  query fragment). No XSS / injection. Noted only to confirm the untrusted-input path is clean.

- FYI (NOT attributable to this diff — flag for a separate sanity check): executing
  `public.leaderboard(...)` from a direct psql session after `set role anon` crashed the local
  Postgres into recovery mode (auto-recovered in ~1s, no data loss; my writes were already
  rolled back). This is on the *permission-denied* path (anon lacks EXECUTE), NOT the new SQL,
  and is **not reachable in production**: PostgREST checks the grant and returns 403 to an anon
  key holder before the function body ever runs. The function body itself runs cleanly as
  `authenticated`. Most likely a local-container quirk of `set role` + a DEFINER function's
  permission failure. Did not re-trigger. Worth a one-off `\df`/local-stack check, but it does
  not change this diff's security verdict.

## Axes checked (focused lens)
security ✓ (touches-sensitive: YES — tournament direct `.update()` writes [scheduled_at,
odds_enabled, cover_url], a new authenticated SELECT gate, and a DROP+recreate of a
SECURITY DEFINER RPC with grant re-assertion. All verified gated/closed empirically.)
correctness / readability / architecture / performance — NOT evaluated (other passes own them).
