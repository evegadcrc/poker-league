import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

// Mutable, hoisted so the vi.mock factories can close over it. Tests set the
// season / RPC results and the current player before rendering.
const h = vi.hoisted(() => ({
  pending: false,
  seasonResult: { data: null as unknown, error: null as unknown },
  rpcResult: { data: null as unknown, error: null as unknown },
  player: null as { id: string } | null,
}))

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ player: h.player }),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () =>
          h.pending ? new Promise(() => {}) : Promise.resolve(h.seasonResult),
      }
      return builder
    },
    rpc: () => (h.pending ? new Promise(() => {}) : Promise.resolve(h.rpcResult)),
  },
}))

// Imported after the mocks are declared.
import Leaderboard from './Leaderboard'

type Row = {
  player_id: string
  player_name: string
  avatar_url: string | null
  total_points: number
  games_played: number
  wins: number
  podiums: number
  form: string[]
}

const ACTIVE_SEASON = { id: 'season-1', name: 'Liga 2026', year: 2026 }

// RPC order = ranked order. `form` is MOST-RECENT-FIRST (index 0 = latest game).
const FIXTURE: Row[] = [
  {
    player_id: 'p-mau',
    player_name: 'Mauricio A.',
    avatar_url: null,
    total_points: 420,
    games_played: 8,
    wins: 3,
    podiums: 5,
    // latest→oldest: champion, podium, final, out, out
    form: ['champion', 'podium', 'final', 'out', 'out'],
  },
  {
    player_id: 'p-edw',
    player_name: 'Edwin V.',
    avatar_url: null,
    total_points: 350,
    games_played: 7,
    wins: 1,
    podiums: 3,
    form: ['podium', 'out', 'champion', 'final', 'podium'],
  },
  {
    player_id: 'p-ran',
    player_name: 'Randall Q.',
    avatar_url: null,
    total_points: 160,
    games_played: 6,
    wins: 0,
    podiums: 0,
    form: ['out', 'final', 'out', 'out', 'out'],
  },
]

function tierClasses(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll('.pill')).map(
    (el) => Array.from(el.classList).find((c) => c !== 'pill') ?? '',
  )
}

beforeEach(() => {
  h.pending = false
  h.seasonResult = { data: ACTIVE_SEASON, error: null }
  h.rpcResult = { data: FIXTURE, error: null }
  h.player = { id: 'p-edw' } // Edwin is the signed-in player.
})

describe('Leaderboard (Tabla)', () => {
  it('renders rows in the RPC order returned by the leaderboard function', async () => {
    render(<Leaderboard />)
    await screen.findByText('Mauricio A.')

    const names = screen
      .getAllByTestId('lb-row')
      .map((row) => within(row).getByText(/[A-Z]\./).textContent)

    expect(names).toEqual(['Mauricio A.', 'Edwin V. · tú', 'Randall Q.'])
  })

  it('renders the form pills newest-on-the-RIGHT (RPC array reversed) with correct tier classes', async () => {
    render(<Leaderboard />)
    await screen.findByText('Mauricio A.')

    const mauricioRow = screen.getAllByTestId('lb-row')[0]!
    // RPC (latest→oldest): champion, podium, final, out, out
    // Rendered left→right (oldest→newest): out, out, final, podio, champ
    expect(tierClasses(mauricioRow)).toEqual(['out', 'out', 'final', 'podio', 'champ'])

    const pills = mauricioRow.querySelectorAll('.pill')
    // Newest game (RPC index 0 = 'champion') must be the RIGHTMOST pill.
    expect(pills[pills.length - 1]!.classList.contains('champ')).toBe(true)
    // Oldest game (RPC last = 'out') is the leftmost pill.
    expect(pills[0]!.classList.contains('out')).toBe(true)
  })

  it("highlights the current player's row and appends '· tú'", async () => {
    render(<Leaderboard />)
    await screen.findByText('Mauricio A.')

    const highlighted = document.querySelector('.lb-row.you')
    expect(highlighted).not.toBeNull()
    expect(highlighted!.textContent).toContain('Edwin V.')
    expect(highlighted!.textContent).toContain('· tú')

    // Only the current player's row is highlighted.
    expect(document.querySelectorAll('.lb-row.you')).toHaveLength(1)
    const mauricioRow = screen.getAllByTestId('lb-row')[0]!
    expect(mauricioRow.classList.contains('you')).toBe(false)
  })

  it('shows the PJ / Tít / Pts stats and the fechas count', async () => {
    render(<Leaderboard />)
    await screen.findByText('Mauricio A.')

    const mauricioRow = screen.getAllByTestId('lb-row')[0]!
    expect(within(mauricioRow).getByText('8')).toBeInTheDocument() // PJ
    expect(within(mauricioRow).getByText('3')).toBeInTheDocument() // Tít
    expect(within(mauricioRow).getByText('420')).toBeInTheDocument() // Pts

    // max(games_played) = 8 → "8 fechas"
    expect(screen.getByText('8 fechas')).toBeInTheDocument()
  })

  it('shows skeleton rows while loading', () => {
    h.pending = true
    const { container } = render(<Leaderboard />)

    expect(container.querySelectorAll('.skeleton-row')).toHaveLength(6)
    expect(screen.queryByText('Mauricio A.')).not.toBeInTheDocument()
  })

  it('shows an empty-roster message when the RPC returns no players', async () => {
    h.rpcResult = { data: [], error: null }
    render(<Leaderboard />)

    expect(await screen.findByText(/no hay jugadores en el roster/i)).toBeInTheDocument()
    expect(screen.queryAllByTestId('lb-row')).toHaveLength(0)
  })

  it('shows a no-season message when there is no active season', async () => {
    h.seasonResult = { data: null, error: null }
    render(<Leaderboard />)

    expect(await screen.findByText(/no hay una temporada activa/i)).toBeInTheDocument()
  })

  it('renders the roster at 0 pts for a brand-new season', async () => {
    h.rpcResult = {
      data: [
        {
          player_id: 'p-new',
          player_name: 'Nuevo Jugador',
          avatar_url: null,
          total_points: 0,
          games_played: 0,
          wins: 0,
          podiums: 0,
          form: [],
        },
      ],
      error: null,
    }
    render(<Leaderboard />)
    await screen.findByText('Nuevo Jugador')

    const row = screen.getAllByTestId('lb-row')[0]!
    // PJ / Tít / Pts all read 0 for a player with no completed games.
    expect(within(row).getAllByText('0')).toHaveLength(3)
    expect(row.querySelector('.stat.pts .v')?.textContent).toBe('0')
    // No completed games → no form pills.
    expect(row.querySelectorAll('.pill')).toHaveLength(0)
  })
})
