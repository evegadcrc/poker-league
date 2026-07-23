import { act, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable, hoisted so the vi.mock factories can close over it. Tests set the
// tournament / levels / entries / pot, the current role, the realtime status,
// and can fire captured postgres_changes handlers to simulate a live payload.
const h = vi.hoisted(() => ({
  isAdmin: false,
  single: {} as Record<string, { data: unknown; error: unknown }>,
  list: {} as Record<string, { data: unknown; error: unknown }>,
  rpcResult: { data: 0 as unknown, error: null as unknown },
  handlers: [] as Array<(payload: unknown) => void>,
  subscribeStatus: 'SUBSCRIBED' as string,
  removed: 0,
  subscribed: 0,
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
        maybeSingle: () => Promise.resolve(h.single[table] ?? { data: null, error: null }),
        then: (resolve: (v: unknown) => void) =>
          resolve(h.list[table] ?? { data: [], error: null }),
      }
      return b
    },
    rpc: () => Promise.resolve(h.rpcResult),
    channel: () => {
      const chan: Record<string, unknown> = {
        on: (_type: string, _filter: unknown, cb: (payload: unknown) => void) => {
          h.handlers.push(cb)
          return chan
        },
        subscribe: (cb?: (status: string) => void) => {
          h.subscribed += 1
          cb?.(h.subscribeStatus)
          return chan
        },
      }
      return chan
    },
    removeChannel: () => {
      h.removed += 1
      return Promise.resolve()
    },
  },
}))

import Live from './Live'

type TournamentOverrides = Partial<{
  ante_enabled: boolean
  current_level: number
  level_started_at: string | null
  is_paused: boolean
  paused_remaining_seconds: number | null
  prizes: unknown
}>

const LEVELS = [
  { level_number: 1, small_blind: 25, big_blind: 50, ante: 0, duration_seconds: 1200, is_break: false },
  { level_number: 2, small_blind: 50, big_blind: 100, ante: 0, duration_seconds: 1200, is_break: false },
  { level_number: 6, small_blind: 400, big_blind: 800, ante: 0, duration_seconds: 720, is_break: false },
  { level_number: 7, small_blind: 200, big_blind: 400, ante: 25, duration_seconds: 1200, is_break: false },
]

function setTournament(over: TournamentOverrides = {}) {
  h.single.tournament = {
    data: {
      id: 't-live',
      name: 'Fecha 8',
      ante_enabled: false,
      current_level: 5,
      level_started_at: null,
      is_paused: true,
      paused_remaining_seconds: 512, // 08:32
      blind_structure_id: 'bs-1',
      prizes: [
        { position: 1, pct: 0.6, amount: 85000 },
        { position: 2, pct: 0.28, amount: 40000 },
        { position: 3, pct: 0.12, amount: 15000 },
      ],
      ...over,
    },
    error: null,
  }
}

function setLevels() {
  h.list.blind_level = { data: LEVELS, error: null }
}

function setEntries() {
  h.list.entry = {
    data: [
      { id: 'a', status: 'playing', final_position: null, chips: 12000, player: { name: 'Ana', avatar_url: null } },
      { id: 'c', status: 'playing', final_position: null, chips: 30000, player: { name: 'Cid', avatar_url: null } },
      { id: 'd', status: 'eliminated', final_position: 7, chips: 0, player: { name: 'Dee', avatar_url: null } },
      { id: 'b', status: 'eliminated', final_position: 8, chips: 0, player: { name: 'Ben', avatar_url: null } },
      { id: 'e', status: 'confirmed', final_position: null, chips: null, player: { name: 'Eve', avatar_url: null } },
    ],
    error: null,
  }
}

const renderLive = () => render(<Live />, { wrapper: MemoryRouter })

beforeEach(() => {
  h.isAdmin = false
  h.single = {}
  h.list = {}
  h.rpcResult = { data: 140000, error: null }
  h.handlers = []
  h.subscribeStatus = 'SUBSCRIBED'
  h.removed = 0
  h.subscribed = 0
  setTournament()
  setLevels()
  setEntries()
})

describe('Live — state-based timer + scoreboard', () => {
  it('renders the paused clock exactly from the fixture state', async () => {
    renderLive()
    const timer = await screen.findByTestId('timer')
    expect(timer).toHaveTextContent('08:32')
  })

  it('counts down a running level (level_duration − elapsed)', async () => {
    // Started 10s ago, 1200s level → ~19:50 remaining.
    setTournament({
      is_paused: false,
      paused_remaining_seconds: null,
      current_level: 1,
      level_started_at: new Date(Date.now() - 10_000).toISOString(),
    })
    renderLive()
    const timer = await screen.findByTestId('timer')
    expect(timer.textContent).toMatch(/^19:(50|49)$/)
  })

  it('hides the ante when the tournament ante is disabled', async () => {
    setTournament({ current_level: 1, ante_enabled: false })
    renderLive()
    const blinds = await screen.findByTestId('blinds')
    expect(within(blinds).getByText('SB')).toBeInTheDocument()
    expect(within(blinds).getByText('BB')).toBeInTheDocument()
    expect(within(blinds).queryByText('Ante')).not.toBeInTheDocument()
  })

  it('shows the ante when enabled and the level has a positive ante', async () => {
    setTournament({ current_level: 7, ante_enabled: true, is_paused: true, paused_remaining_seconds: 100 })
    renderLive()
    const blinds = await screen.findByTestId('blinds')
    expect(within(blinds).getByText('Ante')).toBeInTheDocument()
  })

  it('renders Premios from tournament.prizes', async () => {
    renderLive()
    const premios = await screen.findByTestId('premios')
    expect(within(premios).getByText('1º')).toBeInTheDocument()
    expect(within(premios).getByText('₡85K')).toBeInTheDocument()
    expect(within(premios).getByText('60%')).toBeInTheDocument()
    expect(within(premios).getByText('₡15K')).toBeInTheDocument()
  })

  it('renders live stats: pozo, quedan and fichas en juego', async () => {
    renderLive()
    await screen.findByTestId('timer')
    // Pozo = fn_pot (₡140K); Quedan alive 2 / played 4; chips in play 12000+30000 = 42K.
    expect(screen.getByText('₡140K')).toBeInTheDocument()
    expect(screen.getByText('42K')).toBeInTheDocument()
  })

  it('orders standings: alive (chip-leader first) then eliminated by position asc', async () => {
    renderLive()
    await screen.findByTestId('timer')
    const rows = screen.getAllByTestId('standing')
    const names = rows.map((r) => within(r).getByText(/Ana|Cid|Dee|Ben|Eve/).textContent)
    expect(names).toEqual(['Cid', 'Ana', 'Dee', 'Ben']) // Eve (confirmed) excluded
  })
})

describe('Live — realtime', () => {
  it('subscribes, patches state when a postgres_changes payload arrives, unsubscribes on unmount', async () => {
    const { unmount } = renderLive()
    expect(await screen.findByTestId('timer')).toHaveTextContent('08:32')
    await waitFor(() => expect(h.subscribed).toBeGreaterThan(0))
    expect(h.handlers.length).toBe(2) // tournament + entry listeners

    // Simulate the admin advancing the clock: new state on the tournament row.
    setTournament({ paused_remaining_seconds: 100 }) // 01:40
    await act(async () => {
      h.handlers.forEach((cb) => cb({ eventType: 'UPDATE', table: 'tournament' }))
    })
    await waitFor(() => expect(screen.getByTestId('timer')).toHaveTextContent('01:40'))

    unmount()
    expect(h.removed).toBeGreaterThan(0)
  })

  it('shows a reconnect banner without blanking last-known data', async () => {
    h.subscribeStatus = 'CHANNEL_ERROR'
    renderLive()
    // Data still rendered (timer present) and the reconnect status is shown.
    expect(await screen.findByTestId('timer')).toHaveTextContent('08:32')
    expect(await screen.findByTestId('reconnect')).toBeInTheDocument()
  })
})

describe('Live — empty / admin', () => {
  it('shows a friendly empty state when no fecha is live', async () => {
    h.single.tournament = { data: null, error: null }
    renderLive()
    expect(await screen.findByText(/No hay ningún torneo en vivo/i)).toBeInTheDocument()
  })

  it('offers the admin console link only to admins', async () => {
    h.isAdmin = true
    renderLive()
    expect(await screen.findByRole('link', { name: /consola de admin/i })).toBeInTheDocument()
  })
})
