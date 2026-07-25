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
  // CRITICAL (Phase-3, migration 0019) — anon cannot execute the INTERNAL DEFINER
  // WRITERS. `revoke ... from public` alone left the implicit anon/authenticated
  // EXECUTE grants intact, so an unauthenticated caller could force score/size
  // recomputation (clobbering admin point overrides). 0019 revokes anon+authenticated
  // on both; only complete_tournament/open_tournament (as their own definer) call them.
  it('rejects anon + authenticated execution of fn_tournament_points and recompute_final_table_size', async () => {
    const anon = createClient<Database>(url, anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    // A tournament id that entering the DEFINER body would raise on — so if we
    // still see a "not found"/domain error the guard LEAKED; a permission error
    // (or any error before the body) is the fix working. Either way error != null.
    const anonFn = await anon.rpc('fn_tournament_points', { p_tournament_id: tournamentId })
    expect(anonFn.error).not.toBeNull()
    const anonSize = await anon.rpc('recompute_final_table_size', { p_tournament_id: tournamentId })
    expect(anonSize.error).not.toBeNull()

    // A signed-in NON-admin authenticated member is ALSO blocked (these are
    // internal writers, not player-callable).
    const { client } = await mkSignedInMember({ isAdmin: false })
    const authFn = await client.rpc('fn_tournament_points', { p_tournament_id: tournamentId })
    expect(authFn.error).not.toBeNull()
    const authSize = await client.rpc('recompute_final_table_size', { p_tournament_id: tournamentId })
    expect(authSize.error).not.toBeNull()
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

  // ------------------------------------------------------------------------
  // CRITICAL (Phase-2, migration 0017) — tournament writes are ADMIN-ONLY. The
  // 0001 policies allowed `created_by = auth_player_id()`, so a non-admin could
  // self-INSERT a fecha and UPDATE any column of it — then, because
  // fn_is_tournament_admin honours the created_by owner path, drive every
  // fecha-scoped admin RPC (clock / eliminate_multi / complete_tournament) and
  // inject season points. 0017 drops the owner escape.
  it('blocks a non-admin from INSERTing a tournament (0017 admin-only INSERT policy)', async () => {
    const { client, playerId } = await mkSignedInMember()
    const { error } = await client
      .from('tournament')
      .insert({
        season_id: seasonId,
        name: `SEC ${RUN} phantom`,
        scheduled_at: new Date().toISOString(),
        status: 'scheduled',
        created_by: playerId, // the old owner escape — must NOT pass now
      })
      .select()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501') // new row violates row-level security policy
    // Nothing was written.
    const { count } = await admin
      .from('tournament')
      .select('id', { count: 'exact', head: true })
      .eq('name', `SEC ${RUN} phantom`)
    expect(count ?? 0).toBe(0)
  })

  it('blocks a non-admin from UPDATEing a tournament stamped with their created_by (0017)', async () => {
    const { client, playerId } = await mkSignedInMember()
    // Service-role plants the exact state the old policy would have let the
    // attacker self-INSERT (created_by = attacker). The UPDATE must still fail.
    const { data: t, error: tErr } = await admin
      .from('tournament')
      .insert({
        season_id: seasonId,
        name: `SEC ${RUN} owned`,
        scheduled_at: new Date().toISOString(),
        status: 'scheduled',
        created_by: playerId,
      })
      .select('id')
      .single()
    if (tErr) throw tErr

    const { data } = await client
      .from('tournament')
      .update({ payout_distribution: [{ place: 1, pct: 1 }], counts_for_league: false, status: 'completed' })
      .eq('id', t.id)
      .select()
    expect(data ?? []).toHaveLength(0) // RLS using-clause matched no row

    // Server truth: every column untouched (still the planted defaults).
    const { data: row } = await admin.from('tournament').select('*').eq('id', t.id).single()
    expect(row!.status).toBe('scheduled')
    expect(row!.payout_distribution).toBeNull()
    expect(row!.counts_for_league).toBe(true) // NOT the attacker's false
  })

  it('allows an admin member to UPDATE payout_distribution/counts_for_league directly (RLS admin path holds)', async () => {
    const adminMember = await mkSignedInMember({ isAdmin: true })
    const { data: t, error: tErr } = await admin
      .from('tournament')
      .insert({
        season_id: seasonId,
        name: `SEC ${RUN} adminedit`,
        scheduled_at: new Date().toISOString(),
        status: 'scheduled',
      })
      .select('id')
      .single()
    if (tErr) throw tErr

    const dist = [
      { place: 1, pct: 0.7 },
      { place: 2, pct: 0.3 },
    ]
    const { data, error } = await adminMember.client
      .from('tournament')
      .update({ payout_distribution: dist, counts_for_league: false })
      .eq('id', t.id)
      .select()
    expect(error).toBeNull()
    expect(data ?? []).toHaveLength(1) // admin passes auth_is_admin() → write lands

    const { data: row } = await admin.from('tournament').select('*').eq('id', t.id).single()
    expect(row!.counts_for_league).toBe(false)
    expect(row!.payout_distribution).toEqual(dist)
  })
})
