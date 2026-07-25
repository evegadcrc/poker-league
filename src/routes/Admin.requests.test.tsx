import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Admin → Solicitudes (access-request queue, migration 0022). Verifies the FE
// wiring: the pending list renders, Aprobar calls approve_request THEN dispatches
// the magic link (signInWithOtp) to the returned email, and Rechazar calls
// reject_request. Mocks @/lib/supabase so both the RPCs and auth.signInWithOtp
// are captured in one ordered call log.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  isAdmin: true,
  // signup_request rows returned by the pending-queue fetch.
  requests: [] as unknown[],
  // rpc results keyed by name (approve returns the approved email).
  rpc: {} as Record<string, { data: unknown; error: unknown }>,
  // Ordered log across rpc + otp so we can assert approve → signInWithOtp order.
  calls: [] as Array<{ type: 'rpc' | 'otp'; name?: string; args?: unknown; email?: string }>,
}))

vi.mock('@/lib/auth', () => ({
  useRole: () => ({ isAdmin: h.isAdmin }),
  useAuth: () => ({ player: null }),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        // Awaiting the builder resolves the list. signup_request → pending rows.
        then: (resolve: (v: unknown) => void) =>
          resolve(
            table === 'signup_request'
              ? { data: h.requests, error: null }
              : { data: [], error: null },
          ),
      }
      return b
    },
    rpc: (name: string, args: unknown) => {
      h.calls.push({ type: 'rpc', name, args })
      return Promise.resolve(h.rpc[name] ?? { data: null, error: null })
    },
    auth: {
      signInWithOtp: ({ email }: { email: string }) => {
        h.calls.push({ type: 'otp', email })
        return Promise.resolve({ data: {}, error: null })
      },
    },
    channel: () => {
      const chan: Record<string, unknown> = { on: () => chan, subscribe: () => chan }
      return chan
    },
    removeChannel: () => Promise.resolve(),
  },
}))

import Admin from './Admin'

const renderAdmin = () => render(<Admin />, { wrapper: MemoryRouter })

beforeEach(() => {
  h.isAdmin = true
  h.requests = [
    { id: 'req-1', email: 'nuevo@amigo.com', name: null, created_at: '2026-07-20T18:30:00Z' },
    { id: 'req-2', email: 'otro@amigo.com', name: 'Otro', created_at: '2026-07-21T12:00:00Z' },
  ]
  h.rpc = {
    approve_request: { data: 'nuevo@amigo.com', error: null },
    reject_request: { data: null, error: null },
  }
  h.calls = []
})

describe('Admin — Solicitudes (access requests, 0022)', () => {
  it('shows a pending badge and lists the requests', async () => {
    renderAdmin()
    // Badge reflects the pending count on the tab.
    expect(await screen.findByTestId('requests-badge')).toHaveTextContent('2')

    await userEvent.setup().click(screen.getByRole('tab', { name: /Solicitudes/ }))
    const rows = await screen.findAllByTestId('request-row')
    expect(rows).toHaveLength(2)
    expect(screen.getByText('nuevo@amigo.com')).toBeInTheDocument()
    expect(screen.getByText('otro@amigo.com')).toBeInTheDocument()
  })

  it('Aprobar calls approve_request then signInWithOtp with the returned email', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: /Solicitudes/ }))
    const rows = await screen.findAllByTestId('request-row')

    await user.click(within(rows[0]!).getByRole('button', { name: 'Aprobar' }))

    await waitFor(() => expect(h.calls.some((c) => c.name === 'approve_request')).toBe(true))
    const approveIdx = h.calls.findIndex((c) => c.name === 'approve_request')
    const otpIdx = h.calls.findIndex((c) => c.type === 'otp')
    expect(approveIdx).toBeGreaterThanOrEqual(0)
    expect(otpIdx).toBeGreaterThan(approveIdx) // link sent AFTER approval
    expect(h.calls[approveIdx]!.args).toMatchObject({ p_id: 'req-1' })
    expect(h.calls[otpIdx]!.email).toBe('nuevo@amigo.com')
    expect(await screen.findByTestId('requests-toast')).toHaveTextContent(/aprobado/i)
  })

  it('Rechazar calls reject_request and sends no link', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: /Solicitudes/ }))
    const rows = await screen.findAllByTestId('request-row')

    await user.click(within(rows[0]!).getByRole('button', { name: 'Rechazar' }))

    await waitFor(() => expect(h.calls.some((c) => c.name === 'reject_request')).toBe(true))
    const call = h.calls.find((c) => c.name === 'reject_request')!
    expect(call.args).toMatchObject({ p_id: 'req-1' })
    // No magic link on rejection.
    expect(h.calls.some((c) => c.type === 'otp')).toBe(false)
  })
})
