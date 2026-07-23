# Poker League

Mobile-first web app (PWA) for a friends' Texas Hold'em league: tracks points across a
season of tournaments (game nights), runs a live tournament clock, and keeps a season
leaderboard with a sports-style "form guide."

**Spec / source of truth:** `poker-league-app-plan.md`
(Google Doc: https://docs.google.com/document/d/1iG4WToRJuLPkv0_AWnwOrtUSUHFDkGj_7MLNvpYSVBw)
Sections §4–§9 define the schema, points engine, live-timer architecture, elimination
logic, and RLS. §11 lists open questions still to be resolved before/while building.

## Status

🟡 **Greenfield — not yet scaffolded.** No source code, no commits, no package manager
lockfile yet. The stack and commands below are the *intended* setup from the plan and are
**unverified** — they must be re-confirmed (and this file updated) once the app is
scaffolded. Do not trust the Commands section as a quality gate until then.

## Stack (intended)

- **Frontend:** React + Vite + TypeScript + Tailwind CSS
- **UI kit:** shadcn/ui + lucide icons
- **Backend / DB:** Supabase (Postgres) — "backend" is mostly SQL + row-level security
- **Auth:** Supabase Auth, passwordless magic link (Option A; Option B = name + 4-digit PIN)
- **Realtime:** Supabase Realtime (live timer / blinds / eliminations sync)
- **Storage:** Supabase Storage (photo galleries + tournament covers)
- **Hosting:** Vercel or Netlify (PWA-friendly)
- **Package manager:** TBD — decide on scaffold (Vite default = npm; pick one and record the lockfile here)

## Commands (intended — NOT YET VERIFIED)

Placeholders until the Vite app exists. Re-verify each against the real `package.json`
`scripts` during the first build slice, then update this section.

- Install: `npm install`
- Dev server: `npm run dev`
- Build: `npm run build`
- Lint: `npm run lint`            # not yet configured — no real quality gate yet
- Test: _none configured yet_     # add a runner (e.g. Vitest) and record the invocation here
- Supabase (local): `supabase start` / migrations via `supabase db push` (Supabase CLI, TBD)

## Conventions

- **Commits:** conventional format (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`),
  one logical change per commit.
- **Language:** code, comments, and commit messages in **English**. **UI-facing copy in
  Spanish by default** (league is in Costa Rica; formula terms are Spanish) — pending the
  §11 open question on whether to support a toggle.
- **Timer must be state-based:** store `level_started_at` / `is_paused` /
  `paused_remaining_seconds` / `current_level`; clients compute the display locally and only
  state changes write to the DB. Never broadcast every tick (§8).
- **Points formula (§5):** `Puntos = (N − P) * multiplier + BonusMesaFinal + BonusTop3 + BonusAsistencia`.
  Bonus semantics (§11 Q2) still open — confirm before implementing the engine.

## Gotchas

- **No code yet.** Bootstrap set up the harness only; nothing has been scaffolded or run.
- **Supabase secrets:** the app needs env vars (Supabase URL + anon key, plus a service-role
  key for admin/migrations). Keep them in `.env` / `.env.local` — never commit them. Only the
  anon key is safe client-side; the service-role key must stay server-side/local only.
  `.gitignore` already covers `.env*` (see below).
- **Open questions (§11)** must be answered before building the affected pieces: UI language,
  bonus semantics, final-table size, auth option (A/B), rebuy rules, pot override,
  timer auto-advance, tiebreakers, single vs. multi-league, who can eliminate.
- **Build order (§10):** Phase 1 = auth → league/tournament CRUD → registration (paid/rebuy)
  → live view → admin console → leaderboard with form guide. Phases 2–3 are fast-follow/polish.

## Harness

`.harness/` holds the cross-session protocol (state, decisions, corrections, lessons, plans,
notes). Committed except `.harness/audit/` and `.harness/.runtime/` (gitignored).
