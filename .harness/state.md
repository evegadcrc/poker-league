---
goal: Build "Poker League" PWA (React+Vite+TS+Tailwind+shadcn / Supabase) per poker-league-app-plan.md — Phase 1 first
task: poker-league-prototype
step: build
progress: 64%
blockers: none
updated: 2026-07-24T00:10:00Z
---

## What we're doing
UI-first design for the Poker League Phase 1 prototype. Grilling complete; spec approved at
.harness/specs/poker-league-prototype.md. Aesthetic locked: "Sports Almanac" (paper/ink +
oxblood, big grotesk, tabular figures), light + dark first-class, identity from scratch.

## Last action
/dh:run autopilot. Slices 1-7 DONE + verified (…, 6047863). BACKEND COMPLETE (migs 0001-0005).
Slice 7: open_tournament (opens paused@L1, provisional final_table_size + recompute helper).
28 tests green. DEPENDENCY logged: slice 10 check_in + slice 12 complete MUST call
recompute_final_table_size (see lessons.md).

## Next step
/dh:run continues — slice 8/16: Leaderboard (Tabla) screen. src/routes/Leaderboard.tsx +
PlayerRow/FormPills/Legend/Avatar, consumes leaderboard RPC. MUST reverse form array (RPC is
most-recent-first; render newest-on-RIGHT). Match prototype Tabla. RTL test.
