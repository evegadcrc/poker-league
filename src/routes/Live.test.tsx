import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable, hoisted so the vi.mock factories can close over it. Tests set the
// tournament / levels / entries / pot, the current role, the realtime status,
// and can fire captured postgres_changes handlers to simulate a live payload.
const h = vi.hoisted(() => ({
  isAdmin: false,
  player: null as { id: string; name: string; avatar_url: string | null } | null,
  single: {} as Record<string, { data: unknown; error: unknown }>,
  list: {} as Record<string, { data: unknown; error: unknown }>,
  rpcResult: { data: 0 as unknown, error: null as unknown },
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  // Per-RPC error override (keyed by name) so e.g. self_bust can fail while
  // fn_pot still resolves during the reconcile load().
  rpcErrors: {} as Record<string, { message: string }>,
  handlers: [] as Array<(payload: unknown) => void>,
  subscribeStatus: 'SUBSCRIBED' as string,
  removed: 0,
  subscribed: 0,
}))

vi.mock('@/lib/auth', () => ({
  useRole: () => ({ isAdmin: h.isAdmin }),
  useAuth: () => ({ player: h.player }),
}))

// Spy on the persistent level-end alarm without touching the real cue engine
// (notify.ts still imports playCue/resumeAudio from here — keep them real).
vi.mock('@/lib/sound', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sound')>('@/lib/sound')
  return { ...actual, startLevelAlarm: vi.fn(), stopLevelAlarm: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      // Record `.is(col, null)` filters so maybeSingle can honor them — this is
      // how the cancelled-fecha exclusion (`.is('cancelled_at', null)`) is tested.
      const isFilters: Array<[string, unknown]> = []
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        is: (col: string, val: unknown) => {
          isFilters.push([col, val])
          return b
        },
        order: () => b,
        limit: () => b,
        maybeSingle: () => {
          const res = h.single[table] ?? { data: null, error: null }
          const row = res.data as Record<string, unknown> | null
          if (row) {
            for (const [col, val] of isFilters) {
              if (val === null && row[col] != null) return Promise.resolve({ data: null, error: res.error })
            }
          }
          return Promise.resolve(res)
        },
        then: (resolve: (v: unknown) => void) =>
          resolve(h.list[table] ?? { data: [], error: null }),
      }
      return b
    },
    rpc: (name: string, args: unknown) => {
      h.rpcCalls.push({ name, args })
      if (h.rpcErrors[name]) return Promise.resolve({ data: null, error: h.rpcErrors[name] })
      return Promise.resolve(h.rpcResult)
    },
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
import { startLevelAlarm, stopLevelAlarm } from '@/lib/sound'

type TournamentOverrides = Partial<{
  ante_enabled: boolean
  timer_mode: 'auto' | 'manual'
  current_level: number
  level_started_at: string | null
  is_paused: boolean
  paused_remaining_seconds: number | null
  prizes: unknown
  payout_distribution: unknown
  cancelled_at: string | null
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
      timer_mode: 'auto',
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
      payout_distribution: null,
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
      { id: 'a', player_id: 'p-ana', status: 'playing', final_position: null, chips: 12000, paid: false, player: { name: 'Ana', avatar_url: null } },
      { id: 'c', player_id: 'p-cid', status: 'playing', final_position: null, chips: 30000, paid: true, player: { name: 'Cid', avatar_url: null } },
      { id: 'd', player_id: 'p-dee', status: 'eliminated', final_position: 7, chips: 0, paid: true, player: { name: 'Dee', avatar_url: null } },
      { id: 'b', player_id: 'p-ben', status: 'eliminated', final_position: 8, chips: 0, paid: true, player: { name: 'Ben', avatar_url: null } },
      { id: 'e', player_id: 'p-eve', status: 'confirmed', final_position: null, chips: null, paid: false, player: { name: 'Eve', avatar_url: null } },
    ],
    error: null,
  }
}

const renderLive = () => render(<Live />, { wrapper: MemoryRouter })

beforeEach(() => {
  h.isAdmin = false
  h.player = null
  h.single = {}
  h.list = {}
  h.rpcResult = { data: 140000, error: null }
  h.rpcCalls = []
  h.rpcErrors = {}
  h.handlers = []
  h.subscribeStatus = 'SUBSCRIBED'
  h.removed = 0
  h.subscribed = 0
  vi.mocked(startLevelAlarm).mockClear()
  vi.mocked(stopLevelAlarm).mockClear()
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

  it('shows the PROPOSED split (payout_distribution × pot) before prizes are materialized', async () => {
    // No materialized prizes yet, but the fecha has a distribution + a live pot.
    setTournament({
      prizes: [],
      payout_distribution: [
        { place: 1, pct: 0.6 },
        { place: 2, pct: 0.28 },
        { place: 3, pct: 0.12 },
      ],
    })
    renderLive()
    const premios = await screen.findByTestId('premios')
    // pot = fn_pot (₡140K) → 85K / 40K / 15K (1st absorbs the ₡5.000 remainder).
    expect(within(premios).getByText('reparto propuesto')).toBeInTheDocument()
    expect(within(premios).getByText('₡85K')).toBeInTheDocument()
    expect(within(premios).getByText('₡40K')).toBeInTheDocument()
    expect(within(premios).getByText('₡15K')).toBeInTheDocument()
    // The fallback "se definen según el pozo final" message is NOT shown.
    expect(within(premios).queryByText(/se definen según el pozo final/)).not.toBeInTheDocument()
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
    // Alive rows carry the "En juego" badge (was "Vivo"); eliminated rows don't.
    expect(within(rows[0]!).getByText('En juego')).toBeInTheDocument() // Cid (alive)
    expect(within(rows[2]!).queryByText('En juego')).not.toBeInTheDocument() // Dee (out)
  })

  it('renders blind amounts with the "." thousands separator', async () => {
    // A single 4-digit level so SB/BB cross the thousands boundary.
    h.list.blind_level = {
      data: [
        { level_number: 3, small_blind: 1000, big_blind: 2000, ante: 0, duration_seconds: 900, is_break: false },
      ],
      error: null,
    }
    setTournament({ current_level: 3, is_paused: true, paused_remaining_seconds: 100 })
    renderLive()
    const blinds = await screen.findByTestId('blinds')
    expect(within(blinds).getByText('1.000')).toBeInTheDocument()
    expect(within(blinds).getByText('2.000')).toBeInTheDocument()
  })

  it('flags an unconfirmed-payment player with "Pendiente Pago" and omits it once paid', async () => {
    renderLive()
    await screen.findByTestId('timer')
    const rows = screen.getAllByTestId('standing') // [Cid(paid), Ana(unpaid), Dee, Ben]
    // Ana has not been paid-confirmed → tag present.
    expect(within(rows[1]!).getByTestId('pendiente-pago')).toHaveTextContent('Pendiente Pago')
    // Cid is paid-confirmed → no tag.
    expect(within(rows[0]!).queryByTestId('pendiente-pago')).not.toBeInTheDocument()
  })

  it('renders Premios at the bottom, below the standings', async () => {
    renderLive()
    const premios = await screen.findByTestId('premios')
    const standings = screen.getByTestId('standings')
    // Premios follows the standings block in document order.
    expect(
      standings.compareDocumentPosition(premios) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // …and it still shows its content.
    expect(within(premios).getByText('1º')).toBeInTheDocument()
  })
})

describe('Live — live points (parity with Fecha)', () => {
  // Field of 14, everyone paid, points_earned null so the CLIENT breakdown drives
  // the displayed total. Positions 1..10 made the final table; 11..14 did not.
  function setBigField() {
    h.list.entry = {
      data: Array.from({ length: 14 }, (_, i) => {
        const p = i + 1
        return {
          id: `s${p}`,
          player_id: `p-${p}`,
          status: 'eliminated',
          final_position: p,
          chips: 0,
          paid: true,
          points_earned: null,
          made_final_table: p <= 10,
          chop_group: null,
          player: { name: `Jugador ${p}`, avatar_url: null },
        }
      }),
      error: null,
    }
    // Scoring-v2 season config (== the parser defaults; set to exercise the load).
    h.single.season = {
      data: {
        points_multiplier: 5,
        bonus_final_table: 10,
        bonus_attendance: 15,
        top_finish_bonuses: [20, 15, 10, 5],
      },
      error: null,
    }
  }

  it('shows each eliminated finisher its fecha points total + breakdown', async () => {
    setBigField()
    renderLive()
    await screen.findByTestId('timer')

    // 14º of 14, paid, no final table → base (14−14)×5=0 + asist 15 = 15.
    const last = screen.getByText('Jugador 14').closest('[data-testid="standing"]') as HTMLElement
    expect(within(last).getByTestId('standing-points')).toHaveTextContent('+15 pts')
    const lastBd = within(last).getByTestId('standing-breakdown')
    expect(lastBd).toHaveTextContent('Base 0')
    expect(lastBd).toHaveTextContent('+15 asist')
    expect(lastBd).toHaveTextContent('= 15')
    expect(lastBd).not.toHaveTextContent('mesa')

    // 10º of 14, paid, made the final table → base (14−10)×5=20 + asist 15 + mesa 10 = 45.
    const tenth = screen.getByText('Jugador 10').closest('[data-testid="standing"]') as HTMLElement
    expect(within(tenth).getByTestId('standing-points')).toHaveTextContent('+45 pts')
    const tenthBd = within(tenth).getByTestId('standing-breakdown')
    expect(tenthBd).toHaveTextContent('Base 20')
    expect(tenthBd).toHaveTextContent('+15 asist')
    expect(tenthBd).toHaveTextContent('+10 mesa')
    expect(tenthBd).toHaveTextContent('= 45')
  })

  it('shows NO points for a still-alive player', async () => {
    // Default fixture: Cid is playing (alive) → keeps "En juego", never a total.
    renderLive()
    await screen.findByTestId('timer')
    const alive = screen.getByText('Cid').closest('[data-testid="standing"]') as HTMLElement
    expect(within(alive).getByText('En juego')).toBeInTheDocument()
    expect(within(alive).queryByTestId('standing-points')).not.toBeInTheDocument()
    expect(within(alive).queryByTestId('standing-breakdown')).not.toBeInTheDocument()
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

  it('excludes a soft-cancelled live fecha (empty state, not a running game)', async () => {
    // status is still 'live' but cancelled_at is set → the `.is('cancelled_at', null)`
    // filter must drop it so the En Vivo screen never renders a cancelled game.
    setTournament({ cancelled_at: '2026-07-25T00:00:00Z' })
    renderLive()
    expect(await screen.findByText(/No hay ningún torneo en vivo/i)).toBeInTheDocument()
    expect(screen.queryByTestId('timer')).not.toBeInTheDocument()
  })

  it('offers the admin console link only to admins', async () => {
    h.isAdmin = true
    renderLive()
    expect(await screen.findByRole('link', { name: /consola de admin/i })).toBeInTheDocument()
  })
})

describe('Live — self-report bust', () => {
  it('shows "Estoy fuera — reportar" for a playing current player', async () => {
    h.player = { id: 'p-ana', name: 'Ana', avatar_url: null } // Ana is playing
    renderLive()
    expect(await screen.findByRole('button', { name: /Estoy fuera — reportar/ })).toBeInTheDocument()
  })

  it('hides the button for a player who is already out', async () => {
    h.player = { id: 'p-dee', name: 'Dee', avatar_url: null } // Dee is eliminated
    renderLive()
    await screen.findByTestId('vivo-actions')
    expect(screen.queryByRole('button', { name: /Estoy fuera/ })).not.toBeInTheDocument()
  })

  it('hides the button for a player who is not in this fecha', async () => {
    h.player = { id: 'p-nobody', name: 'Nadie', avatar_url: null }
    renderLive()
    await screen.findByTestId('vivo-actions')
    expect(screen.queryByRole('button', { name: /Estoy fuera/ })).not.toBeInTheDocument()
  })

  it('does not show the button to admins (they get the console link instead)', async () => {
    h.isAdmin = true
    h.player = { id: 'p-ana', name: 'Ana', avatar_url: null }
    renderLive()
    await screen.findByRole('link', { name: /consola de admin/i })
    expect(screen.queryByRole('button', { name: /Estoy fuera/ })).not.toBeInTheDocument()
  })

  it('confirming the sheet calls self_bust with the tournament id and shows the report note', async () => {
    const user = userEvent.setup()
    h.player = { id: 'p-ana', name: 'Ana', avatar_url: null }
    renderLive()

    await user.click(await screen.findByRole('button', { name: /Estoy fuera — reportar/ }))
    // Confirm sheet is open; no RPC yet.
    const dialog = screen.getByRole('dialog', { name: /Reportar que quedaste fuera/ })
    expect(h.rpcCalls.find((c) => c.name === 'self_bust')).toBeFalsy()

    await user.click(within(dialog).getByRole('button', { name: /Sí, quedé fuera/ }))

    const call = h.rpcCalls.find((c) => c.name === 'self_bust')
    expect(call).toBeTruthy()
    expect(call!.args).toMatchObject({ p_tournament_id: 't-live' })
    // Optimistic placement: 2 alive incl. Ana → 2º; friendly note replaces the button.
    expect(await screen.findByTestId('bust-reported')).toHaveTextContent('2º lugar')
  })

  it('on a FAILED self_bust: no false "reportado", error surfaced, retry still possible', async () => {
    const user = userEvent.setup()
    h.player = { id: 'p-ana', name: 'Ana', avatar_url: null } // Ana is playing
    h.rpcErrors = { self_bust: { message: 'boom' } }
    renderLive()

    await user.click(await screen.findByRole('button', { name: /Estoy fuera — reportar/ }))
    const dialog = screen.getByRole('dialog', { name: /Reportar que quedaste fuera/ })
    await user.click(within(dialog).getByRole('button', { name: /Sí, quedé fuera/ }))

    // The RPC was attempted …
    expect(h.rpcCalls.find((c) => c.name === 'self_bust')).toBeTruthy()
    // … but it failed, so there is NO false "reportado" note, an error is shown,
    // and the report button remains (server still has Ana playing → retry).
    expect(await screen.findByTestId('bust-error')).toBeInTheDocument()
    expect(screen.queryByTestId('bust-reported')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Estoy fuera — reportar/ })).toBeInTheDocument()
  })
})

// Player-side level-END alarm. The admin is the sole clock writer; a player
// never advances the level. When THIS player's LOCAL clock for a live, running
// (auto-mode, not paused) level reaches 0, the SAME persistent alarm sounds and
// a "waiting for the admin" indicator shows — and it stops the moment the admin
// advances (fresh level_started_at → remaining > 0), pauses, or completes.
describe('Live — level-end alarm (players)', () => {
  // A live, non-paused auto level whose running clock has already expired
  // (started well before its duration) → local remaining computes to 0.
  const expired = (over: TournamentOverrides = {}) =>
    setTournament({
      timer_mode: 'auto',
      is_paused: false,
      paused_remaining_seconds: null,
      current_level: 1, // level 1 (1200s) with an upcoming level 2
      level_started_at: new Date(Date.now() - 10_000_000).toISOString(),
      ...over,
    })

  it('at 0 on a live non-paused fecha: starts the alarm + shows "esperando al admin"', async () => {
    expired()
    renderLive()
    expect(await screen.findByTestId('live-level-ended')).toHaveTextContent(/Esperando al admin/i)
    await waitFor(() => expect(startLevelAlarm).toHaveBeenCalled())
  })

  it('stops the alarm when the admin advances the level (new level_started_at, remaining > 0)', async () => {
    expired()
    renderLive()
    await screen.findByTestId('live-level-ended')
    await waitFor(() => expect(startLevelAlarm).toHaveBeenCalled())
    vi.mocked(stopLevelAlarm).mockClear()

    // Admin advances to level 2 with a fresh start → the player's clock is > 0.
    setTournament({
      timer_mode: 'auto',
      is_paused: false,
      paused_remaining_seconds: null,
      current_level: 2,
      level_started_at: new Date().toISOString(),
    })
    await act(async () => {
      h.handlers.forEach((cb) => cb({ eventType: 'UPDATE', table: 'tournament' }))
    })

    await waitFor(() => expect(screen.queryByTestId('live-level-ended')).not.toBeInTheDocument())
    expect(stopLevelAlarm).toHaveBeenCalled()
  })

  it('does NOT start the alarm while the clock is paused', async () => {
    expired({ is_paused: true, paused_remaining_seconds: 0 })
    renderLive()
    await screen.findByTestId('timer')
    expect(screen.queryByTestId('live-level-ended')).not.toBeInTheDocument()
    expect(startLevelAlarm).not.toHaveBeenCalled()
  })

  it('does NOT start the alarm in manual mode (the admin drives the clock)', async () => {
    expired({ timer_mode: 'manual' })
    renderLive()
    await screen.findByTestId('timer')
    expect(screen.queryByTestId('live-level-ended')).not.toBeInTheDocument()
    expect(startLevelAlarm).not.toHaveBeenCalled()
  })

  it('does NOT start the alarm when no fecha is live (completed / scheduled)', async () => {
    h.single.tournament = { data: null, error: null }
    renderLive()
    await screen.findByText(/No hay ningún torneo en vivo/i)
    expect(startLevelAlarm).not.toHaveBeenCalled()
  })
})
