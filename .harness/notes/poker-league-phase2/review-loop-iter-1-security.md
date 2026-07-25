# Review iter 1 (SECURITY LENS) — poker-league-phase2 (Track A)
Diff: `main...84b4222`, 29 files, +2861/-93
Lens: security ONLY (correctness/readability/arch/perf owned by another pass)
Verdict: FINDINGS

## Summary of the class
Phase 1's review killed 3 privilege-escalations by dropping the `player`/`entry`
self-write RLS policies (0012), on the principle *"Supabase grants
INSERT/UPDATE/DELETE to `authenticated` by default, so RLS is the ONLY gate; every
legit player write already goes through a DEFINER RPC, so direct-table write policies
are pure attack surface."* Track A **re-introduces exactly that attack surface on the
`tournament` table** — the plan (step 5) and decisions.md (caveat #4) approved persisting
the new columns via a direct `.from('tournament').update()` on *"the existing admin
update-tournament RLS policy (0001:215)"*, on the assumption that policy is admin-only.
**It is not.** Verified empirically against the live local DB (see repro).

## Findings

- **Critical: `supabase/migrations/0001_init.sql:213-219` (relied on by `src/routes/admin/CreateFecha.tsx:143-151` + `src/routes/Admin.tsx:314-337`) — a NON-admin can write `payout_distribution` / `counts_for_league` (and every other tournament column) and seize fecha-admin RPC control.**
  The `tournament` INSERT/UPDATE/DELETE policies are gated on
  `auth_is_admin() OR created_by = auth_player_id()`, **not admin-only**. Any league
  member can:
  1. `supabase.from('tournament').insert({ created_by: <own player id>, season_id: <active>, name, status, ... })` — the INSERT `with check` passes because `created_by = auth_player_id()`.
  2. `supabase.from('tournament').update({ payout_distribution, counts_for_league, status, season_id, prizes, current_level, ... }).eq('id', <that row>)` — the UPDATE `using`/`with check` passes because they own the row.
  3. Because `fn_is_tournament_admin()` (0009:63-78) *also* honors the `created_by`
     owner path, the attacker now returns **TRUE** for that fecha → they can drive
     every fecha-scoped admin RPC on it: `clock`, `eliminate`, `eliminate_multi`
     (0015:339), `complete_tournament`, `add_rebuy`, `confirm_payment`.
  This is the exact question the dispatch asked ("can a non-admin write
  `payout_distribution` / `counts_for_league`?") — **yes**. Impact: a phantom fecha in
  the active season, visible to all members (`read tournament using(true)`), with
  attacker-set name/prizes/`counts_for_league=true`, fully clock/eliminate-controllable
  by a non-admin. Same *class* as the Phase-1 criticals; a documented pitfall re-introduced.

  **Verified repro** (live DB, rolled back): as a bound non-admin
  (`is_admin=f`, `auth_player_id=…002`) with `role=authenticated`:
  - `insert into tournament(... created_by='…002' ...)` → **succeeded** (`INSERT 0 1`).
  - `update tournament set payout_distribution=…, counts_for_league=true, status='completed'` → **1 row updated**.
  - `select fn_is_tournament_admin(<row>)` → **`t`**.
  (`set_prizes` on it errored "admin only" — it uses the stricter
  `auth_is_admin() OR service_role`, 0015:205 — but `eliminate_multi`/`clock`/
  `complete_tournament` gate on `fn_is_tournament_admin` and are reachable.)

  **Origin & scope:** the permissive `created_by = auth_player_id()` clause pre-dates
  Track A (0001), and 0012 hardened `player`/`entry` but left `tournament`. Track A is
  what newly (a) writes these columns from the client through this policy and (b) adds
  `counts_for_league` (drives leaderboard inclusion, 0015:511) + `payout_distribution`
  (drives money) as things a non-admin can now set. It ships a feature on a false
  security assumption, so it must not merge without closing this.

  **Fix (preferred):** tighten the three `tournament` write policies to
  `auth_is_admin()` only — drop the `OR created_by = auth_player_id()` clause. Legit
  inserts already go exclusively through the `create_tournament` DEFINER RPC (0015:84,
  admin-gated, bypasses RLS, sets `created_by` server-side), and every legit *owner* is
  itself a global admin, so `auth_is_admin()` still covers them; no legit flow breaks.
  This also fixes `fn_is_tournament_admin`'s owner path being reachable by a
  self-inserted row. **Alternative/additional:** move the two Track-A writes
  (CreateFecha:150, `saveDistribution` Admin:319) into an admin-gated `SECURITY DEFINER`
  RPC (e.g. `set_fecha_payout(p_tid, p_dist, p_counts)`) that internally checks
  `fn_is_tournament_admin`/`auth_is_admin` and writes ONLY those columns — matching the
  0012 "every write through a DEFINER RPC" pattern. Do both for defense-in-depth.

- **`src/routes/Admin.tsx:314-337` + `src/routes/admin/CreateFecha.tsx:143-151` — the direct `.update(tournament)` path is not column-scoped.**
  Postgres RLS cannot restrict *which* columns are written, and the default grants
  expose all of them (verified: `authenticated` holds column-level UPDATE on
  `season_id, status, prizes, current_level, counts_for_league, payout_distribution,
  created_by, buy_in, …`). So even for a legitimate global admin, the "edit prizes" /
  "create fecha" flows grant write to the entire row, not just the two intended columns
  — a least-privilege regression vs the 0012 principle. Even absent the Critical's
  `created_by` hole, a bug or compromised admin session could flip
  `status`/`season_id`/`current_level` through this surface. Fix folds into the
  Critical's DEFINER-RPC alternative (an RPC writes only `payout_distribution` +
  `counts_for_league`). If the policy-tightening fix is taken alone, at minimum add a
  server-side guard on the sensitive columns.

- **Optional: `supabase/migrations/0015_fecha_prizes_bust_standalone.sql:183-235` — `payout_distribution` has no server-side shape/bounds validation.**
  `set_prizes` trusts the stored pcts verbatim (`(e->>'pct')::numeric`) — negative
  pcts, pcts summing ≠ 1, or huge `place` ints are accepted. The FE validates via
  `isValidDist`, but the direct `.update()` path (and any REST call) bypasses that
  entirely. Not a cross-tenant vuln (writer must be admin/owner), but combined with the
  Critical it lets a phantom-fecha owner write arbitrary prize math. Validate shape +
  bounds in the DEFINER RPC (recommended fix above) or add a `CHECK` / clamp in
  `set_prizes`.

- **FYI: `anon` still holds Supabase-default column INSERT/UPDATE/DELETE grants on `public.tournament`** (and likely the other public tables). Currently *not* exploitable — the write policies are `to authenticated` and `auth_player_id()` is NULL for anon, so RLS blocks anon writes — but it is loose defense-in-depth. 0012 revoked anon on the RPCs but not on the base tables. Consider `revoke insert, update, delete on public.tournament from anon;` (and peers).

- **FYI: search_path consistency.** The new/replaced DEFINER functions (`eliminate_multi`, `create_tournament`, `set_prizes`, `close_season`, `leaderboard`) pin `set search_path = public` (no `pg_temp`). This is safe (fixed path; pg_temp not consulted) and matches 0003/0004/0010, but 0012's functions use `public, pg_temp`. Cosmetic inconsistency, not a vuln — no action required.

## Security checks that PASSED (verified, not assumed)
- `eliminate_multi` (0015:339-446): admin gate via `fn_is_tournament_admin(v_tid)` before any mutation; `v_tid` resolved from the first entry then all entries re-checked to belong to `v_tid` AND be in-play (372-382) → no cross-tournament mutation, no privilege bypass for tournaments the caller doesn't own. No dynamic SQL (parameterized `unnest`); search_path pinned. Sound.
- `entry` direct-insert by a non-admin is still **blocked** by RLS (0012 drop holds) — verified: `insert into entry …` → *"new row violates row-level security policy"*. Attacker can only add themselves via `rsvp`.
- `season` writes are admin-only — policies use `auth_is_admin()` with **no** `created_by` escape (0001:222-227), so a non-admin cannot touch seasons / the single-active invariant.
- Partial unique index `season_single_active` (0014:50-52) enforces one active season regardless of RLS/direct writes; `close_season` archives-all before insert so the index never sees two active rows. Repair (1a) is a safe plain migration statement.
- `close_season` / `create_tournament` / `set_prizes` internal admin gates present and correct (`auth_is_admin() OR service_role`); `set_prizes` is stricter (global-admin only) — confirmed it rejects the non-admin owner.
- All new/replaced functions: `revoke all … from public, anon; grant execute … to authenticated, service_role` — no anon RPC exposure (matches 0012).
- No secrets/credentials introduced in the diff; no new third-party deps / lockfile change; no user-supplied-URL fetch (no SSRF surface) in this diff.

## Axes checked (focused lens)
correctness — (not this pass) · readability — (not this pass) · architecture — (not this pass) · security ✗ (touches-sensitive: **yes** — new RLS-relied direct table write, new SECURITY DEFINER RPC `eliminate_multi`, privilege-escalation on `tournament`) · performance — (not this pass)
