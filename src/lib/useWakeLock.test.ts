import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWakeLock } from './useWakeLock'

// ---------------------------------------------------------------------------
// jsdom has no navigator.wakeLock, so the supported-path tests install a mock
// whose request() hands back a sentinel with spied release/addEventListener and
// a `fireRelease()` helper to simulate the browser's auto-release-on-hide.
// document.visibilityState is 'visible' by default in jsdom.
// ---------------------------------------------------------------------------

type MockSentinel = {
  released: boolean
  release: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  fireRelease: () => void
}

function installWakeLock() {
  const sentinels: MockSentinel[] = []
  const request = vi.fn(async () => {
    const releaseListeners: Array<() => void> = []
    const sentinel: MockSentinel = {
      released: false,
      release: vi.fn(() => Promise.resolve()),
      addEventListener: vi.fn((type: string, cb: () => void) => {
        if (type === 'release') releaseListeners.push(cb)
      }),
      removeEventListener: vi.fn(),
      fireRelease: () => releaseListeners.forEach((cb) => cb()),
    }
    sentinel.release.mockImplementation(() => {
      sentinel.released = true
      return Promise.resolve()
    })
    sentinels.push(sentinel)
    return sentinel as unknown as WakeLockSentinel
  })
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    writable: true,
    value: { request },
  })
  return { request, sentinels }
}

function removeWakeLock() {
  // Remove the API entirely so `'wakeLock' in navigator` is false.
  delete (navigator as unknown as { wakeLock?: unknown }).wakeLock
}

beforeEach(() => {
  removeWakeLock()
})

afterEach(() => {
  removeWakeLock()
})

describe('useWakeLock', () => {
  it("requests a 'screen' lock on mount when supported", async () => {
    const { request } = installWakeLock()

    await act(async () => {
      renderHook(() => useWakeLock())
    })

    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('screen')
  })

  it('re-requests the lock when the page becomes visible after a release', async () => {
    const { request, sentinels } = installWakeLock()

    await act(async () => {
      renderHook(() => useWakeLock())
    })
    expect(request).toHaveBeenCalledTimes(1)

    // Simulate the browser auto-releasing the lock when the page was hidden.
    act(() => {
      sentinels[0].fireRelease()
    })

    // Page becomes visible again → the hook re-acquires (visible by default).
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(request).toHaveBeenCalledTimes(2)
  })

  it('releases the sentinel on unmount', async () => {
    const { sentinels } = installWakeLock()

    let unmount = () => {}
    await act(async () => {
      ;({ unmount } = renderHook(() => useWakeLock()))
    })
    expect(sentinels).toHaveLength(1)

    act(() => {
      unmount()
    })

    expect(sentinels[0].release).toHaveBeenCalledTimes(1)
  })

  it('is a silent no-op when navigator.wakeLock is unsupported', async () => {
    removeWakeLock()
    expect('wakeLock' in navigator).toBe(false)

    let unmount = () => {}
    await act(async () => {
      expect(() => {
        ;({ unmount } = renderHook(() => useWakeLock()))
      }).not.toThrow()
    })

    expect(() => act(() => unmount())).not.toThrow()
  })

  it('does not throw when navigator.wakeLock exists but is undefined', async () => {
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      writable: true,
      value: undefined,
    })

    let unmount = () => {}
    await act(async () => {
      expect(() => {
        ;({ unmount } = renderHook(() => useWakeLock()))
      }).not.toThrow()
    })

    expect(() => act(() => unmount())).not.toThrow()
  })
})
