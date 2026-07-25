# Poker Friends — Phase 2

Builds on the shipped Phase 1 (PR #1). Fixes the shipped `close_season` bug, moves prize
distribution to per-fecha, adds simultaneous multi-bust + standalone fechas, and ships three
new feature areas — a client-side odds/hand calculator, sound & notifications, and a
gallery/learning layer — plus a batch of UI refinements. Built + reviewed via the dh harness
(build → test → simplify → review-loop per track → verify-ui).

## What changed

**Track A — refinements + the close_season bug fix (migrations 0014–0015, 0017)**
- `close_season` single-active integrity (partial unique index + repair + archive-all) and a
  resilient Liga read; leaderboard roster-at-0 for empty seasons; seasons-list UI.
- Per-fecha `payout_distribution` (turnout-scaled seeding, fallback) + an admin distribution
  editor (Create-Fecha + live) + proposed split in the live view.
- Simultaneous multi-bust (ordered + dead-even tie-split via `chop_group`, no co-champion
  mislabel) + standalone fechas (`counts_for_league`).
- Copy/currency: `En juego`, `₡`, `fichas iniciales`.
- **Security:** migration `0017` restricts all `tournament` writes to admins (a review found a
  privilege-escalation where a non-admin could self-create a fecha and inject season points).

**Track B — new features (migration 0016)**
- Odds/hand calculator: a seeded Monte-Carlo equity engine in a Web Worker + a visual card
  picker; native (non-image) hand-rankings reference; an **Aprende** learning section.
- Sound & notifications: a Web-Audio synth cue engine (mute/volume) firing off tournament
  **state changes** (level / open / elimination), in-app toasts + permission-gated local
  notifications.
- Gallery: per-fecha photo gallery + tournament cover cards (Storage bucket, RLS, MIME/size caps).

**Track 2.1 — UI refinements (migration 0018)**
- Form pills show the finishing **number** (leaderboard positions); centered/aligned Tabla stat
  columns; centered login email + RSVP + Legend.
- Completed fecha: place + points earned, 2nd/3rd medals, no-show penalty, and a **Premios**
  section (chop-aware split amounts).
- Fecha info card (points formula + worked example + bonuses + entry/stacks); editable date/time
  on scheduled fechas; thousand-separator money inputs + defaults + "Guardar ajustes".
- Per-fecha **odds-calculator enable/disable** toggle + live gate ("disable while playing").

## Why
Implements `.harness/plan/poker-league-phase2.md` (approved via `/dh:review-plan`). Product
decisions in `.harness/decisions.md`.

## How to verify
- `npm install` → `npm run build` (green) · `npm run lint` (clean) · `npm test` → **350 passed /
  1 skipped** (from local Supabase; integration tests need the local stack).
- Local run: `supabase start` + `npm run dev`; magic-link login via Mailpit.

## Review & verification
- **`/dh:review-loop`: APPROVED for all three tracks** (per-track panels — five-axis + security +
  data-migration — since the full diff far exceeds the single-PR review gate). Caught + fixed: a
  **critical RLS privilege-escalation** (mig 0017), a multi-bust survivor guard, gallery upload
  caps, and a mid-field-tie prize-money split. Full record: `.harness/notes/poker-league-phase2/review-loop.md`.
- **`/dh:verify-ui`: PASSED** — Playwright, admin login, mobile viewport, all priority screens in
  all 3 themes, console clean; 20 screenshots in `.harness/notes/poker-league-phase2/ui-verify/`.

## UI verification
Tiers: DevTools ✓ · Playwright ✓ (20 screenshots) · Human ✓ (product owner drove the changes)
Evidence: `.harness/notes/poker-league-phase2/ui-verify/20260724-180103/`

## Risks / known issues (deferred to followups)
- Gallery upload needs a mobile pass (HEIC + client-side downscale); consider private bucket + signed URLs.
- Profile "Racha completa" pills show color only (numbers landed on the Tabla).
- Máx-recompras + bonus-stack are saved form defaults, not yet enforced/persisted per fecha.
- Two cosmetic product calls open (co-champion pill number; Pendiente-Pago on non-alive rows).
- No background/web push (Phase 3); go-live still needs hosted Supabase + SMTP + FE deploy.

## Not included (Phase 3)
Web/push notifications, full PWA offline, i18n toggle, live per-hand chips, desktop layout,
payment processing.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01KKUxyb1xi2eH1fbrUVFUcG
