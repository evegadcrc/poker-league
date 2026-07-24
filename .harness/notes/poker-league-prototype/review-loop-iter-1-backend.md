# Review iter 1 — poker-league-prototype (BACKEND / DATA layer, security + data-migration lenses)
Diff: dcaa727..HEAD (feat/poker-friends-phase1), backend scope only: 11 migrations + seed.sql + config.toml, +3087 lines
Verdict: FINDINGS (REJECT — 3 Critical authz/data-integrity)

Scope reviewed: `supabase/migrations/0001..0011`, `supabase/seed.sql`, `supabase/config.toml`.
NOT reviewed (other reviewers own FE): everything under `src/`.

## Summary of judgement
The **pinned algorithms are implemented correctly** — points §5, chop averaging + co-champions,
penalties (no-show −15 / graduated cancel bands), elimination total−1, two-tier mesa-final,
prize rounding-to-₡5.000-with-1st-absorbs-remainder all match the plan/contract and the seed math
checks out (Fecha 1: 105/95/85/67/57/42/32/22/12/2/−15 reproduces the formula exactly). The RPC
layer is well-structured: every admin RPC is SECURITY DEFINER with an internal admin guard
(`auth_is_admin() OR owner OR service_role`), `search_path=public` is pinned on every definer
function, and the FE routes all writes through RPCs (verified: only `Profile.tsx` touches a table
directly, updating `player.avatar_url`).

**The defect is the RLS boundary, not the RPCs.** The direct-table write policies on `player` and
`entry` are wide open at the column level, and because Supabase's default privileges already grant
`INSERT/UPDATE/DELETE` on public tables to `authenticated`, RLS is the *only* gate — and it lets a
player rewrite any column of their own rows, including `player.is_admin`. That bypasses every
carefully-guarded RPC. This is the headline.

## Findings

### Critical

- **Critical: `supabase/migrations/0001_init.sql:197-199` (`player self update`) — privilege
  escalation to admin.** The policy is `using (auth_user_id = auth.uid()) with check (auth_user_id
  = auth.uid())` with **no column restriction**. Supabase default privileges grant `UPDATE` on
  `public.player` to `authenticated` (no column grants exist in 0001 — confirmed), so RLS is the
  sole gate. Any logged-in player can run `supabase.from('player').update({ is_admin: true })` on
  their own row (auth_user_id unchanged → `with check` passes) and `auth_is_admin()` immediately
  returns true → full control of every admin RPC (create/delete tournaments, `close_season`,
  `clock`, `eliminate`, `set_prizes`, …). The FE only needs to update `name` + `avatar_url`
  (Profile.tsx:104-105).
  **Fix:** add column-level grants — `revoke update on public.player from authenticated; grant
  update (name, avatar_url) on public.player to authenticated;` — and keep the row-level RLS filter.
  (RLS `with check` cannot restrict *which columns* changed; column grants are the correct tool.)

- **Critical: `supabase/migrations/0001_init.sql:195-201` (`player self insert` / `player self
  delete`) — self-provision an admin row / no admin-onboarding path.** `player self insert` only
  checks `auth_user_id = auth.uid()` and does **not** constrain `is_admin`. Combined with
  `config.toml:169/211 enable_signup=true` + `216 enable_confirmations=false`, a complete stranger
  can: sign up with any (unverified) email → obtain an `authenticated` JWT → `insert into player
  (auth_user_id, name, email, is_admin) values (auth.uid(), 'x','x', true)` → become league admin.
  No email-match is required (claim_player is bypassed entirely by writing the table directly).
  The FE never inserts or deletes `player` rows (verified), so these two policies serve no
  legitimate flow — they are pure attack surface.
  **Fix:** drop `player self insert` and `player self delete`. Player rows are created by an
  admin-only path; see the related required finding below (there is currently *no* such path).

- **Critical: `supabase/migrations/0001_init.sql:204-210` (`entry self insert/update/delete`) —
  arbitrary entry mutation defeats geofence, payment, scoring and the leaderboard.** Same
  root cause: full-column write on any row where `player_id = auth_player_id()`, no status/column
  guard. A player can directly `update entry set status='winner', final_position=1, chopped=true,
  paid=true, chips=999999, checked_in_at=now(), made_final_table=true, points_earned=9999` on their
  own entry. Consequences, all reachable without any admin: (a) self-check-in bypassing the inline
  haversine geofence (`check_in` RPC becomes decorative); (b) self-confirm payment; (c) after a
  tournament is `completed`, `leaderboard()` sums `entry.points_earned` and counts wins/podiums off
  `final_position`/`chopped` **read straight from the row** — a player edits their completed entry
  and instantly inflates their season standing (nothing recomputes post-completion); (d) writing a
  bogus `final_position` on a live entry corrupts `N` and everyone's scores at completion. All four
  RPCs a player legitimately needs (`rsvp`, `cancel_rsvp`, `check_in`, `self_bust`) are SECURITY
  DEFINER and bypass RLS already, and the FE never writes `entry` directly (verified) — so these
  policies are unnecessary.
  **Fix:** drop `entry self insert`, `entry self update`, `entry self delete` entirely; keep only
  `read entry`. All player entry writes already go through the definer RPCs.

### Required

- **`supabase/migrations/*` — no admin path to onboard players (contract regression).**
  be-contract §Resolved 9 and plan step 4 state "admin pre-creates player rows (name/email); first
  login binds via `claim_player`". But `claim_player` (0002) only *binds existing* rows, and the
  only `player` INSERT policy is the self-insert one (which must be dropped, above). There is no
  admin-only `create_player`/invite RPC and the admin RLS does not permit inserting a row for
  another person (auth_user_id would be null ≠ admin's uid → `with check` fails). Net: outside the
  seed, admins cannot add members. Add an admin-guarded `create_player(name, email)` SECURITY
  DEFINER RPC (mirrors the other admin RPCs) so dropping the self-insert policy doesn't strand the
  onboarding flow.

- **`supabase/migrations/0003_points.sql:280-281`, `0004_prizes.sql:243`, `0011_profile.sql:113`,
  `0005_open_tournament.sql` (read helpers) — anon can execute SECURITY DEFINER read RPCs, leaking
  data past the "authenticated read" contract.** `leaderboard`, `player_profile`, `fn_pot`,
  `fn_final_table_size` are granted to `authenticated, service_role` but are **never revoked from
  PUBLIC**, and function creation grants EXECUTE to PUBLIC by default. Because they are SECURITY
  DEFINER (bypassing RLS), an unauthenticated caller holding the public anon key (shipped in the FE
  bundle) can call `rpc('leaderboard', …)` / `rpc('player_profile', …)` and read the full roster,
  avatars, points, and pot — contradicting be-contract §RLS "authenticated read on
  season/tournament/entry/leaderboard". (The admin RPCs correctly `revoke all … from public` first;
  these read helpers were missed.)
  **Fix:** `revoke all on function public.leaderboard(uuid) from public;` (and the same for
  `player_profile`, `fn_pot`, `fn_final_table_size`), relying on the explicit `authenticated` grant.

- **`supabase/migrations/0009_admin.sql:685-716` (`complete_tournament` chop path) — strands
  still-in-play players and completes with no rank / 0 points.** The chop branch validates that the
  supplied `p_chop_entry_ids` are in-play, but does **not** verify they are the *only* remaining
  in-play entries. If the admin chops K players while >K are still `playing`/`checked_in`, the
  leftover in-play entries keep `status='playing'` and `final_position=NULL` through completion:
  step (5) of `fn_tournament_points` assigns them 0, and the tournament is marked `completed` with
  players frozen mid-game. Either reject the call unless every in-play entry is in the chop set, or
  auto-assign finishing positions to the non-chopped remainder before completing.

- **`supabase/seed.sql:124-126` — Fecha 2 (live) eliminated positions are off-by-one vs the
  total−1 algorithm, so the very next `eliminate`/`self_bust` collides.** The two eliminated
  entries are seeded at `final_position` 8 and 7, but 7 entries are still in play (6 `playing` +
  1 `checked_in`; `fn_eliminate_entry` counts `checked_in` as alive — see 0009:341). The next bust
  computes `v_alive_incl=7` → assigns `final_position=7`, duplicating the existing pos-7 entry and
  producing two players at rank 7 in the standings order. To be consistent with total−1 over the 9
  seated players, the two busts should be positions 9 and 8. This breaks the primary demo path
  (open→live→eliminate) immediately.

### Optional / Consider

- **Optional: `supabase/migrations/0009_admin.sql:339-341` — `checked_in` counts as "alive" in
  total−1.** A player who checked in but never had payment confirmed (still `checked_in`, e.g. seed
  Diego) inflates `v_alive_incl` and can even be crowned winner (line 350-354) despite never
  `playing`. Consider counting only `playing` for the bust math, or requiring `paid` before a seat
  counts. Document whichever you choose (the pinned rule says "non-eliminated entries", which is
  ambiguous on checked-in-but-unpaid).

- **Optional: `supabase/migrations/0009_admin.sql:311-370` (concurrent busts).** Two simultaneous
  `self_bust`/`eliminate` calls both read the same `v_alive_incl` (no `SELECT … FOR UPDATE` / no
  serialization) → duplicate `final_position`. The spec explicitly accepts "optimistic placement;
  admin resolves order", so this is acknowledged — but a `FOR UPDATE` lock on the tournament's
  in-play entries would make it correct rather than reconciled-by-hand.

- **Optional: `supabase/migrations/0001_init.sql:40-57` — no constraint enforces a single active
  season.** The contract says "one active at a time"; nothing prevents two `season.status='active'`
  rows, and every "active season" lookup is `order by year desc limit 1` (silently picks one). A
  partial unique index `create unique index on season(status) where status='active'` would enforce
  the invariant.

- **Optional: `supabase/migrations/0010_admin_crud.sql:146-190` (`close_season`) — orphans
  unfinished fechas.** Archiving the active season does not touch its `scheduled`/`live`
  tournaments; they remain attached to an archived season. `open_tournament` (0005) never checks the
  season is active, so an archived-season fecha could still be opened. Consider blocking close while
  a live fecha exists, or cascading scheduled fechas.

- **Consider: `supabase/migrations/0009_admin.sql:441-498` (`undo_last_elimination`) &
  `227-247` (`confirm_payment`) don't guard tournament status.** Undo works on a `completed`
  tournament (points already written, status stays completed → inconsistent), and `confirm_payment`
  will flip an `eliminated`/`winner` entry back to `playing`. Add a `status='live'` / entry-status
  guard.

### Nit / FYI

- **FYI: idempotency style is inconsistent but fine for the run-once + `supabase db reset` model.**
  0001 uses bare `create type`/`create table`/`create policy` (would error on re-apply), while 0011
  storage policies use `drop policy if exists` first. Migrations are correctly ordered (0001→0011)
  and non-destructive (`close_season` archives, never deletes; no `drop table`). No action needed
  unless you expect to re-run a single migration outside a reset.

- **FYI: `config.toml` is the local-dev config** (site_url localhost, `enable_signup=true`,
  `enable_confirmations=false`, no committed signing keys — `signing_keys_path` is commented). These
  defaults are normal for local, but the Critical #2 escalation chain assumes they carry to prod;
  the durable fix is the RLS hardening (Criticals 1-3), independent of auth config. No secrets are
  committed.

- **Nit: `supabase/migrations/0009_admin.sql:145-151` (`clock` resume) & elsewhere** use
  `auth.role() = 'service_role'`, which is deprecated in favor of `auth.jwt()->>'role'` in newer
  Supabase. Low priority; works today.

## Axes checked
correctness ✓/✗ (✗: chop-subset stranding, seed position collision, checked-in-alive & single-
entrant & concurrent-bust edges — **core algorithms are correct**) ·
readability ✓ (thorough header comments, clear naming, no dead code) ·
architecture ✗ (RPC layer solid, but missing admin create_player path; RLS boundary under-designed) ·
security ✗ (touches-sensitive: **YES** — RLS/authz on player+entry, auth binding `claim_player`,
open-signup config, anon exec on read RPCs, avatar storage policies) ·
performance ✓ (tens of players / few fechas; leaderboard window funcs + FK indexes are adequate; no
N+1 or unpaginated-hot-path concern at this scale)

## Route to deeper passes
- **security-guidance**: RLS column-privilege model for `player`/`entry`; auth binding + open-signup
  interaction; anon reachability of SECURITY DEFINER read RPCs. (Strongly recommended — 3 Criticals.)
- performance: not needed at this scale.
