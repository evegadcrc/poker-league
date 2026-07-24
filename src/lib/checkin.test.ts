import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyCheckInError, requestPosition } from '@/lib/checkin'

describe('classifyCheckInError', () => {
  it('maps the out-of-range message', () => {
    expect(classifyCheckInError('check_in: estás fuera de la sede')).toBe('out-of-range')
  })
  it('maps the not-live message', () => {
    expect(classifyCheckInError('check_in: el torneo aún no está abierto')).toBe('not-live')
  })
  it('falls back to other for anything else', () => {
    expect(classifyCheckInError('some unexpected failure')).toBe('other')
    expect(classifyCheckInError(undefined)).toBe('other')
    expect(classifyCheckInError(null)).toBe('other')
  })
})

describe('requestPosition', () => {
  const original = globalThis.navigator

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true })
    vi.restoreAllMocks()
  })

  function stubGeolocation(geolocation: unknown) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { geolocation },
      configurable: true,
    })
  }

  it('resolves with coordinates on a successful fix', async () => {
    stubGeolocation({
      getCurrentPosition: (ok: (p: unknown) => void) =>
        ok({ coords: { latitude: 9.93, longitude: -84.08 } }),
    })
    await expect(requestPosition()).resolves.toEqual({ lat: 9.93, lng: -84.08 })
  })

  it('rejects with "denied" when the user blocks the prompt', async () => {
    stubGeolocation({
      getCurrentPosition: (_ok: unknown, err: (e: unknown) => void) => err({ code: 1 }),
    })
    await expect(requestPosition()).rejects.toThrow('denied')
  })

  it('rejects with "denied" when geolocation is unavailable', async () => {
    stubGeolocation(undefined)
    await expect(requestPosition()).rejects.toThrow('denied')
  })
})
