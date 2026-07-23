# Lessons — poker-league-prototype (task-local)

## Slice 1 — scaffold stack is bleeding-edge; respect these constraints
2026-07-23 · slice 1 · tags: build, stack, tailwind, typescript, lint

- **Tailwind v4** (CSS-first, `@tailwindcss/vite`) — NO `tailwind.config.js`, NO PostCSS. The
  plan said "+ PostCSS"; v4 doesn't need it. Theme tokens live in `src/styles/tokens.css`
  (ported from the approved prototype) — do NOT hand-edit token values; re-port if they change.
- **TypeScript 7.x (native compiler)** was auto-selected. `baseUrl` is removed in TS7 → path
  aliases use bare `paths` (`@/* → ./src/*`). Any dep needing `typescript <7` will conflict —
  pin TS to 5.x OR keep the current setup; decide before adding type-aware tooling.
- **Linter = oxlint** (`npm run lint`), not eslint/typescript-eslint (their peer range excludes
  TS7). It's a real gate; keep it.
- React 19, Vite 8, Vitest 4.
- **shadcn/ui:** `components.json` written manually (new-york, cssVariables, `@/*`); CLI not run
  (needs interactivity). Add primitives with `npx shadcn@latest add <name>` — pulls `lucide-react`.
- **Theme persistence key `pf-theme`** is shared between the `index.html` pre-paint script and
  `ThemeProvider` — keep them in sync to avoid a flash-of-wrong-theme.
- Vitest needs the in-memory `localStorage` polyfill in `src/test/setup.ts` (Node 25's
  experimental global `localStorage` shadows jsdom's).
- Verified commands: `npm run build` (`tsc -b && vite build`), `npm test` (`vitest run`),
  `npm run lint` (`oxlint src`). `npm run dev` is long-running — never a build gate.

## Slice 4 — transient Kong/auth 502 after `supabase db reset`
2026-07-23 · slice 4 · tags: supabase, docker, local-stack

After `supabase db reset` restarts containers, the auth service behind Kong can briefly 502.
Fix: `docker restart supabase_auth_poker-league supabase_kong_poker-league`, then retry. Any
DB-touching slice that resets the stack should expect this and restart those two containers if a
502 hits right after reset.

- Auth binding: `AuthProvider` calls `claim_player()` on first session; `useAuth().player` is the
  bound row, `useRole().isAdmin` gates admin UI. Screens read the current player via `useAuth()`.
- Local ports: API 55321, DB 55322, Studio 55323, Mailpit 55324.

## Slice 5 — scoring model + a FE rendering gotcha
2026-07-23 · slice 5 · tags: points, leaderboard, sql, frontend

- `leaderboard(season_id)` RPC returns each player's `form` array **most-recent-first (index 0 =
  latest game)**. The approved prototype renders form pills **newest-on-the-RIGHT** → the leaderboard
  UI (slice 8) must REVERSE the array (or render right-to-left). Don't show it as-is.
- N = field size = entries with non-null `final_position` (no-shows/cancels excluded from N). P =
  final_position (1=champion). Attendance bonus gated on `paid`. no_show_penalty stored signed (−15).
- Chop: all group members get `round(avg §5 point-values))` and `entry.chopped=true` → counted as
  champions in wins/podiums/form. Podiums = positions 1–3 (includes wins).
- `fn_tournament_points` is `service_role`-only (slice-12 admin RPC calls it); `leaderboard` is granted
  to `authenticated`.

## Slice 7 — final_table_size recompute cadence (DEPENDENCY for slices 10 & 12)
2026-07-23 · slice 7 · tags: open-tournament, final-table, dependency

`open_tournament` opens the fecha **paused** at level 1 and stores a PROVISIONAL `final_table_size`
(most players haven't checked in yet). A helper `recompute_final_table_size(tournament_id)`
(service_role-only) recounts `checked_in_at IS NOT NULL` and re-resolves via `fn_final_table_size`.
**MUST be honored by later slices:**
- **Slice 10 (`check_in`)** → call `recompute_final_table_size` after each successful check-in.
- **Slice 12 (`complete_tournament`)** → call it once after flipping ghosts→no_show, before points.
- Slice-12 eliminate reads the stored `tournament.final_table_size` column.
Backend migrations complete through 0005 (0001 schema/RLS/seed · 0002 auth · 0003 points · 0004
prizes · 0005 open_tournament). Slices 8-16 are the React screens.
