# Review iter 1 — poker-league-phase2 / ui21 (FOCUSED LENS: data-migration)
Diff: d012827..HEAD -- supabase/migrations/0018_form_positions_odds.sql, 1 file, +146/-0
Lens: data-migration ONLY (other axes owned by separate passes)
Verdict: CLEAN

Migration 0018 runs on shipped 0001–0017. It (1) adds `tournament.odds_enabled`
and (2) DROPs + recreates `leaderboard(uuid)` to widen the RETURNS TABLE with
`form_positions int[]`. The latest prior definition is **0015** (0015 replaced
0014 replaced 0003) — the dispatch's "0003+0014" is stale; 0015 is the true
baseline and the header correctly cites it.

## Findings

- Nit: `0018_form_positions_odds.sql:12-14` — Header claims the recreate is
  "byte-for-byte from 0015's definition; the ONLY additions are `form_positions`
  and the `array_agg(final_position …)`." That is very nearly true, but there is
  ALSO a non-additive change the sentence omits: `search_path` went from 0015's
  `set search_path = public` to `set search_path = public, pg_temp` (line 55).
  The change is correct and beneficial (see FYI below) and the header DOES note
  it separately at line 33, but the "ONLY additions are…" phrasing will mislead a
  future maintainer who diffs 0015→0018 trusting that claim. Reword to "…plus the
  search_path is tightened to the 0012 idiom (`public, pg_temp`)."

- FYI: `0018:55` — search_path change `public` → `public, pg_temp` is a security
  IMPROVEMENT, not a regression. For a SECURITY DEFINER fn, if `pg_temp` is not
  listed it is implicitly searched FIRST for relation names, so a caller could
  create a temp table named `entry`/`tournament`/`player` and have this fn read
  the attacker's table. Listing `pg_temp` LAST (the 0012 idiom) closes that.
  Because every table ref in the body is schema-qualified (`public.entry` etc.)
  and all funcs used (row_number/array_agg/coalesce) live in pg_catalog, the
  change produces NO result drift — confirmed empirically (0 mismatches). NOTE
  (out of scope for 0018): 35 other SECURITY DEFINER fns in 0003–0017 still use
  bare `set search_path = public` and carry the same latent temp-shadowing risk;
  worth a follow-up hardening migration, but that is a pre-existing condition,
  not introduced here.

- FYI: `0018:38-40` — `odds_enabled boolean not null default true`: no table
  rewrite / no long lock concern even on a large table. In PG11+ a NON-VOLATILE
  constant default (`true`) is stored in the catalog (attmissingval) and applied
  virtually on read; ADD COLUMN takes only a brief catalog-level lock and does
  NOT rewrite existing rows. Backfill is automatic. Verified: 0 null rows.

- FYI: return-shape change is backward-compatible. Adding a column to the
  RETURNS TABLE does not break PostgREST/supabase-js consumers that select named
  columns; `select *` consumers just gain a column. Generated types were kept in
  sync — `src/lib/database.types.ts:837` already has `form_positions: number[]`.

## What I verified (all PASS)

Recreate fidelity vs 0015 (latest prior def, lines 492–588):
- roster CTE (roster-at-0 fallback via `union … not exists`): IDENTICAL.
- finished CTE incl. `t.counts_for_league` (0015 STEP 7) + `status='completed'`: IDENTICAL.
- agg CTE (total_points/games_played/wins/podiums/last_finish, all the same
  FILTER predicates incl. `final_position=1 or chopped`, `chopped or 1..3`): IDENTICAL.
- form_rows tier CASE (champion/podium/final/out) + window
  `order by scheduled_at desc, id desc`: IDENTICAL; only adds `f.final_position as pos`.
- form_agg: `array_agg(tier order by rn)` UNCHANGED; adds
  `array_agg(pos order by rn) as form_positions` from the SAME CTE, SAME
  `order by rn`, SAME `where rn <= 5` → aligned index-for-index by construction.
- final SELECT / ORDER BY (points, wins, podiums, last_finish nulls last, name):
  IDENTICAL; only adds `coalesce(fa.form_positions, array[]::int[])`.
- `final_position` is `int` (0001:127) → `array_agg(pos)` yields `int[]`, matches
  declared `form_positions int[]` — no cast mismatch. Confirmed in DB: return type
  `… form_positions integer[]`.

DROP safety:
- No view/rule/function depends on `leaderboard(uuid)` — pg_depend query returned
  0 dependents; grep shows only grants + client TS. DROP without CASCADE is correct
  (and would fail loudly rather than silently cascade if a dependent existed).
- Grants re-asserted after recreate; DB shows EXECUTE = {authenticated,
  service_role, postgres-owner} only — anon/PUBLIC correctly absent (matches 0012/0015).
- `security definer` preserved (prosecdef = t).

Idempotency / ordering:
- `add column if not exists` — idempotent.
- `drop function if exists` precedes bare `create function` — safe on re-run
  (can't CREATE OR REPLACE with a changed return type, so DROP is required/justified).
- Migration numbering: no dupes/gaps around 0018.

## Empirical (local Supabase @127.0.0.1:55322, read-only queries)
- Fn signature/config/secdef: `form_positions integer[]`, `search_path=public, pg_temp`, secdef=t. ✓
- odds_enabled: boolean NOT NULL default true; 0/3 null rows (all backfilled). ✓
- Alignment cross-check vs independent re-derivation over season
  a5000000-…-0001 (10 finishers): **0 position_mismatches, 0 form_mismatches**
  across 11 players; pairing correct (champion→1, podium→2, podium→3, final→4/5,
  out→6..10; no-show player → form={} & form_positions={}).
- Roster-at-0: `leaderboard('<empty season>')` returns all 12 players at 0 with
  empty form AND empty form_positions. ✓
- Multi-game rn<=5 cap / most-recent ordering not exercisable empirically (only 1
  completed league fecha in local data), but is structurally guaranteed: the
  already-shipped/tested `form` array and the new `form_positions` share the exact
  same CTE, window, `rn<=5` filter and `order by rn`.

## Axes checked (focused lens)
data-migration ✓ — recreate fidelity, position alignment, DROP/grant safety,
odds_enabled backfill/lock, idempotency, search_path all verified clean.
(other axes intentionally not reviewed — separate passes own them)
