---
goal: Build "Poker League" PWA (React+Vite+TS+Tailwind+shadcn / Supabase) per poker-league-app-plan.md — Phase 1 first
task: poker-league-prototype
step: build
progress: 68%
blockers: none
updated: 2026-07-24T00:40:00Z
---

## What we're doing
UI-first design for the Poker League Phase 1 prototype. Grilling complete; spec approved at
.harness/specs/poker-league-prototype.md. Aesthetic locked: "Sports Almanac" (paper/ink +
oxblood, big grotesk, tabular figures), light + dark first-class, identity from scratch.

## Last action
/dh:run autopilot. Slices 1-8 DONE + verified (…, b7ad224). Slice 8: app shell (AppLayout topbar +
bottom nav, Admin tab role-gated) + Leaderboard wired to RPC (form reversed newest-on-right) +
states. 37 tests green. App renders end-to-end now (placeholders for Fechas/Live/Perfil).

## Next step
/dh:run continues — slice 9/16: Fechas list + Fecha detail + RSVP. Adds mig 0006 rsvp/cancel_rsvp
RPCs (cancel = graduated band penalty by now vs scheduled_at; BOTH reject when status!='scheduled'
= RSVP lock). FE: Fechas cards + attendance grouped by status + pills. Check-in wired in slice 10.
