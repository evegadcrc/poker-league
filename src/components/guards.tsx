import { Navigate, Outlet } from 'react-router-dom'
import { useAuth, useRole } from '@/lib/auth'

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
 */
export function RequireAuth() {
  const { session, player, loading } = useAuth()
  if (loading) return <FullScreenLoading />
  if (!session || !player) return <Navigate to="/login" replace />
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
