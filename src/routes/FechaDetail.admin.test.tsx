import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import '@/App.css'

// ---------------------------------------------------------------------------
// Admin affordances on the fecha view (mig 0020): cancel + delete a fecha, the
// PRÓXIMA buy-in surfaced up top, and the calendar-icon date-edit trigger. The
// supabase mock captures direct .update() payloads (cancel) and .rpc() calls
// (delete); window.confirm is stubbed per-test so the confirmations resolve.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  isAdmin: true,
  player: { id: 'p-me', name: 'Edwin V.', avatar_url: null } as {
    id: string
    name: string
    avatar_url: string | null
  } | null,
  single: {} as Record<string, { data: unknown; error: unknown }>,
  list: {} as Record<string, { data: unknown; error: unknown }>,
  updateCalls: [] as Array<[string, unknown]>,
  rpcCalls: [] as Array<[string, unknown]>,
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
        update: (payload: unknown) => {
          h.updateCalls.push([table, payload])
          return b
        },
        eq: () => b,
        in: () => b,
        order: () => b,
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
  },
}))

import FechaDetail from './FechaDetail'

const NINE_HOURS = new Date(Date.now() + 9 * 3_600_000).toISOString()

const SEASON_CONFIG = {
  cancel_bands: [
    { hours_before: 24, penalty: 0 },
    { hours_before: 0, penalty: -15 },
  ],
  points_multiplier: 5,
  bonus_final_table: 10,
  bonus_attendance: 15,
  top_finish_bonuses: [20, 15, 10, 5],
  no_show_penalty: -15,
  early_bird_bonus_chips: 2000,
}

function setTournament(over: Record<string, unknown> = {}) {
  h.single.tournament = {
    data: {
      id: 't-1',
      season_id: 's1',
      name: 'Fecha 9',
      scheduled_at: NINE_HOURS,
      status: 'scheduled',
      geofence_radius_m: 100,
      cover_url: null,
      counts_for_league: true,
      prizes: null,
      buy_in: 20000,
      rebuy_amount: 20000,
      starting_stack: 10000,
      cancelled_at: null,
      ...over,
    },
    error: null,
  }
}

function setMyEntry(status = 'confirmed') {
  h.list.entry = {
    data: [
      {
        id: 'e-me',
        player_id: 'p-me',
        status,
        rsvp_at: null,
        cancelled_at: null,
        checked_in_at: null,
        early_bird: false,
        points_earned: null,
        final_position: null,
        rebuys_count: 0,
        player: { name: 'Edwin V.', avatar_url: null },
      },
    ],
    error: null,
  }
}

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={['/fechas/t-1']}>
      <Routes>
        <Route path="/fechas/:id" element={<FechaDetail />} />
        <Route path="/fechas" element={<div>FECHAS LIST</div>} />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(() => {
  h.isAdmin = true
  h.player = { id: 'p-me', name: 'Edwin V.', avatar_url: null }
  h.updateCalls = []
  h.rpcCalls = []
  h.rpcResult = { data: null, error: null }
  h.single = { season: { data: SEASON_CONFIG, error: null } }
  setTournament()
  setMyEntry('confirmed')
})

describe('FechaDetail — admin cancel/delete + PRÓXIMA buy-in + calendar trigger', () => {
  it('admin sees Cancelar fecha + Eliminar fecha on a scheduled fecha', async () => {
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.getByTestId('fd-cancel-fecha')).toBeInTheDocument()
    expect(screen.getByTestId('fd-delete-fecha')).toBeInTheDocument()
  })

  it('hides the admin actions from a non-admin', async () => {
    h.isAdmin = false
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.queryByTestId('fd-admin-actions')).not.toBeInTheDocument()
  })

  it('renders the admin actions BELOW the players list (reordered)', async () => {
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    const firstRow = screen.getAllByTestId('prow')[0]
    const actions = screen.getByTestId('fd-admin-actions')
    // Admin Cancelar/Eliminar now sit AFTER the players list in the DOM.
    expect(firstRow.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('Cancelar fecha confirms, then sets cancelled_at via a tournament update', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    await user.click(screen.getByTestId('fd-cancel-fecha'))

    expect(confirm).toHaveBeenCalled()
    const call = h.updateCalls.find(([t]) => t === 'tournament')
    expect(call).toBeDefined()
    const payload = call![1] as { cancelled_at?: unknown }
    expect(typeof payload.cancelled_at).toBe('string')
    confirm.mockRestore()
  })

  it('Cancelar fecha does nothing when the confirmation is dismissed', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    await user.click(screen.getByTestId('fd-cancel-fecha'))

    expect(h.updateCalls.find(([t]) => t === 'tournament')).toBeUndefined()
    confirm.mockRestore()
  })

  it('a cancelled fecha shows the Cancelada badge, hides run actions + the date editor, and drops Cancelar (keeps Eliminar)', async () => {
    setTournament({ cancelled_at: new Date().toISOString() })
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    // Badge shown.
    expect(screen.getByTestId('fd-cancelled')).toHaveTextContent('Cancelada')
    // Run actions gone (RSVP "Voy"/"Cancelar" for a confirmed player).
    expect(screen.queryByRole('button', { name: 'Voy' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument()
    // Date-edit trigger hidden on a cancelled fecha.
    expect(screen.queryByTestId('sched-edit-open')).not.toBeInTheDocument()
    // Admin can still delete, but cancel is no longer offered.
    expect(screen.getByTestId('fd-delete-fecha')).toBeInTheDocument()
    expect(screen.queryByTestId('fd-cancel-fecha')).not.toBeInTheDocument()
  })

  it('does NOT offer Eliminar (nor Cancelar) on a COMPLETED fecha (real results + gallery)', async () => {
    setTournament({ status: 'completed' })
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    // The admin-actions container still renders, but delete is gated off.
    expect(screen.queryByTestId('fd-delete-fecha')).not.toBeInTheDocument()
    expect(screen.queryByTestId('fd-cancel-fecha')).not.toBeInTheDocument()
  })

  it('does NOT offer Eliminar on a LIVE (uncancelled) fecha — cancel it first', async () => {
    setTournament({ status: 'live' })
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    // A live fecha can be cancelled but not hard-deleted while running.
    expect(screen.queryByTestId('fd-delete-fecha')).not.toBeInTheDocument()
    expect(screen.getByTestId('fd-cancel-fecha')).toBeInTheDocument()
  })

  it('Eliminar fecha confirms, calls the delete_tournament RPC, and navigates to the fechas list', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    await user.click(screen.getByTestId('fd-delete-fecha'))

    expect(h.rpcCalls).toContainEqual(['delete_tournament', { p_id: 't-1' }])
    // Navigated back to the fechas list route.
    expect(await screen.findByText('FECHAS LIST')).toBeInTheDocument()
    confirm.mockRestore()
  })

  it('PRÓXIMA fecha surfaces the buy-in (₡ + formatMiles) prominently', async () => {
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    const buyin = screen.getByTestId('fd-buyin')
    expect(buyin).toHaveTextContent('Buy-in')
    expect(buyin).toHaveTextContent('₡20.000')
  })

  it('the date-edit trigger is a calendar icon button with the aria-label', async () => {
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    const trigger = screen.getByTestId('sched-edit-open')
    expect(trigger).toHaveAttribute('aria-label', 'Editar fecha y hora')
    // Icon, not a text label: it renders an inline SVG glyph.
    expect(trigger.querySelector('svg')).not.toBeNull()
  })
})
