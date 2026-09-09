---
goal: Poker Friends PWA — LIVE in prod (Supabase evbbsvwglspdzzqdvrcf + Vercel poker-friends-xi.vercel.app). Phase 3 shipped.
task: poker-league-phase3
step: shipped
progress: 100%
blockers: none
updated: 2026-07-25T16:00:00Z
---

## What we're doing
PHASE 2 fully BUILT + test-green, NOT yet reviewed. Plan approved. PR #1 MERGED → main; Phase 2 on
branch feat/poker-friends-phase2. Track A (steps 1-8) + Track B (steps 9-15) built via 12 delegated
slices, both test-gate green. Ran in --steps mode so simplify + review-loop were deferred by design.

## Last action
SIMPLIFY + REVIEW-LOOP done (both skipped by --steps mode earlier; ran explicitly). Simplify: 1
extraction (191b670 deriveLiveSignal). Review-loop PER-TRACK (full diff 7451 lines >> 1000 gate):
- Track A APPROVED (2 iters; panel five-axis+security+data-migration). Found+fixed 1 CRITICAL RLS
  privilege-escalation (tournament writes were not admin-only → a non-admin could self-create a fecha,
  become its tournament-admin, inject season points → mig 0017 restricts writes to auth_is_admin;
  escalation verified closed via psql) + 1 required (multi-bust ≥1 survivor) + 1 optional (backfill
  non-array guard). Commits 329d02d, bc0afca.
- Track B APPROVED (2 iters; panel five-axis+security). No Critical. Fixed 2 required (elimination-cue
  winner-exclusion test; gallery bucket MIME/size cap) + 1 optional (evaluator 5/6-card tests) + nit
  (quote cover url). Commits e0ad526, d012827.
Test gate GREEN 317 passed / 1 skipped from clean db reset. 18 commits on branch. Record:
.harness/notes/poker-league-phase2/review-loop.md; residuals in followups.md.

## Phase 2.1 UI refinements (build-only batch, 2026-07-24 — user "go with changes")
9 UI changes across 4 slices, all FE-only, test-gate green 326/1skip at HEAD (no reset — local seed
season restored to 2026-active + edwin.vega admin kept for user testing). Commits: 3d9c797 (tabla
cols centered + login email centered + calc rivales max 10); 57775f0 + 5c81547 (fecha money inputs
thousand-sep "." + defaults 10k/10k/20k/5k + "Guardar ajustes" via localStorage pf-fecha-defaults +
removed bonus-llegada from Liga); 289dba8 (En Vivo: Pendiente Pago tag on entry.paid=false, blind
thousand-sep, Premios moved to bottom); 81a3d0d (completed fecha: place + points_earned instead of
CAMPEÓN/FUERA, no-show + penalty, co-champs share 1º). Dropped push notif (#10, needs go-live infra).
NOT reviewed/verify-ui'd yet (build-only batch). #10 push dropped per user.
OPEN CONFIRMS: (1) separator "." vs "," (user wrote ","); (2) bonus-stack has no per-fecha column →
form-default only; (3) "recompra 8" → mapped to existing "hasta Nivel 8".

## Phase 2.1b UI batch (2026-07-24) — DONE + verify-ui PASSED
10-item batch + máx-recompras, commits: 14669bb (2nd/3rd medals + Premios on completed fecha),
ea009a4 (icon upload buttons + centered rsvp/legend + máx-recompras), e9f653a (fecha info card:
points formula+example+bonuses+entry/stacks + editable date/time on scheduled), c864ad4 (mig 0018:
leaderboard form_positions → form-pill NUMBERS + tournament.odds_enabled column), 9799ad9 (per-fecha
odds calculator enable/disable toggle + Calculadora live gate). Full suite 349/1skip green.
VERIFY-UI (Playwright, admin login via Mailpit, mobile viewport): all priority screens OK in 3 themes,
console clean, 20 shots in .harness/notes/poker-league-phase2/ui-verify/20260724-180103/. Data-gated:
Premios not shown on legacy seed Fecha 1 (no prizes) — not a bug. Followups updated.
NOT review-loop'd (build-only batch). Dropped push (#10). Separator "." confirmed. edwin.vega admin
re-seeded post-0018 reset.

## Review-loop COMPLETE — ALL Phase 2 APPROVED (2026-07-24)
2.1 UI batch reviewed (panel five-axis+security+data-migration, 2 iters) → APPROVED. Found+fixed 1
required: chopAdjustedPrizes over-stated money for a mid-field tie → now pools by chop_group
(5e55d27). Security CLEAN (non-admin tournament UPDATE→0 rows; 0018 preserved leaderboard
definer/grants). Data-migration CLEAN (0018 form_positions aligned, 0 mismatches). Test gate 350/1skip.
Full record: review-loop.md. Track A + Track B + Track 2.1 all APPROVED; verify-ui PASSED.

## Next step
SHIP. Everything on feat/poker-friends-phase2 (NOT pushed): Track A + B + 2.1, all reviewed + verify-ui'd,
350/1skip green. Ship as ONE Phase-2 PR (or stacked). Then go-live (hosted Supabase + SMTP + FE deploy).
Deferred followups (all optional): profile-racha numbers, gallery mobile-upload (HEIC+downscale), private
bucket, wire máx-recompras/bonus-stack, FormPills co-champ number + Pendiente-Pago-alive-only (product calls).

## 2026-09-07 — Editar fecha (admin edit page) — BUILT + verified, NOT committed
User could not edit a created (scheduled) fecha beyond the icon-only date editor; asked for an edit
button covering the geofence too. Built: `src/routes/admin/FechaForm.tsx` (form extracted from
CreateFecha, shared), `CreateFecha.tsx` now a thin wrapper (loads structures + season template, seeds
from pf-fecha-defaults, RPC create_tournament), NEW `src/routes/admin/EditFecha.tsx` at
`/fechas/:id/editar` (RequireAdmin route in App.tsx): seeds every field from the row (name, date/time,
venue lat/lng/radius, buy-in, rebuy, stacks, rebuy cutoff, blinds, payout split, toggles); saves via
direct tournament UPDATE filtered by status='scheduled' AND cancelled_at IS NULL (0 rows → friendly
error); venue validation (half-entered venue / bad coords / radius ≤ 0). Locked note for live /
completed / cancelled. FechaDetail: "Editar fecha" ghost button in AdminFechaActions (same gate as
Abrir). Inline date editor KEPT. Tests: +14 EditFecha.test.tsx, +5 FechaDetail.admin.test.tsx;
full suite 517 pass / 1 skip on local stack. Verify-ui (Playwright, admin Carlos via minted magic
link): button → edit page → changed lng/radius → saved → DB row + detail "Radio 150 m" confirmed,
console clean; seed row restored. Same day: prod Supabase found PAUSED (free tier) → user restored;
keep-alive workflow shipped (4472af9).

## 2026-09-07 — share links + WhatsApp convocatoria + Web Push + per-fecha preview — BUILT, local commits, NOT pushed
User: "WhatsApp updates with the player list / push when someone confirms or cancels / a join link with
WhatsApp preview" → "go with the 3". Decision: no official API can post into a WhatsApp group →
one-tap share instead. Plan: .harness/plan/share-and-push.md. Commits (local, on main):
- 9ab465e feat(auth): deep link through login (lib/next.ts peek/clear, RequireAuth). E2E-verified with
  Playwright: logged-out /fechas/:id → login → magic link → lands on the fecha. Caught + fixed a
  StrictMode double-render bug (read-and-clear in render consumed the value).
- c8a1c65 feat(share): OG/Twitter tags + public/og/fecha-card.png (1200×630, rsvg from SVG+logo,
  excluded from SW precache); FechaDetail admin "Compartir en WhatsApp" (wa.me + convocatoriaText
  roster) + "Copiar enlace".
- 2fbf662 feat(push): mig 0032 push_subscription + entry trigger → pg_net → Edge Function
  push-notify (npm:web-push; verify_jwt=false; shared secret); lib/push.ts; public/sw-push.js via
  workbox importScripts; Perfil "Notificaciones" switch (admins). Local E2E: trigger fired twice →
  net._http_response 200 ×2, recipients=1.
- b88f328 feat(share): mig 0033 fecha_preview(uuid) anon RPC; api/preview.ts Vercel fn; vercel.json
  UA-gated rewrite /fechas/:id → /api/preview. Handler verified locally via tsx against local stack.
Suite 560 pass / 1 skip. Build OK (sw.js imports sw-push.js).
PROD SIDE DONE: `supabase secrets set` (VAPID_*, PUSH_WEBHOOK_SECRET from .env.production.local —
VAPID keys generated 2026-09-07, stored there), `supabase functions deploy push-notify` (v1 ACTIVE),
Vault push_webhook_url/secret via `supabase db query --linked`.
PROD SIDE PENDING (classifier blocked reading the DB password): `supabase db push` for 0032 + 0033 —
USER must run it. Then "ship it" → push 6 commits → Vercel deploys FE + api/preview + rewrite.
Verify after: curl -A WhatsApp https://poker-friends-xi.vercel.app/fechas/<id> → OG HTML; admin
turns on Avisos in Perfil (installed PWA on iPhone) and a test RSVP flips → push arrives.
Vercel CLI not logged in locally (no preview deploys possible from here).

## 2026-09-07 (later) — follow-ups: copy, "nueva fecha" push for everyone, activation error
User: "Confirmá acá" → "Confirmar acá" (impersonal); notify when a fecha is created; toggle gave
"No se pudo activar". ROOT CAUSE of the error: prod still lacks migrations 0032/0033 (user has not run
`supabase db push`; classifier blocks it from here) → push_subscription table missing → upsert fails.
Changes: mig 0034 (fn_push_webhook helper reading Vault; entry trigger re-pointed; NEW tournament
after-insert trigger → event fecha_created); Edge Function v2 deployed to prod (fecha_created →
ALL subscriptions, RSVP events → admins; impersonal body "Sáb 20 sep · 19:00 · Confirmar asistencia");
Perfil toggle now for EVERY player (help text by role); subscribePush asks permission FIRST (iOS user
activation) and the error note includes the underlying message. Local E2E via pg_net: fecha_created →
audience all / recipients 1; confirmed → audience admins / recipients 0. Prod needs `supabase db push`
(0032, 0033, 0034) — USER action.
2026-09-08: USER ran `supabase db push` → 0032/0033/0034 applied in prod. Verified from here: objects
present (table, 4 fns, 2 triggers, pg_net, vault ×2); WhatsApp crawler on real Fecha 2 → "Fecha 2 ·
Poker Friends / Sáb 12 sept · 18:00 · 1 confirmado"; prod push-notify fecha_created → 200 audience all,
recipients 0 (no subscriptions yet). Remaining: user tests on phone (install PWA → Perfil → Avisos).

## 2026-09-08 — install walkthrough + post-"Voy" convocatoria sheet — BUILT
User: (1) a tour teaching how to install the PWA (Share → Agregar a inicio; push only from the installed
app); (2) after a player joins, pop a screen to copy/share the WhatsApp roster.
- lib/install.ts (isStandalone / installPlatform / tour bookkeeping `pf-install-tour` seen|done);
  components/InstallTour.tsx (Sheet, numbered steps per platform ios-safari / ios-other / android
  (native "Instalar ahora" when beforeinstallprompt captured) / desktop + 🔔 note); InstallPrompt now
  auto-opens the tour ONCE on phones not running standalone, banner gets "Cómo instalar", ✕ closes both;
  Perfil › Notificaciones "Ver cómo instalar" (needs-install) opens it.
- components/ConvocatoriaSheet.tsx (preview textarea + Compartir en WhatsApp + Copiar texto);
  FechaDetail opens it after a successful rsvp confirm (optimistic roster).
- Verified in Chrome DevTools MCP: iPhone UA emulation → tour auto-opened with 4 steps; as player Ana
  → "Voy — confirmar asistencia" → "¡Confirmado! 🎉" sheet with 6 confirmados incl. Ana. Seed restored.

## 2026-09-08 — check-in countdown (replaces "próximamente")
Confirmed player before the window: disabled button "📍 Check-in · abre en 7h 59m" (counts down to
scheduled_at − 1h; formatCountdown: "2d 4h" / "4h 12m" / "mm:ss" / "ahora"). Pre-live (check-in open):
red pulsing chip "🔴 Empieza en 24:38" above the enabled "Hacer check-in" (past start → "🔴 ¡Ya es la
hora!"). Tick is 1s once check-in opens within the hour, 30s otherwise (needsFastTick). Verified both
states in Chrome DevTools MCP (iPhone viewport) by moving the local Fecha 3 to +9h / +25min; restored.
NOTE: full-suite runs while the dev server + browser hammer the local stack intermittently fail
integration tests with "An invalid response was received from the upstream server" (Kong); they pass
when re-run on a quiet stack — run the gate with nothing else hitting 55321.

## 2026-09-08 — prod data: merged duplicate player accounts (Santi)
Two player rows for the same person: OLD stg.sh.s@outlook.com (Santi, created 2026-07-25, Fecha 1
2nd place = 100 pts) and NEW stg.ch.s@outlook.com (Santi 420, created 2026-09-08, Fecha 2 confirmed).
Kept the NEW row/login (valid account), moved the OLD row's entries (+ any photos/subs/refs) onto it,
copied the old name ("Santi") and kept the new avatar, deleted the OLD player row and the OLD auth
user. Leaderboard: Santi once, 100 pts, 1 game. Pre-merge snapshot: .harness/audit/2026-09-08-santi-
account-merge-before.json (gitignored). Done via `supabase db query --linked` in one transaction.

## 2026-09-08 — guest self-join ("option 1") — BUILT, committed locally, NOT pushed
mig 0035 (guests_open, guest_join anon RPC, promote_guest, fecha_preview+guests_open) + FE (form
toggle, Login "Voy como invitado", roster "· invitado" tag, share hint, convocatoria hint, Admin
"Hacer miembro"). Suite 596 pass / 1 skip (incl. new guest_join integration). Browser E2E (Chrome
DevTools, iPhone viewport): logged-out fecha link → login shows the offer → email+name → guest
player + confirmed entry created, magic link sent → link lands on the fecha confirmed, in roster.
ORDER MATTERS FOR PROD: run `supabase db push` (0035) BEFORE the FE deploys — the edit page now
writes guests_open and would fail on a DB without the column. Push code after the migration.

## 2026-09-08 — admin WhatsApp shares (result + tabla) and portada in the link preview — BUILT
- components/ShareSheet.tsx (generic preview + Compartir en WhatsApp + Copiar); ConvocatoriaSheet now
  wraps it. FechaDetail: admin-only "Compartir resultado en WhatsApp" on COMPLETED fechas
  (fechaSummaryText; pot = materialized prizes or computePot). Leaderboard: admin-only "Compartir tabla
  en WhatsApp" (seasonSummaryText top 5). Summary links now default to window.location.origin (no more
  'poker-friends.app' placeholder); Admin console WhatsSheet benefits automatically.
- Portada in the WhatsApp card: mig 0036 fecha_preview +cover_url; api/_lib/preview.mjs uses an https
  cover as og:image (drops the fixed 1200×630 tags), else the branded card. Preview.mjs was rewritten
  whole after a perl edit mangled it — prefer Write for multi-line JS edits.
- Prod pending (USER): `supabase db push` for 0035 + 0036 BEFORE the code is pushed (edit page writes
  guests_open; preview handler tolerates a missing cover_url).
