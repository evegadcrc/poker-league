import { useEffect } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth, useRole } from '@/lib/auth'
import { clearNext, peekNext, saveNext } from '@/lib/next'

function FullScreenLoading() {
  return (
    <div className="fullscreen-center" role="status" aria-live="polite">
      <span className="loading-text">Cargando…</span>
    </div>
  )
}

/**
 * Gate for every non-public route. Unauthenticated users — or an authenticated
 * session whose email has no bound `player` row — are sent to /login (where the
 * "pedile al admin" message is shown for the unbound case).
 *
 * Deep links: the path a logged-out visitor asked for (a shared /fechas/:id) is
 * remembered (see lib/next.ts) and, once session + player exist — whether they
 * logged in right away or came back through the magic link landing on `/` —
 * the visitor is sent there instead of the home screen. The stored value is
 * only READ during render (StrictMode-safe) and cleared after commit.
 */
export function RequireAuth() {
  const { session, player, loading } = useAuth()
  const location = useLocation()
  const here = `${location.pathname}${location.search}${location.hash}`
  const bound = Boolean(session && player)
  const anon = !loading && !bound
  const authed = !loading && bound
  const next = authed ? peekNext() : null
  const redirect = next && next !== here ? next : null

  useEffect(() => {
    if (anon) saveNext(here)
    else if (authed && next) clearNext()
  }, [anon, authed, next, here])

  if (loading) return <FullScreenLoading />
  if (anon) return <Navigate to="/login" replace />
  if (redirect) return <Navigate to={redirect} replace />
  return <Outlet />
}

/**
 * Nested under RequireAuth, so session + player are already guaranteed here.
 * Non-admins are bounced to the authenticated home, making /admin* unreachable.
 */
export function RequireAdmin() {
  const { loading } = useAuth()
  const { isAdmin } = useRole()
  if (loading) return <FullScreenLoading />
  if (!isAdmin) return <Navigate to="/" replace />
  return <Outlet />
}
