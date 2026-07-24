# Poker Friends — Phase 1

Mobile-first PWA for a friends' Texas Hold'em league (Costa Rica). Season leaderboard,
scheduled game nights with RSVP + geofenced check-in, a live tournament clock, an admin
console, and a distinctive "Sports Almanac" + "Neón" theme system. Built via the dh harness
(grill → design → plan → build → test → simplify → review-loop → verify-ui).

## What changed
Complete Phase-1 app on a clean greenfield repo:
- **Backend (Supabase, 13 migrations):** schema + RLS, magic-link auth + first-login player binding,
  points/leaderboard engine (§5 formula + chop/co-champions + penalties + dynamic final table),
  pot + prize distribution (auto-materialized from the league template, ₡5.000 rounding), tournament
  lifecycle RPCs (open, RSVP + graduated cancel penalty, geofenced check-in + early-bird bonus,
  clock, eliminate/self-bust/undo, rebuy re-entry, mark-no-show, complete + chop), season CRUD +
  rollover, profile + avatar storage. Security-hardened RLS (players SELECT-only; all writes via
  guarded SECURITY DEFINER RPCs).
- **Frontend (React 19 + TS + Tailwind v4):** leaderboard, fechas list + detail (RSVP), geofenced
  check-in, live view (state-based timer, blinds, pot, Premios, standings, realtime), admin console
  (clock + player management + chop flow), Create-Fecha + League settings, profile, self-report bust,
  WhatsApp summary. Three themes (Almanaque claro/oscuro + Neón), installable PWA.

## Why
Implements `.harness/specs/poker-league-prototype.md` and the approved plan
`.harness/plan/poker-league-prototype.md`. Product decisions in `.harness/decisions.md`.

## How to verify
- `npm install` → `npm run build` (green) · `npm run lint` (clean) · `npm test` → **201 passed / 1
  skipped** (from a clean `supabase db reset`; local Supabase stack required for the integration tests).
- Local run: `supabase start` + `npm run dev`; log in via magic link (Mailpit at the local stack).

## Review & verification
- **`/dh:review-loop`: APPROVED** (3 iterations, 3-reviewer panel). It caught and fixed 3 **critical
  RLS privilege-escalations** (a player could self-set `is_admin`; players could rewrite entry
  columns) and an auto-advance double-fire regression. Full record: `.harness/notes/.../review-loop.md`.
- **`/dh:verify-ui`: Tier 2 (Playwright) passed** — all screens toured as admin, console clean, 21
  screenshots in `.harness/notes/.../ui-verify/`. Tier 1 (DevTools) + Tier 3 (Chrome ext) unavailable
  this run. Tier 4 (human): approved; the chop-money ₡0 finding was fixed (prizes auto-materialize).

## Risks / known issues (deferred to Phase 2 by the product owner)
- **`close_season` is broken** (Liga screen can go blank on rollover) — fix + seasons-list UI are the
  first Phase-2 items. Documented in `.harness/plan/poker-league-refinements.md`.
- Prize distribution is currently per-league; moving to per-fecha (variable places) is Phase 2.
- Simultaneous multi-bust position rule, standalone (non-league) fechas, and minor copy/currency
  fixes are Phase 2. Other non-blocking items in `.harness/notes/.../followups.md`.
- App is mobile-width-locked (intentional); no live per-hand chip tracking (fichas = buy-in chips).

## Not included (Phase 2/3)
Odds/hand calculator, sound & notifications, memorable-hands gallery, history cover cards, learning
section, i18n toggle, offline-beyond-shell, deployment to hosted Supabase.
