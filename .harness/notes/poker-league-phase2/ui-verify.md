# UI verification — poker-league-phase2 (Phase 2 + 2.1)

Run: 2026-07-24T18:01 (local) · mobile viewport 430×932 · logged in as ADMIN (Edwin Vega, magic-link)

## Tiers covered
- Tier 1 (DevTools MCP):    — not used; ran Tier-1-equivalent runtime checks via Playwright (console + computed-style probes).
- Tier 2 (Playwright MCP):  ✓ all priority screens driven + screenshotted; console checked per screen. Screenshots in ./ui-verify/20260724-180103/ (20 files).
- Tier 3 (Claude ext):       — not run this pass.
- Tier 4 (Human):            pending.

## Console
Clean. Only benign entries across the whole session:
- `favicon.ico` 404 (no favicon asset) — cosmetic.
- `auth/v1/token?grant_type=refresh_token` 400 — one-time, cold load before login (no session to refresh). Expected.
No app/runtime errors on any screen.

## Per-screen findings

1. **Login** — PASS. Email input `text-align: center` (verified computed style + visual). Placeholder `tu@correo.com` centered.
2. **Clasificación/Tabla** — PASS (all 3 themes). Form pills show finishing NUMBER inside each pill, colored by tier: 1=Campeón (red/pink), 2–3=Podio (dark/cyan), 4–5=Mesa final (beige/purple), 6+=Fuera (gray). PJ/Tít/Pts columns centered + aligned across all rows.
3. **Calculadora** — PASS (rankings in all 3 themes). Card picker works (selected A♠/K♥, used cards greyed in grid). Rivales stepper caps at 10 (Más button disabled at 10, counter shows 10). Probabilities compute (15/2/83%). Hand-rankings reference renders native + crisp in claro / oscuro / Neón.
4. **Aprende** — PASS (oscuro). Learning content (Las ciegas, Rondas de apuestas, En tu turno) + full 10-hand rankings reference with example cards.
5. **Temporadas** — PASS (oscuro). Liga 2026 card with ACTIVA badge on top; "Ver tabla" link. Single season in seed.
6. **Nueva fecha** (admin) — PASS (oscuro). Money inputs show "." thousand separators + ₡ prefix. Defaults correct: Buy-in ₡10.000 / Recompra ₡10.000 / Stack 20.000 / Bonus stack 5.000. "Máx recompras por jugador" field present (8). "Guardar ajustes" button present. "Permitir calculadora de probabilidades" toggle present (on).
7. **Fecha detail** — PASS (completed in all 3 themes; scheduled in claro).
   - "Cómo se juega" info card: points formula `(N−P)×mult + bonos − castigos`, worked example, bonuses (Mesa Final +5, Top3 +8, Asistencia +2, no-show −15), Entrada y fichas (Buy-in ₡20.000, Recompra ₡20.000, Stack 10.000, Llegada temprana +2.000). ✓
   - RSVP chips centered. ✓
   - Icon-only upload buttons: Portada 🖼️ / Galería 📷. ✓
   - COMPLETED (Fecha 1): place + points per player, 👑 1º / 🥈 2º / 🥉 3º medals, no-show tag (−15). ✓
   - SCHEDULED (Fecha 3): "✎ Editar fecha y hora" admin editor present and opens a datetime-local input + Cancelar/Guardar. ✓
   - **VISUAL GAP:** no "Premios" section on the COMPLETED fecha detail (page ends at Galería). Task expected a Premios section at the bottom of completed view. Likely data-dependent (seed Fecha 1 has no prize payout recorded) — flag for confirmation; not a runtime error.
8. **En Vivo** (live Fecha 2) — PASS (claro). Timer Nivel 4 counting down, blinds 100/200 (SB/BB), Pozo ₡200K, 7/9 quedan, 97K fichas. "PENDIENTE PAGO" outlined tag on unpaid player (Diego Herrera). "Premios" section at the bottom ("reparto propuesto"). NOTE: blinds "." separator not observable at Nivel 4 — values <1000 (100/200); would only appear at higher levels (e.g. 1.000/2.000). Did not advance levels (would mutate live state).
9. **Liga settings** (admin) — PASS (claro). Bonuses are Mesa Final / Top 3 / Asistencia (5/8/2). No "bonus llegada" field — confirmed REMOVED.
10. **Perfil** — PASS (claro). "Sonido" section: "Silenciar" mute switch + "Volumen" slider (0.7).
11. **Legend** — PASS. Form-guide legend (Campeón/Podio/Mesa final/Fuera) on Tabla is a centered flexbox (`justify-content: center`), verified in all 3 theme captures.

## Skipped / not reached
- Tier 3 (Claude ext) + Tier 4 (human) not run this pass.
- Blinds "." thousand separator on En Vivo not visually confirmable (live level = 100/200, sub-1000).
- "Premios" section on COMPLETED fecha not present in seed (see #7) — needs data or design confirmation.

## Next step
Present screenshots for human approval. Confirm whether the completed-fecha "Premios" section is expected to render with the current seed (or is data-gated).
