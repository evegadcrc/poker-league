# Design notes — poker-league-prototype

## Inputs
- mode: generate
- references: approved spec (.harness/specs/poker-league-prototype.md), CONTEXT.md glossary.
  Aesthetic direction chosen in /dh:grill: "Sports Almanac".

## Decisions
- Aesthetic: Sports Almanac — warm paper/ink + oxblood accent, ruled dividers, paper grain,
  editorial league-table character. Light + dark both first-class.
- Type: Bricolage Grotesque (display/wordmark) + Archivo (body + tabular figures for all
  stats/timer). Deliberately not Inter/Space Grotesk. Scoreboard-style tabular timer.
- Hand-written CSS with custom properties (no utility framework) for a designed, non-generic feel.
- Single self-contained index.html prototype: phone frame, bottom-tab IA (Liga / Fechas /
  En Vivo / [Admin] / Perfil), role toggle (Jugador/Admin), theme toggle. Mock data only.
- Screens: leaderboard (form pills), fecha detail (attendance + RSVP + geofenced check-in +
  all lifecycle status pills), live view (scoreboard timer/blinds/pot/standings), admin console
  (clock + player mgmt: paid/rebuy/reactivate/complete), profile (points history + full form),
  login (magic link).

## Verification log
- 2026-07-23 — iter 3, verify-ui Tier 2 (Playwright MCP). Branding + polish: rebranded "LA LIGA"
  → "POKER FRIENDS" (topbar, login, title, WhatsApp; kept "Liga" bottom tab). Added the community
  logo (prototype/poker-friends.jpg) as topbar mark + login hero, with per-theme framing (ink ring
  light / oxblood ring dark / magenta+cyan glow neon). Login simplified (removed overline + blurb,
  button → "Enviar enlace"). Admin Liga: button → "Cerrar liga actual" + confirmation modal
  ("no se puede deshacer"). Profile avatar smaller (54px). Admin sub-nav fits 3 tabs on one row
  (Consola / Nueva Fecha / Liga). Console: 0 errors. Screenshots in screenshots/iter3-branding-*.
- 2026-07-23 — iter 2, verify-ui Tier 2 (Playwright MCP). Applied review changes: photo avatars
  (+ profile change-photo), Premios block in live view, 3rd theme "Neón" (3-way theme cycle),
  form-guide recolor (oxblood/ink/gray monochrome) + legend, ante optional (hidden in live),
  chips-in-play stat + per-player chips/bonus, admin "marcar no-show", graduated late-cancel
  penalty (sheet + bands + settings; ghosting = −15 max), rebuy = re-entry only (playing → Eliminar,
  out → Reactivar), admin Create-Fecha + League/Season settings + season rollover sheet, WhatsApp
  copy-paste summary. Console: 0 errors. Screenshots in screenshots/iter2-20260723T130353/.
  Placeholder: points & prize distribution rules (open question, deferred to discussion→plan).
- 2026-07-23 — iter 1, verify-ui Tier 2 (Playwright MCP). Served over localhost:8777.
  Console: only a harmless favicon.ico 404, no JS errors. Fixed: JS naming collision
  (STAPI const+function) and a toast that peeked above the tab bar at rest. Screenshots of all
  6 screens in light + leaderboard in dark saved to screenshots/20260723T120655/.
  Tier 1 (chrome-devtools MCP) skipped — not loaded this session (added to .mcp.json, needs
  restart). Tier 3 (Chrome ext) not run. Tier 4 (human approval) — pending.
