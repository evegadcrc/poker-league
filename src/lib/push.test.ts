import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted supabase mock: captures upsert / delete payloads on push_subscription.
const h = vi.hoisted(() => ({
  upserts: [] as Array<{ table: string; row: unknown; opts: unknown }>,
  deletes: [] as Array<{ table: string; eq: unknown }>,
  upsertError: null as null | { message: string },
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      upsert: (row: unknown, opts: unknown) => {
        h.upserts.push({ table, row, opts })
        return Promise.resolve({ error: h.upsertError })
      },
      delete: () => ({
        eq: (col: string, val: unknown) => {
          h.deletes.push({ table, eq: [col, val] })
          return Promise.resolve({ error: null })
        },
      }),
    }),
  },
}))

import {
  VAPID_PUBLIC_KEY,
  getPushSubscription,
  pushSupport,
  subscribePush,
  unsubscribePush,
  urlBase64ToUint8Array,
} from './push'

describe('pushSupport', () => {
  const win = { PushManager: {}, Notification: {} }
  it('ok when SW + PushManager + Notification exist', () => {
    expect(pushSupport({ userAgent: 'Chrome', serviceWorker: {} }, win)).toBe('ok')
  })
  it('needs-install on iOS Safari in the browser (no PushManager, not standalone)', () => {
    expect(
      pushSupport(
        { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari', serviceWorker: {} },
        { Notification: {}, matchMedia: () => ({ matches: false }) },
      ),
    ).toBe('needs-install')
  })
  it('unsupported on iOS when installed but APIs still missing, and on desktop without push', () => {
    expect(
      pushSupport(
        { userAgent: 'iPhone', serviceWorker: {}, standalone: true },
        { Notification: {} },
      ),
    ).toBe('unsupported')
    expect(pushSupport({ userAgent: 'Firefox old' }, {})).toBe('unsupported')
  })
})

describe('urlBase64ToUint8Array', () => {
  it('decodes URL-safe base64 (with implicit padding) into bytes', () => {
    // "hi?" → aGk_ in URL-safe base64 (standard: aGk/).
    expect(Array.from(urlBase64ToUint8Array('aGk_'))).toEqual([104, 105, 63])
    expect(urlBase64ToUint8Array(VAPID_PUBLIC_KEY)).toHaveLength(65) // uncompressed P-256 point
  })
})

// --- subscribe / unsubscribe against a fake service worker registration ------
type FakeSub = {
  endpoint: string
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } }
  unsubscribe: () => Promise<boolean>
}
function fakeSub(endpoint = 'https://push.example/abc'): FakeSub {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'P256', auth: 'AUTH' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  }
}

const pm = {
  current: null as FakeSub | null,
  getSubscription: vi.fn(async () => pm.current),
  subscribe: vi.fn(async (_opts: unknown) => {
    pm.current = fakeSub()
    return pm.current
  }),
}
let registrationAvailable = true

beforeEach(() => {
  h.upserts = []
  h.deletes = []
  h.upsertError = null
  pm.current = null
  pm.getSubscription.mockClear()
  pm.subscribe.mockClear()
  registrationAvailable = true
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: async () => (registrationAvailable ? { pushManager: pm } : undefined),
    },
  })
  vi.stubGlobal('Notification', {
    permission: 'default',
    requestPermission: vi.fn().mockResolvedValue('granted'),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('subscribePush', () => {
  it('asks permission, subscribes with the VAPID key and upserts the row keyed by endpoint', async () => {
    const res = await subscribePush('p-1')
    expect(res).toEqual({ ok: true })
    expect(pm.subscribe).toHaveBeenCalledTimes(1)
    const arg = pm.subscribe.mock.calls[0]![0] as unknown as {
      userVisibleOnly: boolean
      applicationServerKey: Uint8Array
    }
    expect(arg.userVisibleOnly).toBe(true)
    expect(arg.applicationServerKey).toHaveLength(65)
    expect(h.upserts).toEqual([
      {
        table: 'push_subscription',
        row: {
          player_id: 'p-1',
          endpoint: 'https://push.example/abc',
          p256dh: 'P256',
          auth: 'AUTH',
          user_agent: navigator.userAgent,
        },
        opts: { onConflict: 'endpoint' },
      },
    ])
  })

  it('reuses an existing browser subscription instead of creating a second one', async () => {
    pm.current = fakeSub('https://push.example/existing')
    const res = await subscribePush('p-1')
    expect(res).toEqual({ ok: true })
    expect(pm.subscribe).not.toHaveBeenCalled()
    expect((h.upserts[0]!.row as { endpoint: string }).endpoint).toBe('https://push.example/existing')
  })

  it('reports denied permission without subscribing or writing', async () => {
    ;(Notification.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue('denied')
    const res = await subscribePush('p-1')
    expect(res).toEqual({ ok: false, reason: 'denied' })
    expect(pm.subscribe).not.toHaveBeenCalled()
    expect(h.upserts).toHaveLength(0)
  })

  it('reports no-sw when no service worker is registered (dev server)', async () => {
    registrationAvailable = false
    expect(await subscribePush('p-1')).toEqual({ ok: false, reason: 'no-sw' })
  })

  it('surfaces a row-write failure', async () => {
    h.upsertError = { message: 'rls' }
    expect(await subscribePush('p-1')).toEqual({ ok: false, reason: 'error', message: 'rls' })
  })
})

describe('unsubscribePush / getPushSubscription', () => {
  it('deletes the row by endpoint, then unsubscribes the browser', async () => {
    pm.current = fakeSub('https://push.example/gone')
    await unsubscribePush()
    expect(h.deletes).toEqual([{ table: 'push_subscription', eq: ['endpoint', 'https://push.example/gone'] }])
    expect(pm.current.unsubscribe).toHaveBeenCalled()
  })

  it('is a no-op without a subscription', async () => {
    await unsubscribePush()
    expect(h.deletes).toHaveLength(0)
    expect(await getPushSubscription()).toBeNull()
  })
})
