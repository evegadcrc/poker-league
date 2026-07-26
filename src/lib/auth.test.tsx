import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'

// ---------------------------------------------------------------------------
// CHANGE 5 — claim_player self-heal for a stranded session (authenticated yet
// still unbound). The once-per-session bind runs first (returns empty → the
// user stays 'no-player'); a later window focus / tab-visible event re-runs
// claim_player and binds on success. Mocks supabase.auth + the claim_player RPC
// so successive calls return "no member" then "the row".
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  session: { user: { id: 'u1' } } as unknown,
  claimResults: [] as Array<{ data: unknown; error: unknown }>,
  claimCalls: 0,
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: h.session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signInWithOtp: () => Promise.resolve({ error: null }),
      signOut: () => Promise.resolve({ error: null }),
    },
    rpc: (name: string) => {
      if (name !== 'claim_player') return Promise.resolve({ data: null, error: null })
      const idx = Math.min(h.claimCalls, h.claimResults.length - 1)
      h.claimCalls += 1
      return Promise.resolve(h.claimResults[idx] ?? { data: [], error: null })
    },
  },
}))

vi.mock('@/lib/access', () => ({
  requestAccess: () => Promise.resolve({ result: 'member', error: null }),
}))

import { AuthProvider, useAuth } from './auth'

function Consumer() {
  const { player, bindError, loading } = useAuth()
  return (
    <div>
      <span data-testid="player">{player?.name ?? 'unbound'}</span>
      <span data-testid="bind-error">{bindError ?? 'none'}</span>
      <span data-testid="loading">{loading ? 'yes' : 'no'}</span>
    </div>
  )
}

const PLAYER_ROW = {
  data: [{ id: 'p1', name: 'Edwin V.', is_admin: false, avatar_url: null }],
  error: null,
}
const NO_MEMBER = { data: [], error: null }

function renderAuth() {
  return render(
    <AuthProvider>
      <Consumer />
    </AuthProvider>,
  )
}

beforeEach(() => {
  h.session = { user: { id: 'u1' } }
  h.claimCalls = 0
  h.claimResults = []
})

describe('AuthProvider — claim_player self-heal', () => {
  it('re-binds on window focus when signed-in but still unbound', async () => {
    // First bind → no member; the retry → the now-created row.
    h.claimResults = [NO_MEMBER, PLAYER_ROW]
    renderAuth()

    // Initial bind resolves to the stranded state.
    await waitFor(() => expect(screen.getByTestId('bind-error')).toHaveTextContent('no-player'))
    expect(screen.getByTestId('player')).toHaveTextContent('unbound')

    // Tab regains focus → claim_player retried → the row binds.
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(screen.getByTestId('player')).toHaveTextContent('Edwin V.'))
    expect(screen.getByTestId('bind-error')).toHaveTextContent('none')
  })

  it('re-binds on document visibilitychange (tab becomes visible)', async () => {
    h.claimResults = [NO_MEMBER, PLAYER_ROW]
    renderAuth()
    await waitFor(() => expect(screen.getByTestId('bind-error')).toHaveTextContent('no-player'))

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(screen.getByTestId('player')).toHaveTextContent('Edwin V.'))
  })

  it('does NOT retry once already bound (a focus event is a no-op)', async () => {
    // First bind already succeeds → the self-heal effect never attaches.
    h.claimResults = [PLAYER_ROW]
    renderAuth()
    await waitFor(() => expect(screen.getByTestId('player')).toHaveTextContent('Edwin V.'))

    const callsAfterBind = h.claimCalls
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    // No extra claim_player call — the listener was never registered.
    await Promise.resolve()
    expect(h.claimCalls).toBe(callsAfterBind)
  })
})
