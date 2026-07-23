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
