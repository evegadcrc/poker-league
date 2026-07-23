---
goal: Build "Poker League" PWA (React+Vite+TS+Tailwind+shadcn / Supabase) per poker-league-app-plan.md — Phase 1 first
task: poker-league-prototype
step: build
progress: 76%
blockers: none
updated: 2026-07-24T01:20:00Z
---

## What we're doing
UI-first design for the Poker League Phase 1 prototype. Grilling complete; spec approved at
.harness/specs/poker-league-prototype.md. Aesthetic locked: "Sports Almanac" (paper/ink +
oxblood, big grotesk, tabular figures), light + dark first-class, identity from scratch.

## Last action
/dh:run autopilot. Slices 1-10 DONE + verified (…, 0139ee0). Slice 10: mig 0007 check_in (live-gate,
haversine, early_bird+chips, recompute) + admin_check_in + FE geolocation/states/"+2.000 fichas".
82 tests green. Note: pre-existing lint warnings on test-mock `then` pattern → simplify pass.

## Next step
/dh:run continues — slice 11/16: Live view (En Vivo) + realtime. src/routes/Live.tsx state-based
timer (client computes remaining), blinds (hide ante when ante_enabled=false), fn_pot, Premios
(tournament.prizes), standings; subscribe tournament:{id}+entries:{id}. Ground Realtime v2 in docs.
