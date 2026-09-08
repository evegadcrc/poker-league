// ---------------------------------------------------------------------------
// push-notify — Web Push fan-out for RSVP events.
//
// Called by the `entry` trigger (mig 0032) through pg_net whenever a player's
// status becomes confirmed / declined / checked_in. Authenticated with a shared
// secret header (the DB call carries no user JWT → deploy with verify_jwt=false).
// Sends one push to every ADMIN subscription except the actor's own, and prunes
// subscriptions the push service reports as gone (404 / 410).
//
// Env (supabase secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
// PUSH_WEBHOOK_SECRET. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected.
// ---------------------------------------------------------------------------
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

type Event = 'confirmed' | 'declined' | 'checked_in'

type Payload = {
  event: Event
  entry_id: string
  tournament_id: string
  subject_player_id: string
  actor_player_id: string | null
}

type Sub = { id: string; endpoint: string; p256dh: string; auth: string; player_id: string }

const EVENTS: ReadonlySet<string> = new Set(['confirmed', 'declined', 'checked_in'])

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Spanish title/body for the admin push. */
export function composeMessage(
  event: Event,
  playerName: string,
  fechaName: string,
  confirmedCount: number,
): { title: string; body: string } {
  const count = `${confirmedCount} ${confirmedCount === 1 ? 'confirmado' : 'confirmados'}`
  switch (event) {
    case 'confirmed':
      return { title: `✅ ${playerName} confirmó`, body: `${fechaName} · ${count}` }
    case 'declined':
      return { title: `❌ ${playerName} canceló`, body: `${fechaName} · ${count}` }
    case 'checked_in':
      return { title: `📍 ${playerName} hizo check-in`, body: `${fechaName} · ${count}` }
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' })

  const secret = Deno.env.get('PUSH_WEBHOOK_SECRET') ?? ''
  const given = req.headers.get('x-webhook-secret') ?? ''
  if (!secret || given !== secret) return json(401, { error: 'unauthorized' })

  let payload: Payload
  try {
    payload = (await req.json()) as Payload
  } catch {
    return json(400, { error: 'invalid json' })
  }
  if (!EVENTS.has(payload.event) || !payload.tournament_id || !payload.subject_player_id) {
    return json(400, { error: 'invalid payload' })
  }

  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY')
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY')
  const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com'
  if (!vapidPublic || !vapidPrivate) return json(500, { error: 'vapid keys not configured' })
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  const [playerRes, fechaRes, countRes, subsRes] = await Promise.all([
    supabase.from('player').select('name').eq('id', payload.subject_player_id).maybeSingle(),
    supabase.from('tournament').select('name').eq('id', payload.tournament_id).maybeSingle(),
    supabase
      .from('entry')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', payload.tournament_id)
      .in('status', ['confirmed', 'checked_in', 'playing']),
    supabase
      .from('push_subscription')
      .select('id, endpoint, p256dh, auth, player_id, player:player_id!inner(is_admin)')
      .eq('player.is_admin', true),
  ])

  if (subsRes.error) return json(500, { error: subsRes.error.message })

  const playerName = (playerRes.data as { name?: string } | null)?.name ?? 'Un jugador'
  const fechaName = (fechaRes.data as { name?: string } | null)?.name ?? 'la fecha'
  const confirmed = countRes.count ?? 0
  const { title, body } = composeMessage(payload.event, playerName, fechaName, confirmed)
  const message = JSON.stringify({
    title,
    body,
    url: `/fechas/${payload.tournament_id}`,
    tag: `rsvp-${payload.tournament_id}`,
  })

  const subs = ((subsRes.data ?? []) as unknown as Sub[]).filter(
    (s) => s.player_id !== payload.actor_player_id,
  )

  let sent = 0
  let failed = 0
  const pruned: string[] = []
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          message,
          { TTL: 60 * 60 },
        )
        sent += 1
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) pruned.push(s.id)
        else failed += 1
      }
    }),
  )
  if (pruned.length > 0) {
    await supabase.from('push_subscription').delete().in('id', pruned)
  }

  return json(200, { event: payload.event, recipients: subs.length, sent, failed, pruned: pruned.length })
})
