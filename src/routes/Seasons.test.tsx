import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'

// Table-dispatching supabase mock: the seasons list is an awaited builder
// (.select().order() → thenable) resolving to h.list.season.
const h = vi.hoisted(() => ({
  list: {} as Record<string, { data: unknown; error: unknown }>,
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        order: () => b,
        then: (resolve: (v: unknown) => void) =>
          resolve(h.list[table] ?? { data: [], error: null }),
      }
      return b
    },
  },
}))

import Seasons from './Seasons'

// Probe route: renders the resolved :seasonId so a card tap can be asserted.
function SeasonProbe() {
  const { seasonId } = useParams()
  return <div data-testid="season-probe">season:{seasonId}</div>
}

const SEASONS = [
  { id: 's-2024', name: 'Liga 2024', year: 2024, status: 'archived' },
  { id: 's-2026', name: 'Liga 2026', year: 2026, status: 'active' },
  { id: 's-2025', name: 'Liga 2025', year: 2025, status: 'archived' },
]

function renderSeasons() {
  return render(
    <MemoryRouter initialEntries={['/temporadas']}>
      <Routes>
        <Route path="/temporadas" element={<Seasons />} />
        <Route path="/temporadas/:seasonId" element={<SeasonProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  h.list = { season: { data: SEASONS, error: null } }
})

describe('Seasons (Temporadas)', () => {
  it('lists the active season first, then archived (newest year first)', async () => {
    renderSeasons()
    await screen.findByText('Liga 2026')

    const cards = screen.getAllByTestId('season-card')
    expect(cards).toHaveLength(3)
    // Active on top, archived after — each newest-year-first.
    expect(cards.map((c) => c.getAttribute('data-season-id'))).toEqual([
      's-2026', // active
      's-2025', // archived, newest
      's-2024', // archived, oldest
    ])
    // The active card carries the "Activa" badge; the rest "Archivada".
    expect(cards[0]!.textContent).toContain('Activa')
    expect(cards[1]!.textContent).toContain('Archivada')
  })

  it('tapping a card routes to that season’s Tabla (/temporadas/:seasonId)', async () => {
    const user = userEvent.setup()
    renderSeasons()
    await screen.findByText('Liga 2025')

    const archived = screen
      .getAllByTestId('season-card')
      .find((c) => c.getAttribute('data-season-id') === 's-2025')!
    await user.click(archived)

    expect(await screen.findByTestId('season-probe')).toHaveTextContent('season:s-2025')
  })

  it('shows an empty message when there are no seasons', async () => {
    h.list = { season: { data: [], error: null } }
    renderSeasons()

    expect(await screen.findByText(/aún no hay temporadas/i)).toBeInTheDocument()
    expect(screen.queryAllByTestId('season-card')).toHaveLength(0)
  })
})
