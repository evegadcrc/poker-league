import { supabase } from '@/lib/supabase'

// ---------------------------------------------------------------------------
// Web Push (client side). The admin turns "Avisos de la fecha" on in Perfil:
// we ask for notification permission, subscribe the service worker's
// PushManager with our VAPID public key and store the subscription in
// `push_subscription` (owner-only RLS, mig 0032). The `entry` trigger →
// `push-notify` Edge Function does the sending; public/sw-push.js shows it.
//
// iOS: Web Push exists only for a PWA installed to the home screen (16.4+), so
// Safari-in-browser reports `needs-install` rather than `unsupported`.
// ---------------------------------------------------------------------------

/** VAPID public key — not a secret (it is embedded in every subscription). The
 *  env override exists for a future key rotation / other deployments. */
export const VAPID_PUBLIC_KEY: string =
  (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ||
  'BEr3wwsyFTjIHH8KEjcty8i_6TLfQjlw_5nPk8_aRZl89CVWAdu3vhCNTnepnsI6BXlsJMCC_hZ659BDA0kLNLU'

export type PushSupport = 'ok' | 'unsupported' | 'needs-install'

type NavLike = Pick<Navigator, 'userAgent'> & {
  serviceWorker?: unknown
  standalone?: boolean
  maxTouchPoints?: number
  platform?: string
}
type WinLike = {
  PushManager?: unknown
  Notification?: unknown
  matchMedia?: (q: string) => { matches: boolean }
}

function isIOS(nav: NavLike): boolean {
  return (
    /iPhone|iPad|iPod/i.test(nav.userAgent) ||
    (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1)
  )
}

function isStandalone(nav: NavLike, win: WinLike): boolean {
  if (nav.standalone === true) return true
  try {
    return Boolean(win.matchMedia?.('(display-mode: standalone)').matches)
  } catch {
    return false
  }
}

/** Can this browser do Web Push right now? */
export function pushSupport(
  nav: NavLike = navigator as NavLike,
  win: WinLike = window as unknown as WinLike,
): PushSupport {
  const hasApis = Boolean(nav.serviceWorker) && 'PushManager' in win && 'Notification' in win
  if (hasApis) return 'ok'
  return isIOS(nav) && !isStandalone(nav, win) ? 'needs-install' : 'unsupported'
}

/** VAPID key (URL-safe base64) → the BufferSource PushManager wants. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    // `.ready` would hang forever when no SW is registered (e.g. `npm run dev`,
    // where the PWA plugin is disabled) — ask for the registration instead.
    return (await navigator.serviceWorker.getRegistration()) ?? null
  } catch {
    return null
  }
}

/** The browser's current push subscription, if any. */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  const reg = await registration()
  if (!reg) return null
  try {
    return await reg.pushManager.getSubscription()
  } catch {
    return null
  }
}

async function upsertRow(playerId: string, sub: PushSubscription): Promise<string | null> {
  const json = sub.toJSON()
  const { error } = await supabase.from('push_subscription').upsert(
    {
      player_id: playerId,
      endpoint: sub.endpoint,
      p256dh: json.keys?.p256dh ?? '',
      auth: json.keys?.auth ?? '',
      user_agent: navigator.userAgent,
    },
    { onConflict: 'endpoint' },
  )
  return error ? error.message : null
}

export type SubscribeResult =
  | { ok: true }
  | { ok: false; reason: 'no-sw' | 'denied' | 'error'; message?: string }

/** Ask permission, subscribe this device and store the subscription. */
export async function subscribePush(playerId: string): Promise<SubscribeResult> {
  const reg = await registration()
  if (!reg) return { ok: false, reason: 'no-sw' }
  let permission: NotificationPermission
  try {
    permission = await Notification.requestPermission()
  } catch {
    permission = Notification.permission
  }
  if (permission !== 'granted') return { ok: false, reason: 'denied' }
  try {
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
      }))
    const err = await upsertRow(playerId, sub)
    if (err) return { ok: false, reason: 'error', message: err }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

/** Re-save an existing browser subscription (self-heal after a server prune). */
export async function syncPushSubscription(playerId: string): Promise<void> {
  const sub = await getPushSubscription()
  if (sub) await upsertRow(playerId, sub)
}

/** Remove this device's subscription (row first, then the browser side). */
export async function unsubscribePush(): Promise<void> {
  const sub = await getPushSubscription()
  if (!sub) return
  await supabase.from('push_subscription').delete().eq('endpoint', sub.endpoint)
  try {
    await sub.unsubscribe()
  } catch {
    // Already gone on the browser side — nothing else to do.
  }
}
