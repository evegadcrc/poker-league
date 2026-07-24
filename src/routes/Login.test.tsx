import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Login screen (magic-link) states: idle → sending → sent (+ resend affordance)
// / error (+ Reintentar) / unbound (session with no bound player). Mocks useAuth
// and useTheme; the supabase client is never touched (signInWithOtp/signOut are
// the only side effects and come from the auth context).
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  session: null as unknown,
  player: null as unknown,
  loading: false,
  bindError: null as 'no-player' | 'other' | null,
  signInResult: { error: null as string | null },
  signInCalls: [] as string[],
  signOut: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    session: h.session,
    player: h.player,
    loading: h.loading,
    bindError: h.bindError,
    signInWithOtp: (email: string) => {
      h.signInCalls.push(email)
      return Promise.resolve(h.signInResult)
    },
    signOut: h.signOut,
  }),
}))

vi.mock('@/lib/theme', () => ({
  useTheme: () => ({ theme: 'light', cycleTheme: vi.fn() }),
  THEME_ICONS: { light: '☀', dark: '☾', neon: '⚡' },
  THEME_LABELS: { light: 'Almanaque claro', dark: 'Nocturno', neon: 'Neón' },
}))

import Login from './Login'

const renderLogin = () => render(<Login />, { wrapper: MemoryRouter })

beforeEach(() => {
  h.session = null
  h.player = null
  h.loading = false
  h.bindError = null
  h.signInResult = { error: null }
  h.signInCalls = []
  h.signOut = vi.fn()
})

describe('Login — magic link', () => {
  it('idle: renders the email form with the send button', () => {
    renderLogin()
    expect(screen.getByLabelText('Correo electrónico')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enviar enlace' })).toBeInTheDocument()
  })

  it('sent: a successful send shows the envelope confirmation and a resend affordance', async () => {
    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText('Correo electrónico'), 'edwin@test.com')
    await user.click(screen.getByRole('button', { name: 'Enviar enlace' }))

    // Confirmation copy names the address the link was sent to.
    await waitFor(() => {
      const note = document.querySelector('.login-note.ok')
      expect(note?.textContent).toContain('Enlace enviado a edwin@test.com')
    })
    expect(h.signInCalls).toEqual(['edwin@test.com'])
    // The email input is locked in the sent state.
    expect(screen.getByLabelText('Correo electrónico')).toBeDisabled()

    // Resend affordance re-fires signInWithOtp with the same address.
    await user.click(screen.getByRole('button', { name: 'Reenviar enlace' }))
    await waitFor(() => expect(h.signInCalls).toEqual(['edwin@test.com', 'edwin@test.com']))
  })

  it('error: a failed send shows the error copy and Reintentar returns to idle', async () => {
    h.signInResult = { error: 'Correo no válido.' }
    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText('Correo electrónico'), 'edwin@test.com')
    await user.click(screen.getByRole('button', { name: 'Enviar enlace' }))

    const errNote = await waitFor(() => {
      const n = document.querySelector('.login-note.err')
      expect(n).not.toBeNull()
      return n as HTMLElement
    })
    expect(errNote.textContent).toContain('Correo no válido.')

    // Reintentar resets to idle: the error clears and the input is editable again.
    await user.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(document.querySelector('.login-note.err')).toBeNull()
    expect(screen.getByLabelText('Correo electrónico')).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Enviar enlace' })).toBeInTheDocument()
  })

  it('unbound (no-player): a session with no league player shows the "pedile al admin" message + sign out', () => {
    h.session = { user: { id: 'u-1' } }
    h.player = null
    h.bindError = 'no-player'
    renderLogin()

    expect(screen.getByText(/no está en la liga/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cerrar sesión/ })).toBeInTheDocument()
    // No magic-link form in the unbound terminal state.
    expect(screen.queryByLabelText('Correo electrónico')).not.toBeInTheDocument()
  })

  it('unbound (other): a bind RPC failure shows the generic "no pudimos cargar tu perfil" message', () => {
    h.session = { user: { id: 'u-1' } }
    h.player = null
    h.bindError = 'other'
    renderLogin()

    expect(screen.getByText(/no pudimos cargar tu perfil/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cerrar sesión/ })).toBeInTheDocument()
  })
})
