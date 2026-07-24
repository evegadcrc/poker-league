import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Slice 14 — player_profile RPC + avatar Storage upload, integration tests
// against the local Supabase stack.
//
// ISOLATION (per the flaky-tests lesson): all fixtures live in a throwaway
// ARCHIVED season (year 2097) created per-run, and player_profile is queried
// with an EXPLICIT p_season_id, so this suite never reads or mutates the shared
// seed's active season. Everything created is torn down in afterAll (entries →
// tournaments → season, players by id, auth users, and the uploaded object).
// Gated: skips cleanly when the URL / service-role / anon keys are absent.
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const canRun = Boolean(url && serviceKey && anonKey)

type HistoryPoint = { scheduled_at: string; points: number; cumulative: number }

describe.skipIf(!canRun)('player_profile + avatar upload (slice 14, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const RUN = crypto.randomUUID().slice(0, 8)
  const tournamentIds: string[] = []
  let seasonId: string
  let member: SupabaseClient<Database>
  let memberPlayerId: string
  let emptyPlayerId: string
  const playerIds: string[] = []
  const authUserIds: string[] = []
  const uploadedPaths: string[] = []

  async function mkSeason() {
    const { data, error } = await admin
      .from('season')
      .insert({ name: `PROF ${RUN}`, year: 2097, status: 'archived' })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  async function mkCompletedTournament(scheduledAt: string) {
    const { data, error } = await admin
      .from('tournament')
      .insert({
        season_id: seasonId,
        name: `T ${RUN}`,
        scheduled_at: scheduledAt,
        status: 'completed',
      })
      .select('id')
      .single()
    if (error) throw error
    tournamentIds.push(data.id)
    return data.id
  }

  async function mkEntry(
    tournamentId: string,
    e: {
      final_position?: number | null
      points_earned: number
      made_final_table?: boolean
      chopped?: boolean
      status?: Database['public']['Enums']['entry_status']
    },
  ) {
    const { error } = await admin.from('entry').insert({
      tournament_id: tournamentId,
      player_id: memberPlayerId,
      status: e.status ?? 'eliminated',
      final_position: e.final_position ?? null,
      points_earned: e.points_earned,
      made_final_table: e.made_final_table ?? false,
      chopped: e.chopped ?? false,
    })
    if (error) throw error
  }

  async function mkPlayer() {
    const email = `prof-${RUN}-${crypto.randomUUID().slice(0, 8)}@test.local`
    const { data: p, error } = await admin
      .from('player')
      .insert({ name: `PROF ${RUN}`, email })
      .select('id')
      .single()
    if (error) throw error
    playerIds.push(p.id)
    return { id: p.id, email }
  }

  async function mkSignedInMember() {
    const { id, email } = await mkPlayer()
    const client = createClient<Database>(url, anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: su, error } = await client.auth.signUp({
      email,
      password: `Pw-${crypto.randomUUID()}`,
    })
    if (error) throw error
    if (su.user) authUserIds.push(su.user.id)
    const { error: bindErr } = await admin
      .from('player')
      .update({ auth_user_id: su.user!.id })
      .eq('id', id)
    if (bindErr) throw bindErr
    return { client, playerId: id }
  }

  beforeAll(async () => {
    await admin.from('player').delete().like('email', 'prof-%@test.local')
    seasonId = await mkSeason()

    const m = await mkSignedInMember()
    member = m.client
    memberPlayerId = m.playerId

    // Four completed fechas (oldest → newest):
    //   t1 champion +100 (final table), t2 no-show -15, t3 podium(3rd) +50, t4 out(6th) +20
    const t1 = await mkCompletedTournament('2097-01-05T00:00:00Z')
    const t2 = await mkCompletedTournament('2097-02-05T00:00:00Z')
    const t3 = await mkCompletedTournament('2097-03-05T00:00:00Z')
    const t4 = await mkCompletedTournament('2097-04-05T00:00:00Z')
    await mkEntry(t1, { final_position: 1, points_earned: 100, made_final_table: true, status: 'winner' })
    await mkEntry(t2, { final_position: null, points_earned: -15, status: 'no_show' })
    await mkEntry(t3, { final_position: 3, points_earned: 50 })
    await mkEntry(t4, { final_position: 6, points_earned: 20 })

    const empty = await mkPlayer()
    emptyPlayerId = empty.id
  }, 40_000)

  afterAll(async () => {
    for (const p of uploadedPaths) await admin.storage.from('avatars').remove([p])
    if (tournamentIds.length) await admin.from('tournament').delete().in('id', tournamentIds)
    await admin.from('season').delete().eq('id', seasonId)
    if (playerIds.length) await admin.from('player').delete().in('id', playerIds)
    for (const uid of authUserIds) await admin.auth.admin.deleteUser(uid)
  })

  // ------------------------------------------------------------------------
  it('returns correct totals, cumulative history and full form for a seeded player', async () => {
    const { data, error } = await admin.rpc('player_profile', {
      p_player_id: memberPlayerId,
      p_season_id: seasonId,
    })
    expect(error).toBeNull()
    const row = data![0]!

    // total_points includes the -15 penalty; games_played counts ranked games only.
    expect(row.total_points).toBe(155)
    expect(row.games_played).toBe(3)
    expect(row.wins).toBe(1)
    expect(row.podiums).toBe(2)

    // Full form, MOST-RECENT-FIRST (ranked games only, no-show excluded):
    //   newest t4 out → t3 podium → t1 champion
    expect(row.form).toEqual(['out', 'podium', 'champion'])

    // History (oldest→newest) includes the penalty fecha; cumulative ends on total.
    const history = row.points_history as unknown as HistoryPoint[]
    expect(history.map((p) => p.cumulative)).toEqual([100, 85, 135, 155])
    expect(history[history.length - 1]!.cumulative).toBe(row.total_points)
  })

  // ------------------------------------------------------------------------
  it('returns zeros / empty series for a player with no completed games', async () => {
    // No p_season_id → defaults to the active season; the empty player has no
    // entries anywhere, so the result is zeros regardless of season.
    const { data, error } = await admin.rpc('player_profile', { p_player_id: emptyPlayerId })
    expect(error).toBeNull()
    const row = data![0]!
    expect(row.total_points).toBe(0)
    expect(row.games_played).toBe(0)
    expect(row.form).toEqual([])
    expect(row.points_history as unknown as HistoryPoint[]).toEqual([])
  })

  // ------------------------------------------------------------------------
  it('uploads an avatar to the bucket, gets a public URL, and persists avatar_url', async () => {
    const path = `${memberPlayerId}/avatar`
    uploadedPaths.push(path)
    // 1x1 transparent PNG.
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    )

    // Owner-only RLS: the signed-in member uploads under their own player-id folder.
    const { error: upErr } = await member.storage
      .from('avatars')
      .upload(path, png, { upsert: true, contentType: 'image/png' })
    expect(upErr).toBeNull()

    const {
      data: { publicUrl },
    } = member.storage.from('avatars').getPublicUrl(path)
    expect(publicUrl).toContain(`/avatars/${memberPlayerId}/avatar`)

    // The public object is actually readable (public bucket).
    const res = await fetch(publicUrl)
    expect(res.ok).toBe(true)

    // Persist on the player row via the update_own_profile RPC (direct player
    // table writes were removed in 0012 — the RPC is the only self-write path).
    const stored = `${publicUrl}?t=${Date.now()}`
    const { error: updErr } = await member.rpc('update_own_profile', { p_avatar_url: stored })
    expect(updErr).toBeNull()

    const { data: p, error: readErr } = await admin
      .from('player')
      .select('avatar_url')
      .eq('id', memberPlayerId)
      .single()
    expect(readErr).toBeNull()
    expect(p!.avatar_url).toBe(stored)
  })

  // ------------------------------------------------------------------------
  it('rejects an avatar upload into another player folder (owner-only RLS)', async () => {
    const foreignPath = `${emptyPlayerId}/avatar`
    const { error } = await member.storage
      .from('avatars')
      .upload(foreignPath, new Uint8Array([1, 2, 3]), { upsert: true, contentType: 'image/png' })
    expect(error).not.toBeNull()
  })
})
