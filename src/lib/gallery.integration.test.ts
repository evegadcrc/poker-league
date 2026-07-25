import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Slice 14 — gallery_photo RLS, integration tests against the local Supabase
// stack. Proves: a league member can insert their OWN gallery_photo row and
// read it back; a NON-member (signed-in auth user with no bound player) cannot
// read any row; a non-uploader non-admin cannot delete someone else's photo;
// an admin can delete it.
//
// ISOLATION (per the flaky-test lesson): every fixture hangs off a THROWAWAY
// archived season (year 2097) with a unique RUN tag and is torn down in
// afterAll; the suite runs serial (fileParallelism:false) so it never overlaps
// other DB files. Setup uses the SERVICE-ROLE client (bypasses RLS); the
// assertions run through REAL signed-in clients so RLS is the gate under test.
// Gated: skips cleanly when the URL / service-role / anon keys are absent.
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const canRun = Boolean(url && serviceKey && anonKey)

describe.skipIf(!canRun)('gallery_photo RLS (0016, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const RUN = crypto.randomUUID().slice(0, 8)
  const playerIds: string[] = []
  const authUserIds: string[] = []
  let seasonId: string
  let tournamentId: string
  let memberA: SupabaseClient<Database>
  let memberAId: string
  let memberB: SupabaseClient<Database>
  let adminClient: SupabaseClient<Database>
  let nonMember: SupabaseClient<Database>
  let sharedPhotoId: string

  async function mkSeason() {
    const { data, error } = await admin
      .from('season')
      .insert({ name: `GAL ${RUN}`, year: 2097, status: 'archived' })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  async function mkTournament() {
    const { data, error } = await admin
      .from('tournament')
      .insert({
        season_id: seasonId,
        name: `GAL ${RUN}`,
        scheduled_at: new Date().toISOString(),
        status: 'completed',
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  // A player row (optionally admin) + a bound, signed-in anon client.
  async function mkSignedInMember(opts: { isAdmin?: boolean } = {}) {
    const email = `gal-${RUN}-${crypto.randomUUID().slice(0, 8)}@test.local`
    const { data: p, error: pErr } = await admin
      .from('player')
      .insert({ name: `GAL ${RUN}`, email, is_admin: opts.isAdmin ?? false })
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
    return { client, playerId: p.id }
  }

  // A signed-in auth user with NO bound player row → auth_player_id() is null.
  async function mkSignedInNonMember() {
    const email = `gal-${RUN}-nonmember-${crypto.randomUUID().slice(0, 8)}@test.local`
    const client = createClient<Database>(url, anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: su, error } = await client.auth.signUp({
      email,
      password: `Pw-${crypto.randomUUID()}`,
    })
    if (error) throw error
    if (su.user) authUserIds.push(su.user.id)
    return client
  }

  beforeAll(async () => {
    await admin.from('player').delete().like('email', 'gal-%@test.local')
    seasonId = await mkSeason()
    tournamentId = await mkTournament()

    const a = await mkSignedInMember()
    memberA = a.client
    memberAId = a.playerId
    memberB = (await mkSignedInMember()).client
    adminClient = (await mkSignedInMember({ isAdmin: true })).client
    nonMember = await mkSignedInNonMember()

    // A photo owned by memberA, seeded via service-role (bypasses RLS), used by
    // the read + delete assertions below.
    const { data, error } = await admin
      .from('gallery_photo')
      .insert({
        tournament_id: tournamentId,
        uploader_id: memberAId,
        storage_path: `${memberAId}/${tournamentId}-shared.jpg`,
      })
      .select('id')
      .single()
    if (error) throw error
    sharedPhotoId = data.id
  }, 40_000)

  afterAll(async () => {
    // gallery_photo rows cascade with the tournament; delete it explicitly first.
    await admin.from('tournament').delete().eq('id', tournamentId)
    await admin.from('season').delete().eq('id', seasonId)
    if (playerIds.length) await admin.from('player').delete().in('id', playerIds)
    for (const uid of authUserIds) await admin.auth.admin.deleteUser(uid)
  })

  // ------------------------------------------------------------------------
  it('lets a league member insert their own photo row and read it back', async () => {
    const path = `${memberAId}/${tournamentId}-${crypto.randomUUID()}.jpg`
    const { data: inserted, error: insErr } = await memberA
      .from('gallery_photo')
      .insert({ tournament_id: tournamentId, uploader_id: memberAId, storage_path: path })
      .select('id, storage_path')
      .single()
    expect(insErr).toBeNull()
    expect(inserted?.storage_path).toBe(path)

    const { data: readBack, error: readErr } = await memberA
      .from('gallery_photo')
      .select('id, storage_path')
      .eq('id', inserted!.id)
      .single()
    expect(readErr).toBeNull()
    expect(readBack?.storage_path).toBe(path)
  })

  // ------------------------------------------------------------------------
  it('blocks a member from inserting a row owned by another player', async () => {
    const { error } = await memberB
      .from('gallery_photo')
      .insert({
        tournament_id: tournamentId,
        uploader_id: memberAId, // not memberB → with-check fails
        storage_path: `${memberAId}/${tournamentId}-forged.jpg`,
      })
      .select()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501') // row-level security violation
  })

  // ------------------------------------------------------------------------
  it('lets a league member read photos but hides them from a non-member', async () => {
    // A bound member sees the shared photo.
    const { data: memberView, error: mErr } = await memberB
      .from('gallery_photo')
      .select('id')
      .eq('tournament_id', tournamentId)
    expect(mErr).toBeNull()
    expect((memberView ?? []).length).toBeGreaterThanOrEqual(1)

    // A signed-in non-member (no player row) sees nothing (SELECT policy).
    const { data: nonView, error: nErr } = await nonMember
      .from('gallery_photo')
      .select('id')
      .eq('tournament_id', tournamentId)
    expect(nErr).toBeNull()
    expect(nonView ?? []).toHaveLength(0)
  })

  // ------------------------------------------------------------------------
  it("blocks a non-uploader non-admin from deleting someone else's photo", async () => {
    const { data } = await memberB
      .from('gallery_photo')
      .delete()
      .eq('id', sharedPhotoId)
      .select()
    expect(data ?? []).toHaveLength(0)

    // Server truth: still there.
    const { count } = await admin
      .from('gallery_photo')
      .select('id', { count: 'exact', head: true })
      .eq('id', sharedPhotoId)
    expect(count ?? 0).toBe(1)
  })

  // ------------------------------------------------------------------------
  it('lets an admin delete any photo', async () => {
    const { data } = await adminClient
      .from('gallery_photo')
      .delete()
      .eq('id', sharedPhotoId)
      .select('id')
    expect(data ?? []).toHaveLength(1)

    const { count } = await admin
      .from('gallery_photo')
      .select('id', { count: 'exact', head: true })
      .eq('id', sharedPhotoId)
    expect(count ?? 0).toBe(0)
  })
})
