# Poker League

Mobile-first web app (PWA) for a friends' Texas Hold'em league: tracks points across a
season of tournaments (game nights), runs a live tournament clock, and keeps a season
leaderboard with a sports-style "form guide."

**Spec / source of truth:** `poker-league-app-plan.md`
(Google Doc: https://docs.google.com/document/d/1iG4WToRJuLPkv0_AWnwOrtUSUHFDkGj_7MLNvpYSVBw)
Sections §4–§9 define the schema, points engine, live-timer architecture, elimination
logic, and RLS. §11 lists open questions still to be resolved before/while building.

## Status

🟢 **Scaffolded (slice 1).** Vite + React + TypeScript app at repo root with the 3-theme
design system (Sports Almanac light/dark + Neón) ported from the approved prototype. Build,
test, and lint commands below are **verified**. Backend (Supabase), auth, and screens land in
later plan slices.

## Stack

- **Frontend:** React + Vite + TypeScript + Tailwind CSS
- **UI kit:** shadcn/ui + lucide icons
- **Backend / DB:** Supabase (Postgres) — "backend" is mostly SQL + row-level security
- **Auth:** Supabase Auth, passwordless magic link (Option A; Option B = name + 4-digit PIN)
- **Realtime:** Supabase Realtime (live timer / blinds / eliminations sync)
- **Storage:** Supabase Storage (photo galleries + tournament covers)
- **Hosting:** Vercel or Netlify (PWA-friendly)
- **Package manager:** **npm** (lockfile: `package-lock.json`, committed)

## Commands (verified — slice 1)

- Install: `npm install`
- Dev server: `npm run dev`          # Vite; long-running, do not use as a build gate
- Build: `npm run build`             # `tsc -b && vite build` — typecheck + production bundle
- Test: `npm test`                   # `vitest run` (non-watch); `npm run test:watch` to watch
- Lint: `npm run lint`               # `oxlint src`
- Supabase (local): `supabase start` / migrations via `supabase db push` (Supabase CLI — added in a later slice)

**Toolchain notes (slice 1):** TypeScript **7.x** (native compiler) — `baseUrl` is removed in
TS7, so path aliases use bare `paths` (`@/* → ./src/*`). Linter is **oxlint** (not
eslint/typescript-eslint, which don't yet support TS7's peer range). shadcn/ui `components.json`
is present (new-york, cssVariables, `@/*` alias) but its CLI was not run — add components with
`npx shadcn@latest add <name>` as needed. Vitest uses an in-memory `localStorage` polyfill in
`src/test/setup.ts` (Node 25's experimental global `localStorage` shadows jsdom's).

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

- **Design tokens are the source of truth.** The three themes live in `src/styles/tokens.css`
  (ported verbatim from the approved prototype); the 3-way cycle + persistence is in
  `src/lib/theme.tsx`. Do not hand-edit token values — re-port from the prototype if they change.
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
