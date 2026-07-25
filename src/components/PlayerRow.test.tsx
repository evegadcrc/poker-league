import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ---------------------------------------------------------------------------
// PlayerRow tap interactions (slice: feat/player-tap-stats). Mocks the supabase
// client so the stats popup's `player_profile` RPC is observable. The avatar tap
// must open the photo lightbox WITHOUT opening (or fetching) the stats popup —
// i.e. stopPropagation works. Tapping the row body opens the popup and fetches
// player_profile with THIS row's player_id. Both paths are keyboard-accessible.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  rpcResult: { data: null as unknown, error: null as unknown },
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args })
      return Promise.resolve(h.rpcResult)
    },
  },
}))

import PlayerRow, { type LeaderboardRow } from './PlayerRow'

const ROW = {
  player_id: 'p-mau',
  player_name: 'Mauricio A.',
  avatar_url: null,
  total_points: 420,
  games_played: 8,
  wins: 3,
  podiums: 5,
  form: ['champion', 'podium', 'final', 'out', 'out'],
  form_positions: [1, 3, 5, 8, 10],
} as unknown as LeaderboardRow

// player_profile returns one row; points_history is Json (array) in the schema.
const PROFILE_ROW = {
  player_id: 'p-mau',
  player_name: 'Mauricio A.',
  avatar_url: null,
  total_points: 420,
  games_played: 8,
  wins: 3,
  podiums: 5,
  points_history: [
    { scheduled_at: '2026-05-01T00:00:00Z', points: 100, cumulative: 100 },
    { scheduled_at: '2026-06-01T00:00:00Z', points: 120, cumulative: 220 },
  ],
  form: ['champion', 'podium', 'final', 'out', 'out'],
}

const renderRow = () => render(<PlayerRow row={ROW} rank={1} isCurrent={false} />)
const profileCalls = () => h.rpcCalls.filter((c) => c.name === 'player_profile')

beforeEach(() => {
  h.rpcCalls = []
  h.rpcResult = { data: [PROFILE_ROW], error: null }
})

describe('PlayerRow tap interactions', () => {
  it('opens the avatar lightbox on avatar tap and does NOT open/fetch the stats popup (stopPropagation)', async () => {
    const user = userEvent.setup()
    renderRow()

    await user.click(screen.getByRole('button', { name: 'Ver foto de Mauricio A.' }))

    // Lightbox is up…
    expect(screen.getByRole('dialog', { name: 'Foto de Mauricio A.' })).toBeInTheDocument()
    // …and the row's stats popup never mounted → player_profile was NOT called.
    expect(profileCalls()).toHaveLength(0)
    expect(screen.queryByTestId('ps-stats')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ps-loading')).not.toBeInTheDocument()
  })

  it('opens the stats popup on row-body tap and fetches player_profile for that player', async () => {
    const user = userEvent.setup()
    renderRow()

    // The name lives in the row body (outside the avatar button).
    await user.click(screen.getByText('Mauricio A.'))

    await screen.findByTestId('ps-stats')
    expect(profileCalls()).toHaveLength(1)
    expect(profileCalls()[0]!.args.p_player_id).toBe('p-mau')
    // The photo lightbox did not open.
    expect(screen.queryByRole('dialog', { name: /^Foto de/ })).not.toBeInTheDocument()
    // Stats block reflects the fetched profile.
    const stats = screen.getByTestId('ps-stats')
    expect(stats.querySelector('.v.blood')?.textContent).toBe('420')
  })

  it('closes the lightbox by tapping the overlay and closes the stats popup via Escape', async () => {
    const user = userEvent.setup()
    renderRow()

    // Lightbox — tap anywhere on the overlay to dismiss.
    await user.click(screen.getByRole('button', { name: 'Ver foto de Mauricio A.' }))
    const overlay = screen.getByRole('dialog', { name: 'Foto de Mauricio A.' })
    await user.click(overlay)
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Foto de Mauricio A.' })).not.toBeInTheDocument(),
    )

    // Stats popup — Escape closes it.
    await user.click(screen.getByText('Mauricio A.'))
    await screen.findByTestId('ps-stats')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('ps-stats')).not.toBeInTheDocument())
  })

  it('is keyboard accessible: Enter on the avatar opens the lightbox, Enter on the row opens the popup', async () => {
    const user = userEvent.setup()
    renderRow()

    // Enter on the avatar → lightbox only (keydown stopPropagation, no fetch).
    screen.getByRole('button', { name: 'Ver foto de Mauricio A.' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('dialog', { name: 'Foto de Mauricio A.' })).toBeInTheDocument()
    expect(profileCalls()).toHaveLength(0)
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Foto de Mauricio A.' })).not.toBeInTheDocument(),
    )

    // Enter on the row (role="button") → stats popup + fetch.
    screen.getByRole('button', { name: 'Ver perfil de Mauricio A.' }).focus()
    await user.keyboard('{Enter}')
    await screen.findByTestId('ps-stats')
    expect(profileCalls()).toHaveLength(1)
    expect(profileCalls()[0]!.args.p_player_id).toBe('p-mau')
  })
})
