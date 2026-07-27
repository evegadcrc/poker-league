import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// ---------------------------------------------------------------------------
// Slice 10 — FechaDetail geofenced check-in flow (RTL). Mocks navigator
// .geolocation + the check_in / admin_check_in RPCs. Its own module-level mocks
// (isAdmin toggled per test) live here rather than in FechaDetail.test.tsx.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  player: { id: 'p-me', name: 'Edwin V.', avatar_url: null } as {
    id: string
    name: string
    avatar_url: string | null
  } | null,
  isAdmin: false,
  single: {} as Record<string, { data: unknown; error: unknown }>,
  list: {} as Record<string, { data: unknown; error: unknown }>,
  rpcCalls: [] as Array<[string, unknown]>,
  updateCalls: [] as Array<[string, unknown]>,
  rpcResult: { data: null as unknown, error: null as unknown },
}))

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ player: h.player }),
  useRole: () => ({ isAdmin: h.isAdmin }),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: () => b,
        order: () => b,
        update: (payload: unknown) => {
          h.updateCalls.push([table, payload])
          return b
        },
        maybeSingle: () => Promise.resolve(h.single[table] ?? { data: null, error: null }),
        single: () => Promise.resolve(h.single[table] ?? { data: null, error: null }),
        then: (resolve: (v: unknown) => void) =>
          resolve(h.list[table] ?? { data: [], error: null }),
      }
      return b
    },
    rpc: (name: string, args: unknown) => {
      h.rpcCalls.push([name, args])
      return Promise.resolve(h.rpcResult)
    },
    // Realtime stub (mig 0030 live-refresh subscription) — chainable no-op.
    channel: () => {
      const ch: Record<string, unknown> = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: () => {},
  },
}))

import FechaDetail from './FechaDetail'

const FUTURE = new Date(Date.now() + 2 * 3_600_000).toISOString()
// Inside the 1h pre-live window (30 min out) vs. comfortably outside it (2h out).
const PRELIVE = new Date(Date.now() + 30 * 60_000).toISOString()

function setTournament(status = 'live', scheduledAt = FUTURE) {
  h.single.tournament = {
    data: {
      id: 't-1',
      season_id: 's1',
      name: 'Fecha 9',
      scheduled_at: scheduledAt,
      status,
      geofence_radius_m: 100,
    },
    error: null,
  }
}

function setEntries(myStatus: string) {
  h.list.entry = {
    data: [
      { id: 'e-me', player_id: 'p-me', status: myStatus, rsvp_at: null, cancelled_at: null, checked_in_at: null, early_bird: false, chips: null, points_earned: null, final_position: null, rebuys_count: 0, player: { name: 'Edwin V.', avatar_url: null } },
      { id: 'e2', player_id: 'p2', status: 'confirmed', rsvp_at: null, cancelled_at: null, checked_in_at: null, early_bird: false, chips: null, points_earned: null, final_position: null, rebuys_count: 0, player: { name: 'María R.', avatar_url: null } },
    ],
    error: null,
  }
}

/** Install a navigator.geolocation stub that either succeeds or errors. */
function stubGeo(mode: 'ok' | 'deny') {
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (ok: (p: unknown) => void, err: (e: unknown) => void) => {
        if (mode === 'ok') ok({ coords: { latitude: 9.93, longitude: -84.08 } })
        else err({ code: 1 })
      },
    },
  })
}

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={['/fechas/t-1']}>
      <Routes>
        <Route path="/fechas/:id" element={<FechaDetail />} />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(() => {
  h.player = { id: 'p-me', name: 'Edwin V.', avatar_url: null }
  h.isAdmin = false
  h.rpcCalls = []
  h.updateCalls = []
  h.rpcResult = { data: null, error: null }
  h.single = { season: { data: { cancel_bands: [] }, error: null } }
  setTournament('live')
  setEntries('confirmed')
})

describe('FechaDetail — geofenced check-in', () => {
  it('a live + confirmed player sees the geo banner and the check-in button', async () => {
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    expect(screen.getByText(/sin GPS, el admin te registra/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Hacer check-in/i })).toBeInTheDocument()
  })

  it('pre-live (scheduled, ≤1h before start) + confirmed player sees the check-in button', async () => {
    setTournament('scheduled', PRELIVE)
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    expect(screen.getByRole('button', { name: /Hacer check-in/i })).toBeInTheDocument()
    // Pre-live surfaces its "Registro abierto" state label + sub-label.
    expect(screen.getByTestId('fd-prelive-note')).toHaveTextContent(/check-in y pagos abiertos/i)
  })

  it('scheduled but NOT yet pre-live (>1h before start): NO check-in button yet', async () => {
    setTournament('scheduled', FUTURE) // 2h out
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    // Check-in is gated to the 1h window — a confirmed player only sees RSVP.
    expect(screen.queryByRole('button', { name: /Hacer check-in/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('fd-prelive-note')).not.toBeInTheDocument()
  })

  it('success: geolocates, calls check_in with coords, shows the +2.000 fichas moment', async () => {
    // Pre-live (scheduled): check-in proceeds directly, no late-warning sheet.
    setTournament('scheduled', PRELIVE)
    stubGeo('ok')
    h.rpcResult = { data: [{ early_bird: true, chips: 12000 }], error: null }
    const user = userEvent.setup()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    await user.click(screen.getByRole('button', { name: /Hacer check-in/i }))

    expect(h.rpcCalls).toContainEqual([
      'check_in',
      { p_tournament_id: 't-1', p_lat: 9.93, p_lng: -84.08 },
    ])
    // Celebratory sheet with the early-bird bonus headline.
    expect(await screen.findByText('+2.000 fichas')).toBeInTheDocument()
  })

  it('out-of-range: an "estás fuera de la sede" RPC error shows the warn banner', async () => {
    setTournament('scheduled', PRELIVE)
    stubGeo('ok')
    h.rpcResult = { data: null, error: { message: 'check_in: estás fuera de la sede' } }
    const user = userEvent.setup()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    await user.click(screen.getByRole('button', { name: /Hacer check-in/i }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/fuera de la sede/i)
  })

  it('permission denied / no GPS: shows the friendly "pedile al admin" banner', async () => {
    setTournament('scheduled', PRELIVE)
    stubGeo('deny')
    const user = userEvent.setup()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    await user.click(screen.getByRole('button', { name: /Hacer check-in/i }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/pedile al admin que te registre/i)
    // No check_in RPC was attempted without a fix.
    expect(h.rpcCalls.some(([name]) => name === 'check_in')).toBe(false)
  })

  // NEW MODEL (mig 0031): a LIVE check-in earns no early-bird bonus, so tapping
  // check-in once the fecha is live opens a confirmation first. Only "Sí, hacer
  // check-in" runs the geolocate → check_in flow; "Cancelar" does nothing.
  it('live check-in shows the late-warning sheet and only checks in on confirm', async () => {
    setTournament('live') // beforeEach already does this, explicit for clarity
    stubGeo('ok')
    h.rpcResult = { data: [{ early_bird: false, chips: 10000 }], error: null }
    const user = userEvent.setup()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    // Tapping check-in opens the warning, NOT the RPC.
    await user.click(screen.getByRole('button', { name: /Hacer check-in/i }))
    const dialog = await screen.findByRole('dialog', { name: 'Check-in tarde' })
    expect(dialog).toHaveTextContent(/no recibís las fichas de bono/i)
    expect(h.rpcCalls.some(([name]) => name === 'check_in')).toBe(false)

    // Cancel → still no check_in.
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(h.rpcCalls.some(([name]) => name === 'check_in')).toBe(false)

    // Re-open and confirm → check_in fires with the coords.
    await user.click(screen.getByRole('button', { name: /Hacer check-in/i }))
    const dialog2 = await screen.findByRole('dialog', { name: 'Check-in tarde' })
    await user.click(within(dialog2).getByRole('button', { name: 'Sí, hacer check-in' }))
    expect(h.rpcCalls).toContainEqual([
      'check_in',
      { p_tournament_id: 't-1', p_lat: 9.93, p_lng: -84.08 },
    ])
  })

  // "A tiempo" badge: an entry checked in on time (early_bird true + checked_in_at
  // set) renders the green marker; a plain confirmed row does not.
  it('renders an "A tiempo" badge for an on-time checked-in entry', async () => {
    h.list.entry = {
      data: [
        { id: 'e-ot', player_id: 'p-ot', status: 'checked_in', rsvp_at: null, cancelled_at: null, checked_in_at: new Date().toISOString(), early_bird: true, chips: 12000, points_earned: null, final_position: null, rebuys_count: 0, player: { name: 'Puntual Pam', avatar_url: null } },
        { id: 'e-late', player_id: 'p-late', status: 'checked_in', rsvp_at: null, cancelled_at: null, checked_in_at: new Date().toISOString(), early_bird: false, chips: 10000, points_earned: null, final_position: null, rebuys_count: 0, player: { name: 'Tardío Tom', avatar_url: null } },
      ],
      error: null,
    }
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    // Exactly one "A tiempo" badge — Pam (early_bird), not Tom (late).
    const badges = screen.getAllByTestId('ontime-badge')
    expect(badges).toHaveLength(1)
    const pam = screen.getAllByTestId('prow').find((r) => within(r).queryByText(/Puntual Pam/))!
    expect(within(pam).getByTestId('ontime-badge')).toHaveTextContent('A tiempo')
  })

  it('admin sees a per-player "Registrar" affordance that calls admin_check_in', async () => {
    h.isAdmin = true
    const user = userEvent.setup()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    // Every confirmed player row (me + María) gets a Registrar button.
    const buttons = screen.getAllByRole('button', { name: 'Registrar' })
    expect(buttons.length).toBeGreaterThanOrEqual(2)

    // Click María's row button → admin_check_in with her entry id (e2).
    const maria = screen.getAllByTestId('prow').find((r) => within(r).queryByText(/María/))!
    await user.click(within(maria).getByRole('button', { name: 'Registrar' }))

    expect(h.rpcCalls).toContainEqual(['admin_check_in', { p_entry_id: 'e2' }])
  })

  // CHANGE 3 — admin registration desk: a "Confirmar pago" per-row button for a
  // confirmed-but-unpaid entry (pre-live / live) → confirm_payment RPC.
  it('admin sees "Confirmar pago" for a confirmed unpaid entry and it calls confirm_payment', async () => {
    h.isAdmin = true
    // Live + confirmed rows (paid undefined → treated as unpaid).
    const user = userEvent.setup()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const maria = screen.getAllByTestId('prow').find((r) => within(r).queryByText(/María/))!
    await user.click(within(maria).getByRole('button', { name: 'Confirmar pago' }))

    expect(h.rpcCalls).toContainEqual(['confirm_payment', { p_entry_id: 'e2' }])
    // The stats popup never opened (the button stops propagation).
    expect(screen.queryByTestId('ps-stats')).not.toBeInTheDocument()
  })

  it('hides "Confirmar pago" once the entry is already paid', async () => {
    h.isAdmin = true
    h.list.entry = {
      data: [
        { id: 'e2', player_id: 'p2', status: 'confirmed', paid: true, rsvp_at: null, cancelled_at: null, checked_in_at: null, early_bird: false, chips: null, points_earned: null, final_position: null, rebuys_count: 0, player: { name: 'María R.', avatar_url: null } },
      ],
      error: null,
    }
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    expect(screen.queryByRole('button', { name: 'Confirmar pago' })).not.toBeInTheDocument()
    // Registrar (admin_check_in) is still offered for the confirmed player.
    expect(screen.getByRole('button', { name: 'Registrar' })).toBeInTheDocument()
  })

  it('scheduled fecha: admin edits the date/time → updates tournament.scheduled_at', async () => {
    h.isAdmin = true
    setTournament('scheduled')
    const user = userEvent.setup()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    // Open the inline editor, set a new local date/time, save.
    await user.click(screen.getByTestId('sched-edit-open'))
    const input = screen.getByLabelText('Fecha y hora de la fecha')
    fireEvent.change(input, { target: { value: '2030-01-15T20:30' } })
    await user.click(screen.getByRole('button', { name: 'Guardar' }))

    const expected = new Date('2030-01-15T20:30').toISOString()
    expect(h.updateCalls).toContainEqual(['tournament', { scheduled_at: expected }])
  })

  it('scheduled fecha: a NON-admin never sees the date/time editor', async () => {
    h.isAdmin = false
    setTournament('scheduled')
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    expect(screen.queryByTestId('sched-edit-open')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Editar fecha y hora/i })).not.toBeInTheDocument()
  })
})
