import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

// Hoisted mutable state: the active-season load, the close_season RPC result,
// and a spy for the post-close navigation.
const h = vi.hoisted(() => ({
  single: {} as Record<string, { data: unknown; error: unknown }>,
  rpcResults: {} as Record<string, { data: unknown; error: unknown }>,
  navigate: vi.fn(),
}))

// Mock only useNavigate; keep the rest of react-router-dom real.
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => h.navigate,
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
      }
      return b
    },
    rpc: (name: string) => Promise.resolve(h.rpcResults[name] ?? { data: [], error: null }),
  },
}))

import LeagueSettings from './LeagueSettings'

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
    { hours_before: 0, penalty: -15 },
  ],
}

const renderSettings = () => render(<LeagueSettings />, { wrapper: MemoryRouter })

beforeEach(() => {
  h.single = { season: { data: SEASON, error: null } }
  h.rpcResults = {
    // close_season returns the NEW active season row.
    close_season: { data: [{ ...SEASON, id: 's-2027', name: 'Liga 2027', year: 2027 }], error: null },
  }
  h.navigate = vi.fn()
})

describe('LeagueSettings · close_season navigation', () => {
  it('navigates to the new active season’s Tabla after confirming the close', async () => {
    const user = userEvent.setup()
    renderSettings()
    await screen.findByTestId('league-settings')

    await user.click(screen.getByRole('button', { name: 'Cerrar liga actual' }))
    const dialog = screen.getByRole('dialog', { name: 'Cerrar liga actual' })
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar liga' }))

    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/temporadas/s-2027'))
  })

  it('does not navigate while the confirm modal is merely open (only on confirm)', async () => {
    const user = userEvent.setup()
    renderSettings()
    await screen.findByTestId('league-settings')

    await user.click(screen.getByRole('button', { name: 'Cerrar liga actual' }))
    const dialog = screen.getByRole('dialog', { name: 'Cerrar liga actual' })
    await user.click(within(dialog).getByRole('button', { name: 'Volver' }))

    expect(h.navigate).not.toHaveBeenCalled()
  })
})
