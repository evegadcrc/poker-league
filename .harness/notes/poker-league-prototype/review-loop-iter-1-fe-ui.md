# Review iter 1 (FE / presentational lens) — poker-league-prototype
Diff: dcaa727..HEAD (feat/poker-friends-phase1). Scoped to the presentational FE only
(App/main/theme/tokens, the 7 components, Leaderboard/Fechas/Login/Profile, admin/CreateFecha
+ LeagueSettings, their co-located tests, App.css structural). SQL + auth/core-logic + Live +
FechaDetail + Admin console covered by other reviewers.
Verdict: FINDINGS

## Lesson checks (both documented pitfalls honored — no re-introduction)
- **Form array reversal (lessons slice 5 — newest-on-RIGHT):** HONORED. `FormPills.tsx:39-40`
  copies then reverses the RPC array; `Leaderboard.test.tsx:108-122` + `Profile.test.tsx:144-156`
  assert the newest tier is the rightmost pill. Correct.
- **Theme key `pf-theme` shared with index.html pre-paint (lessons slice 1):** HONORED.
  `theme.tsx:15` STORAGE_KEY === `index.html:24` key; `getInitialTheme` prefers the DOM attribute
  the pre-paint script set → hydrates to the same value, no flash. `App.test.tsx:86-104` covers
  the light→dark→neon cycle + persistence.

## Findings

### Correctness
- **Fechas.tsx:93-100** — `buildCards` re-sorts within each status group by `card.when`, which is
  the **localized display string** from `formatWhen` (`fechas.ts:131-147`, e.g. `"Mié 23 jul ·
  19:00"`). `localeCompare` on Spanish weekday/day text is **not chronological**: e.g. `"Dom 3 ago"`
  sorts before `"Vie 1 ago"` (D<V) though Aug 1 precedes Aug 3; day-number-as-text mis-orders too
  (`"25 …"` < `"3 …"`). The DB query already returns `scheduled_at desc` (`Fechas.tsx:117`) — that
  correct order is thrown away and replaced by a broken string sort. Fix: keep the raw
  `scheduled_at` ISO on `FechaCard` and sort by it (ISO-8601 sorts lexicographically ==
  chronologically) or by `Date.parse`. Tests miss this because each status group has exactly one
  card (`Fechas.test.tsx` has 1 scheduled / 1 live / 1 completed) — add a multi-scheduled fixture.

### Tests
- **Login.tsx (no co-located test)** — Login is the only in-scope screen with zero component tests.
  It has five states — idle / sending / `sent` (envelope confirmation) / `error` (+ "Reintentar")
  / unbound ("pedile al admin" + Cerrar sesión, `Login.tsx:64-79`). `App.test.tsx:59-63` only
  smoke-checks that the "Enviar enlace" button renders. The spec States section requires
  "magic-link failure → resend affordance"; none of the sent/error/unbound branches are pinned.
  Add `Login.test.tsx` covering: submit→sent copy, `signInWithOtp` error→error copy + Reintentar
  resets to idle, and the `bindError='no-player'` vs generic unbound messages.

### Readability / dead code
- **components/ScreenPlaceholder.tsx** — unused. No import anywhere in `src/` (grep clean); its
  own docstring says it's for "tab screens not yet built", and every tab screen is now built.
  Remove the file (§2 dead-code).

### Accessibility / i18n
- **App.css:71-73 (`.icon-btn` 38×38px)** — below the spec accessibility checklist's "tap targets
  ≥44px" bar. This is the theme-cycle button in both the header (`AppLayout.tsx:45-53`) and Login
  (`Login.tsx:43-51`). Bump to ≥44px or add an invisible hit area. (`.btn` is correctly 44px,
  `.tab` fills the 66px nav — only `.icon-btn` misses.)
- Optional: **Sheet.tsx:27-40** — `role="dialog" aria-modal="true"` but no focus management: focus
  is not moved into the dialog on open, the background is not inert, and focus is not restored to
  the trigger on close. Escape + scrim-click close work. For the destructive close-season confirm
  (`LeagueSettings.tsx:284-308`) this is a real keyboard/SR gap. Add autofocus on open, a focus
  trap, and return-focus on close.
- Optional: **FormPills.tsx:41-56 + App.css:159-183** — inline form pills are empty spans that
  differ **only by background color** (identical 19×19 rounded squares). SR users get `aria-label`
  (good) and the `Legend` is present, but colorblind sighted users rely on color/lightness alone.
  The shaped Legend markers (`.ld`: circle/circle/diamond/bar, App.css:471-495) don't carry into
  the pills. `.pill` already `place-items:center` with a font size — consider a per-tier glyph/
  letter for parity. Spec-approved visual, so low priority.

### UX
- Optional: **Fechas.tsx:178-183, 193-199** — the "+ Nueva fecha" links target `/admin`, which
  defaults to the **Consola** (live-clock) tab (`Admin.tsx:44` `useState<AdminTab>('consola')`),
  not the create-fecha form. The affordance's label promises the create form. Deep-link to the
  `crear` tab (e.g. `/admin?tab=crear` with Admin reading a search param) or a dedicated route.
- Optional: **Login.tsx:93-106** — after a successful send (`status==='sent'`) the input and button
  are disabled with no "reenviar" path; a user who never receives the link must reload the page.
  Spec asks for a resend affordance. Add a "Reenviar enlace" action in the sent state.

### Nits / FYI
- Nit: **AppLayout.tsx:50 / Login.tsx:48** — the theme button's `aria-label` announces the CURRENT
  theme ("Tema: Almanaque claro") on a control that CHANGES it. "Cambiar tema (actual: …)" reads
  clearer for SR users.
- FYI (route to security pass): **Avatar.tsx:25 / AppLayout.tsx:35 / Login.tsx:55** — the
  player-writable `avatar_url` flows into inline `backgroundImage: url(${url})`. Via React's style
  object → CSSOM this cannot break out into a CSS-injection and `url()` won't execute scripts, so
  risk is low, but `avatar_url` is user-writable under owner RLS and is rendered on other users'
  leaderboards — name it for the security lens. Also: avatar upload (`Profile.tsx:79-117`) is
  client-`accept="image/*"` only, no size/type enforcement on the FE (Storage bucket policy is the
  real gate — out of this scope).
- FYI: **LeagueSettings.tsx:107** — `final_table_size_override: ftSize === '' ? '' : Number(ftSize)`
  sends `''` for the "automático" case. **Verified correct-by-contract:** the RPC coalesces it via
  `nullif(p_payload->>'final_table_size_override','')::int` (`0010_admin_crud.sql:130-131`) → `''`
  maps to NULL. No bug.
- FYI: **LeagueSettings.tsx:83-86** — a missing active season is folded into the generic `error`
  phase (no distinct "no hay temporada" message). Acceptable, slightly misleading vs Leaderboard/
  Fechas which have a dedicated `no-season` branch.
- FYI: **CreateFecha.tsx:85-101** — no client-side required-field validation; "Crear fecha" is
  enabled with empty date/venue/structure (`scheduled_at`→undefined, `blind_structure_id`→null).
  `create_tournament` is the gate; on rejection the admin sees only the raw `rpcErr.message`.
  Fine for a friends' league; consider disabling submit until date + structure are set.

## Payload correctness (emphasis check) — PASS
- CreateFecha → `create_tournament` (`CreateFecha.tsx:89-104`): builds the documented fields;
  empty numerics coalesced (`buy_in→0`, `radius→100`, nullable rebuy/stack→null), rebuy level from
  the select, ante toggle boolean. `AdminCrud.test.tsx:86-125` asserts name/radius/buy_in/stack/
  rebuy_until_level/ante_enabled/blind_structure_id + manual lat/lng. Matches be-contract.
- LeagueSettings → `update_season_config` (`LeagueSettings.tsx:99-109`): all config fields;
  percents→decimals via `percentsToTemplate` (`AdminCrud.test.tsx:158` asserts `[0.6,0.28,0.12]`);
  override-empty→NULL handled by the RPC (see FYI). `close_season` gated behind the confirm Sheet
  and fired ONLY on confirm (`AdminCrud.test.tsx:163-184`). Matches be-contract + plan step 13.

## States coverage (emphasis check) — per screen
- Leaderboard: loading(skeleton)/error(+Reintentar)/no-season/empty-roster/ready — all present +
  tested (`Leaderboard.test.tsx:152-200`). ✓
- Fechas: loading/error/no-season/empty(+admin CTA)/ready — present; live→/vivo. States tested
  except empty (only ready tested). ✓ (empty-state untested — minor, folded into no new finding)
- Profile: loading/error(+Reintentar)/ready + empty-history + upload error — present + tested
  (`Profile.test.tsx`). ✓
- Login: idle/sending/sent/error/unbound present in code but UNTESTED → required finding above.
- Theme cycle + persistence + no-flash: ✓ (tested).

## Admin gating (emphasis check) — PASS
`/admin` is wrapped by `RequireAdmin` (`App.tsx:30-32`), nested under `RequireAuth`
(`guards.tsx:28-34` bounces non-admins to `/`); CreateFecha + LeagueSettings render only inside
Admin's tabs (`Admin.tsx:88,91`). Admin nav tab hidden for non-admins (`AppLayout.tsx:62`,
`App.test.tsx:75-84`). ✓

## Theming (emphasis check) — PASS
No hardcoded colors in the in-scope TSX — every color reference uses a token (`var(--oxblood)` in
Fechas/CreateFecha/LeagueSettings/Sparkline). tokens.css defines all three themes verbatim; pills/
legend key off `--champ/podio/final/out-*`. ✓

## Axes checked
correctness ✗ (Fechas sort) · readability ✗ (dead ScreenPlaceholder) · architecture ✓
(useLoadable reuse clean, component boundaries sound) · security ✓ light — touches-sensitive: yes
(avatar file upload + user-writable avatar_url rendered into CSS; route to security pass) ·
performance ✓ (lists small, spec N/A on pagination; no N+1)
