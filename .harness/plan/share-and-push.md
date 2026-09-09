# Plan — share links, WhatsApp convocatoria, Web Push (2026-09-07)

User asks (verbatim intent): WhatsApp updates with the latest player list for the open fecha, or push
notifications when a player confirms/cancels; a direct link for players to join the fecha, with a
WhatsApp preview. Decision: automatic WhatsApp *group* posting is not possible with any official API
(Business API is 1:1 templates only; unofficial bots risk a ban) → one-tap share instead. User chose
"go with the 3" = all three items in the recommended order.

## Slice 1 — deep link through login + static preview card + WhatsApp convocatoria (FE only)
1. `src/lib/next.ts` — remember the path a logged-out visitor wanted (`pf-next`, 24h TTL, must be a
   same-origin path, never `/` or `/login`); `RequireAuth` stores it when bouncing to /login and
   consumes it (once) as soon as session+player exist. Magic link keeps landing on `/`
   (emailRedirectTo unchanged — prod redirect allowlist untouched).
2. `index.html` — Open Graph + Twitter card tags (og:image absolute → prod origin) +
   `public/og/fecha-card.png` (1200×630, rendered with ImageMagick from the logo + brand colours).
   The SPA rewrite serves index.html for every route, so every shared link gets the card.
3. `src/lib/summary.ts` — `convocatoriaText({fechaName, scheduledAt, buyIn, entries, link})`:
   confirmados / sin responder / cancelaron with names + counts + "Confirmá acá: <link>".
   FechaDetail (admin, scheduled|live, not cancelled): "Compartir en WhatsApp" → `wa.me/?text=`
   (admin picks the group) + "Copiar enlace". Tests for the builder + the buttons.

## Slice 2 — Web Push for admins on confirm / cancel / check-in
- Migration 0032: `push_subscription(id, player_id, endpoint unique, p256dh, auth, user_agent,
  created_at)` owner-only RLS; trigger on `entry` status transitions (confirmed / declined /
  checked_in) → `net.http_post` to the Edge Function, URL + shared secret read from Vault
  (`push_webhook_url`, `push_webhook_secret`; no-op when absent so local/test envs don't fail).
- Edge Function `push-notify` (Deno, `npm:web-push`): verify secret, resolve actor + fecha, send to
  every admin subscription except the actor's, prune 404/410.
- FE: `public/sw-push.js` pulled in via workbox `importScripts` (push + notificationclick →
  open `/fechas/:id`); `src/lib/push.ts` subscribe/unsubscribe; Perfil toggle (admins) with the
  iOS "install to home screen first" hint. `VITE_VAPID_PUBLIC_KEY` env.
- Prod setup (outside git): VAPID keys (private → `supabase secrets set`, public → Vercel env +
  `.env.production.local`), vault secrets via psql, `supabase db push`, `supabase functions deploy`.
  Delivery to a real phone is verified by the user; here: trigger fires (net._http_response),
  function returns 200 with the right recipient set.

## Slice 3 — per-fecha WhatsApp preview
- Migration: `fecha_preview(p_id uuid)` SECURITY DEFINER, granted to anon: name, scheduled_at,
  status, cancelled_at, confirmed count only. No service-role key on Vercel.
- `api/preview.ts` Vercel function renders OG HTML; `vercel.json` rewrite `/fechas/:id` →
  `/api/preview?id=:id` only when the User-Agent matches WhatsApp/facebookexternalhit/Twitterbot/
  TelegramBot/Slackbot/Discordbot/iMessage/Applebot (placed before the SPA catch-all).
- Verify with `curl -A WhatsApp` against a Vercel preview deploy, then prod after ship.

## Gates
- `npm run build`, `npm run lint`, `npm test` (local stack running) after every slice.
- One commit per slice, local; push on "ship it" (user convention) → Vercel deploys.

## Slice 4 (2026-09-08) — guest self-join through the shared link ("option 1")
- mig 0035: tournament.guests_open (default false); fecha_preview +guests_open; guest_join(email,
  name, tournament) ANON → creates guest player (is_guest, real email) + confirmed entry, 'member'
  for known members, idempotent; promote_guest(player) admin-only (past nights start counting).
- FechaForm toggle "Invitados pueden unirse con el enlace" (create + edit); FechaDetail: "· invitado"
  tag, admin hint under the share row, convocatoria gets "🙋 ¿Invitado? Mismo enlace → «Voy como
  invitado»" when open; Login: when the pending deep link is an open fecha → "Voy como invitado"
  (email + name → guest_join → magic link → lands confirmed on the fecha); Admin › Jugadores:
  "Hacer miembro" on guest rows.
- Tests: Login (6), Admin (2), AdminCrud (1), EditFecha (fixture), FechaDetail.admin (2), summary (1),
  guest_join.integration (5). Prod: `supabase db push` (0035) is the USER's step; FE ships on push.

## Slice 5 (2026-09-08) — admin shares for result + tabla, portada in the link preview
- ShareSheet (generic) ← ConvocatoriaSheet; FechaDetail "Compartir resultado en WhatsApp" (completed,
  admin); Leaderboard "Compartir tabla en WhatsApp" (admin). Summary links default to the app origin.
- mig 0036 fecha_preview +cover_url → api/_lib/preview.mjs og:image = https cover else branded card.
- Tests: FechaDetail.admin (2), Leaderboard (2), summary (1), preview (2). Prod: db push 0035+0036 first.
