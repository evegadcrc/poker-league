---
goal: Build "Poker League" PWA (React+Vite+TS+Tailwind+shadcn / Supabase) per poker-league-app-plan.md — Phase 1 first
task: poker-league-prototype
step: build
progress: 55%
blockers: none
updated: 2026-07-23T23:10:00Z
---

## What we're doing
UI-first design for the Poker League Phase 1 prototype. Grilling complete; spec approved at
.harness/specs/poker-league-prototype.md. Aesthetic locked: "Sports Almanac" (paper/ink +
oxblood, big grotesk, tabular figures), light + dark first-class, identity from scratch.

## Last action
/dh:run autopilot. Slices 1-5 DONE + verified (…, f143ba7). Slice 5: scoring engine (mig 0003) —
fn_final_table_size, fn_tournament_points (§5 + penalties + chop=co-champions), leaderboard RPC.
19 tests green. NOTE for slice 8: leaderboard form array is most-recent-FIRST; prototype renders
newest-on-the-RIGHT → reverse it. N=field size (non-null final_position); no_show stored −15.

## Next step
/dh:run continues — slice 6/16: pot + prizes SQL (mig 0004). fn_pot (COALESCE override, paid·buy_in
+ rebuys·rebuy_amount); set_prizes (payout_template×pot, round nearest ₡5.000, 1st absorbs remainder
→ sum=pot); admin override preserved. Tests: 60/28/12 on ₡140K → 85/40/15K.
