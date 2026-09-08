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
