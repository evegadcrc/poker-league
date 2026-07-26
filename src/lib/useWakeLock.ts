import { useEffect } from 'react'

/**
 * Hold a screen Wake Lock for as long as the component is mounted and the page
 * is foregrounded, so the device screen doesn't dim/sleep while the app is open
 * (e.g. watching the live tournament clock). Mount this once, high in the tree.
 *
 * Behavior:
 * - On mount (and only when the Screen Wake Lock API exists) it requests a
 *   `'screen'` lock and keeps the returned sentinel.
 * - Wake locks are auto-released by the browser whenever the page is hidden, so
 *   a `visibilitychange` listener re-requests the lock every time the document
 *   becomes visible again. The sentinel's own `release` event clears our handle
 *   so the next visibility change re-acquires cleanly.
 * - On unmount it removes the listener and releases the sentinel.
 *
 * Graceful degradation: on browsers without the API (older iOS < 16.4,
 * unsupported engines) it is a silent no-op. `request('screen')` can reject when
 * the document isn't active or permission is denied — those are swallowed, and
 * the next visibility change simply tries again.
 */
export function useWakeLock(): void {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return
    const wakeLock = navigator.wakeLock
    // Value may be undefined even when the key exists on some polyfilled envs.
    if (!wakeLock) return

    let sentinel: WakeLockSentinel | null = null
    let onRelease: (() => void) | null = null
    // Set on unmount so a request still in flight releases instead of retaining.
    let cancelled = false

    const request = async () => {
      // A request in a hidden document rejects; skip until visible. Only ever
      // hold one lock at a time.
      if (cancelled || sentinel || document.visibilityState !== 'visible') return
      try {
        const next = await wakeLock.request('screen')
        if (cancelled) {
          void next.release().catch(() => {})
          return
        }
        sentinel = next
        onRelease = () => {
          // Auto-released on hide: drop our handle so a later visibility change
          // re-acquires. Guard against a stale sentinel's late event.
          if (sentinel === next) sentinel = null
        }
        next.addEventListener('release', onRelease)
      } catch {
        // Document not active / permission denied → retry on next visibility.
      }
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void request()
    }

    document.addEventListener('visibilitychange', handleVisibility)
    void request()

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibility)
      const current = sentinel
      const handler = onRelease
      sentinel = null
      onRelease = null
      if (current) {
        if (handler) current.removeEventListener('release', handler)
        void current.release().catch(() => {})
      }
    }
  }, [])
}
