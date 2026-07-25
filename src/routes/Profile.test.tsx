import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getSoundSettings, setMuted, setVolume } from '@/lib/sound'

// ---------------------------------------------------------------------------
// Slice 14 — Perfil screen (RTL). Mocks useAuth (current player + updatePlayer)
// and the supabase client (player_profile RPC + storage upload/getPublicUrl +
// the update_own_profile RPC). Asserts stats + sparkline + reversed form, the
// loading and empty states, and the avatar-upload happy path + error state.
// NB: migration 0012 dropped the direct player self-UPDATE RLS, so the avatar
// save MUST go through update_own_profile — there is intentionally no `from`
// table-write mock, so a regression to a direct write would throw.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  pending: false,
  rpcResult: { data: null as unknown, error: null as unknown },
  uploadResult: { data: { path: 'p/avatar' } as unknown, error: null as unknown },
  updateResult: { data: null as unknown, error: null as unknown },
  uploadCalls: [] as Array<{ path: string; file: unknown }>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  player: { id: 'p-edw', name: 'Edwin V.', avatar_url: null } as {
    id: string
    name: string
    avatar_url: string | null
  } | null,
  updatePlayer: vi.fn(),
  signOut: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ player: h.player, updatePlayer: h.updatePlayer, signOut: h.signOut }),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args })
      if (name === 'update_own_profile') return Promise.resolve(h.updateResult)
      // player_profile fetch
      return h.pending ? new Promise(() => {}) : Promise.resolve(h.rpcResult)
    },
    storage: {
      from: () => ({
        upload: (path: string, file: unknown) => {
          h.uploadCalls.push({ path, file })
          return Promise.resolve(h.uploadResult)
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://cdn.test/storage/${path}` },
        }),
      }),
    },
  },
}))

import Profile from './Profile'

type Row = {
  player_id: string
  player_name: string
  avatar_url: string | null
  total_points: number
  games_played: number
  wins: number
  podiums: number
  points_history: Array<{ scheduled_at: string; points: number; cumulative: number }>
  form: string[]
}

// form is MOST-RECENT-FIRST (index 0 = latest). champion is the newest game.
const FIXTURE: Row = {
  player_id: 'p-edw',
  player_name: 'Edwin V.',
  avatar_url: null,
  total_points: 350,
  games_played: 3,
  wins: 1,
  podiums: 2,
  points_history: [
    { scheduled_at: '2026-05-01T00:00:00Z', points: 100, cumulative: 100 },
    { scheduled_at: '2026-06-01T00:00:00Z', points: 130, cumulative: 230 },
    { scheduled_at: '2026-07-01T00:00:00Z', points: 120, cumulative: 350 },
  ],
  form: ['champion', 'podium', 'out'],
}

const EMPTY_ROW: Row = {
  player_id: 'p-new',
  player_name: 'Nuevo Jugador',
  avatar_url: null,
  total_points: 0,
  games_played: 0,
  wins: 0,
  podiums: 0,
  points_history: [],
  form: [],
}

function tierClasses(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('.pill')).map(
    (p) => Array.from(p.classList).find((c) => c !== 'pill') ?? '',
  )
}

beforeEach(() => {
  h.pending = false
  h.rpcResult = { data: [FIXTURE], error: null }
  h.uploadResult = { data: { path: 'p-edw/avatar' }, error: null }
  h.updateResult = { data: null, error: null }
  h.uploadCalls = []
  h.rpcCalls = []
  h.player = { id: 'p-edw', name: 'Edwin V.', avatar_url: null }
  h.updatePlayer = vi.fn()
  h.signOut = vi.fn()
})

describe('Profile (Perfil)', () => {
  it('renders the name, the 4-stat grid and the hero sub', async () => {
    render(<Profile />)
    await screen.findByTestId('prof-stats')

    expect(screen.getByRole('heading', { name: 'Edwin V.' })).toBeInTheDocument()

    const stats = screen.getByTestId('prof-stats')
    // Puntos / Jugadas / Títulos / Podios
    expect(stats.querySelector('.v.blood')?.textContent).toBe('350')
    expect(stats.textContent).toContain('Puntos')
    expect(stats.textContent).toContain('Jugadas')
    expect(stats.textContent).toContain('Títulos')
    expect(stats.textContent).toContain('Podios')
    expect(screen.getByText('350 pts · 3 jugadas')).toBeInTheDocument()
  })

  it('renders a sparkline with one node per history point', async () => {
    render(<Profile />)
    const spark = await screen.findByTestId('spark')
    expect(spark.querySelector('svg')).not.toBeNull()
    // 3 history points → 3 circles.
    expect(spark.querySelectorAll('circle')).toHaveLength(3)
  })

  it('renders the full form (Racha completa) reversed newest-on-the-RIGHT', async () => {
    const { container } = render(<Profile />)
    await screen.findByTestId('prof-stats')

    const bigForm = container.querySelector('.big-form') as HTMLElement
    expect(bigForm).not.toBeNull()
    // RPC (latest→oldest): champion, podium, out
    // Rendered left→right (oldest→newest): out, podio, champ
    expect(tierClasses(bigForm)).toEqual(['out', 'podio', 'champ'])
    const pills = bigForm.querySelectorAll('.pill')
    // Newest game (champion) is the RIGHTMOST pill.
    expect(pills[pills.length - 1]!.classList.contains('champ')).toBe(true)
  })

  it('shows the loading skeleton while the RPC is pending', () => {
    h.pending = true
    render(<Profile />)
    expect(screen.getByTestId('prof-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('prof-stats')).not.toBeInTheDocument()
  })

  it('renders the empty state for a new player with no games', async () => {
    h.rpcResult = { data: [EMPTY_ROW], error: null }
    h.player = { id: 'p-new', name: 'Nuevo Jugador', avatar_url: null }
    render(<Profile />)
    await screen.findByTestId('prof-stats')

    expect(screen.getByText('Sin jugadas todavía')).toBeInTheDocument()
    expect(screen.getByText(/no tienes historial de puntos/i)).toBeInTheDocument()
    // No sparkline and no form pills.
    expect(screen.queryByTestId('spark')).not.toBeInTheDocument()
    expect(document.querySelector('.big-form')).toBeNull()
  })

  it('uploads a new avatar and reflects it immediately', async () => {
    const user = userEvent.setup()
    render(<Profile />)
    await screen.findByTestId('prof-stats')

    const file = new File(['x'], 'me.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('Subir foto de perfil'), file)

    await waitFor(() => expect(h.updatePlayer).toHaveBeenCalled())

    // Uploaded under the player-id folder so the owner-only RLS policy matches.
    expect(h.uploadCalls).toHaveLength(1)
    expect(h.uploadCalls[0]!.path).toBe('p-edw/avatar')
    // Persisted via the update_own_profile RPC (NOT a direct player table write,
    // which 0012's RLS now blocks). Sends the current name + cache-busted URL.
    const rpcCall = h.rpcCalls.find((c) => c.name === 'update_own_profile')
    expect(rpcCall).toBeTruthy()
    expect(rpcCall!.args.p_name).toBe('Edwin V.')
    expect(rpcCall!.args.p_avatar_url).toMatch(
      /^https:\/\/cdn\.test\/storage\/p-edw\/avatar\?t=\d+/,
    )
    const updatedUrl = h.updatePlayer.mock.calls[0]![0].avatar_url as string

    // Hero avatar now shows the uploaded image.
    const avatar = document.querySelector('.prof-hero .avatar') as HTMLElement
    expect(avatar.getAttribute('role')).toBe('img')
    expect(avatar.style.backgroundImage).toContain(updatedUrl)
  })

  it('shows an upload-error message when the storage upload fails', async () => {
    h.uploadResult = { data: null, error: { message: 'boom' } }
    const user = userEvent.setup()
    render(<Profile />)
    await screen.findByTestId('prof-stats')

    const file = new File(['x'], 'me.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('Subir foto de perfil'), file)

    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo subir la foto/i)
    // No profile-save RPC attempted on a failed upload.
    expect(h.rpcCalls.find((c) => c.name === 'update_own_profile')).toBeFalsy()
  })

  it('shows a save-error message when the update_own_profile RPC fails', async () => {
    h.updateResult = { data: null, error: { message: 'rls' } }
    const user = userEvent.setup()
    render(<Profile />)
    await screen.findByTestId('prof-stats')

    const file = new File(['x'], 'me.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('Subir foto de perfil'), file)

    // The RPC was attempted (upload succeeded) but reported an error.
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo guardar/i)
    expect(h.rpcCalls.find((c) => c.name === 'update_own_profile')).toBeTruthy()
    // Context is not patched when the save failed.
    expect(h.updatePlayer).not.toHaveBeenCalled()
  })

  it('renders an error state with a retry when the RPC errors', async () => {
    h.rpcResult = { data: null, error: { message: 'nope' } }
    render(<Profile />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo cargar tu perfil/i)
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument()
  })
})

// The sound store (@/lib/sound) is a real module-level singleton — reset it to
// defaults before each test so state doesn't bleed between cases.
describe('Profile — Sonido settings', () => {
  beforeEach(() => {
    setMuted(false)
    setVolume(0.7)
    localStorage.removeItem('pf-sound')
  })

  it('toggles mute and persists it to pf-sound', async () => {
    const user = userEvent.setup()
    render(<Profile />)

    const toggle = await screen.findByRole('switch', { name: 'Silenciar' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(getSoundSettings().muted).toBe(true)
    expect(JSON.parse(localStorage.getItem('pf-sound')!).muted).toBe(true)
  })

  it('changes the volume via the range and persists it', async () => {
    render(<Profile />)

    const range = (await screen.findByLabelText('Volumen')) as HTMLInputElement
    fireEvent.change(range, { target: { value: '0.4' } })

    expect(getSoundSettings().volume).toBeCloseTo(0.4)
    expect(JSON.parse(localStorage.getItem('pf-sound')!).volume).toBeCloseTo(0.4)
  })

  it('reflects the persisted muted state on mount', async () => {
    setMuted(true)
    render(<Profile />)

    const toggle = await screen.findByRole('switch', { name: 'Silenciar' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    // Muted disables the volume slider.
    expect(screen.getByLabelText('Volumen')).toBeDisabled()
  })
})
