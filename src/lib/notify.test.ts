import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sound = vi.hoisted(() => ({ playCue: vi.fn(), resumeAudio: vi.fn() }))
vi.mock('@/lib/sound', () => ({
  playCue: sound.playCue,
  resumeAudio: sound.resumeAudio,
}))

import { useLiveEventCues, type LiveEventSignal } from './notify'

function sig(level: number, remaining: number, out: Record<string, string> = {}): LiveEventSignal {
  return {
    settled: true,
    tournament: {
      id: 't-1',
      name: 'Fecha 8',
      currentLevel: level,
      smallBlind: level * 25,
      bigBlind: level * 50,
      remaining,
    },
    out,
  }
}

const warnCount = () => sound.playCue.mock.calls.filter((c) => c[0] === 'levelWarning').length

beforeEach(() => {
  sound.playCue.mockClear()
  sound.resumeAudio.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useLiveEventCues — final-seconds warning (state-based, once per level)', () => {
  it('fires ONCE on the downward crossing of the threshold, never per tick, and re-arms per level', () => {
    const { rerender } = renderHook((s: LiveEventSignal) => useLiveEventCues(s), {
      initialProps: sig(1, 12), // seed above threshold — no fire
    })
    expect(warnCount()).toBe(0)

    rerender(sig(1, 11)) // still above → no fire
    expect(warnCount()).toBe(0)

    rerender(sig(1, 9)) // 11 → 9 crosses ≤10 → fire once
    expect(warnCount()).toBe(1)

    rerender(sig(1, 6)) // keeps ticking down, same level → latched, no re-fire
    rerender(sig(1, 3))
    expect(warnCount()).toBe(1)

    // New level re-arms the warning.
    rerender(sig(2, 40)) // level advanced, well above threshold
    rerender(sig(2, 8)) // crosses on level 2 → fire again
    expect(warnCount()).toBe(2)
  })

  it('does not fire when the clock is already at/below threshold on the first observation', () => {
    const { rerender } = renderHook((s: LiveEventSignal) => useLiveEventCues(s), {
      initialProps: sig(1, 8), // opened the app mid-warning-window → seed only
    })
    expect(warnCount()).toBe(0)
    rerender(sig(1, 7)) // no upward-then-downward crossing recorded → still silent
    expect(warnCount()).toBe(0)
  })
})

describe('useLiveEventCues — requestNotifications', () => {
  it('reports "unsupported" and still unlocks audio when the Notification API is absent', async () => {
    vi.stubGlobal('Notification', undefined)
    const { result } = renderHook(() => useLiveEventCues({ settled: true, tournament: null, out: {} }))
    expect(result.current.permission).toBe('unsupported')

    await act(async () => {
      await result.current.requestNotifications()
    })
    expect(sound.resumeAudio).toHaveBeenCalledTimes(1)
    expect(result.current.permission).toBe('unsupported')
  })

  it('requests permission and reflects the granted result', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted')
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    const { result } = renderHook(() => useLiveEventCues({ settled: true, tournament: null, out: {} }))
    expect(result.current.permission).toBe('default')

    await act(async () => {
      await result.current.requestNotifications()
    })
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(result.current.permission).toBe('granted')
  })
})
