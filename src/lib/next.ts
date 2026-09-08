// ---------------------------------------------------------------------------
// "Volver a donde iba" — remember the in-app path a logged-out visitor wanted
// (a shared /fechas/:id link) across the magic-link round trip.
//
// The magic link always lands on `/` (emailRedirectTo is the origin; changing
// it per-link would need the prod redirect allowlist), so the destination is
// kept in localStorage: RequireAuth SAVES it when bouncing to /login and reads
// it back as soon as session + player exist. Same-origin paths only, never the
// home or login screens, and a 24h TTL so a stale entry from a link that was
// never followed can't hijack a later login.
//
// `peekNext` is a PURE read (safe to call during render — React StrictMode
// renders twice in dev, so a read-and-clear in render would consume the value
// on the discarded first pass); `clearNext` is the side effect, run after
// commit. `takeNext` combines both for non-render callers.
// ---------------------------------------------------------------------------

export const NEXT_KEY = 'pf-next'
const TTL_MS = 24 * 60 * 60 * 1000

/** Same-origin, non-trivial in-app path: "/fechas/abc", "/vivo?x=1". */
export function isSafeNext(path: string | null | undefined): path is string {
  if (!path || path.length > 2048) return false
  if (!path.startsWith('/') || path.startsWith('//')) return false
  if (/[\s\\]/.test(path)) return false
  const pathname = path.split(/[?#]/)[0] ?? ''
  return pathname !== '/' && pathname !== '/login'
}

export function saveNext(path: string, now: number = Date.now()): void {
  if (!isSafeNext(path)) return
  try {
    localStorage.setItem(NEXT_KEY, JSON.stringify({ path, ts: now }))
  } catch {
    // localStorage unavailable — the visitor just lands on the home screen.
  }
}

/** Read WITHOUT clearing. Null when nothing valid is stored (or it expired). */
export function peekNext(now: number = Date.now()): string | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(NEXT_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { path?: unknown; ts?: unknown }
    if (typeof parsed.ts !== 'number' || now - parsed.ts > TTL_MS) return null
    return isSafeNext(parsed.path as string) ? (parsed.path as string) : null
  } catch {
    return null
  }
}

export function clearNext(): void {
  try {
    localStorage.removeItem(NEXT_KEY)
  } catch {
    // nothing to clear
  }
}

/** Read-and-clear (for non-render callers). */
export function takeNext(now: number = Date.now()): string | null {
  const next = peekNext(now)
  clearNext()
  return next
}
