// @vitest-environment node
// Realtime uses a WebSocket; jsdom's Event shim collides with Node/undici's WS
// ("The 'event' argument must be an instance of Event"), so this file runs under
// the node environment where the native WebSocket works.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createClient,
  type RealtimeChannel,
  type RealtimePostgresUpdatePayload,
  type SupabaseClient,
} from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Slice 11 — realtime delivery, integration test against the local Supabase
// stack. postgres_changes enforces RLS for the subscribing role, and the SELECT
// policies are `to authenticated`, so we subscribe with a REAL signed-in client
// (anon can't read → would receive nothing). A service-role client then writes
// a state change to the tournament row and we assert the subscriber gets it.
// Requires migration 0008 (tournament/entry in the supabase_realtime
// publication). OPT-IN: the realtime WebSocket is flaky when many test files run
// in parallel (Kong contention), so this is skipped in the default `npm test`
// gate. Run it deliberately with the local stack up:
//   RUN_REALTIME_IT=1 npx vitest run src/lib/live.integration.test.ts
// It passes reliably in isolation. Also skips when URL / keys are absent.
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const optedIn = import.meta.env.RUN_REALTIME_IT === '1'
const canRun = Boolean(url && serviceKey && anonKey && optedIn)

type TournamentRow = Database['public']['Tables']['tournament']['Row']

describe.skipIf(!canRun)('live realtime delivery (slice 11, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const member: SupabaseClient<Database> = createClient<Database>(url, anonKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const RUN = crypto.randomUUID().slice(0, 8)
  const email = `rt-${RUN}@test.local`
  let seasonId: string
  let tournamentId: string
  let authUserId: string | undefined
  let channel: RealtimeChannel | undefined

  beforeAll(async () => {
    const { data: s, error: sErr } = await admin
      .from('season')
      .insert({ name: `RT ${RUN}`, year: 2099, status: 'archived' })
      .select('id')
      .single()
    if (sErr) throw sErr
    seasonId = s.id

    const { data: t, error: tErr } = await admin
      .from('tournament')
      .insert({
        season_id: seasonId,
        name: `RT Fecha ${RUN}`,
        scheduled_at: new Date().toISOString(),
        status: 'live',
        current_level: 1,
        is_paused: true,
        paused_remaining_seconds: 600,
      })
      .select('id')
      .single()
    if (tErr) throw tErr
    tournamentId = t.id

    // A real authenticated session so realtime's RLS check passes.
    const { data: su, error: suErr } = await member.auth.signUp({
      email,
      password: `Pw-${crypto.randomUUID()}`,
    })
    if (suErr) throw suErr
    authUserId = su.user?.id
    // Apply the session token to the realtime socket so postgres_changes
    // authorizes as `authenticated` (RLS SELECT is authenticated-only).
    if (su.session?.access_token) await member.realtime.setAuth(su.session.access_token)
  })

  afterAll(async () => {
    if (channel) await member.removeChannel(channel)
    if (tournamentId) await admin.from('tournament').delete().eq('id', tournamentId)
    if (seasonId) await admin.from('season').delete().eq('id', seasonId)
    if (authUserId) await admin.auth.admin.deleteUser(authUserId)
  })

  it('delivers a tournament-row state change to a subscribed client', async () => {
    const received = new Promise<RealtimePostgresUpdatePayload<TournamentRow>>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no realtime payload within 12s')), 12_000)
        channel = member
          .channel(`live:${tournamentId}`)
          .on<TournamentRow>(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'tournament', filter: `id=eq.${tournamentId}` },
            (payload) => {
              clearTimeout(timer)
              resolve(payload)
            },
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              // Push a state change once the subscription is live. The
              // PostgREST builder is a lazy thenable — it must be awaited to
              // actually run, hence the async IIFE (not a bare `void`).
              void (async () => {
                const { error } = await admin
                  .from('tournament')
                  .update({ paused_remaining_seconds: 123 })
                  .eq('id', tournamentId)
                if (error) reject(error)
              })()
            }
          })
      },
    )

    const payload = await received
    expect(payload.new.id).toBe(tournamentId)
    expect(payload.new.paused_remaining_seconds).toBe(123)
  }, 20_000)
})
