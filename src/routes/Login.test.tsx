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
  // request_access gate result: default 'member' so the legacy send/error tests
  // exercise the magic-link path unchanged.
  requestResult: { result: 'member' as 'member' | 'pending' | 'rejected' | null, error: null as string | null },
  requestCalls: [] as string[],
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
    requestAccess: (email: string) => {
      h.requestCalls.push(email)
      return Promise.resolve(h.requestResult)
    },
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
  h.requestResult = { result: 'member', error: null }
  h.requestCalls = []
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

  it('member: request_access→member sends the magic link (link path unchanged)', async () => {
    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText('Correo electrónico'), 'socio@test.com')
    await user.click(screen.getByRole('button', { name: 'Enviar enlace' }))

    // Gate is consulted first, then the OTP link is dispatched to the member.
    await waitFor(() => expect(h.requestCalls).toEqual(['socio@test.com']))
    expect(h.signInCalls).toEqual(['socio@test.com'])
    await waitFor(() => {
      expect(document.querySelector('.login-note.ok')?.textContent).toContain(
        'Enlace enviado a socio@test.com',
      )
    })
  })

  it('pending: an unknown email shows the "solicitud enviada" message and sends NO link', async () => {
    h.requestResult = { result: 'pending', error: null }
    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText('Correo electrónico'), 'desconocido@test.com')
    await user.click(screen.getByRole('button', { name: 'Enviar enlace' }))

    await waitFor(() => expect(h.requestCalls).toEqual(['desconocido@test.com']))
    expect(await screen.findByText(/Solicitud anotada en la lista/i)).toBeInTheDocument()
    // Crucially, no magic link is sent for a pending request.
    expect(h.signInCalls).toEqual([])
  })

  it('rejected: a rejected email shows a neutral message and sends NO link', async () => {
    h.requestResult = { result: 'rejected', error: null }
    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText('Correo electrónico'), 'rechazado@test.com')
    await user.click(screen.getByRole('button', { name: 'Enviar enlace' }))

    expect(await screen.findByText(/No se pudo procesar la solicitud/i)).toBeInTheDocument()
    expect(h.signInCalls).toEqual([])
  })

  it('unbound (no-player): a session with no league player shows the "solicitar al admin" message + sign out', () => {
    h.session = { user: { id: 'u-1' } }
    h.player = null
    h.bindError = 'no-player'
    renderLogin()

    expect(screen.getByText(/no está en la liga/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cerrar sesión/ })).toBeInTheDocument()
    // No magic-link form in the unbound terminal state.
    expect(screen.queryByLabelText('Correo electrónico')).not.toBeInTheDocument()
  })

  it('unbound (other): a bind RPC failure shows the generic "no se pudo cargar el perfil" message', () => {
    h.session = { user: { id: 'u-1' } }
    h.player = null
    h.bindError = 'other'
    renderLogin()

    expect(screen.getByText(/no se pudo cargar el perfil/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cerrar sesión/ })).toBeInTheDocument()
  })
})
