// ---------------------------------------------------------------------------
// push-notify — Web Push fan-out for fecha events.
//
// Called by DB triggers (mig 0032 / 0034) through pg_net:
//   • confirmed / declined / checked_in  (entry status transitions) → ADMINS
//   • fecha_created                      (new tournament row)        → EVERYONE
// always excluding the actor's own devices. Authenticated with a shared secret
// header (the DB call carries no user JWT → deployed with verify_jwt=false).
// Prunes subscriptions the push service reports as gone (404 / 410).
//
// Env (supabase secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
// PUSH_WEBHOOK_SECRET. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected.
// ---------------------------------------------------------------------------
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

type Event = 'confirmed' | 'declined' | 'checked_in' | 'fecha_created'

type Payload = {
  event: Event
  tournament_id: string
  subject_player_id: string | null
  actor_player_id: string | null
}

type Sub = { id: string; endpoint: string; p256dh: string; auth: string; player_id: string }

const RSVP_EVENTS: ReadonlySet<string> = new Set(['confirmed', 'declined', 'checked_in'])
const EVENTS: ReadonlySet<string> = new Set([...RSVP_EVENTS, 'fecha_created'])
const TZ = 'America/Costa_Rica'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** "Sáb 20 sep · 19:00" in Costa Rica time; "" when unparseable. */
function formatWhenCR(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = new Intl.DateTimeFormat('es-CR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: TZ,
  }).format(d)
  const time = new Intl.DateTimeFormat('es-CR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TZ,
  }).format(d)
  const pretty = day.replace(',', '').replace(/\.$/, '')
  return `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)} · ${time}`
}

/** Spanish title/body per event (impersonal copy, like the app). */
export function composeMessage(
  event: Event,
  ctx: { playerName: string; fechaName: string; confirmedCount: number; scheduledAt: string | null },
): { title: string; body: string } {
  const count = `${ctx.confirmedCount} ${ctx.confirmedCount === 1 ? 'confirmado' : 'confirmados'}`
  switch (event) {
    case 'confirmed':
      return { title: `✅ ${ctx.playerName} confirmó`, body: `${ctx.fechaName} · ${count}` }
    case 'declined':
      return { title: `❌ ${ctx.playerName} canceló`, body: `${ctx.fechaName} · ${count}` }
    case 'checked_in':
      return { title: `📍 ${ctx.playerName} hizo check-in`, body: `${ctx.fechaName} · ${count}` }
    case 'fecha_created': {
      const when = formatWhenCR(ctx.scheduledAt)
      return {
        title: `🃏 Nueva fecha: ${ctx.fechaName}`,
        body: when ? `${when} · Confirmar asistencia` : 'Confirmar asistencia',
      }
    }
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
  if (!EVENTS.has(payload.event) || !payload.tournament_id) {
    return json(400, { error: 'invalid payload' })
  }
  if (RSVP_EVENTS.has(payload.event) && !payload.subject_player_id) {
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

  const adminsOnly = RSVP_EVENTS.has(payload.event)
  const subsQuery = adminsOnly
    ? supabase
        .from('push_subscription')
        .select('id, endpoint, p256dh, auth, player_id, player:player_id!inner(is_admin)')
        .eq('player.is_admin', true)
    : supabase.from('push_subscription').select('id, endpoint, p256dh, auth, player_id')

  const [playerRes, fechaRes, countRes, subsRes] = await Promise.all([
    payload.subject_player_id
      ? supabase.from('player').select('name').eq('id', payload.subject_player_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from('tournament')
      .select('name, scheduled_at')
      .eq('id', payload.tournament_id)
      .maybeSingle(),
    supabase
      .from('entry')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', payload.tournament_id)
      .in('status', ['confirmed', 'checked_in', 'playing']),
    subsQuery,
  ])

  if (subsRes.error) return json(500, { error: subsRes.error.message })

  const fecha = fechaRes.data as { name?: string; scheduled_at?: string } | null
  const { title, body } = composeMessage(payload.event, {
    playerName: (playerRes.data as { name?: string } | null)?.name ?? 'Un jugador',
    fechaName: fecha?.name ?? 'la fecha',
    confirmedCount: countRes.count ?? 0,
    scheduledAt: fecha?.scheduled_at ?? null,
  })
  const message = JSON.stringify({
    title,
    body,
    url: `/fechas/${payload.tournament_id}`,
    tag: `${payload.event === 'fecha_created' ? 'fecha' : 'rsvp'}-${payload.tournament_id}`,
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

  return json(200, {
    event: payload.event,
    audience: adminsOnly ? 'admins' : 'all',
    recipients: subs.length,
    sent,
    failed,
    pruned: pruned.length,
  })
})
