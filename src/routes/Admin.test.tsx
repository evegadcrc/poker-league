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
  // When set, the channel mock invokes subscribe's status callback with it
  // (e.g. 'CHANNEL_ERROR') so the reconnect banner can be exercised.
  channelStatus: undefined as string | undefined,
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

import Admin from './Admin'

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
      final_table_size: 5,
      starting_stack: 10_000,
    },
    error: null,
  }
  h.single.season = {
    data: { name: 'Liga 2026', points_multiplier: 10, bonus_final_table: 5, bonus_top3: 8, bonus_attendance: 2 },
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
  h.channelStatus = undefined
  setLive()
})

describe('Admin console (slice 12)', () => {
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
    // N = 2 placed + 2 choppers = 4 → money (85k+40k)/2 = ₡62 500 ; points (45+35)/2 = 40
    expect(txt.replace(/[\s.,]/g, '')).toContain('62500')
    expect(txt).toContain('40 pts')

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

// Auto-advance FE contract (single writer). The admin client, and only in
// timer_mode='auto', advances the level when the LOCAL clock reaches 0. Uses
// real fixtures (never forces manual mode to dodge the effect).
describe('Admin console — auto-advance (single-writer clock)', () => {
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

  it('fires clock(next_level) exactly once when an auto timer hits 0', async () => {
    setAutoExpired()
    renderAdmin()
    await waitFor(() => expect(nextLevelCalls()).toBe(1))
    // Latched for this level → does not fire again on the reconcile refetch.
    await screen.findAllByTestId('admin-prow')
    expect(nextLevelCalls()).toBe(1)
  })

  it('does NOT auto-advance while the clock is paused', async () => {
    setAutoExpired({ is_paused: true, paused_remaining_seconds: 0 })
    renderAdmin()
    await screen.findAllByTestId('admin-prow')
    expect(nextLevelCalls()).toBe(0)
  })

  it('does NOT auto-advance in manual mode even when expired', async () => {
    setAutoExpired({ timer_mode: 'manual' })
    renderAdmin()
    await screen.findAllByTestId('admin-prow')
    expect(nextLevelCalls()).toBe(0)
  })

  it('a FAILED auto-advance does not permanently stall — it retries on the next tick', async () => {
    setAutoExpired()
    h.rpc.clock = { data: null, error: { message: 'kong-502' } }
    renderAdmin()
    // First attempt fires and fails (toast shown), guard NOT latched.
    await waitFor(() => expect(nextLevelCalls()).toBe(1))
    expect(await screen.findByTestId('admin-toast')).toBeInTheDocument()
    // The per-tick throttle blocks a tight loop within the same second, then the
    // 1s clock tick re-arms the attempt → a second next_level write is issued.
    await waitFor(() => expect(nextLevelCalls()).toBeGreaterThanOrEqual(2), { timeout: 3000 })
  })

  it('does NOT double-fire next_level when the clock RPC is still in flight across a tick', async () => {
    setAutoExpired()
    // Keep the next_level RPC in flight (unresolved) so ~2 one-second ticks elapse
    // while it's pending. The pre-await latch must prevent a second fire (which the
    // increment-based next_level would turn into a skipped level).
    let resolveClock: (v: { data: unknown; error: unknown }) => void = () => {}
    h.rpcImpl.clock = () =>
      new Promise((res) => {
        resolveClock = res
      })
    renderAdmin()
    await waitFor(() => expect(nextLevelCalls()).toBe(1))
    await new Promise((r) => setTimeout(r, 2200)) // ~2 real 1s ticks while in flight
    expect(nextLevelCalls()).toBe(1) // latched before the await → no double-fire
    resolveClock({ data: null, error: null }) // resolve success; stays latched
    await waitFor(() => expect(nextLevelCalls()).toBe(1))
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
