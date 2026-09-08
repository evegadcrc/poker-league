import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { colonesFull } from '@/lib/fechas'

// Hoisted mutable state so the vi.mock factory can close over it. Tests set the
// live tournament / levels / entries / season, and inspect the captured RPC
// calls to assert the console wired the right RPCs.
const h = vi.hoisted(() => ({
  isAdmin: true,
  single: {} as Record<string, { data: unknown; error: unknown }>,
  list: {} as Record<string, { data: unknown; error: unknown }>,
  rpc: {} as Record<string, { data: unknown; error: unknown }>,
  // Optional per-RPC impl override — lets a test return a deferred/in-flight
  // promise it resolves manually (for the auto-advance in-flight race test).
  rpcImpl: {} as Record<string, (args: unknown) => Promise<{ data: unknown; error: unknown }>>,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  // Captured tournament .update() payloads (payout_distribution edit).
  updates: [] as Array<{ table: string; payload: unknown }>,
  // When set, the channel mock invokes subscribe's status callback with it
  // (e.g. 'CHANNEL_ERROR') so the reconnect banner can be exercised.
  channelStatus: undefined as string | undefined,
  // Bound player for useAuth (the PlayersPanel reads it to flag the "self" row).
  authPlayer: null as { id: string; is_admin?: boolean } | null,
}))

vi.mock('@/lib/auth', () => ({
  useRole: () => ({ isAdmin: h.isAdmin }),
  useAuth: () => ({ player: h.authPlayer }),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      // Record `.is(col, null)` filters so maybeSingle honors them (the cancelled-
      // fecha exclusion `.is('cancelled_at', null)` on the live console query).
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
        update: (payload: unknown) => {
          h.updates.push({ table, payload })
          return b
        },
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
        then: (resolve: (v: unknown) => void) => resolve(h.list[table] ?? { data: [], error: null }),
      }
      return b
    },
    rpc: (name: string, args: unknown) => {
      h.rpcCalls.push({ name, args })
      if (h.rpcImpl[name]) return h.rpcImpl[name](args)
      if (h.rpc[name]) return Promise.resolve(h.rpc[name])
      if (name === 'fn_pot') return Promise.resolve({ data: 140_000, error: null })
      return Promise.resolve({ data: [], error: null })
    },
    channel: () => {
      const chan: Record<string, unknown> = {
        on: () => chan,
        subscribe: (cb?: (status: string) => void) => {
          if (cb && h.channelStatus) cb(h.channelStatus)
          return chan
        },
      }
      return chan
    },
    removeChannel: () => Promise.resolve(),
  },
}))

// Spy on the persistent level-end alarm without touching the real cue engine
// (notify.ts still imports playCue/resumeAudio from here — keep them real).
vi.mock('@/lib/sound', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sound')>('@/lib/sound')
  return { ...actual, startLevelAlarm: vi.fn(), stopLevelAlarm: vi.fn() }
})

import Admin from './Admin'
import { startLevelAlarm, stopLevelAlarm } from '@/lib/sound'

const LEVELS = [
  { level_number: 1, small_blind: 25, big_blind: 50, ante: 0, duration_seconds: 1200, is_break: false },
  { level_number: 2, small_blind: 50, big_blind: 100, ante: 0, duration_seconds: 1200, is_break: false },
]

function setLive() {
  h.single.tournament = {
    data: {
      id: 't-live',
      name: 'Fecha 8',
      season_id: 's-1',
      ante_enabled: false,
      timer_mode: 'manual', // avoid auto-advance firing clock() during the test
      current_level: 1,
      level_started_at: new Date().toISOString(),
      is_paused: false,
      paused_remaining_seconds: null,
      blind_structure_id: 'bs-1',
      prizes: [
        { position: 1, pct: 0.6, amount: 85_000 },
        { position: 2, pct: 0.28, amount: 40_000 },
        { position: 3, pct: 0.12, amount: 15_000 },
      ],
      payout_distribution: [
        { place: 1, pct: 0.6 },
        { place: 2, pct: 0.28 },
        { place: 3, pct: 0.12 },
      ],
      final_table_size: 5,
      starting_stack: 10_000,
      odds_enabled: true,
    },
    error: null,
  }
  h.single.season = {
    data: {
      name: 'Liga 2026',
      points_multiplier: 5,
      bonus_final_table: 10,
      bonus_attendance: 15,
      top_finish_bonuses: [20, 15, 10, 5],
    },
    error: null,
  }
  h.list.blind_level = { data: LEVELS, error: null }
  h.list.entry = {
    data: [
      { id: 'e-ana', player_id: 'p-ana', status: 'playing', paid: true, chips: 30_000, rebuys_count: 0, early_bird: false, final_position: null, player: { name: 'Ana', avatar_url: null } },
      { id: 'e-cid', player_id: 'p-cid', status: 'playing', paid: true, chips: 22_000, rebuys_count: 1, early_bird: false, final_position: null, player: { name: 'Cid', avatar_url: null } },
      { id: 'e-dee', player_id: 'p-dee', status: 'eliminated', paid: true, chips: 0, rebuys_count: 0, early_bird: false, final_position: 3, player: { name: 'Dee', avatar_url: null } },
      { id: 'e-eve', player_id: 'p-eve', status: 'eliminated', paid: true, chips: 0, rebuys_count: 0, early_bird: false, final_position: 4, player: { name: 'Eve', avatar_url: null } },
      { id: 'e-ben', player_id: 'p-ben', status: 'confirmed', paid: false, chips: null, rebuys_count: 0, early_bird: false, final_position: null, player: { name: 'Ben', avatar_url: null } },
    ],
    error: null,
  }
}

const renderAdmin = () => render(<Admin />, { wrapper: MemoryRouter })

beforeEach(() => {
  h.isAdmin = true
  h.single = {}
  h.list = {}
  h.rpc = {}
  h.rpcImpl = {}
  h.rpcCalls = []
  h.updates = []
  h.channelStatus = undefined
  h.authPlayer = null
  vi.mocked(startLevelAlarm).mockClear()
  vi.mocked(stopLevelAlarm).mockClear()
  setLive()
})

describe('Admin console (slice 12)', () => {
  it('does not load a soft-cancelled live fecha into the console (no complete path)', async () => {
    // status still 'live' but cancelled_at set → `.is('cancelled_at', null)` drops
    // it, so the console shows the empty state and complete_tournament is unreachable.
    setLive()
    ;(h.single.tournament!.data as Record<string, unknown>).cancelled_at = '2026-07-25T00:00:00Z'
    renderAdmin()
    expect(await screen.findByText(/No hay ninguna fecha en vivo/i)).toBeInTheDocument()
    expect(screen.queryByTestId('clock-grid')).not.toBeInTheDocument()
  })

  it('renders the live console: sub-nav, clock grid, and the player list', async () => {
    renderAdmin()
    expect(screen.getByRole('tab', { name: 'Consola' })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(screen.getByTestId('clock-grid')).toBeInTheDocument())
    expect(screen.getByTestId('admin-timer')).toBeInTheDocument()
    const rows = await screen.findAllByTestId('admin-prow')
    expect(rows).toHaveLength(5)
    // paid / unpaid badges rendered.
    expect(screen.getAllByText('✓ Pagó').length).toBeGreaterThan(0)
    expect(screen.getByText('● Sin pagar')).toBeInTheDocument()
    // chips badge is labeled "fichas iniciales" (buy-in chips, not a live stack).
    expect(screen.getAllByText(/fichas iniciales/).length).toBeGreaterThan(0)
  })

  it('clock buttons call the clock RPC (pause)', async () => {
    const user = userEvent.setup()
    renderAdmin()
    const pause = await screen.findByRole('button', { name: /Pausar/ })
    await user.click(pause)
    const call = h.rpcCalls.find((c) => c.name === 'clock')
    expect(call).toBeTruthy()
    expect(call!.args).toMatchObject({ p_tournament_id: 't-live', p_action: 'pause' })
  })

  it('confirm_payment is called for an unpaid confirmed player', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await screen.findAllByTestId('admin-prow')
    // Ben is the confirmed/unpaid player → his row exposes "Confirmar pago".
    const payBtn = screen.getAllByRole('button', { name: 'Confirmar pago' })[0]!
    await user.click(payBtn)
    const call = h.rpcCalls.find((c) => c.name === 'confirm_payment')
    expect(call).toBeTruthy()
    expect(call!.args).toMatchObject({ p_entry_id: 'e-ben' })
  })

  it('eliminate goes through a confirm sheet before firing', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await screen.findAllByTestId('admin-prow')
    // Click the first "Eliminar" → confirm sheet, not the RPC yet.
    await user.click(screen.getAllByRole('button', { name: 'Eliminar' })[0]!)
    expect(h.rpcCalls.find((c) => c.name === 'eliminate')).toBeFalsy()
    // Confirm inside the dialog.
    const dialog = screen.getByRole('dialog', { name: 'Eliminar jugador' })
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar' }))
    expect(h.rpcCalls.find((c) => c.name === 'eliminate')).toBeTruthy()
  })

  it('chop flow: select finalists → preview → confirm calls complete_tournament with chop ids', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await screen.findAllByTestId('admin-prow')

    await user.click(screen.getByRole('button', { name: /Completar fecha/ }))
    const dialog = screen.getByRole('dialog', { name: 'Completar fecha' })

    // Select the two players still in play (Ana + Cid).
    await user.click(within(dialog).getByLabelText('Chop Ana'))
    await user.click(within(dialog).getByLabelText('Chop Cid'))

    // Preview appears with equal money + points. (Normalize locale spaces.)
    const preview = await within(dialog).findByTestId('chop-preview')
    const txt = preview.textContent!.replace(/[  ]/g, ' ')
    // N = 2 placed + 2 choppers = 4 → money (85k+40k)/2 = ₡62 500 ; points (scoring
    // v2): pv(1)=(4−1)×5+10+20+15=60 ; pv(2)=(4−2)×5+10+15+15=50 ; avg = 55.
    expect(txt.replace(/[\s.,]/g, '')).toContain('62500')
    expect(txt).toContain('55 pts')

    await user.click(within(dialog).getByRole('button', { name: /Chop y completar/ }))
    const call = h.rpcCalls.find((c) => c.name === 'complete_tournament')
    expect(call).toBeTruthy()
    expect(call!.args).toMatchObject({ p_tournament_id: 't-live' })
    expect((call!.args as { p_chop_entry_ids: string[] }).p_chop_entry_ids.sort()).toEqual([
      'e-ana',
      'e-cid',
    ])
  })

  it('completes without a chop when no finalists are selected', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await screen.findAllByTestId('admin-prow')
    await user.click(screen.getByRole('button', { name: /Completar fecha/ }))
    const dialog = screen.getByRole('dialog', { name: 'Completar fecha' })
    await user.click(within(dialog).getByRole('button', { name: 'Completar sin chop' }))
    const call = h.rpcCalls.find((c) => c.name === 'complete_tournament')
    expect(call).toBeTruthy()
    expect((call!.args as Record<string, unknown>).p_chop_entry_ids).toBeUndefined()
  })

  // Multi-bust must leave ≥1 survivor: selecting the WHOLE in-play field is a
  // final-table/heads-up chop (→ "Completar fecha"), so both bust actions
  // disable and a survivor hint appears. A subset (leaving ≥1) enables them.
  it('MultiBustSheet disables En orden + Empataron when all in-play are selected', async () => {
    const user = userEvent.setup()
    h.list.entry = {
      data: [
        { id: 'e-a', player_id: 'p-a', status: 'playing', paid: true, chips: 10_000, rebuys_count: 0, early_bird: false, final_position: null, player: { name: 'Ana', avatar_url: null } },
        { id: 'e-b', player_id: 'p-b', status: 'playing', paid: true, chips: 20_000, rebuys_count: 0, early_bird: false, final_position: null, player: { name: 'Bea', avatar_url: null } },
        { id: 'e-c', player_id: 'p-c', status: 'playing', paid: true, chips: 30_000, rebuys_count: 0, early_bird: false, final_position: null, player: { name: 'Cid', avatar_url: null } },
      ],
      error: null,
    }
    renderAdmin()
    await screen.findAllByTestId('admin-prow')

    await user.click(screen.getByRole('button', { name: /Eliminar varios/ }))
    const dialog = screen.getByRole('dialog', { name: /Eliminar varios/ })
    const orden = within(dialog).getByRole('button', { name: /En orden/ })
    const empate = within(dialog).getByRole('button', { name: /Empataron/ })

    // Select 2 of 3 (leaves 1 survivor) → both actions enabled, no hint.
    await user.click(within(dialog).getByLabelText('Eliminar Ana'))
    await user.click(within(dialog).getByLabelText('Eliminar Bea'))
    expect(orden).toBeEnabled()
    expect(empate).toBeEnabled()
    expect(within(dialog).queryByTestId('multibust-survivor-hint')).not.toBeInTheDocument()

    // Select the 3rd too (whole field, 0 survivors) → both disabled + hint.
    await user.click(within(dialog).getByLabelText('Eliminar Cid'))
    expect(orden).toBeDisabled()
    expect(empate).toBeDisabled()
    expect(within(dialog).getByTestId('multibust-survivor-hint')).toBeInTheDocument()
  })
})

// The running clock's next-level footer shows the NEXT blind's real values
// (SB/BB + duration), and tapping the clock opens the read-only full structure.
describe('Admin console — next-blind footer + blind structure table', () => {
  it('the next-level footer shows the next blind values (SB/BB + duration)', async () => {
    renderAdmin()
    // current_level 1 → next is level 2 (SB 50 / BB 100, 1200s = 20:00).
    const next = await screen.findByTestId('admin-next-lvl')
    expect(next).toHaveTextContent('Nivel 2')
    expect(next).toHaveTextContent('50 / 100')
    expect(next).toHaveTextContent('20:00')
  })

  it('tapping the clock opens the read-only blind structure table', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await screen.findByTestId('admin-timer')

    expect(screen.queryByTestId('blinds-table')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('admin-clock-tap'))

    const dialog = await screen.findByRole('dialog', { name: 'Estructura de blinds' })
    const table = within(dialog).getByTestId('blinds-table')
    // Both levels listed; the current level (1) is marked.
    expect(within(table).getByText('50 / 100')).toBeInTheDocument()
    expect(within(dialog).getByTestId('blinds-row-current')).toBeInTheDocument()
  })
})

// The admin roster shows an "A tiempo" marker next to players who checked in on
// time (early_bird set + checked_in_at), so the admin can see who arrived early.
describe('Admin console — "A tiempo" roster indicator (mig 0031)', () => {
  it('marks on-time players and leaves late/no check-in players unmarked', async () => {
    h.list.entry = {
      data: [
        { id: 'e-ot', player_id: 'p-ot', status: 'checked_in', paid: true, chips: 12_000, rebuys_count: 0, early_bird: true, checked_in_at: new Date().toISOString(), final_position: null, player: { name: 'Puntual Pam', avatar_url: null, is_guest: false } },
        { id: 'e-late', player_id: 'p-late', status: 'checked_in', paid: true, chips: 10_000, rebuys_count: 0, early_bird: false, checked_in_at: new Date().toISOString(), final_position: null, player: { name: 'Tardío Tom', avatar_url: null, is_guest: false } },
        { id: 'e-conf', player_id: 'p-conf', status: 'confirmed', paid: false, chips: null, rebuys_count: 0, early_bird: false, checked_in_at: null, final_position: null, player: { name: 'Confirmó Cata', avatar_url: null, is_guest: false } },
      ],
      error: null,
    }
    renderAdmin()
    await screen.findAllByTestId('admin-prow')

    // Exactly one "A tiempo" badge — Pam only.
    const badges = screen.getAllByTestId('admin-ontime-badge')
    expect(badges).toHaveLength(1)
    const pam = screen.getAllByTestId('admin-prow').find((r) => within(r).queryByText(/Puntual Pam/))!
    expect(within(pam).getByTestId('admin-ontime-badge')).toHaveTextContent('A tiempo')
  })
})

describe('Admin console — odds-calculator toggle (Phase-2 step 7)', () => {
  it('flips odds_enabled on the live fecha via .update()', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await screen.findAllByTestId('admin-prow')

    // Fixture starts enabled → the switch reflects that.
    const toggle = screen.getByTestId('admin-odds-toggle')
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await user.click(toggle)

    // The live console writes the flipped value to the tournament row.
    await waitFor(() => expect(h.updates.find((u) => u.table === 'tournament')).toBeTruthy())
    const upd = h.updates.find((u) => u.table === 'tournament')!.payload as {
      odds_enabled?: boolean
    }
    expect(upd.odds_enabled).toBe(false)
  })
})

describe('Admin console — edit prizes (payout distribution, Phase-2 step 5)', () => {
  it('editing the split updates payout_distribution then re-materializes via set_prizes', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await screen.findAllByTestId('admin-prow')

    await user.click(screen.getByRole('button', { name: /Editar premios/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Editar premios del torneo' })
    // Seeded from the fecha's current distribution (60 / 28 / 12).
    const editor = within(dialog).getByTestId('prize-dist-editor')
    expect(within(editor).getAllByRole('textbox')).toHaveLength(3)

    // Add a 4th place and rebalance to keep the sum at 100% (60/25/10/5).
    await user.click(within(editor).getByRole('button', { name: '+ Agregar lugar' }))
    const [first, second, third, fourth] = within(editor).getAllByRole('textbox')
    await user.clear(second!)
    await user.type(second!, '25')
    await user.clear(third!)
    await user.type(third!, '10')
    await user.clear(fourth!)
    await user.type(fourth!, '5')
    void first

    await user.click(within(dialog).getByRole('button', { name: 'Guardar premios' }))

    // (1) payout_distribution written directly to the tournament row …
    await waitFor(() => expect(h.updates.find((u) => u.table === 'tournament')).toBeTruthy())
    const upd = h.updates.find((u) => u.table === 'tournament')!.payload as {
      payout_distribution: Array<{ place: number; pct: number }>
    }
    expect(upd.payout_distribution).toEqual([
      { place: 1, pct: 0.6 },
      { place: 2, pct: 0.25 },
      { place: 3, pct: 0.1 },
      { place: 4, pct: 0.05 },
    ])
    // (2) … then set_prizes re-materializes prizes against the current pot.
    await waitFor(() =>
      expect(h.rpcCalls.find((c) => c.name === 'set_prizes')).toMatchObject({
        args: { p_tournament_id: 't-live' },
      }),
    )
  })
})

describe('Admin console — error / reconnect states (slice 16)', () => {
  it('surfaces a toast when an action RPC fails, and refetches to reconcile (safe retry)', async () => {
    const user = userEvent.setup()
    h.rpc.confirm_payment = { data: null, error: { message: 'boom' } }
    renderAdmin()
    await screen.findAllByTestId('admin-prow')

    await user.click(screen.getAllByRole('button', { name: 'Confirmar pago' })[0]!)

    // Toast shown …
    expect(await screen.findByTestId('admin-toast')).toBeInTheDocument()
    // … and the console reconciled by refetching (a second console load ran
    // after the failed RPC), so a retry acts on server truth, never stale state.
    const consoleLoads = h.rpcCalls.filter((c) => c.name === 'fn_pot').length
    expect(consoleLoads).toBeGreaterThanOrEqual(2)
  })

  it('shows the reconnect banner when the realtime channel drops', async () => {
    h.channelStatus = 'CHANNEL_ERROR'
    renderAdmin()
    expect(await screen.findByTestId('admin-reconnect')).toBeInTheDocument()
  })
})

// Level-END FE contract (single writer, NO silent auto-advance). When a running
// auto-mode level's LOCAL clock reaches 0 the admin client must NOT fire
// next_level on its own: it sounds a persistent alarm and surfaces a manual
// "start next level" control. Only a tap advances the level (and stops the
// alarm). Uses real fixtures (never forces manual mode to dodge the effect).
describe('Admin console — level-end alarm + manual next-level (single writer)', () => {
  // An auto tournament whose running clock has already expired (started well
  // before its level duration) → remaining computes to 0.
  function setAutoExpired(overrides: Record<string, unknown> = {}) {
    setLive()
    Object.assign(h.single.tournament.data as Record<string, unknown>, {
      timer_mode: 'auto',
      is_paused: false,
      current_level: 1,
      level_started_at: new Date(Date.now() - 10_000_000).toISOString(),
      ...overrides,
    })
  }

  const nextLevelCalls = () =>
    h.rpcCalls.filter(
      (c) => c.name === 'clock' && (c.args as { p_action?: string }).p_action === 'next_level',
    ).length

  it('at 0: does NOT auto-fire next_level — it starts the alarm and shows the start button', async () => {
    setAutoExpired()
    renderAdmin()
    // Level-end state: the manual "start next level" affordance is present…
    expect(await screen.findByTestId('start-next-level')).toBeInTheDocument()
    expect(screen.getByTestId('level-ended')).toHaveTextContent(/Nivel 1 terminado/i)
    // …the persistent alarm is sounding…
    await waitFor(() => expect(startLevelAlarm).toHaveBeenCalled())
    // …and NOTHING advanced on its own.
    expect(nextLevelCalls()).toBe(0)
  })

  it('tapping "Iniciar siguiente nivel" stops the alarm and advances exactly once', async () => {
    setAutoExpired()
    const user = userEvent.setup()
    renderAdmin()
    const btn = await screen.findByTestId('start-next-level')
    vi.mocked(stopLevelAlarm).mockClear()

    await user.click(btn)

    await waitFor(() => expect(nextLevelCalls()).toBe(1))
    expect(stopLevelAlarm).toHaveBeenCalled()
    // `busy` disables the button while the RPC is in flight → no double-advance.
    expect(nextLevelCalls()).toBe(1)
  })

  it('does NOT start the alarm or show the button while the clock is paused', async () => {
    setAutoExpired({ is_paused: true, paused_remaining_seconds: 0 })
    renderAdmin()
    await screen.findAllByTestId('admin-prow')
    expect(screen.queryByTestId('start-next-level')).not.toBeInTheDocument()
    expect(startLevelAlarm).not.toHaveBeenCalled()
    expect(nextLevelCalls()).toBe(0)
  })

  it('does NOT enter the level-end state in manual mode even when expired', async () => {
    setAutoExpired({ timer_mode: 'manual' })
    renderAdmin()
    await screen.findAllByTestId('admin-prow')
    expect(screen.queryByTestId('start-next-level')).not.toBeInTheDocument()
    expect(startLevelAlarm).not.toHaveBeenCalled()
    expect(nextLevelCalls()).toBe(0)
  })

  it('on the LAST level ending: terminal state, no start button, no looping alarm', async () => {
    setAutoExpired({ current_level: 2 }) // level 2 is the last in LEVELS
    renderAdmin()
    expect(await screen.findByTestId('level-ended-final')).toBeInTheDocument()
    expect(screen.queryByTestId('start-next-level')).not.toBeInTheDocument()
    expect(startLevelAlarm).not.toHaveBeenCalled()
    expect(nextLevelCalls()).toBe(0)
  })
})

describe('Admin — WhatsApp summary (slice 15)', () => {
  it('does not show the Resumen action to a non-admin', async () => {
    h.isAdmin = false
    renderAdmin()
    await screen.findAllByTestId('admin-prow')
    expect(screen.queryByRole('button', { name: /Resumen/ })).not.toBeInTheDocument()
  })

  it('opens the sheet with the fecha-result summary formatted for the group', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await screen.findAllByTestId('admin-prow')

    await user.click(screen.getByRole('button', { name: /Resumen/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Resumen para WhatsApp' })
    const text = (await within(dialog).findByTestId('wa-text')) as HTMLTextAreaElement

    // Header + podium (Dee 3rd is the only placed finisher) + pot + counts.
    expect(text.value).toContain('🃏 POKER FRIENDS · Fecha 8')
    expect(text.value).toContain('🥉 3º: Dee')
    expect(text.value).toContain(`💰 Pozo: ${colonesFull(140_000)}`)
    // 4 players took a seat (2 playing + 2 eliminated); Cid had 1 rebuy.
    expect(text.value).toContain('👥 4 jugadores · 1 recompra')
  })

  it('switches to the season standings summary from the leaderboard RPC', async () => {
    h.rpc.leaderboard = {
      data: [
        { player_name: 'Mauricio A.', total_points: 320 },
        { player_name: 'Andrés R.', total_points: 295 },
        { player_name: 'Edwin V.', total_points: 270 },
      ],
      error: null,
    }
    const user = userEvent.setup()
    renderAdmin()
    await screen.findAllByTestId('admin-prow')

    await user.click(screen.getByRole('button', { name: /Resumen/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Resumen para WhatsApp' })
    await user.click(within(dialog).getByRole('tab', { name: 'Temporada' }))

    const text = (await within(dialog).findByTestId('wa-text')) as HTMLTextAreaElement
    await waitFor(() =>
      expect(text.value).toContain('🃏 POKER FRIENDS · Liga 2026 — Tabla general'),
    )
    expect(text.value).toContain('🥇 1º Mauricio A. — 320 pts')
    expect(text.value).toContain('🥉 3º Edwin V. — 270 pts')
  })

  it('Copiar resumen invokes the clipboard with the summary text', async () => {
    const user = userEvent.setup()
    // Install our mock AFTER setup() so it wins over userEvent's own clipboard stub.
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    renderAdmin()
    await screen.findAllByTestId('admin-prow')

    await user.click(screen.getByRole('button', { name: /Resumen/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Resumen para WhatsApp' })
    await user.click(within(dialog).getByRole('button', { name: /Copiar resumen/ }))

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0]![0]).toContain('🃏 POKER FRIENDS · Fecha 8')
    expect(await within(dialog).findByTestId('wa-status')).toHaveTextContent('Resumen copiado')
  })
})

// ---------------------------------------------------------------------------
// Phase 3 — Agregar jugador (whitelist a league member via create_player).
// ---------------------------------------------------------------------------
describe('Admin — Agregar jugador (Phase 3)', () => {
  it('submits name + email and calls create_player', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Jugadores' }))
    await screen.findByTestId('add-player')

    await user.type(screen.getByLabelText('Nombre'), 'Nuevo Amigo')
    await user.type(screen.getByLabelText('Correo'), 'amigo@example.com')
    await user.click(screen.getByRole('button', { name: 'Agregar jugador' }))

    const call = h.rpcCalls.find((c) => c.name === 'create_player')
    expect(call).toBeTruthy()
    expect(call!.args).toMatchObject({ p_name: 'Nuevo Amigo', p_email: 'amigo@example.com' })
    // Success note shown; form cleared.
    expect(await screen.findByTestId('add-player-ok')).toBeInTheDocument()
  })

  it('surfaces a duplicate-email error (23505) without clearing the form', async () => {
    const user = userEvent.setup()
    h.rpc.create_player = { data: null, error: { code: '23505', message: 'duplicate key' } }
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Jugadores' }))
    await screen.findByTestId('add-player')

    await user.type(screen.getByLabelText('Nombre'), 'Repetido')
    await user.type(screen.getByLabelText('Correo'), 'dup@example.com')
    await user.click(screen.getByRole('button', { name: 'Agregar jugador' }))

    expect(await screen.findByTestId('add-player-error')).toHaveTextContent(/ya está registrado/i)
  })
})

// ---------------------------------------------------------------------------
// Phase 3 — Jugadores roster (always visible) + block/unblock toggle (mig 0023).
// ---------------------------------------------------------------------------
describe('Admin — Jugadores roster + block toggle (mig 0023)', () => {
  function setRoster() {
    h.authPlayer = { id: 'p-self', is_admin: true }
    h.list.player = {
      data: [
        { id: 'p-self', name: 'Yo Admin', email: 'self@ex.com', is_admin: true, is_guest: false, blocked: false },
        { id: 'p-nor', name: 'Normal Norm', email: 'norm@ex.com', is_admin: false, is_guest: false, blocked: false },
        { id: 'p-blk', name: 'Bloqueado Bob', email: 'bob@ex.com', is_admin: false, is_guest: false, blocked: true },
        { id: 'p-gst', name: 'Invitado Ivy', email: 'guest+x@local', is_admin: false, is_guest: true, blocked: false },
      ],
      error: null,
    }
  }

  it('always shows the roster with name + tags alongside the add form', async () => {
    const user = userEvent.setup()
    setRoster()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Jugadores' }))

    // Add form + roster both present.
    expect(await screen.findByTestId('add-player')).toBeInTheDocument()
    const roster = await screen.findByTestId('players-roster')
    expect(within(roster).getAllByTestId('roster-row')).toHaveLength(4)

    expect(within(roster).getByText('Yo Admin')).toBeInTheDocument()
    expect(within(roster).getByText('norm@ex.com')).toBeInTheDocument()
    // Tags: Admin / Invitado / Bloqueado.
    expect(within(roster).getByTestId('admin-tag')).toHaveTextContent('Admin')
    expect(within(roster).getByTestId('invitado-tag')).toHaveTextContent('Invitado')
    expect(within(roster).getByTestId('blocked-tag')).toHaveTextContent('Bloqueado')
  })

  it('offers a Bloquear/Desbloquear toggle only for non-admin, non-self, non-guest rows', async () => {
    const user = userEvent.setup()
    setRoster()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Jugadores' }))
    await screen.findByTestId('players-roster')

    // Exactly two toggles: Normal Norm (Bloquear) + Bloqueado Bob (Desbloquear).
    const toggles = screen.getAllByTestId('block-toggle')
    expect(toggles).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Bloquear' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Desbloquear' })).toBeInTheDocument()
  })

  it('confirms then calls set_player_blocked when blocking a player', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    setRoster()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Jugadores' }))
    await screen.findByTestId('players-roster')

    await user.click(screen.getByRole('button', { name: 'Bloquear' }))

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    const call = h.rpcCalls.find((c) => c.name === 'set_player_blocked')
    expect(call).toBeTruthy()
    expect(call!.args).toMatchObject({ p_player_id: 'p-nor', p_blocked: true })
    confirmSpy.mockRestore()
  })

  it('does not call set_player_blocked when the block confirm is cancelled', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    setRoster()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Jugadores' }))
    await screen.findByTestId('players-roster')

    await user.click(screen.getByRole('button', { name: 'Bloquear' }))

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(h.rpcCalls.find((c) => c.name === 'set_player_blocked')).toBeFalsy()
    confirmSpy.mockRestore()
  })

  it('unblocks without a confirm dialog', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    setRoster()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Jugadores' }))
    await screen.findByTestId('players-roster')

    await user.click(screen.getByRole('button', { name: 'Desbloquear' }))

    expect(confirmSpy).not.toHaveBeenCalled()
    const call = h.rpcCalls.find((c) => c.name === 'set_player_blocked')
    expect(call!.args).toMatchObject({ p_player_id: 'p-blk', p_blocked: false })
    confirmSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Phase 3 — Agregar invitado (guest on a fecha) + the "Invitado" tag.
// ---------------------------------------------------------------------------
describe('Admin — Agregar invitado (guest, Phase 3)', () => {
  it('opens the sheet and calls add_guest_entry with the name + live tournament id', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await screen.findAllByTestId('admin-prow')

    await user.click(screen.getByTestId('add-guest-btn'))
    const dialog = await screen.findByRole('dialog', { name: 'Agregar invitado' })
    await user.type(within(dialog).getByLabelText('Nombre'), 'Fulano')
    await user.click(within(dialog).getByRole('button', { name: 'Agregar invitado' }))

    const call = h.rpcCalls.find((c) => c.name === 'add_guest_entry')
    expect(call).toBeTruthy()
    expect(call!.args).toMatchObject({ p_name: 'Fulano', p_tournament_id: 't-live' })
  })

  it('tags a guest entry with an "Invitado" badge in the player list', async () => {
    h.list.entry = {
      data: [
        {
          id: 'e-guest',
          player_id: 'p-guest',
          status: 'checked_in',
          paid: false,
          chips: 10_000,
          rebuys_count: 0,
          early_bird: false,
          final_position: null,
          player: { name: 'Invitado X', avatar_url: null, is_guest: true },
        },
        {
          id: 'e-real',
          player_id: 'p-real',
          status: 'playing',
          paid: true,
          chips: 20_000,
          rebuys_count: 0,
          early_bird: false,
          final_position: null,
          player: { name: 'Real Y', avatar_url: null, is_guest: false },
        },
      ],
      error: null,
    }
    renderAdmin()
    await screen.findAllByTestId('admin-prow')

    const tags = screen.getAllByTestId('guest-tag')
    expect(tags).toHaveLength(1)
    expect(tags[0]).toHaveTextContent('Invitado')
  })
})

describe('Admin — Jugadores: hacer miembro a un invitado (mig 0035)', () => {
  function setRosterWithGuest() {
    h.authPlayer = { id: 'p-self', is_admin: true }
    h.list.player = {
      data: [
        { id: 'p-self', name: 'Yo Admin', email: 'self@ex.com', is_admin: true, is_guest: false, blocked: false },
        { id: 'p-gst', name: 'Primo Pepe', email: 'primo@example.com', is_admin: false, is_guest: true, blocked: false },
      ],
      error: null,
    }
  }

  it('guest rows get "Hacer miembro" (no Bloquear); confirming calls promote_guest and reloads', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    setRosterWithGuest()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Jugadores' }))
    await screen.findByTestId('players-roster')

    expect(screen.queryAllByTestId('block-toggle')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Hacer miembro' }))

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    const call = h.rpcCalls.find((c) => c.name === 'promote_guest')
    expect(call).toBeTruthy()
    expect(call!.args).toMatchObject({ p_player_id: 'p-gst' })
    confirmSpy.mockRestore()
  })

  it('dismissing the confirm does nothing', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    setRosterWithGuest()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Jugadores' }))
    await screen.findByTestId('players-roster')
    await user.click(screen.getByRole('button', { name: 'Hacer miembro' }))
    expect(h.rpcCalls.find((c) => c.name === 'promote_guest')).toBeUndefined()
    confirmSpy.mockRestore()
  })
})
