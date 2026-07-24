// ---------------------------------------------------------------------------
// Geofenced check-in helpers (slice 10). Keeps the browser-geolocation
// plumbing and the RPC-error classification out of the FechaDetail component so
// both are unit-testable and the component stays declarative.
// ---------------------------------------------------------------------------

export type Coords = { lat: number; lng: number }

/** Why a check-in attempt could not complete — drives the FE state/copy. */
export type CheckInFailure =
  | 'denied' // permission denied / position unavailable / timeout / no GPS API
  | 'out-of-range' // GPS ok but the player is outside the venue geofence
  | 'not-live' // fecha isn't open yet
  | 'other' // anything else (surface the raw message)

/**
 * Promisified `navigator.geolocation.getCurrentPosition`. Resolves with the
 * caller's coordinates, or rejects with the string 'denied' when geolocation is
 * unavailable or the user blocks/times-out the prompt — every non-success
 * outcome collapses to the friendly "pedile al admin que te registre" path.
 */
export function requestPosition(): Promise<Coords> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('denied'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => reject(new Error('denied')),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    )
  })
}

/** Map a check_in RPC error message onto a FE failure kind. */
export function classifyCheckInError(message: string | undefined | null): CheckInFailure {
  const m = (message ?? '').toLowerCase()
  if (m.includes('fuera de la sede')) return 'out-of-range'
  if (m.includes('no está abierto')) return 'not-live'
  return 'other'
}
