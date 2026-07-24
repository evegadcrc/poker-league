import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Review iter 1 — RLS / authz hardening (migration 0012). Proves the dropped
// self-write policies actually block privilege escalation + entry tampering,
// that anon can no longer execute the SECURITY DEFINER read RPCs, and that the
// two new player-facing/admin RPCs (update_own_profile, create_player) behave.
//
// Isolation (per the flaky-test lesson): everything hangs off a THROWAWAY
// archived season with a unique RUN tag and is torn down in afterAll; the suite
// runs serial (fileParallelism:false) so it never overlaps other DB files.
// Setup uses the SERVICE-ROLE client (bypasses RLS); the assertions run through
// a REAL signed-in member (anon key + a session) so RLS is the gate under test.
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const canRun = Boolean(url && serviceKey && anonKey)

const STACK = 10_000

describe.skipIf(!canRun)('RLS / authz hardening (0012, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const RUN = crypto.randomUUID().slice(0, 8)
  const seasonIds: string[] = []
  const playerIds: string[] = []
  const authUserIds: string[] = []
  let seasonId: string
  let tournamentId: string

  async function mkSeason() {
    const { data, error } = await admin
      .from('season')
      .insert({ name: `SEC ${RUN}`, year: 2097, status: 'archived' })
      .select('id')
      .single()
    if (error) throw error
    seasonIds.push(data.id)
    return data.id
  }

  async function mkTournament() {
    const { data, error } = await admin
      .from('tournament')
      .insert({
        season_id: seasonId,
        name: `SEC ${RUN}`,
        scheduled_at: new Date().toISOString(),
        status: 'live',
        starting_stack: STACK,
        final_table_size: 5,
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  // Insert a player row (optionally admin) + a bound, signed-in anon client.
  async function mkSignedInMember(opts: { isAdmin?: boolean } = {}) {
    const email = `sec-${RUN}-${crypto.randomUUID().slice(0, 8)}@test.local`
    const { data: p, error: pErr } = await admin
      .from('player')
      .insert({ name: `SEC ${RUN}`, email, is_admin: opts.isAdmin ?? false })
      .select('id')
      .single()
    if (pErr) throw pErr
    playerIds.push(p.id)
    const client = createClient<Database>(url, anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: su, error: suErr } = await client.auth.signUp({
      email,
      password: `Pw-${crypto.randomUUID()}`,
    })
    if (suErr) throw suErr
    if (su.user) authUserIds.push(su.user.id)
    const { error: bindErr } = await admin
      .from('player')
      .update({ auth_user_id: su.user!.id })
      .eq('id', p.id)
    if (bindErr) throw bindErr
    return { client, playerId: p.id, email }
  }

  async function readPlayer(id: string) {
    const { data, error } = await admin.from('player').select('*').eq('id', id).single()
    if (error) throw error
    return data
  }

  async function readEntry(id: string) {
    const { data, error } = await admin.from('entry').select('*').eq('id', id).single()
    if (error) throw error
    return data
  }

  beforeAll(async () => {
    await admin.from('player').delete().like('email', 'sec-%@test.local')
    seasonId = await mkSeason()
    tournamentId = await mkTournament()
  }, 30_000)

  afterAll(async () => {
    for (const id of seasonIds) await admin.from('season').delete().eq('id', id)
    if (playerIds.length) await admin.from('player').delete().in('id', playerIds)
    for (const uid of authUserIds) await admin.auth.admin.deleteUser(uid)
  })

  // ------------------------------------------------------------------------
  // CRITICAL #1 — a signed-in player cannot self-promote to admin.
  it('blocks a player from setting is_admin=true on their own row (no UPDATE policy)', async () => {
    const { client, playerId } = await mkSignedInMember()

    // Sanity: RLS still lets them READ their own row.
    const { data: readOwn } = await client.from('player').select('id,is_admin').eq('id', playerId).single()
    expect(readOwn?.is_admin).toBe(false)

    // The escalation attempt — RLS default-deny (no UPDATE policy) → 0 rows.
    const { data } = await client.from('player').update({ is_admin: true }).eq('id', playerId).select()
    expect(data ?? []).toHaveLength(0)
    // Server truth: still not an admin.
    expect((await readPlayer(playerId)).is_admin).toBe(false)
  })

  // ------------------------------------------------------------------------
  // CRITICAL #2 — a stranger cannot self-provision a player row.
  it('blocks a player from INSERTing a player row (no INSERT policy → RLS violation)', async () => {
    const { client } = await mkSignedInMember()
    const { error } = await client
      .from('player')
      .insert({ name: 'intruder', email: `sec-${RUN}-intruder@test.local`, is_admin: true })
      .select()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501') // new row violates row-level security policy
    // Nothing was written.
    const { count } = await admin
      .from('player')
      .select('id', { count: 'exact', head: true })
      .eq('email', `sec-${RUN}-intruder@test.local`)
    expect(count ?? 0).toBe(0)
  })

  // ------------------------------------------------------------------------
  // CRITICAL #3 — a player cannot rewrite their own entry's money/chips/points/status.
  it('blocks direct UPDATE of own entry paid/chips/points_earned/status (no UPDATE policy)', async () => {
    const { client, playerId } = await mkSignedInMember()
    const { data: e, error: eErr } = await admin
      .from('entry')
      .insert({
        tournament_id: tournamentId,
        player_id: playerId,
        status: 'playing',
        paid: false,
        chips: STACK,
        points_earned: null,
      })
      .select('id')
      .single()
    if (eErr) throw eErr

    const { data } = await client
      .from('entry')
      .update({ paid: true, chips: 999_999, points_earned: 9999, status: 'winner', final_position: 1 })
      .eq('id', e.id)
      .select()
    expect(data ?? []).toHaveLength(0)

    // Server truth: untouched.
    const row = await readEntry(e.id)
    expect(row.paid).toBe(false)
    expect(row.chips).toBe(STACK)
    expect(row.points_earned).toBeNull()
    expect(row.status).toBe('playing')
    expect(row.final_position).toBeNull()
  })

  // ------------------------------------------------------------------------
  // REQUIRED #5 — anon cannot execute the SECURITY DEFINER read RPCs.
  it('rejects anon execution of leaderboard and player_profile', async () => {
    const anon = createClient<Database>(url, anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const lb = await anon.rpc('leaderboard', { p_season_id: seasonId })
    expect(lb.error).not.toBeNull()

    const anyPlayer = playerIds[0]
    const pp = await anon.rpc('player_profile', { p_player_id: anyPlayer, p_season_id: seasonId })
    expect(pp.error).not.toBeNull()
  })

  // ------------------------------------------------------------------------
  // REQUIRED #3 — update_own_profile updates ONLY name + avatar_url.
  it('update_own_profile changes name/avatar but never is_admin or email', async () => {
    const { client, playerId, email } = await mkSignedInMember()
    const before = await readPlayer(playerId)

    const { error } = await client.rpc('update_own_profile', {
      p_name: 'Nuevo Nombre',
      p_avatar_url: 'https://example.com/a.png',
    })
    expect(error).toBeNull()

    const after = await readPlayer(playerId)
    expect(after.name).toBe('Nuevo Nombre')
    expect(after.avatar_url).toBe('https://example.com/a.png')
    // The columns the Profile screen must NOT be able to touch:
    expect(after.is_admin).toBe(before.is_admin) // still false
    expect(after.email).toBe(email) // unchanged
    expect(after.auth_user_id).toBe(before.auth_user_id)
  })

  // ------------------------------------------------------------------------
  // REQUIRED #4 — create_player is admin-only and always makes a non-admin.
  it('create_player: allowed for an admin member, rejected for a non-admin member', async () => {
    // non-admin → rejected.
    const nonAdmin = await mkSignedInMember({ isAdmin: false })
    const denied = await nonAdmin.client.rpc('create_player', {
      p_name: 'Should Fail',
      p_email: `sec-${RUN}-nope@test.local`,
    })
    expect(denied.error).not.toBeNull()

    // admin → allowed; new row is is_admin=false.
    const adminMember = await mkSignedInMember({ isAdmin: true })
    const newEmail = `sec-${RUN}-created@test.local`
    const ok = await adminMember.client.rpc('create_player', { p_name: 'Nuevo Miembro', p_email: newEmail })
    expect(ok.error).toBeNull()
    const created = Array.isArray(ok.data) ? ok.data[0] : ok.data
    expect(created?.email).toBe(newEmail)
    expect(created?.is_admin).toBe(false)
    if (created?.id) playerIds.push(created.id)
  })
})
