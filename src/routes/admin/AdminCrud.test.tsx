import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mutable state: tests set the `from()` responses + per-RPC results and
// inspect the captured RPC calls to assert the CreateFecha / LeagueSettings
// panels wired create_tournament / update_season_config / close_season.
const h = vi.hoisted(() => ({
  single: {} as Record<string, { data: unknown; error: unknown }>,
  list: {} as Record<string, { data: unknown; error: unknown }>,
  rpcResults: {} as Record<string, { data: unknown; error: unknown }>,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  updates: [] as Array<{ table: string; payload: unknown }>,
}))

vi.mock('@/lib/auth', () => ({
  useRole: () => ({ isAdmin: true }),
  useAuth: () => ({ player: null }),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: () => b,
        order: () => b,
        limit: () => b,
        update: (payload: unknown) => {
          h.updates.push({ table, payload })
          return b
        },
        maybeSingle: () => Promise.resolve(h.single[table] ?? { data: null, error: null }),
        single: () => Promise.resolve(h.single[table] ?? { data: null, error: null }),
        then: (resolve: (v: unknown) => void) => resolve(h.list[table] ?? { data: [], error: null }),
      }
      return b
    },
    rpc: (name: string, args: unknown) => {
      h.rpcCalls.push({ name, args })
      if (name === 'fn_pot') return Promise.resolve({ data: 0, error: null })
      return Promise.resolve(h.rpcResults[name] ?? { data: [], error: null })
    },
    channel: () => {
      const chan: Record<string, unknown> = { on: () => chan, subscribe: () => chan }
      return chan
    },
    removeChannel: () => Promise.resolve(),
  },
}))

import Admin from '@/routes/Admin'

const SEASON = {
  id: 's-2026',
  name: 'Liga 2026',
  year: 2026,
  points_multiplier: 10,
  bonus_final_table: 5,
  bonus_top3: 8,
  bonus_attendance: 2,
  no_show_penalty: -15,
  early_bird_bonus_chips: 2000,
  final_table_size_override: null,
  payout_template: [0.6, 0.28, 0.12],
  cancel_bands: [
    { hours_before: 24, penalty: 0 },
    { hours_before: 12, penalty: -5 },
    { hours_before: 6, penalty: -10 },
    { hours_before: 0, penalty: -15 },
  ],
}

const renderAdmin = () => render(<Admin />, { wrapper: MemoryRouter })
const rpc = (name: string) => h.rpcCalls.find((c) => c.name === name)

beforeEach(() => {
  h.single = { season: { data: SEASON, error: null } }
  h.list = { blind_structure: { data: [{ id: 'bs-1', name: 'Estándar 15 min' }], error: null } }
  h.rpcResults = {
    create_tournament: { data: [{ id: 't-new' }], error: null },
    update_season_config: { data: [SEASON], error: null },
    close_season: { data: [{ ...SEASON, id: 's-2027', name: 'Liga 2027', year: 2027 }], error: null },
  }
  h.rpcCalls = []
  h.updates = []
  // CreateFecha seeds its money defaults from localStorage (pf-fecha-defaults);
  // clear it so each test starts from the hardcoded defaults.
  localStorage.clear()
})

describe('Admin · Nueva fecha (slice 13)', () => {
  it('submits the create-fecha form and calls create_tournament with the field values', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Nueva fecha' }))
    await screen.findByTestId('create-fecha')

    await user.type(screen.getByLabelText('Nombre de la fecha'), 'Fecha 10 — Casa de José')
    // flip the ante toggle on.
    await user.click(screen.getByRole('switch', { name: 'Usar ante' }))

    await user.click(screen.getByRole('button', { name: 'Crear fecha' }))

    await waitFor(() => expect(rpc('create_tournament')).toBeTruthy())
    const payload = (rpc('create_tournament')!.args as { p_payload: Record<string, unknown> })
      .p_payload
    expect(payload.name).toBe('Fecha 10 — Casa de José')
    expect(payload.geofence_radius_m).toBe(100)
    // New defaults (CHANGE 9): buy-in 10.000, stack inicial 20.000, recompra hasta N8.
    expect(payload.buy_in).toBe(10000)
    expect(payload.starting_stack).toBe(20000)
    expect(payload.rebuy_until_level).toBe(8)
    expect(payload.ante_enabled).toBe(true)
    expect(payload.blind_structure_id).toBe('bs-1')
  })

  it('displays money inputs with es-CR thousand separators but submits the raw integer', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Nueva fecha' }))
    await screen.findByTestId('create-fecha')

    const buyIn = screen.getByLabelText('Buy-in / Recompra (₡)')
    // Default seeds to 10.000 (formatted).
    expect(buyIn).toHaveValue('10.000')

    await user.clear(buyIn)
    await user.type(buyIn, '25000')
    // Formatted display while typing.
    expect(buyIn).toHaveValue('25.000')

    await user.click(screen.getByRole('button', { name: 'Crear fecha' }))
    await waitFor(() => expect(rpc('create_tournament')).toBeTruthy())
    const payload = (rpc('create_tournament')!.args as { p_payload: Record<string, unknown> })
      .p_payload
    // Persisted value is the raw integer, not the formatted string.
    expect(payload.buy_in).toBe(25000)
  })

  it('"Guardar ajustes" persists the current money values to localStorage as defaults', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Nueva fecha' }))
    await screen.findByTestId('create-fecha')

    const buyIn = screen.getByLabelText('Buy-in / Recompra (₡)')
    await user.clear(buyIn)
    await user.type(buyIn, '30000')
    await user.click(screen.getByRole('button', { name: 'Guardar ajustes' }))

    expect(await screen.findByText('✓ Guardado como predeterminado')).toBeInTheDocument()
    const stored = JSON.parse(localStorage.getItem('pf-fecha-defaults') ?? '{}')
    expect(stored.buyIn).toBe(30000)
    expect(stored.startingStack).toBe(20000)
    expect(stored.rebuyUntil).toBe(8)
  })

  it('shows a ₡ adornment on the colón money inputs (buy-in / rebuy)', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Nueva fecha' }))
    await screen.findByTestId('create-fecha')

    // The buy-in and rebuy inputs are wrapped in a .money-input adornment that
    // renders the ₡ symbol (display only — the submitted value stays the bare
    // number, verified by the create_tournament payload test above).
    expect(screen.getByLabelText('Buy-in / Recompra (₡)').closest('.money-input')).toHaveAttribute(
      'data-symbol',
      '₡',
    )
    expect(screen.getByLabelText('Recompra').closest('.money-input')).toHaveAttribute(
      'data-symbol',
      '₡',
    )
  })

  it('captures manual venue coordinates into the payload', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Nueva fecha' }))
    await screen.findByTestId('create-fecha')

    await user.type(screen.getByPlaceholderText('Latitud'), '9.9281')
    await user.type(screen.getByPlaceholderText('Longitud'), '-84.0907')
    await user.click(screen.getByRole('button', { name: 'Crear fecha' }))

    await waitFor(() => expect(rpc('create_tournament')).toBeTruthy())
    const payload = (rpc('create_tournament')!.args as { p_payload: Record<string, unknown> })
      .p_payload
    expect(payload.venue_lat).toBe(9.9281)
    expect(payload.venue_lng).toBe(-84.0907)
  })

  it('seeds the prize-distribution editor from the season template and persists it on create', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Nueva fecha' }))
    await screen.findByTestId('create-fecha')

    // Seeded from season.payout_template [0.6, 0.28, 0.12] → 60 / 28 / 12, sum 100%.
    const editor = screen.getByTestId('prize-dist-editor')
    expect(within(editor).getAllByRole('textbox')).toHaveLength(3)
    expect(within(editor).getByTestId('dist-sum')).toHaveTextContent('Suma: 100%')

    await user.click(screen.getByRole('button', { name: 'Crear fecha' }))

    await waitFor(() => expect(rpc('create_tournament')).toBeTruthy())
    // After create, the fecha's payout_distribution is persisted via .update().
    await waitFor(() => expect(h.updates.find((u) => u.table === 'tournament')).toBeTruthy())
    const upd = h.updates.find((u) => u.table === 'tournament')!.payload as {
      payout_distribution: Array<{ place: number; pct: number }>
    }
    expect(upd.payout_distribution).toEqual([
      { place: 1, pct: 0.6 },
      { place: 2, pct: 0.28 },
      { place: 3, pct: 0.12 },
    ])
  })
})

describe('Admin · Liga · temporada (slice 13)', () => {
  it('loads the active season config and shows the cancel-bands', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Liga' }))
    await screen.findByTestId('league-settings')

    expect(screen.getByLabelText('Temporada activa')).toHaveValue('Liga 2026')
    expect(screen.getByLabelText('Multiplicador de puntos')).toHaveValue('10')
    const bands = screen.getByTestId('cancel-bands')
    // four graduated bands rendered with their penalties (the <b> values).
    const penalties = Array.from(bands.querySelectorAll('b')).map((n) => n.textContent)
    expect(penalties).toEqual(['0', '-5', '-10', '-15'])
  })

  it('saves settings via update_season_config with the edited fields', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Liga' }))
    await screen.findByTestId('league-settings')

    const mult = screen.getByLabelText('Multiplicador de puntos')
    await user.clear(mult)
    await user.type(mult, '12')
    await user.click(screen.getByRole('button', { name: 'Guardar ajustes' }))

    await waitFor(() => expect(rpc('update_season_config')).toBeTruthy())
    const payload = (rpc('update_season_config')!.args as { p_payload: Record<string, unknown> })
      .p_payload
    expect(payload.points_multiplier).toBe(12)
    expect(payload.payout_template).toEqual([0.6, 0.28, 0.12])
    // success note shown.
    expect(await screen.findByText('✓ Ajustes guardados')).toBeInTheDocument()
  })

  it('the Cerrar-liga confirm modal calls close_season ONLY on confirm', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await user.click(screen.getByRole('tab', { name: 'Liga' }))
    await screen.findByTestId('league-settings')

    // Opening the modal must NOT fire the RPC.
    await user.click(screen.getByRole('button', { name: 'Cerrar liga actual' }))
    const dialog = screen.getByRole('dialog', { name: 'Cerrar liga actual' })
    expect(dialog).toHaveTextContent(/no se puede deshacer/i)
    expect(rpc('close_season')).toBeFalsy()

    // Volver dismisses without firing.
    await user.click(within(dialog).getByRole('button', { name: 'Volver' }))
    expect(rpc('close_season')).toBeFalsy()

    // Reopen and confirm → fires close_season.
    await user.click(screen.getByRole('button', { name: 'Cerrar liga actual' }))
    const dialog2 = screen.getByRole('dialog', { name: 'Cerrar liga actual' })
    await user.click(within(dialog2).getByRole('button', { name: 'Cerrar liga' }))
    await waitFor(() => expect(rpc('close_season')).toBeTruthy())
  })
})
