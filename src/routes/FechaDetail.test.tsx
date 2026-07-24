import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const h = vi.hoisted(() => ({
  player: { id: 'p-me', name: 'Edwin V.', avatar_url: null } as {
    id: string
    name: string
    avatar_url: string | null
  } | null,
  single: {} as Record<string, { data: unknown; error: unknown }>,
  list: {} as Record<string, { data: unknown; error: unknown }>,
  rpcCalls: [] as Array<[string, unknown]>,
  rpcResult: { data: null as unknown, error: null as unknown },
}))

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ player: h.player }),
  useRole: () => ({ isAdmin: false }),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
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

const DEFAULT_BANDS = [
  { hours_before: 24, penalty: 0 },
  { hours_before: 12, penalty: -5 },
  { hours_before: 6, penalty: -10 },
  { hours_before: 0, penalty: -15 },
]

// ~9 h out → the −10 band.
const NINE_HOURS = new Date(Date.now() + 9 * 3_600_000).toISOString()

function setTournament(status = 'scheduled', scheduledAt = NINE_HOURS) {
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
      { id: 'e-me', player_id: 'p-me', status: myStatus, rsvp_at: null, cancelled_at: null, checked_in_at: null, early_bird: false, points_earned: myStatus === 'declined' ? -10 : null, final_position: null, rebuys_count: 0, player: { name: 'Edwin V.', avatar_url: null } },
      { id: 'e2', player_id: 'p2', status: 'confirmed', rsvp_at: null, cancelled_at: null, checked_in_at: null, early_bird: false, points_earned: null, final_position: null, rebuys_count: 0, player: { name: 'María R.', avatar_url: null } },
      { id: 'e3', player_id: 'p3', status: 'invited', rsvp_at: null, cancelled_at: null, checked_in_at: null, early_bird: false, points_earned: null, final_position: null, rebuys_count: 0, player: { name: 'José V.', avatar_url: null } },
      { id: 'e4', player_id: 'p4', status: 'declined', rsvp_at: null, cancelled_at: null, checked_in_at: null, early_bird: false, points_earned: null, final_position: null, rebuys_count: 0, player: { name: 'Ana M.', avatar_url: null } },
      { id: 'e5', player_id: 'p5', status: 'declined', rsvp_at: null, cancelled_at: null, checked_in_at: null, early_bird: false, points_earned: -15, final_position: null, rebuys_count: 0, player: { name: 'Luis C.', avatar_url: null } },
    ],
    error: null,
  }
}

// A finished fecha: ranked finishers (winner + eliminated) each carry a
// final_position and the engine's points_earned; a confirmed-but-ghosted player
// is a no_show with the negative penalty.
function setCompletedEntries() {
  const base = {
    rsvp_at: null,
    cancelled_at: null,
    checked_in_at: null,
    early_bird: false,
    rebuys_count: 0,
    chopped: false,
  }
  h.list.entry = {
    data: [
      { id: 'w', player_id: 'pw', status: 'winner', points_earned: 45, final_position: 1, ...base, player: { name: 'Mauricio A.', avatar_url: null } },
      { id: 'e2', player_id: 'p2', status: 'eliminated', points_earned: 34, final_position: 2, ...base, player: { name: 'Andrés R.', avatar_url: null } },
      { id: 'e3', player_id: 'p3', status: 'eliminated', points_earned: 20, final_position: 3, ...base, player: { name: 'Sofía M.', avatar_url: null } },
      { id: 'ns', player_id: 'pns', status: 'no_show', points_earned: -15, final_position: null, ...base, player: { name: 'Luis C.', avatar_url: null } },
    ],
    error: null,
  }
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
  h.rpcCalls = []
  h.rpcResult = { data: null, error: null }
  h.single = { season: { data: { cancel_bands: DEFAULT_BANDS }, error: null } }
  setTournament('scheduled')
  setEntries('confirmed')
})

describe('FechaDetail', () => {
  it('renders the header, attendance chips grouped by status with counts', async () => {
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const head = screen.getByTestId('att-head')
    // Voy = me(confirmed) + p2(confirmed) = 2; Cancelaron = 2; Sin resp. = 1
    expect(within(head).getByText('Voy').previousSibling?.textContent).toBe('2')
    expect(within(head).getByText('Cancelaron').previousSibling?.textContent).toBe('2')
    expect(within(head).getByText('Sin resp.').previousSibling?.textContent).toBe('1')
  })

  it('renders the attendance list with the correct status pills', async () => {
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const rows = screen.getAllByTestId('prow')
    expect(rows).toHaveLength(5)

    const pillClass = (row: HTMLElement) =>
      Array.from(row.querySelector('.status')!.classList).find((c) => c.startsWith('s-'))

    // confirmed rows (me + p2) sort first, then invited, then the two declined.
    const byName = (n: string) => rows.find((r) => within(r).queryByText(new RegExp(n)))!
    expect(pillClass(byName('Edwin'))).toBe('s-confirmed')
    expect(pillClass(byName('José'))).toBe('s-none')
    expect(pillClass(byName('Ana'))).toBe('s-declined')

    // The signed-in player's row is marked "· tú".
    expect(byName('Edwin').textContent).toContain('· tú')
    // A declined row with a stored penalty shows it.
    expect(byName('Luis').textContent).toContain('−15 pts')
  })

  it('confirmed player sees Cancelar; the confirm sheet shows the right band (9h → −10)', async () => {
    const user = userEvent.setup()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    // Confirmed → a "Cancelar" action (penalized path).
    await user.click(screen.getByRole('button', { name: 'Cancelar' }))

    const bands = screen.getByTestId('bands')
    const here = bands.querySelector('.br.here')!
    expect(here.textContent).toContain('estás aquí')
    expect(here.textContent).toContain('−10') // the active band is the −10 row

    // Confirm button carries the applied penalty.
    expect(screen.getByRole('button', { name: /Cancelar \(.?10\)/ })).toBeInTheDocument()
  })

  it('confirming the cancel calls cancel_rsvp', async () => {
    const user = userEvent.setup()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    await user.click(screen.getByRole('button', { name: 'Cancelar' }))
    await user.click(screen.getByRole('button', { name: /Cancelar \(.?10\)/ }))

    expect(h.rpcCalls).toContainEqual(['cancel_rsvp', { p_tournament_id: 't-1' }])
  })

  it('invited player sees Voy / No voy and rsvp confirm calls the RPC', async () => {
    const user = userEvent.setup()
    setEntries('invited')
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    expect(screen.getByRole('button', { name: 'No voy' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Voy' }))

    expect(h.rpcCalls).toContainEqual(['rsvp', { p_tournament_id: 't-1', p_choice: 'confirm' }])
  })

  it('locks RSVP actions once the fecha is live (shows Ir a En Vivo instead)', async () => {
    setTournament('live')
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Voy' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /en vivo/i })).toBeInTheDocument()
  })

  it('completed fecha shows finishing place + points per player (winner accented)', async () => {
    setTournament('completed')
    setCompletedEntries()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const rows = screen.getAllByTestId('prow')
    const byName = (n: string) => rows.find((r) => within(r).queryByText(new RegExp(n)))!

    // Winner: 1º + champion accent + positive points; no CAMPEÓN status badge.
    const champ = within(byName('Mauricio')).getByTestId('fd-result')
    expect(champ.textContent).toContain('1º')
    expect(champ.textContent).toContain('+45 pts')
    expect(champ.querySelector('.place.champ')).not.toBeNull()
    expect(within(byName('Mauricio')).queryByText('Campeón')).not.toBeInTheDocument()

    // Runner-up: 2º + points, not champ-accented; no FUERA badge.
    const second = within(byName('Andrés')).getByTestId('fd-result')
    expect(second.textContent).toContain('2º')
    expect(second.textContent).toContain('+34 pts')
    expect(second.querySelector('.place.champ')).toBeNull()
    expect(within(byName('Andrés')).queryByText('Fuera')).not.toBeInTheDocument()

    // 3rd place renders its ordinal too.
    expect(within(byName('Sofía')).getByTestId('fd-result').textContent).toContain('3º')
  })

  it('completed fecha: a no-show shows "No Show" + the penalty points', async () => {
    setTournament('completed')
    setCompletedEntries()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const noShow = screen
      .getAllByTestId('prow')
      .find((r) => within(r).queryByText(/Luis/))!
    const result = within(noShow).getByTestId('fd-result')
    expect(result.textContent).toContain('No Show')
    expect(result.textContent).toContain('−15 pts')
  })

  it('completed fecha: chopped co-champions share 1º and keep the champion accent', async () => {
    setTournament('completed')
    const base = {
      rsvp_at: null,
      cancelled_at: null,
      checked_in_at: null,
      early_bird: false,
      rebuys_count: 0,
      points_earned: 40,
    }
    h.list.entry = {
      data: [
        { id: 'ca', player_id: 'pca', status: 'winner', final_position: 1, chopped: true, ...base, player: { name: 'Ana M.', avatar_url: null } },
        // Co-champion with final_position=2 must still render 1º (shared place).
        { id: 'cb', player_id: 'pcb', status: 'winner', final_position: 2, chopped: true, ...base, player: { name: 'Beto S.', avatar_url: null } },
      ],
      error: null,
    }
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const rows = screen.getAllByTestId('prow')
    for (const nm of ['Ana', 'Beto']) {
      const res = within(rows.find((r) => within(r).queryByText(new RegExp(nm)))!).getByTestId(
        'fd-result',
      )
      expect(res.textContent).toContain('1º')
      expect(res.textContent).toContain('+40 pts')
      expect(res.querySelector('.place.champ')).not.toBeNull()
    }
  })
})
