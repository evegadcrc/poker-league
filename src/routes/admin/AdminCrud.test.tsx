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
    expect(payload.buy_in).toBe(20000)
    expect(payload.starting_stack).toBe(10000)
    expect(payload.rebuy_until_level).toBe(6)
    expect(payload.ante_enabled).toBe(true)
    expect(payload.blind_structure_id).toBe('bs-1')
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
