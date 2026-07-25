import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Cue engine spy + supabase/auth harness (mirrors Live.test.tsx). Tests set the
// tournament / levels / entries, then fire captured postgres_changes handlers to
// simulate a live state change, and assert the cue fired OFF THE TRANSITION.
const sound = vi.hoisted(() => ({ playCue: vi.fn(), resumeAudio: vi.fn() }))
vi.mock('@/lib/sound', () => ({
  playCue: sound.playCue,
  resumeAudio: sound.resumeAudio,
}))

const h = vi.hoisted(() => ({
  single: {} as Record<string, { data: unknown; error: unknown }>,
  list: {} as Record<string, { data: unknown; error: unknown }>,
  rpcResult: { data: 0 as unknown, error: null as unknown },
  handlers: [] as Array<(payload: unknown) => void>,
  subscribeStatus: 'SUBSCRIBED' as string,
}))

vi.mock('@/lib/auth', () => ({
  useRole: () => ({ isAdmin: false }),
  useAuth: () => ({ player: null }),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        is: () => b, // `.is('cancelled_at', null)` on the live query — passthrough
        order: () => b,
        limit: () => b,
        maybeSingle: () => Promise.resolve(h.single[table] ?? { data: null, error: null }),
        then: (resolve: (v: unknown) => void) => resolve(h.list[table] ?? { data: [], error: null }),
      }
      return b
    },
    rpc: () => Promise.resolve(h.rpcResult),
    channel: () => {
      const chan: Record<string, unknown> = {
        on: (_type: string, _filter: unknown, cb: (payload: unknown) => void) => {
          h.handlers.push(cb)
          return chan
        },
        subscribe: (cb?: (status: string) => void) => {
          cb?.(h.subscribeStatus)
          return chan
        },
      }
      return chan
    },
    removeChannel: () => Promise.resolve(),
  },
}))

import Live from './Live'

const LEVELS = [
  { level_number: 1, small_blind: 25, big_blind: 50, ante: 0, duration_seconds: 1200, is_break: false },
  { level_number: 2, small_blind: 50, big_blind: 100, ante: 0, duration_seconds: 1200, is_break: false },
]

type Over = Partial<{ current_level: number; is_paused: boolean; paused_remaining_seconds: number | null }>

function setTournament(over: Over = {}) {
  h.single.tournament = {
    data: {
      id: 't-live',
      name: 'Fecha 8',
      ante_enabled: false,
      current_level: 1,
      level_started_at: null,
      is_paused: true,
      paused_remaining_seconds: 600, // constant → no warning noise
      blind_structure_id: 'bs-1',
      prizes: [],
      payout_distribution: null,
      ...over,
    },
    error: null,
  }
}

function setEntries(rows?: Array<Record<string, unknown>>) {
  h.list.entry = {
    data: rows ?? [
      { id: 'a', player_id: 'p-ana', status: 'playing', final_position: null, chips: 12000, player: { name: 'Ana', avatar_url: null } },
      { id: 'c', player_id: 'p-cid', status: 'playing', final_position: null, chips: 30000, player: { name: 'Cid', avatar_url: null } },
      { id: 'd', player_id: 'p-dee', status: 'eliminated', final_position: 7, chips: 0, player: { name: 'Dee', avatar_url: null } },
    ],
    error: null,
  }
}

const renderLive = () => render(<Live />, { wrapper: MemoryRouter })
const cueCount = (cue: string) => sound.playCue.mock.calls.filter((c) => c[0] === cue).length
const fireAll = async (payload: unknown = { eventType: 'UPDATE' }) =>
  act(async () => {
    h.handlers.forEach((cb) => cb(payload))
  })

beforeEach(() => {
  sound.playCue.mockClear()
  sound.resumeAudio.mockClear()
  h.single = {}
  h.list = {}
  h.rpcResult = { data: 140000, error: null }
  h.handlers = []
  h.subscribeStatus = 'SUBSCRIBED'
  setTournament()
  h.list.blind_level = { data: LEVELS, error: null }
  setEntries()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Live — cues fire off STATE TRANSITIONS (step 13)', () => {
  it('level advance fires levelChange ONCE + toast; the same state re-firing (tick) fires nothing', async () => {
    renderLive()
    await screen.findByTestId('timer')
    // Initial (seed) observation is not a transition → no cue.
    expect(cueCount('levelChange')).toBe(0)

    // Admin advances the clock: current_level 1 → 2.
    setTournament({ current_level: 2 })
    await fireAll()

    await waitFor(() => expect(cueCount('levelChange')).toBe(1))
    expect(await screen.findByTestId('live-toast')).toHaveTextContent('Nivel 2 — ciegas 50/100')

    // A pure tick / re-fetch carrying the SAME level fires nothing new.
    await fireAll()
    await fireAll()
    expect(cueCount('levelChange')).toBe(1)
  })

  it('a tournament OPENING (no-live → live) fires tournamentStart + toast', async () => {
    // Start with no live fecha → the idle scan subscription is what catches it.
    h.single.tournament = { data: null, error: null }
    renderLive()
    await screen.findByText(/No hay ningún torneo en vivo/i)
    expect(cueCount('tournamentStart')).toBe(0)

    // A fecha goes live; the scan handler triggers a reload.
    setTournament({ current_level: 1 })
    await fireAll()

    await waitFor(() => expect(cueCount('tournamentStart')).toBe(1))
    expect(await screen.findByTestId('live-toast')).toHaveTextContent('¡Fecha abierta!')
  })

  it('a new elimination fires elimination + toast; re-rendering the same state does NOT re-fire', async () => {
    renderLive()
    await screen.findByTestId('timer')
    // Dee is already out in the fixture → seeded, not a new elimination.
    expect(cueCount('elimination')).toBe(0)

    // Ana busts (playing → eliminated).
    setEntries([
      { id: 'a', player_id: 'p-ana', status: 'eliminated', final_position: 2, chips: 0, player: { name: 'Ana', avatar_url: null } },
      { id: 'c', player_id: 'p-cid', status: 'playing', final_position: null, chips: 30000, player: { name: 'Cid', avatar_url: null } },
      { id: 'd', player_id: 'p-dee', status: 'eliminated', final_position: 7, chips: 0, player: { name: 'Dee', avatar_url: null } },
    ])
    await fireAll()

    await waitFor(() => expect(cueCount('elimination')).toBe(1))
    expect(await screen.findByTestId('live-toast')).toHaveTextContent('Ana quedó fuera')

    // Same entries again (dedupe by entry id) → no re-fire.
    await fireAll()
    await fireAll()
    expect(cueCount('elimination')).toBe(1)
  })

  it('the champion reaching 1st (playing → winner) does NOT fire elimination; the busted runner-up DOES', async () => {
    renderLive()
    await screen.findByTestId('timer')
    expect(cueCount('elimination')).toBe(0)

    // Heads-up ends in the SAME batch: Cid busts to 2nd (playing → eliminated)
    // and Ana takes the title (playing → winner). Only the bust is a "quedó
    // fuera" event — a champion reaching a final position must NOT be counted as
    // an elimination (deriveLiveSignal keys `out` on status === 'eliminated').
    setEntries([
      { id: 'a', player_id: 'p-ana', status: 'winner', final_position: 1, chips: 42000, player: { name: 'Ana', avatar_url: null } },
      { id: 'c', player_id: 'p-cid', status: 'eliminated', final_position: 2, chips: 0, player: { name: 'Cid', avatar_url: null } },
      { id: 'd', player_id: 'p-dee', status: 'eliminated', final_position: 7, chips: 0, player: { name: 'Dee', avatar_url: null } },
    ])
    await fireAll()

    await waitFor(() => expect(cueCount('elimination')).toBe(1))
    const toast = await screen.findByTestId('live-toast')
    expect(toast).toHaveTextContent('Cid quedó fuera')
    // The champion is never announced as "quedó fuera".
    expect(toast).not.toHaveTextContent('Ana')
  })

  it('co-champions chopping the title (both → winner) fire NO elimination', async () => {
    renderLive()
    await screen.findByTestId('timer')
    expect(cueCount('elimination')).toBe(0)

    // Ana + Cid chop the title: both reach status 'winner' (chopped final
    // position). Dee was already out (seeded, not new). No NEW `eliminated`
    // entry appears → no "quedó fuera" cue for the co-champions.
    setEntries([
      { id: 'a', player_id: 'p-ana', status: 'winner', final_position: 1, chips: 21000, player: { name: 'Ana', avatar_url: null } },
      { id: 'c', player_id: 'p-cid', status: 'winner', final_position: 1, chips: 21000, player: { name: 'Cid', avatar_url: null } },
      { id: 'd', player_id: 'p-dee', status: 'eliminated', final_position: 7, chips: 0, player: { name: 'Dee', avatar_url: null } },
    ])
    await fireAll()
    await fireAll()

    expect(cueCount('elimination')).toBe(0)
    expect(screen.queryByTestId('live-toast')).not.toBeInTheDocument()
  })

  it('permission DENIED: no local Notification is constructed and no throw; the toast still shows', async () => {
    const NotificationMock = vi.fn() as unknown as { permission: string; requestPermission: () => Promise<string> }
    ;(NotificationMock as unknown as { permission: string }).permission = 'denied'
    ;(NotificationMock as unknown as { requestPermission: () => Promise<string> }).requestPermission = vi
      .fn()
      .mockResolvedValue('denied')
    vi.stubGlobal('Notification', NotificationMock)

    renderLive()
    await screen.findByTestId('timer')

    setTournament({ current_level: 2 })
    await fireAll()

    // Cue + toast fire …
    await waitFor(() => expect(cueCount('levelChange')).toBe(1))
    expect(await screen.findByTestId('live-toast')).toHaveTextContent('Nivel 2')
    // … but with permission denied the Notification constructor is never called.
    expect(NotificationMock).not.toHaveBeenCalled()
    // Permission is not 'default' → the "activar notificaciones" CTA is hidden.
    expect(screen.queryByTestId('notify-cta')).not.toBeInTheDocument()
  })
})
