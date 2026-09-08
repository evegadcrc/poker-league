import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { RequireAdmin, RequireAuth } from './guards'

// Controllable auth state — mutated per test before rendering.
const mockAuth = {
  session: null as unknown,
  player: null as unknown,
  loading: false,
}
let mockIsAdmin = false

vi.mock('@/lib/auth', () => ({
  useAuth: () => mockAuth,
  useRole: () => ({ isAdmin: mockIsAdmin }),
}))

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>LOGIN PAGE</div>} />
        <Route element={<RequireAuth />}>
          <Route path="/" element={<div>HOME PAGE</div>} />
          <Route element={<RequireAdmin />}>
            <Route path="/admin" element={<div>ADMIN PAGE</div>} />
          </Route>
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  mockAuth.session = null
  mockAuth.player = null
  mockAuth.loading = false
  mockIsAdmin = false
})

describe('route guards', () => {
  it('redirects an unauthenticated user from a protected route to /login', () => {
    mockAuth.session = null
    mockAuth.player = null
    renderAt('/')
    expect(screen.getByText('LOGIN PAGE')).toBeInTheDocument()
    expect(screen.queryByText('HOME PAGE')).not.toBeInTheDocument()
  })

  it('redirects an authenticated session with no bound player to /login', () => {
    mockAuth.session = { user: { id: 'u1' } }
    mockAuth.player = null // email matched no pre-created player
    renderAt('/')
    expect(screen.getByText('LOGIN PAGE')).toBeInTheDocument()
  })

  it('lets an authenticated, bound user reach home', () => {
    mockAuth.session = { user: { id: 'u1' } }
    mockAuth.player = { id: 'p1', is_admin: false }
    renderAt('/')
    expect(screen.getByText('HOME PAGE')).toBeInTheDocument()
  })

  it('bounces a non-admin away from an admin-only route to home', () => {
    mockAuth.session = { user: { id: 'u1' } }
    mockAuth.player = { id: 'p1', is_admin: false }
    mockIsAdmin = false
    renderAt('/admin')
    expect(screen.getByText('HOME PAGE')).toBeInTheDocument()
    expect(screen.queryByText('ADMIN PAGE')).not.toBeInTheDocument()
  })

  it('lets an admin reach the admin-only route', () => {
    mockAuth.session = { user: { id: 'u1' } }
    mockAuth.player = { id: 'p1', is_admin: true }
    mockIsAdmin = true
    renderAt('/admin')
    expect(screen.getByText('ADMIN PAGE')).toBeInTheDocument()
  })

  it('shows a loading state while auth resolves (no premature redirect)', () => {
    mockAuth.session = null
    mockAuth.player = null
    mockAuth.loading = true
    renderAt('/')
    expect(screen.getByText(/cargando/i)).toBeInTheDocument()
    expect(screen.queryByText('LOGIN PAGE')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Deep links through login (lib/next.ts): a logged-out visitor's destination is
// remembered when RequireAuth bounces them to /login and consumed once they are
// signed in — including the magic-link case where they land back on `/`.
// ---------------------------------------------------------------------------
function renderDeep(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>LOGIN PAGE</div>} />
        <Route element={<RequireAuth />}>
          <Route path="/" element={<div>HOME PAGE</div>} />
          <Route path="/fechas/:id" element={<div>FECHA PAGE</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('route guards — deep link through login', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('remembers the fecha a logged-out visitor asked for and sends them there after login', () => {
    const first = renderDeep('/fechas/t-1')
    expect(screen.getByText('LOGIN PAGE')).toBeInTheDocument()
    first.unmount()

    // Magic link lands on `/` with a bound session.
    mockAuth.session = { user: { id: 'u1' } }
    mockAuth.player = { id: 'p1', is_admin: false }
    renderDeep('/')
    expect(screen.getByText('FECHA PAGE')).toBeInTheDocument()
    expect(screen.queryByText('HOME PAGE')).not.toBeInTheDocument()
  })

  it('consumes the remembered destination only once', () => {
    renderDeep('/fechas/t-1').unmount()
    mockAuth.session = { user: { id: 'u1' } }
    mockAuth.player = { id: 'p1', is_admin: false }
    renderDeep('/').unmount()
    renderDeep('/')
    expect(screen.getByText('HOME PAGE')).toBeInTheDocument()
  })

  it('does not remember the home screen itself', () => {
    renderDeep('/').unmount()
    mockAuth.session = { user: { id: 'u1' } }
    mockAuth.player = { id: 'p1', is_admin: false }
    renderDeep('/')
    expect(screen.getByText('HOME PAGE')).toBeInTheDocument()
  })

  it('lands directly on the fecha when the visitor is already signed in', () => {
    mockAuth.session = { user: { id: 'u1' } }
    mockAuth.player = { id: 'p1', is_admin: false }
    renderDeep('/fechas/t-1')
    expect(screen.getByText('FECHA PAGE')).toBeInTheDocument()
  })
})
