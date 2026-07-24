import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Table-dispatching supabase mock: list queries (await builder) resolve to
// h.list[table]; single queries (.maybeSingle) resolve to h.single[table].
const h = vi.hoisted(() => ({
  isAdmin: false,
  single: {} as Record<string, { data: unknown; error: unknown }>,
  list: {} as Record<string, { data: unknown; error: unknown }>,
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
        in: () => b,
        order: () => b,
        maybeSingle: () => Promise.resolve(h.single[table] ?? { data: null, error: null }),
        single: () => Promise.resolve(h.single[table] ?? { data: null, error: null }),
        then: (resolve: (v: unknown) => void) =>
          resolve(h.list[table] ?? { data: [], error: null }),
      }
      return b
    },
  },
}))

import Fechas from './Fechas'

const soon = new Date(Date.now() + 7 * 86_400_000).toISOString()

const TOURNAMENTS = [
  {
    id: 't-sch',
    name: 'Fecha 9',
    scheduled_at: soon,
    status: 'scheduled',
    buy_in: 20000,
    rebuy_amount: 20000,
    prize_pool_override: null,
  },
  {
    id: 't-live',
    name: 'Fecha 8',
    scheduled_at: new Date().toISOString(),
    status: 'live',
    buy_in: 20000,
    rebuy_amount: 20000,
    prize_pool_override: null,
  },
  {
    id: 't-done',
    name: 'Fecha 7',
    scheduled_at: new Date(Date.now() - 14 * 86_400_000).toISOString(),
    status: 'completed',
    buy_in: 20000,
    rebuy_amount: 20000,
    prize_pool_override: null,
  },
]

const ENTRIES = [
  // scheduled: 2 confirmed, 1 invited, 1 declined
  { tournament_id: 't-sch', status: 'confirmed', paid: false, rebuys_count: 0, final_position: null, player: { name: 'A' } },
  { tournament_id: 't-sch', status: 'confirmed', paid: false, rebuys_count: 0, final_position: null, player: { name: 'B' } },
  { tournament_id: 't-sch', status: 'invited', paid: false, rebuys_count: 0, final_position: null, player: { name: 'C' } },
  { tournament_id: 't-sch', status: 'declined', paid: false, rebuys_count: 0, final_position: null, player: { name: 'D' } },
  // live: 3 playing + 1 checked_in (alive=4) + 2 eliminated (played=6), all paid → pot 120k
  { tournament_id: 't-live', status: 'playing', paid: true, rebuys_count: 0, final_position: null, player: { name: 'A' } },
  { tournament_id: 't-live', status: 'playing', paid: true, rebuys_count: 0, final_position: null, player: { name: 'B' } },
  { tournament_id: 't-live', status: 'playing', paid: true, rebuys_count: 0, final_position: null, player: { name: 'E' } },
  { tournament_id: 't-live', status: 'checked_in', paid: true, rebuys_count: 0, final_position: null, player: { name: 'F' } },
  { tournament_id: 't-live', status: 'eliminated', paid: true, rebuys_count: 0, final_position: 6, player: { name: 'G' } },
  { tournament_id: 't-live', status: 'eliminated', paid: true, rebuys_count: 0, final_position: 5, player: { name: 'H' } },
  // completed: winner + 4 eliminated (played=5), all paid → pot 100k
  { tournament_id: 't-done', status: 'winner', paid: true, rebuys_count: 0, final_position: 1, player: { name: 'Mauricio A.' } },
  { tournament_id: 't-done', status: 'eliminated', paid: true, rebuys_count: 0, final_position: 2, player: { name: 'I' } },
  { tournament_id: 't-done', status: 'eliminated', paid: true, rebuys_count: 0, final_position: 3, player: { name: 'J' } },
  { tournament_id: 't-done', status: 'eliminated', paid: true, rebuys_count: 0, final_position: 4, player: { name: 'K' } },
  { tournament_id: 't-done', status: 'eliminated', paid: true, rebuys_count: 0, final_position: 5, player: { name: 'L' } },
]

const renderFechas = () =>
  render(
    <MemoryRouter>
      <Fechas />
    </MemoryRouter>,
  )

beforeEach(() => {
  h.isAdmin = false
  h.single = { season: { data: { id: 's1' }, error: null } }
  h.list = {
    tournament: { data: TOURNAMENTS, error: null },
    entry: { data: ENTRIES, error: null },
  }
})

describe('Fechas list', () => {
  it('renders a card per tournament, sorted live → scheduled → completed', async () => {
    renderFechas()
    await screen.findByText('Fecha 8')
    const cards = screen.getAllByTestId('tourn-card')
    expect(cards).toHaveLength(3)
    expect(within(cards[0]!).getByText('Fecha 8')).toBeInTheDocument() // live first
    expect(within(cards[1]!).getByText('Fecha 9')).toBeInTheDocument() // scheduled
    expect(within(cards[2]!).getByText('Fecha 7')).toBeInTheDocument() // completed
  })

  it('orders two cards in the same status group chronologically (by scheduled_at, not the display string)', async () => {
    // Two scheduled fechas. Aug 7 ("Vie 7 ago") precedes Aug 23 ("Dom 23 ago")
    // chronologically, but a localeCompare on the display string sorts "Dom…"
    // before "Vie…" — the exact bug. Correct order = soonest first: Aug 7, Aug 23.
    h.list = {
      tournament: {
        data: [
          {
            id: 't-late',
            name: 'Fecha Tardía',
            scheduled_at: '2026-08-23T19:00:00Z',
            status: 'scheduled',
            buy_in: 20000,
            rebuy_amount: 20000,
            prize_pool_override: null,
          },
          {
            id: 't-soon',
            name: 'Fecha Pronta',
            scheduled_at: '2026-08-07T19:00:00Z',
            status: 'scheduled',
            buy_in: 20000,
            rebuy_amount: 20000,
            prize_pool_override: null,
          },
        ],
        error: null,
      },
      entry: { data: [], error: null },
    }
    renderFechas()
    await screen.findByText('Fecha Pronta')
    const cards = screen.getAllByTestId('tourn-card')
    expect(cards).toHaveLength(2)
    expect(within(cards[0]!).getByText('Fecha Pronta')).toBeInTheDocument() // Aug 7 soonest
    expect(within(cards[1]!).getByText('Fecha Tardía')).toBeInTheDocument() // Aug 23 later
  })

  it('renders the status badges (Live / Próxima / Jugada)', async () => {
    renderFechas()
    await screen.findByText('Fecha 8')
    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(screen.getByText('Próxima')).toBeInTheDocument()
    expect(screen.getByText('Jugada')).toBeInTheDocument()
  })

  it('shows the scheduled footer: Confirmados / Sin resp. / Buy-in', async () => {
    renderFechas()
    const card = within(await findCard('Fecha 9'))
    expect(card.getByText('Confirmados')).toBeInTheDocument()
    expect(card.getByText('Sin resp.')).toBeInTheDocument()
    expect(card.getByText('Buy-in')).toBeInTheDocument()
    expect(card.getByText('2')).toBeInTheDocument() // confirmados
    expect(card.getByText('1')).toBeInTheDocument() // sin resp.
    expect(card.getByText('₡20K')).toBeInTheDocument()
  })

  it('shows the live footer: Quedan (alive/played) / Pozo / Entrar', async () => {
    renderFechas()
    const card = within(await findCard('Fecha 8'))
    expect(card.getByText('Quedan')).toBeInTheDocument()
    expect(card.getByText('4/6')).toBeInTheDocument()
    expect(card.getByText('Pozo')).toBeInTheDocument()
    expect(card.getByText('₡120K')).toBeInTheDocument()
    expect(card.getByText('Entrar')).toBeInTheDocument()
  })

  it('shows the completed footer: Campeón / Jugadores / Pozo', async () => {
    renderFechas()
    const card = within(await findCard('Fecha 7'))
    expect(card.getByText('Campeón')).toBeInTheDocument()
    expect(card.getByText('Mauricio A.')).toBeInTheDocument()
    expect(card.getByText('Jugadores')).toBeInTheDocument()
    expect(card.getByText('5')).toBeInTheDocument()
    expect(card.getByText('₡100K')).toBeInTheDocument()
  })

  it('renders a completed fecha as a full-bleed cover card using cover_url', async () => {
    h.list = {
      tournament: {
        data: [
          {
            id: 't-cover',
            name: 'Fecha Portada',
            scheduled_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
            status: 'completed',
            buy_in: 20000,
            rebuy_amount: null,
            prize_pool_override: null,
            cover_url: 'https://cdn.test/gallery/cover.jpg',
          },
        ],
        error: null,
      },
      entry: { data: [], error: null },
    }
    renderFechas()
    await screen.findByText('Fecha Portada')
    const media = screen.getByTestId('cover-media')
    expect(media).toHaveAttribute('data-cover', 'image')
    expect(media.getAttribute('style') ?? '').toContain('https://cdn.test/gallery/cover.jpg')
  })

  it('falls back to a themed gradient when a completed fecha has no cover_url', async () => {
    h.list = {
      tournament: {
        data: [
          {
            id: 't-nocover',
            name: 'Fecha Sin Portada',
            scheduled_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
            status: 'completed',
            buy_in: 20000,
            rebuy_amount: null,
            prize_pool_override: null,
            cover_url: null,
          },
        ],
        error: null,
      },
      entry: { data: [], error: null },
    }
    renderFechas()
    await screen.findByText('Fecha Sin Portada')
    const media = screen.getByTestId('cover-media')
    expect(media).toHaveAttribute('data-cover', 'fallback')
    expect(media.className).toContain('fallback')
    // No inline background-image → the CSS gradient (.cover-media.fallback) applies.
    expect(media.getAttribute('style')).toBeNull()
  })

  it('shows the admin "+ Nueva fecha" affordance only for admins', async () => {
    const { unmount } = renderFechas()
    await screen.findByText('Fecha 8')
    expect(screen.queryByRole('link', { name: /nueva fecha/i })).not.toBeInTheDocument()
    unmount()

    h.isAdmin = true
    renderFechas()
    await screen.findByText('Fecha 8')
    expect(screen.getByRole('link', { name: /nueva fecha/i })).toBeInTheDocument()
  })
})

async function findCard(name: string): Promise<HTMLElement> {
  const title = await screen.findByText(name)
  const card = title.closest('[data-testid="tourn-card"]')
  if (!card) throw new Error(`card for ${name} not found`)
  return card as HTMLElement
}
