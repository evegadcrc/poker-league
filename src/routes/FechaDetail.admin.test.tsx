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
    // Realtime stub (mig 0030 live-refresh subscription) — chainable no-op.
    channel: () => {
      const ch: Record<string, unknown> = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: () => {},
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
        <Route path="/vivo" element={<div>EN VIVO</div>} />
        <Route path="/fechas/:id/editar" element={<div>EDITAR FECHA</div>} />
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

  it('admin sees the "Abrir fecha" button on a scheduled, non-cancelled fecha', async () => {
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.getByTestId('fd-open-fecha')).toHaveTextContent('Abrir fecha')
  })

  it('hides "Abrir fecha" from a non-admin', async () => {
    h.isAdmin = false
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.queryByTestId('fd-open-fecha')).not.toBeInTheDocument()
  })

  it('hides "Abrir fecha" on a LIVE fecha', async () => {
    setTournament({ status: 'live' })
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.queryByTestId('fd-open-fecha')).not.toBeInTheDocument()
  })

  it('hides "Abrir fecha" on a COMPLETED fecha', async () => {
    setTournament({ status: 'completed' })
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.queryByTestId('fd-open-fecha')).not.toBeInTheDocument()
  })

  it('hides "Abrir fecha" on a CANCELLED (scheduled) fecha', async () => {
    setTournament({ cancelled_at: new Date().toISOString() })
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.queryByTestId('fd-open-fecha')).not.toBeInTheDocument()
  })

  it('Abrir fecha confirms, calls open_tournament with the tournament id, then navigates to /vivo', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    await user.click(screen.getByTestId('fd-open-fecha'))

    expect(confirm).toHaveBeenCalled()
    expect(h.rpcCalls).toContainEqual(['open_tournament', { p_tournament_id: 't-1' }])
    // Landed on the live view to run the clock / open the Consola.
    expect(await screen.findByText('EN VIVO')).toBeInTheDocument()
    confirm.mockRestore()
  })

  it('Abrir fecha does nothing when the confirmation is dismissed', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    await user.click(screen.getByTestId('fd-open-fecha'))

    expect(h.rpcCalls.some(([n]) => n === 'open_tournament')).toBe(false)
    confirm.mockRestore()
  })

  it('Abrir fecha shows a friendly error and stays put when the RPC fails', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    h.rpcResult = { data: null, error: { message: 'open_tournament: tournament is live' } }
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    await user.click(screen.getByTestId('fd-open-fecha'))

    expect(h.rpcCalls).toContainEqual(['open_tournament', { p_tournament_id: 't-1' }])
    // No navigation; a friendly message is surfaced.
    expect(screen.queryByText('EN VIVO')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo abrir la fecha')
    confirm.mockRestore()
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

  it('admin check-in button fires its own handler WITHOUT opening the stats popup', async () => {
    const user = userEvent.setup()
    setTournament({ status: 'live' })
    setMyEntry('confirmed') // isAdmin + live + confirmed → the "Registrar" button
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    await user.click(screen.getByRole('button', { name: 'Registrar' }))

    // The admin_check_in RPC fired for this entry…
    expect(h.rpcCalls).toContainEqual(['admin_check_in', { p_entry_id: 'e-me' }])
    // …and the row's stats popup did NOT open (no player_profile fetch, no sheet).
    expect(h.rpcCalls.some(([n]) => n === 'player_profile')).toBe(false)
    expect(screen.queryByTestId('ps-stats')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ps-loading')).not.toBeInTheDocument()
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

describe('FechaDetail — admin "Editar fecha" entry point (→ /fechas/:id/editar)', () => {
  it('admin sees Editar fecha on a scheduled fecha and it navigates to the edit page', async () => {
    const user = userEvent.setup()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const btn = screen.getByTestId('fd-edit-fecha')
    expect(btn).toHaveTextContent('Editar fecha')
    await user.click(btn)

    expect(await screen.findByText('EDITAR FECHA')).toBeInTheDocument()
  })

  it('hides Editar fecha from a non-admin', async () => {
    h.isAdmin = false
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.queryByTestId('fd-edit-fecha')).not.toBeInTheDocument()
  })

  it('hides Editar fecha on a LIVE fecha', async () => {
    setTournament({ status: 'live' })
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.queryByTestId('fd-edit-fecha')).not.toBeInTheDocument()
  })

  it('hides Editar fecha on a COMPLETED fecha', async () => {
    setTournament({ status: 'completed' })
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.queryByTestId('fd-edit-fecha')).not.toBeInTheDocument()
  })

  it('hides Editar fecha on a CANCELLED (scheduled) fecha', async () => {
    setTournament({ cancelled_at: new Date().toISOString() })
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.queryByTestId('fd-edit-fecha')).not.toBeInTheDocument()
  })
})

describe('FechaDetail — admin share row (convocatoria → WhatsApp, copiar enlace)', () => {
  it('Compartir en WhatsApp opens wa.me with the roster + join link pre-filled', async () => {
    const user = userEvent.setup()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    await user.click(screen.getByTestId('fd-share-whatsapp'))

    expect(open).toHaveBeenCalledTimes(1)
    const [url, target] = open.mock.calls[0]! as [string, string]
    expect(url.startsWith('https://wa.me/?text=')).toBe(true)
    expect(target).toBe('_blank')
    const text = decodeURIComponent(url.slice('https://wa.me/?text='.length))
    expect(text).toContain('🃏 POKER FRIENDS · Fecha 9')
    expect(text).toContain('✅ Confirmados (1):\nEdwin V.')
    expect(text).toContain(`👉 Confirmar acá: ${window.location.origin}/fechas/t-1`)
    open.mockRestore()
  })

  it('Copiar enlace writes the fecha deep link to the clipboard and confirms', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    await user.click(screen.getByTestId('fd-copy-link'))

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/fechas/t-1`)
    expect(await screen.findByText('✓ Enlace copiado')).toBeInTheDocument()
  })

  it('shows the share row on a LIVE fecha too, but not on COMPLETED or CANCELLED', async () => {
    setTournament({ status: 'live' })
    const live = renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.getByTestId('fd-share')).toBeInTheDocument()
    live.unmount()

    setTournament({ status: 'completed' })
    const done = renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.queryByTestId('fd-share')).not.toBeInTheDocument()
    done.unmount()

    setTournament({ cancelled_at: new Date().toISOString() })
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.queryByTestId('fd-share')).not.toBeInTheDocument()
  })

  it('hides the share row from a non-admin', async () => {
    h.isAdmin = false
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.queryByTestId('fd-share')).not.toBeInTheDocument()
  })
})

describe('FechaDetail — guests (mig 0035)', () => {
  it('tags guest players in the roster and tells the admin the link admits guests', async () => {
    setTournament({ guests_open: true })
    h.list.entry = {
      data: [
        { id: 'e-me', player_id: 'p-me', status: 'confirmed', rsvp_at: null, cancelled_at: null, checked_in_at: null, early_bird: false, points_earned: null, final_position: null, rebuys_count: 0, player: { name: 'Edwin V.', avatar_url: null, is_guest: false } },
        { id: 'e-g', player_id: 'p-g', status: 'confirmed', rsvp_at: null, cancelled_at: null, checked_in_at: null, early_bird: false, points_earned: null, final_position: null, rebuys_count: 0, player: { name: 'Primo Pepe', avatar_url: null, is_guest: true } },
      ],
      error: null,
    }
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.getByText(/Primo Pepe · invitado/)).toBeInTheDocument()
    expect(screen.getByTestId('fd-guests-open')).toHaveTextContent('Invitados pueden anotarse')
  })

  it('no guest hint when the fecha is closed to guests', async () => {
    setTournament({ guests_open: false })
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.queryByTestId('fd-guests-open')).toBeNull()
  })
})

describe('FechaDetail — admin share of a COMPLETED fecha result', () => {
  it('shows "Compartir resultado en WhatsApp" and the sheet carries podium, pot, players and the fecha link', async () => {
    const user = userEvent.setup()
    setTournament({ status: 'completed', prizes: [{ position: 1, pct: 0.6, amount: 60000 }, { position: 2, pct: 0.4, amount: 40000 }] })
    const base = { rsvp_at: null, cancelled_at: null, checked_in_at: null, early_bird: false, rebuys_count: 0, chopped: false, paid: true }
    h.list.entry = {
      data: [
        { id: 'w', player_id: 'pw', status: 'winner', points_earned: 45, final_position: 1, ...base, player: { name: 'Mauricio A.', avatar_url: null } },
        { id: 'e2', player_id: 'p2', status: 'eliminated', points_earned: 34, final_position: 2, ...base, player: { name: 'Andrés R.', avatar_url: null } },
        { id: 'e3', player_id: 'p3', status: 'eliminated', points_earned: 20, final_position: 3, ...base, rebuys_count: 1, player: { name: 'Sofía M.', avatar_url: null } },
      ],
      error: null,
    }
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    // No convocatoria share on a completed fecha; the result share instead.
    expect(screen.queryByTestId('fd-share')).toBeNull()
    await user.click(screen.getByTestId('fd-share-result-open'))

    const text = (screen.getByTestId('resultado-text') as HTMLTextAreaElement).value
    expect(text).toContain('🃏 POKER FRIENDS · Fecha 9')
    expect(text).toContain('🏆 Campeón: Mauricio A.')
    expect(text).toContain('🥈 2º: Andrés R.')
    expect(text).toContain('🥉 3º: Sofía M.')
    // Pot = the materialized prizes (60.000 + 40.000).
    expect(text).toContain('💰 Pozo: ₡100')
    expect(text).toContain('👥 3 jugadores · 1 recompra')
    expect(text).toContain(`📊 Tabla general → ${window.location.origin}/fechas/t-1`)
  })

  it('hides the result share from non-admins', async () => {
    h.isAdmin = false
    setTournament({ status: 'completed' })
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.queryByTestId('fd-share-result-open')).toBeNull()
  })
})
