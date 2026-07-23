---
goal: Build "Poker League" PWA (React+Vite+TS+Tailwind+shadcn / Supabase) per poker-league-app-plan.md — Phase 1 first
task: poker-league-prototype
step: build
progress: 72%
blockers: none
updated: 2026-07-24T00:40:00Z
---

## What we're doing
UI-first design for the Poker League Phase 1 prototype. Grilling complete; spec approved at
.harness/specs/poker-league-prototype.md. Aesthetic locked: "Sports Almanac" (paper/ink +
oxblood, big grotesk, tabular figures), light + dark first-class, identity from scratch.

## Last action
/dh:run autopilot. Slices 1-9 DONE + verified (…, 6e1c26e). Slice 9: mig 0006 rsvp/cancel_rsvp
(status-locked, graduated penalty 0/−5/−10/−15, idempotent) + Fechas cards + FechaDetail
(/fechas/:id) attendance/pills/CancelSheet. 66 tests green.

## Next step
/dh:run continues — slice 10/16: geofenced check-in. Mig 0007 check_in(id,lat,lng) — require
status=live, haversine vs venue±radius, early_bird+bonus chips, admin_check_in override, and MUST
call recompute_final_table_size after each check-in (slice-7 dependency). FE: geolocation +
states + "+2.000 fichas" moment.
