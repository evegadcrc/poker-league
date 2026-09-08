import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
// Inject App.css so class-based layout (e.g. .att-head centering) is computable.
import '@/App.css'

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
    // Realtime stub (mig 0030 live-refresh subscription): a chainable no-op
    // channel so mounting FechaDetail doesn't throw. The subscribe callback is
    // intentionally not invoked — these tests assert render, not resync.
    channel: () => {
      const ch: Record<string, unknown> = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: () => {},
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
      buy_in: 20000,
      rebuy_amount: 20000,
      starting_stack: 10000,
    },
    error: null,
  }
}

// Season config (scoring v2) — mult 5, mesa final 10, asistencia 15, graduated
// top-4 [20,15,10,5], no-show −15, early bird 2000. The fecha card only reads
// early_bird_bonus_chips now (the scoring explainer moved to the Liga view).
const SEASON_CONFIG = {
  cancel_bands: DEFAULT_BANDS,
  points_multiplier: 5,
  bonus_final_table: 10,
  bonus_attendance: 15,
  top_finish_bonuses: [20, 15, 10, 5],
  no_show_penalty: -15,
  early_bird_bonus_chips: 2000,
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
  h.single = { season: { data: SEASON_CONFIG, error: null } }
  setTournament('scheduled')
  setEntries('confirmed')
})

describe('FechaDetail', () => {
  it('fecha card shows entry + chips (buy-in, stack, early bird), not the scoring formula', async () => {
    const user = userEvent.setup()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    // Collapsible → expand it, then assert against the info section only.
    await user.click(screen.getByRole('button', { name: /Entrada y fichas/i }))
    const info = screen.getByTestId('fd-info-section')

    // Entry + chips: buy-in ₡20.000, stack 10.000 fichas, early bird 2.000 fichas.
    expect(info.textContent).toContain('₡20.000')
    expect(info.textContent).toContain('10.000 fichas')
    expect(info.textContent).toContain('2.000 fichas')
    // The scoring explainer moved to the Liga view — it is NOT on the fecha card.
    expect(info.textContent).not.toMatch(/\(N − P\)/)
    expect(info.textContent).not.toContain('Bonus Top 3')
  })

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

  it('locks RSVP actions once the fecha is live (confirmed → check-in, no Voy/Cancelar)', async () => {
    setTournament('live') // default beforeEach entry: confirmed
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    // The scheduled RSVP affordances are gone once live; a confirmed player's
    // primary CTA is the geofenced check-in.
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Voy' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Hacer check-in/i })).toBeInTheDocument()
  })

  it('live + already-checked-in player sees "Ir a En Vivo" at the top', async () => {
    setTournament('live')
    setEntries('checked_in')
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const bar = screen.getByTestId('fd-top-actions')
    expect(within(bar).getByRole('link', { name: /en vivo/i })).toBeInTheDocument()
    // No RSVP / check-in CTA once a seat is taken.
    expect(within(bar).queryByRole('button', { name: /Hacer check-in/i })).not.toBeInTheDocument()
  })

  // CHANGE 4 — live-join for a player NOT on the initial list: they can tap "Voy"
  // to confirm, then the check-in CTA appears (now confirmed).
  it('live + player with NO entry sees "Voy" at the top; confirming surfaces check-in', async () => {
    const user = userEvent.setup()
    setTournament('live')
    // Entries list does NOT include the signed-in player (p-me).
    h.list.entry = {
      data: [
        { id: 'e2', player_id: 'p2', status: 'playing', rsvp_at: null, cancelled_at: null, checked_in_at: null, early_bird: false, points_earned: null, final_position: null, rebuys_count: 0, player: { name: 'María R.', avatar_url: null } },
      ],
      error: null,
    }
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const bar = screen.getByTestId('fd-top-actions')
    const voy = within(bar).getByRole('button', { name: /Voy — confirmar asistencia/i })

    // The post-confirm silent reload returns the now-confirmed entry for p-me.
    h.list.entry = {
      data: [
        { id: 'e-me', player_id: 'p-me', status: 'confirmed', rsvp_at: null, cancelled_at: null, checked_in_at: null, early_bird: false, points_earned: null, final_position: null, rebuys_count: 0, player: { name: 'Edwin V.', avatar_url: null } },
        { id: 'e2', player_id: 'p2', status: 'playing', rsvp_at: null, cancelled_at: null, checked_in_at: null, early_bird: false, points_earned: null, final_position: null, rebuys_count: 0, player: { name: 'María R.', avatar_url: null } },
      ],
      error: null,
    }
    await user.click(voy)

    expect(h.rpcCalls).toContainEqual(['rsvp', { p_tournament_id: 't-1', p_choice: 'confirm' }])
    expect(await screen.findByRole('button', { name: /Hacer check-in/i })).toBeInTheDocument()
  })

  // Slice 24 — a late arrival can confirm ("Voy") on a LIVE fecha; decline/cancel
  // stay scheduled-only.
  it('live + non-confirmed player sees the "Voy" confirm button (no decline/cancel)', async () => {
    setTournament('live')
    setEntries('invited')
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    expect(screen.getByRole('button', { name: /Voy/i })).toBeInTheDocument()
    // Decline / cancel are frozen once the fecha is opened.
    expect(screen.queryByRole('button', { name: 'No voy' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument()
  })

  it('live: confirming (Voy) calls rsvp and the check-in button becomes reachable', async () => {
    const user = userEvent.setup()
    setTournament('live')
    setEntries('invited')
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const voy = screen.getByRole('button', { name: /Voy/i })
    // The post-confirm silent reload returns the now-confirmed entry.
    setEntries('confirmed')
    await user.click(voy)

    expect(h.rpcCalls).toContainEqual(['rsvp', { p_tournament_id: 't-1', p_choice: 'confirm' }])
    // Confirmed → the geofenced check-in affordance takes over.
    expect(await screen.findByRole('button', { name: /Hacer check-in/i })).toBeInTheDocument()
  })

  it('live: a player already in the game (playing) sees no RSVP/confirm button', async () => {
    setTournament('live')
    setEntries('playing')
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    expect(screen.queryByRole('button', { name: /Voy/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'No voy' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument()
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

  it('completed fecha: medal icons for 2º (silver) / 3º (bronze), none for 4º+', async () => {
    setTournament('completed')
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
        { id: 'w', player_id: 'pw', status: 'winner', points_earned: 45, final_position: 1, ...base, player: { name: 'Uno P.', avatar_url: null } },
        { id: 'e2', player_id: 'p2', status: 'eliminated', points_earned: 34, final_position: 2, ...base, player: { name: 'Dos P.', avatar_url: null } },
        { id: 'e3', player_id: 'p3', status: 'eliminated', points_earned: 20, final_position: 3, ...base, player: { name: 'Tres P.', avatar_url: null } },
        { id: 'e4', player_id: 'p4', status: 'eliminated', points_earned: 10, final_position: 4, ...base, player: { name: 'Cuatro P.', avatar_url: null } },
      ],
      error: null,
    }
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const rows = screen.getAllByTestId('prow')
    const byName = (n: string) => rows.find((r) => within(r).queryByText(new RegExp(n)))!

    // 1º keeps the champion crown (no runner-up medal marker).
    expect(within(byName('Uno')).getByTestId('fd-result').querySelector('.crown')).not.toBeNull()
    expect(within(byName('Uno')).queryByTestId('fd-medal')).toBeNull()

    // 2º → silver medal + silver-tinted place; 3º → bronze medal + bronze tint.
    const second = within(byName('Dos')).getByTestId('fd-result')
    expect(within(second).getByTestId('fd-medal').textContent).toBe('🥈')
    expect(second.querySelector('.place.silver')).not.toBeNull()

    const third = within(byName('Tres')).getByTestId('fd-result')
    expect(within(third).getByTestId('fd-medal').textContent).toBe('🥉')
    expect(third.querySelector('.place.bronze')).not.toBeNull()

    // 4º+ show no medal (just the ordinal).
    expect(within(byName('Cuatro')).queryByTestId('fd-medal')).toBeNull()
  })

  it('centers the RSVP summary chips row', async () => {
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    const head = screen.getByTestId('att-head')
    expect(getComputedStyle(head).justifyContent).toBe('center')
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

  // A completed fecha with a tournament header that also carries the materialized
  // `prizes` (set_prizes output). `extra` merges onto the tournament mock so tests
  // can add prizes / counts_for_league without repeating the whole row.
  function setCompletedTournament(extra: Record<string, unknown>) {
    h.single.tournament = {
      data: {
        id: 't-1',
        season_id: 's1',
        name: 'Fecha 9',
        scheduled_at: NINE_HOURS,
        status: 'completed',
        geofence_radius_m: 100,
        counts_for_league: true,
        ...extra,
      },
      error: null,
    }
  }

  it('completed fecha: Premios list renders below the results with final ₡ amounts', async () => {
    setCompletedTournament({
      prizes: [
        { position: 1, pct: 0.5, amount: 100000, overridden: false },
        { position: 2, pct: 0.3, amount: 60000, overridden: false },
        { position: 3, pct: 0.2, amount: 40000, overridden: false },
      ],
    })
    setCompletedEntries()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const premios = screen.getByTestId('premios')
    // Full ₡ + "." thousands separators (not the compact "₡100K" live style).
    expect(premios.textContent).toContain('₡100.000')
    expect(premios.textContent).toContain('₡60.000')
    expect(premios.textContent).toContain('₡40.000')

    // Sits AFTER the player list in the DOM (bottom of the results block).
    const firstRow = screen.getAllByTestId('prow')[0]
    expect(firstRow.compareDocumentPosition(premios) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('completed fecha: a chopped top-place shows the split amount, not the template', async () => {
    setCompletedTournament({
      prizes: [
        { position: 1, pct: 0.5, amount: 80000, overridden: false },
        { position: 2, pct: 0.3, amount: 50000, overridden: false },
        { position: 3, pct: 0.2, amount: 30000, overridden: false },
      ],
    })
    const base = { rsvp_at: null, cancelled_at: null, checked_in_at: null, early_bird: false, rebuys_count: 0 }
    h.list.entry = {
      data: [
        { id: 'ca', player_id: 'pca', status: 'winner', points_earned: 40, final_position: 1, chopped: true, chop_group: 1, ...base, player: { name: 'Ana M.', avatar_url: null } },
        { id: 'cb', player_id: 'pcb', status: 'winner', points_earned: 40, final_position: 2, chopped: true, chop_group: 1, ...base, player: { name: 'Beto S.', avatar_url: null } },
        { id: 'e3', player_id: 'p3', status: 'eliminated', points_earned: 20, final_position: 3, chopped: false, chop_group: null, ...base, player: { name: 'Sofía M.', avatar_url: null } },
      ],
      error: null,
    }
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const premios = screen.getByTestId('premios')
    // 1º + 2º chopped → each shows (80.000 + 50.000) / 2 = ₡65.000, NOT the template.
    expect(premios.textContent).toContain('₡65.000')
    expect(premios.textContent).not.toContain('₡80.000')
    expect(premios.textContent).not.toContain('₡50.000')
    // 3º is un-chopped → keeps its template amount.
    expect(premios.textContent).toContain('₡30.000')
  })

  it('standalone completed fecha (no suma a la liga) still shows the Premios section', async () => {
    setCompletedTournament({
      counts_for_league: false,
      prizes: [
        { position: 1, pct: 0.6, amount: 90000, overridden: false },
        { position: 2, pct: 0.4, amount: 60000, overridden: false },
      ],
    })
    setCompletedEntries()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    expect(screen.getByTestId('fd-standalone')).toBeInTheDocument()
    const premios = screen.getByTestId('premios')
    expect(premios.textContent).toContain('₡90.000')
    expect(premios.textContent).toContain('₡60.000')
  })

  // ---- Portada hero: visible to EVERYONE (not just admin), tap to expand. ----
  it('shows the portada hero to a NON-admin when cover_url is set (tap opens the lightbox)', async () => {
    // The mock's useRole returns isAdmin:false → CoverControl (upload) is hidden,
    // yet the cover must still render as a hero banner for everyone.
    h.single.tournament = {
      data: { ...(h.single.tournament!.data as object), cover_url: 'https://cdn.test/gallery/cover.jpg' },
      error: null,
    }
    const user = userEvent.setup()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const hero = screen.getByTestId('fd-cover-hero')
    expect(hero).toHaveAttribute('aria-label', 'Ampliar portada de la fecha')
    expect(hero.style.backgroundImage).toContain('cover.jpg')
    // Upload control stays admin-only → absent for this non-admin viewer.
    expect(screen.queryByTestId('cover-upload')).not.toBeInTheDocument()

    // Tap → full-screen lightbox of the cover.
    await user.click(hero)
    const dialog = screen.getByRole('dialog', { name: 'Portada de la fecha' })
    expect(dialog.querySelector('img')).toHaveAttribute('src', 'https://cdn.test/gallery/cover.jpg')
  })

  it('renders no portada hero when the fecha has no cover_url', async () => {
    renderDetail() // default fixture has no cover_url
    await screen.findByRole('heading', { name: 'Fecha 9' })
    expect(screen.queryByTestId('fd-cover-hero')).not.toBeInTheDocument()
  })

  // ---- CHANGE 1: reorder — players list first, chips/actions below it. -------
  it('renders the players list BEFORE the RSVP summary chips (reordered)', async () => {
    renderDetail() // default scheduled fixture (5 entries)
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const firstRow = screen.getAllByTestId('prow')[0]
    const head = screen.getByTestId('att-head')
    // The summary chips now sit AFTER the players list in the DOM.
    expect(firstRow.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // ---- CHANGE 2: real-time per-player v2 points breakdown. -------------------
  it('shows the v2 points breakdown for a ranked finisher (20-player, 3rd → 120)', async () => {
    setTournament('completed')
    const base = {
      rsvp_at: null,
      cancelled_at: null,
      checked_in_at: null,
      early_bird: false,
      rebuys_count: 0,
      chop_group: null,
      chopped: false,
      points_earned: 0,
    }
    // 20 seated finishers (positions 1..20), all paid; final-table size for a
    // 20-field is 10, so positions 1..10 made the final table. 3rd place is the
    // assertion target: (20−3)×5 = 85 · +15 asist · +10 mesa · +10 (3º) = 120.
    const data = Array.from({ length: 20 }, (_, i) => {
      const pos = i + 1
      return {
        id: `e${pos}`,
        player_id: `p${pos}`,
        status: pos === 1 ? 'winner' : 'eliminated',
        final_position: pos,
        paid: true,
        made_final_table: pos <= 10,
        ...base,
        player: { name: pos === 3 ? 'Carlos T.' : `Jugador ${pos}`, avatar_url: null },
      }
    })
    h.list.entry = { data, error: null }
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const target = screen.getAllByTestId('prow').find((r) => within(r).queryByText('Carlos T.'))!
    const bd = within(target).getByTestId('fd-breakdown')
    expect(bd.textContent).toContain('Base 85')
    expect(bd.textContent).toContain('+15 asist')
    expect(bd.textContent).toContain('+10 mesa')
    expect(bd.textContent).toContain('+10 (3º)')
    // CHANGE 1: the running total is no longer duplicated in the breakdown line
    // (it already shows in the row's place/points badge).
    expect(bd.textContent).not.toContain('=')
  })

  // ---- Tap interactions: avatar → lightbox, row → player-stats (parity w/ Tabla).
  it('tapping a player avatar opens the lightbox and does NOT open/fetch the stats popup', async () => {
    const user = userEvent.setup()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    await user.click(screen.getByRole('button', { name: 'Ver foto de María R.' }))

    // Lightbox is up…
    expect(screen.getByRole('dialog', { name: 'Foto de María R.' })).toBeInTheDocument()
    // …and the row's stats popup never mounted → player_profile was NOT called.
    expect(h.rpcCalls.filter(([n]) => n === 'player_profile')).toHaveLength(0)
    expect(screen.queryByTestId('ps-stats')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ps-loading')).not.toBeInTheDocument()
  })

  it('tapping the row body opens the stats popup and fetches player_profile for that entry', async () => {
    h.rpcResult = {
      data: [{ total_points: 77, games_played: 4, wins: 1, podiums: 2, points_history: [], form: [] }],
      error: null,
    }
    const user = userEvent.setup()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    // The name lives in the row body (outside the avatar button).
    await user.click(screen.getByText('María R.'))

    await screen.findByTestId('ps-stats')
    const profileCalls = h.rpcCalls.filter(([n]) => n === 'player_profile')
    expect(profileCalls).toHaveLength(1)
    expect((profileCalls[0]![1] as { p_player_id: string }).p_player_id).toBe('p2')
    // The photo lightbox did not open, and the stats reflect the fetched profile.
    expect(screen.queryByRole('dialog', { name: /^Foto de/ })).not.toBeInTheDocument()
    expect(screen.getByTestId('ps-stats').querySelector('.v.blood')?.textContent).toBe('77')
  })

  it('closes the lightbox via overlay tap and the stats popup via Escape', async () => {
    const user = userEvent.setup()
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    // Lightbox — tap the overlay to dismiss.
    await user.click(screen.getByRole('button', { name: 'Ver foto de María R.' }))
    await user.click(screen.getByRole('dialog', { name: 'Foto de María R.' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Foto de María R.' })).not.toBeInTheDocument(),
    )

    // Stats popup — Escape closes it.
    await user.click(screen.getByText('María R.'))
    await screen.findByTestId('ps-stats')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('ps-stats')).not.toBeInTheDocument())
  })

  it('live fecha: an eliminated player shows place + points + breakdown; a still-playing one does not', async () => {
    setTournament('live')
    const base = {
      rsvp_at: null,
      cancelled_at: null,
      checked_in_at: null,
      early_bird: false,
      rebuys_count: 0,
      chop_group: null,
      chopped: false,
      points_earned: 0,
    }
    h.list.entry = {
      data: [
        { id: 'a', player_id: 'pa', status: 'playing', final_position: null, paid: true, made_final_table: true, ...base, player: { name: 'Alicia P.', avatar_url: null } },
        { id: 'b', player_id: 'pb', status: 'playing', final_position: null, paid: true, made_final_table: true, ...base, player: { name: 'Bruno Q.', avatar_url: null } },
        // points_earned null → the badge falls back to the client breakdown total
        // (mig 0030: shows the live total even before the DB write lands).
        { id: 'c', player_id: 'pc', status: 'eliminated', final_position: 3, paid: true, made_final_table: true, ...base, points_earned: null, player: { name: 'Carla R.', avatar_url: null } },
      ],
      error: null,
    }
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    const rows = screen.getAllByTestId('prow')
    const byName = (n: string) => rows.find((r) => within(r).queryByText(new RegExp(n)))!
    // Eliminated on a LIVE fecha → real-time breakdown. N = 3 seated → (3−3)×5 = 0 base.
    const elim = within(byName('Carla')).getByTestId('fd-breakdown')
    expect(elim.textContent).toContain('Base 0')
    expect(elim.textContent).not.toContain('=') // total moved to the result badge
    // …AND the right-side badge shows the finishing place + live total (breakdown
    // fallback since points_earned is null): "3º · +35 pts".
    const result = within(byName('Carla')).getByTestId('fd-result')
    expect(result.textContent).toContain('3º')
    expect(result.textContent).toContain('35')
    // Still en juego → no breakdown, and it keeps its status pill (no result badge).
    expect(within(byName('Alicia')).queryByTestId('fd-breakdown')).toBeNull()
    expect(within(byName('Alicia')).queryByTestId('fd-result')).toBeNull()
  })
})

describe('FechaDetail — post-"Voy" convocatoria sheet', () => {
  it('after confirming, offers the updated roster to share/copy (me included), and closes', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    setEntries('invited')
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })

    // The silent reload after the RPC re-reads the entries: serve the server
    // truth (me confirmed) so the reconcile keeps me on the confirmados line.
    setEntries('confirmed')
    await user.click(screen.getByRole('button', { name: 'Voy' }))

    const sheet = await screen.findByTestId('convocatoria-sheet')
    const text = (within(sheet).getByTestId('convocatoria-text') as HTMLTextAreaElement).value
    // Optimistic confirm already applied → I'm in the confirmados line.
    expect(text).toContain('✅ Confirmados (2)')
    expect(text).toContain('Edwin V.')
    expect(text).toContain('María R.')
    expect(text).toContain('/fechas/t-1')

    await user.click(within(sheet).getByRole('button', { name: 'Copiar texto' }))
    expect(writeText).toHaveBeenCalledWith(text)

    await user.click(within(sheet).getByRole('button', { name: 'Cerrar' }))
    expect(screen.queryByTestId('convocatoria-sheet')).toBeNull()
  })

  it('does NOT open the sheet on "No voy"', async () => {
    const user = userEvent.setup()
    setEntries('invited')
    renderDetail()
    await screen.findByRole('heading', { name: 'Fecha 9' })
    await user.click(screen.getByRole('button', { name: 'No voy' }))
    expect(h.rpcCalls).toContainEqual(['rsvp', { p_tournament_id: 't-1', p_choice: 'decline' }])
    expect(screen.queryByTestId('convocatoria-sheet')).toBeNull()
  })
})
