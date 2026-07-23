import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { ThemeProvider } from './lib/theme'

// Mock the auth layer so App's guards/screens render deterministically without
// a live Supabase session. The binding RPC itself is covered by the gated
// integration test (src/lib/claim_player.test.ts).
const mockAuth = {
  session: null as unknown,
  user: null as unknown,
  player: null as unknown,
  loading: false,
  bindError: null as unknown,
  signInWithOtp: vi.fn(async () => ({ error: null })),
  signOut: vi.fn(async () => {}),
}
let mockIsAdmin = false

vi.mock('@/lib/auth', () => ({
  useAuth: () => mockAuth,
  useRole: () => ({ isAdmin: mockIsAdmin }),
}))

function renderApp() {
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  )
}

function signInAs(player: { name: string; is_admin: boolean }) {
  mockAuth.session = { user: { id: 'u1' } }
  mockAuth.user = { id: 'u1' }
  mockAuth.player = { id: 'p1', ...player }
  mockIsAdmin = player.is_admin
}

describe('App routing', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    window.history.replaceState({}, '', '/')
    mockAuth.session = null
    mockAuth.user = null
    mockAuth.player = null
    mockAuth.loading = false
    mockIsAdmin = false
  })

  it('shows the login screen for an unauthenticated visitor', () => {
    renderApp()
    expect(screen.getByRole('button', { name: /enviar enlace/i })).toBeInTheDocument()
    expect(screen.queryByText('POKER FRIENDS')).not.toBeInTheDocument()
  })

  it('renders the authenticated home shell with the wordmark', () => {
    signInAs({ name: 'Carlos Jiménez', is_admin: true })
    renderApp()
    // Exact, case-sensitive match hits only the header wordmark.
    expect(screen.getByText('POKER FRIENDS')).toBeInTheDocument()
    expect(screen.getByText(/Hola, Carlos/)).toBeInTheDocument()
  })

  it('cycles the theme light → dark → neon → light and persists it', async () => {
    signInAs({ name: 'Carlos Jiménez', is_admin: false })
    const user = userEvent.setup()
    renderApp()

    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    const button = screen.getByRole('button', { name: /tema/i })

    await user.click(button)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('pf-theme')).toBe('dark')

    await user.click(button)
    expect(document.documentElement.getAttribute('data-theme')).toBe('neon')

    await user.click(button)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem('pf-theme')).toBe('light')
  })
})
