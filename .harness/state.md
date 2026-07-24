---
goal: Build "Poker Friends" PWA (React+Vite+TS+Tailwind / Supabase) — Phase 2 (refinements + odds calc, sound, gallery/learning)
task: poker-league-phase2
step: review
progress: 85%
blockers: none
updated: 2026-07-24T08:00:00Z
---

## What we're doing
PHASE 2 fully BUILT + test-green, NOT yet reviewed. Plan approved. PR #1 MERGED → main; Phase 2 on
branch feat/poker-friends-phase2. Track A (steps 1-8) + Track B (steps 9-15) built via 12 delegated
slices, both test-gate green. Ran in --steps mode so simplify + review-loop were deferred by design.

## Last action
SIMPLIFY + REVIEW-LOOP done (both skipped by --steps mode earlier; ran explicitly). Simplify: 1
extraction (191b670 deriveLiveSignal). Review-loop PER-TRACK (full diff 7451 lines >> 1000 gate):
- Track A APPROVED (2 iters; panel five-axis+security+data-migration). Found+fixed 1 CRITICAL RLS
  privilege-escalation (tournament writes were not admin-only → a non-admin could self-create a fecha,
  become its tournament-admin, inject season points → mig 0017 restricts writes to auth_is_admin;
  escalation verified closed via psql) + 1 required (multi-bust ≥1 survivor) + 1 optional (backfill
  non-array guard). Commits 329d02d, bc0afca.
- Track B APPROVED (2 iters; panel five-axis+security). No Critical. Fixed 2 required (elimination-cue
  winner-exclusion test; gallery bucket MIME/size cap) + 1 optional (evaluator 5/6-card tests) + nit
  (quote cover url). Commits e0ad526, d012827.
Test gate GREEN 317 passed / 1 skipped from clean db reset. 18 commits on branch. Record:
.harness/notes/poker-league-phase2/review-loop.md; residuals in followups.md.

## Next step
VERIFY-UI then SHIP. Track B is net-new UX (design was skipped) → /dh:verify-ui the new screens
(Calculadora `%`, Aprende `?`, sound settings in Perfil, gallery/cover in FechaDetail, Seasons) in all
3 themes before ship. Then ship as STACKED PRs: Track A (PR #2) then Track B (PR #3) off main. Local
Supabase up; dev server :5173. Followups: gallery mobile-upload pass (HEIC+downscale), private bucket.
