# UI verification — poker-league-prototype (real "Poker Friends" app)

Run: 2026-07-23T22:08 (local) · branch `feat/poker-friends-phase1`
Scope: Tiers 1–3 of the /dh:verify-ui ladder on the live app (Vite dev @ http://localhost:5173, Supabase local stack). Tier 4 (human) stays with the orchestrator.
Screenshots: `.harness/notes/poker-league-prototype/ui-verify/20260723-220834/` (21 files, mobile 412×900 unless noted `desktop`).

## Tiers covered
- Tier 1 (DevTools MCP):   skipped — chrome-devtools server in `.mcp.json` but NOT loaded this session. Declared, not attempted.
- Tier 2 (Playwright MCP): ✓ — authenticated as ADMIN; all 7 screens + chop flow + desktop spot-check walked; console checked; light/dark/neón captured for Login, Leaderboard, En Vivo, Chop preview. Screenshots saved.
- Tier 3 (Claude ext):     skipped — Chrome extension not available this session.
- Tier 4 (Human):          pending — orchestrator presents screenshots + this report.

## Auth
- Logged in as **carlos.jimenez@example.com** — confirmed **is_admin = true** (Admin tab + admin-only CTAs render).
- Method: service-role `admin/generate_link` (type=magiclink) → single-use token verified **in-page** through the app's own Supabase client (`supabase.auth.verifyOtp`), which persists the session to localStorage; reload landed authenticated on the leaderboard.
- Two sanctioned paths were unavailable: (a) navigating the `action_link` redirects to the allow-listed `127.0.0.1:3000`, not the dev server (dead), and (b) the pure in-browser Mailpit read is blocked by CORS (`No Access-Control-Allow-Origin` from :55324). The verifyOtp path is equivalent-exposure to method (b) and keeps the access/refresh tokens out of the transcript. No source files were modified; no secrets written to the repo.

## Findings

### CHOP / "Completar fecha" flow (priority — never in the approved prototype)
- **Flow renders correctly.** "🏁 Completar fecha" opens a bottom-sheet dialog: heading, clear Spanish copy ("…seleccioná a los jugadores que reparten los primeros lugares (co-campeones)"), a checkbox list of the 7 in-play finalists with avatars + chip counts, and footer "Volver" / "Completar sin chop". Selecting ≥2 reveals a live split preview and the CTA switches to "Chop y completar (N)". Labels, layout, and theming (light/dark/neón) are all clean.
- **FINDING — money split shows "Dinero c/u ₡0".** For both 2-way (40 pts c/u) and 3-way (45 pts c/u) the money row reads **₡0**, despite a ₡200K pot. Root cause is a data gap, not a calc bug: `tournament.prizes` jsonb is **null for every seeded tournament** (verified via REST). `chopPreview()` (src/lib/admin.ts:69) sums `prizes[].amount`, so an empty prize array → ₡0. The league *does* define a payout split ("Reparto de premios (% top 3) = 60, 28, 12" in Liga settings), but it is never materialized into per-tournament `amount`s (pot × pct). Net effect: the preview presents a misleading ₡0 for a real chop. Recommend either materializing `tournament.prizes` from pot × league-pct when a tournament goes live, or having `chopPreview`/the UI fall back to pct×pot (or show "sin premios definidos") when amounts are absent. (admin.test.ts covers the calc with real amounts, so the unit path is fine.)
- **QUESTION — points scale up with chop size** (2-way = 40 pts each, 3-way = 45 pts each). Co-champions each earning *more* points as more players join the chop is counterintuitive; it follows from averaging `pointValueForPosition` over positions 1..k. Worth a product/domain confirmation — flagged, not asserted as a bug.

### Other screens
- **Login** (logged out): emblem + "POKER FRIENDS" + email textbox + "Enviar enlace" (disabled until email). ✓ All 3 themes.
- **Leaderboard (Tabla)**: 11 ranked rows (Carlos #1 · 105 pts · "· tú"), #/Jugador/Pts columns, form pills ("Racha reciente"), legend (Campeón/Podio/Mesa final/Fuera). ✓ All 3 themes + desktop.
  - **Could NOT verify "newest-on-RIGHT" pill order** — seed has only 1 played fecha, so each player shows a single pill. Re-verify once ≥2 fechas are completed.
- **Fechas list**: all 3 card variants present — Live (Fecha 2: 7/9 Quedan, ₡200K, "Entrar"), Próxima (Fecha 3: 5 Confirmados/4 Sin resp., ₡20K Buy-in), Jugada (Fecha 1: Carlos Campeón, 10 Jugadores, ₡220K). ✓
- **Fecha detail** (Fecha 3): back nav, Próxima badge, counts (5 Voy / 2 Cancelaron / 4 Sin resp.), RSVP actions (disabled "Check-in próximamente" + active "Cancelar"), roster grouped by status with pills + sub-labels ("· falta check-in", "· sin castigo"). ✓
- **En Vivo**: header "…· En juego" + Live badge; timer, blinds **SB/BB only — ante correctly hidden**; "Siguiente · Nivel N"; pot (₡200K / 7/9 Quedan / 97K fichas); Premios "según el pozo"; "Posiciones en vivo" (7 Vivo + 8º/9º eliminated); admin console link. ✓ All 3 themes.
  - Minor: /vivo showed "Nivel 3 / 00:00" while /admin showed "Nivel 4 / 19:xx" moments later — consistent with the clock auto-advancing at the level boundary (clock is running); the momentary 00:00 at a boundary could read as a stopped clock.
- **Admin console**: tabs (Consola/Nueva fecha/Liga); live clock (Nivel 4, counting) with controls (Pausar, ±1 min, Nivel ◀▶, Editar blinds); stats (₡200K / 7 En juego / 5 Mesa final); full player list with pay status, chips, recompra (↺), eliminated positions, and per-row actions (Confirmar pago / Eliminar / ↺ Recompra / No-show); Resumen; Deshacer; Completar fecha. ✓
- **Nueva fecha form**: nombre, fecha/hora, sede (geocerca lat/long + "usar mi ubicación"), radio check-in, buy-in/recompra, stack/bonus, recompra-hasta select, estructura de blinds, "Usar ante" switch (Normalmente sin ante), "Crear fecha". ✓
- **Liga settings form**: temporada, multiplicador (10), bonus Mesa Final/Top 3/Asistencia (5/8/2), tamaño mesa final, bonus llegada temprana (2000), castigo no-show (-15), reparto de premios % (60,28,12), cancel-penalty tiers, "Guardar ajustes", season close. ✓
  - Minor: the "Asistencia" input wraps to its own row below "Mesa Final / Top 3" — verify intended.
- **Perfil**: avatar "CJ" with camera badge ("Cambiar/Subir foto"), name + "105 pts · 1 jugada", stat tiles (Puntos/Jugadas/Títulos/Podios), "Historial de puntos" sparkline (rendered), "Racha completa" form pills, "Cerrar sesión". ✓

### Console
- **Clean of app-origin errors/warnings on every screen.** Only noise across the whole session: `favicon.ico` 404 (benign, cold-load only) and one `Access-Control-Allow-Origin` failure to Mailpit :55324 — that CORS error is from **my own auth probe**, a test artifact, not the app.

### Layout
- Desktop (1280px): the app stays a centered mobile-width column — intentional for a mobile-first PWA. Noted, not a defect.

## Skipped tiers
- **Tier 1 — DevTools MCP**: server declared in `.mcp.json` but not loaded this session; runtime a11y/perf/computed-styles pass not run. (Playwright console checks partly cover the runtime-sanity gap.)
- **Tier 3 — Claude Chrome extension**: not available; no pixel/aesthetic refinement pass. **Recommend running Tier 3 for a final aesthetic pass**, especially on the never-prototyped chop bottom-sheet.

## Next step
- Present screenshots + this report to the human (Tier 4). Priority decision: the chop **"Dinero c/u ₡0"** — confirm whether tournament prizes should be materialized from pot × league-pct (fix owner: build slice, not this verify pass) and confirm the points-per-chop direction. Re-verify form-pill "newest-on-right" once ≥2 fechas are played.

## Tier-4 resolution (2026-07-24)
- Finding #1 (chop/Premios ₡0): FIXED — migration 0013 auto-materializes `tournament.prizes` from
  the season template on open/payment/rebuy. Verified by integration test (chop `moneyEach>0`,
  prizes sum to pot, overrides preserved). No FE change needed. Commit 3c3044c.
- Finding #2 (chop points scale up with size): CONFIRMED INTENDED by product owner — no change;
  recorded in decisions.md.
- Remaining findings: non-issues or logged in followups.md (non-blocking).
- Verdict: Tier 2 PASS; Tier 1 (DevTools) + Tier 3 (Chrome ext) not available this run (declared).
  Tier 4 human: screenshots reviewed, product decisions made. UI APPROVED for ship.
