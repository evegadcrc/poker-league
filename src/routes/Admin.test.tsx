import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mutable state so the vi.mock factory can close over it. Tests set the
// live tournament / levels / entries / season, and inspect the captured RPC
// calls to assert the console wired the right RPCs.
const h = vi.hoisted(() => ({
  single: {} as Record<string, { data: unknown; error: unknown }>,
  list: {} as Record<string, { data: unknown; error: unknown }>,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
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
      if (name === 'fn_pot') return Promise.resolve({ data: 140_000, error: null })
      return Promise.resolve({ data: [], error: null })
    },
    channel: () => {
      const chan: Record<string, unknown> = {
        on: () => chan,
        subscribe: () => chan,
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
    data: { points_multiplier: 10, bonus_final_table: 5, bonus_top3: 8, bonus_attendance: 2 },
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
  h.single = {}
  h.list = {}
  h.rpcCalls = []
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
