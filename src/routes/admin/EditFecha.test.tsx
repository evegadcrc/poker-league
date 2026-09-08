import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// /fechas/:id/editar — the admin edit page for a SCHEDULED fecha. The supabase
// mock serves the tournament row (maybeSingle) + blind structures (list) and
// captures the direct .update() payload; awaiting the update chain resolves
// h.list.tournament so tests can simulate "0 rows matched" (fecha no longer
// scheduled at save time).
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  single: {} as Record<string, { data: unknown; error: unknown }>,
  list: {} as Record<string, { data: unknown; error: unknown }>,
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        is: () => b,
        order: () => b,
        update: (payload: Record<string, unknown>) => {
          h.updates.push({ table, payload })
          return b
        },
        maybeSingle: () => Promise.resolve(h.single[table] ?? { data: null, error: null }),
        then: (resolve: (v: unknown) => void) =>
          resolve(h.list[table] ?? { data: [], error: null }),
      }
      return b
    },
  },
}))

import EditFecha from './EditFecha'

// Local 2026-09-20 19:30 — the form shows local date/time, so build it locally.
const SCHEDULED = new Date(2026, 8, 20, 19, 30)

function setTournament(over: Record<string, unknown> = {}) {
  h.single.tournament = {
    data: {
      id: 't-1',
      name: 'Fecha 9',
      scheduled_at: SCHEDULED.toISOString(),
      status: 'scheduled',
      cancelled_at: null,
      venue_lat: 9.9333,
      venue_lng: -84.0833,
      geofence_radius_m: 150,
      buy_in: 20000,
      rebuy_amount: 20000,
      rebuy_until_level: 6,
      starting_stack: 10000,
      ante_enabled: false,
      blind_structure_id: 'bs-2',
      payout_distribution: [
        { place: 1, pct: 0.5 },
        { place: 2, pct: 0.3 },
        { place: 3, pct: 0.2 },
      ],
      counts_for_league: true,
      odds_enabled: false,
      guests_open: true,
      ...over,
    },
    error: null,
  }
}

const renderEdit = () =>
  render(
    <MemoryRouter initialEntries={['/fechas/t-1/editar']}>
      <Routes>
        <Route path="/fechas/:id/editar" element={<EditFecha />} />
        <Route path="/fechas/:id" element={<div>DETALLE FECHA</div>} />
      </Routes>
    </MemoryRouter>,
  )

const lastUpdate = () => h.updates.filter((u) => u.table === 'tournament').at(-1)?.payload

beforeEach(() => {
  h.updates = []
  h.single = {}
  h.list = {
    blind_structure: {
      data: [
        { id: 'bs-1', name: 'Estándar 15 min' },
        { id: 'bs-2', name: 'Turbo 10 min' },
      ],
      error: null,
    },
    // The UPDATE … select('id') result: 1 row matched by default.
    tournament: { data: [{ id: 't-1' }], error: null },
  }
  localStorage.clear()
  setTournament()
})

describe('EditFecha — seeding from the stored row', () => {
  it('shows the fecha name as the heading and seeds every field from the row', async () => {
    renderEdit()
    await screen.findByTestId('edit-fecha')

    expect(screen.getByRole('heading', { name: 'Fecha 9' })).toBeInTheDocument()
    expect(screen.getByLabelText('Nombre de la fecha')).toHaveValue('Fecha 9')
    expect(screen.getByLabelText('Fecha y hora')).toHaveValue('2026-09-20')
    expect(screen.getByLabelText('Hora')).toHaveValue('19:30')
    // Geofence: stored numerics → the raw input strings.
    expect(screen.getByPlaceholderText('Latitud')).toHaveValue('9.9333')
    expect(screen.getByPlaceholderText('Longitud')).toHaveValue('-84.0833')
    expect(screen.getByLabelText('Radio de check-in (m)')).toHaveValue('150')
    // Money with es-CR thousands separators.
    expect(screen.getByLabelText('Buy-in / Recompra (₡)')).toHaveValue('20.000')
    expect(screen.getByLabelText('Recompra')).toHaveValue('20.000')
    expect(screen.getByLabelText('Stack inicial / Bonus stack')).toHaveValue('10.000')
    expect(screen.getByLabelText('Recompra permitida hasta')).toHaveValue('6')
    expect(screen.getByLabelText('Estructura de blinds')).toHaveValue('bs-2')
    // Toggles reflect the row (odds OFF here).
    expect(screen.getByRole('switch', { name: 'Usar ante' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch', { name: 'Cuenta para la liga' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(
      screen.getByRole('switch', { name: 'Permitir calculadora de probabilidades' }),
    ).toHaveAttribute('aria-checked', 'false')
    expect(
      screen.getByRole('switch', { name: 'Invitados pueden unirse con el enlace' }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeInTheDocument()
  })

  it('surfaces a stored rebuy cutoff that is not one of the presets instead of silently changing it', async () => {
    setTournament({ rebuy_until_level: 5 })
    renderEdit()
    await screen.findByTestId('edit-fecha')
    expect(screen.getByLabelText('Recompra permitida hasta')).toHaveValue('5')
    expect(screen.getByRole('option', { name: 'Nivel 5' })).toBeInTheDocument()
  })

  it('shows a blank venue when the row has no geofence', async () => {
    setTournament({ venue_lat: null, venue_lng: null })
    renderEdit()
    await screen.findByTestId('edit-fecha')
    expect(screen.getByPlaceholderText('Latitud')).toHaveValue('')
    expect(screen.getByPlaceholderText('Longitud')).toHaveValue('')
  })
})

describe('EditFecha — saving', () => {
  it('writes the edited geofence (+ every other field) via a status-guarded tournament update, then returns to the fecha', async () => {
    const user = userEvent.setup()
    renderEdit()
    await screen.findByTestId('edit-fecha')

    const lat = screen.getByPlaceholderText('Latitud')
    const lng = screen.getByPlaceholderText('Longitud')
    const radius = screen.getByLabelText('Radio de check-in (m)')
    await user.clear(lat)
    await user.type(lat, '10.001')
    await user.clear(lng)
    await user.type(lng, '-84.25')
    await user.clear(radius)
    await user.type(radius, '250')
    // Flip the calculator back on.
    await user.click(screen.getByRole('switch', { name: 'Permitir calculadora de probabilidades' }))

    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }))

    await waitFor(() => expect(lastUpdate()).toBeTruthy())
    const payload = lastUpdate()!
    expect(payload).toMatchObject({
      name: 'Fecha 9',
      scheduled_at: SCHEDULED.toISOString(),
      venue_lat: 10.001,
      venue_lng: -84.25,
      geofence_radius_m: 250,
      buy_in: 20000,
      rebuy_amount: 20000,
      rebuy_until_level: 6,
      starting_stack: 10000,
      ante_enabled: false,
      blind_structure_id: 'bs-2',
      counts_for_league: true,
      odds_enabled: true,
      guests_open: true,
      payout_distribution: [
        { place: 1, pct: 0.5 },
        { place: 2, pct: 0.3 },
        { place: 3, pct: 0.2 },
      ],
    })
    // Never touches status / timer / results columns.
    expect(payload).not.toHaveProperty('status')
    expect(payload).not.toHaveProperty('prizes')
    expect(payload).not.toHaveProperty('current_level')

    expect(await screen.findByText('DETALLE FECHA')).toBeInTheDocument()
  })

  it('a rescheduled date/time is written as the new scheduled_at', async () => {
    const user = userEvent.setup()
    renderEdit()
    await screen.findByTestId('edit-fecha')

    const date = screen.getByLabelText('Fecha y hora')
    const time = screen.getByLabelText('Hora')
    await user.clear(date)
    await user.type(date, '2026-09-27')
    await user.clear(time)
    await user.type(time, '20:00')
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }))

    await waitFor(() => expect(lastUpdate()).toBeTruthy())
    expect(lastUpdate()!.scheduled_at).toBe(new Date(2026, 8, 27, 20, 0).toISOString())
  })

  it('rejects a half-entered venue (latitude without longitude) and does not write', async () => {
    const user = userEvent.setup()
    renderEdit()
    await screen.findByTestId('edit-fecha')

    await user.clear(screen.getByPlaceholderText('Longitud'))
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Sede incompleta')
    expect(h.updates).toHaveLength(0)
    expect(screen.queryByText('DETALLE FECHA')).not.toBeInTheDocument()
  })

  it('rejects a non-positive check-in radius', async () => {
    const user = userEvent.setup()
    renderEdit()
    await screen.findByTestId('edit-fecha')

    const radius = screen.getByLabelText('Radio de check-in (m)')
    await user.clear(radius)
    await user.type(radius, '0')
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('radio de check-in')
    expect(h.updates).toHaveLength(0)
  })

  it('stays put with a friendly error when the fecha is no longer scheduled at save time (0 rows updated)', async () => {
    const user = userEvent.setup()
    h.list.tournament = { data: [], error: null }
    renderEdit()
    await screen.findByTestId('edit-fecha')

    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('ya no está programada')
    expect(screen.queryByText('DETALLE FECHA')).not.toBeInTheDocument()
  })

  it('shows a save error (and no navigation) when the update fails', async () => {
    const user = userEvent.setup()
    h.list.tournament = { data: null, error: { message: 'boom' } }
    renderEdit()
    await screen.findByTestId('edit-fecha')

    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron guardar')
    expect(screen.queryByText('DETALLE FECHA')).not.toBeInTheDocument()
  })
})

describe('EditFecha — locked / missing fechas', () => {
  it('a LIVE fecha shows the locked note instead of the form', async () => {
    setTournament({ status: 'live' })
    renderEdit()
    expect(await screen.findByTestId('edit-fecha-locked')).toHaveTextContent('está en vivo')
    expect(screen.queryByTestId('edit-fecha')).not.toBeInTheDocument()
  })

  it('a COMPLETED fecha shows the locked note', async () => {
    setTournament({ status: 'completed' })
    renderEdit()
    expect(await screen.findByTestId('edit-fecha-locked')).toHaveTextContent('ya se jugó')
  })

  it('a CANCELLED fecha shows the locked note', async () => {
    setTournament({ cancelled_at: new Date().toISOString() })
    renderEdit()
    expect(await screen.findByTestId('edit-fecha-locked')).toHaveTextContent('fue cancelada')
  })

  it('an unknown id shows the not-found note', async () => {
    h.single.tournament = { data: null, error: null }
    renderEdit()
    expect(await screen.findByText('Esta fecha no existe.')).toBeInTheDocument()
  })

  it('the back link returns to the fecha detail', async () => {
    const user = userEvent.setup()
    renderEdit()
    await screen.findByTestId('edit-fecha')
    await user.click(screen.getByRole('button', { name: '← Fecha' }))
    expect(await screen.findByText('DETALLE FECHA')).toBeInTheDocument()
  })
})
