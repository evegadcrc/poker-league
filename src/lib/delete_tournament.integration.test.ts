import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// mig 0020 — delete_tournament(id), integration against the local Supabase
// stack. Proves the RPC is ADMIN-GATED (a signed-in non-admin member's call
// raises and deletes nothing) and CASCADES (an admin's call removes the fecha
// AND its entries + gallery_photo rows).
//
// ISOLATION (per the flaky-test lesson): fixtures hang off a THROWAWAY archived
// season (year 2097) with a unique RUN tag; the suite runs serial
// (fileParallelism:false) so it never overlaps other DB files. Setup uses the
// SERVICE-ROLE client (bypasses RLS); the RPC calls run through REAL signed-in
// clients (anon key + a session) so the internal admin gate is what's tested.
// Gated: skips cleanly when the URL / service-role / anon keys are absent.
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const canRun = Boolean(url && serviceKey && anonKey)

describe.skipIf(!canRun)('delete_tournament (0020, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const RUN = crypto.randomUUID().slice(0, 8)
  const playerIds: string[] = []
  const authUserIds: string[] = []
  const tournamentIds: string[] = []
  let seasonId: string
  let subjectPlayerId: string
  let memberClient: SupabaseClient<Database>
  let adminClient: SupabaseClient<Database>

  async function mkSeason() {
    const { data, error } = await admin
      .from('season')
      .insert({ name: `DEL ${RUN}`, year: 2097, status: 'archived' })
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
        name: `DEL ${RUN}`,
        scheduled_at: new Date().toISOString(),
        status: 'scheduled',
      })
      .select('id')
      .single()
    if (error) throw error
    tournamentIds.push(data.id)
    return data.id as string
  }

  async function mkEntry(tournamentId: string) {
    const { data, error } = await admin
      .from('entry')
      .insert({ tournament_id: tournamentId, player_id: subjectPlayerId, status: 'confirmed' })
      .select('id')
      .single()
    if (error) throw error
    return data.id as string
  }

  async function mkGalleryPhoto(tournamentId: string) {
    const { data, error } = await admin
      .from('gallery_photo')
      .insert({
        tournament_id: tournamentId,
        uploader_id: subjectPlayerId,
        storage_path: `${subjectPlayerId}/${tournamentId}-${crypto.randomUUID()}.jpg`,
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id as string
  }

  // A player row (optionally admin) + a bound, signed-in anon client.
  async function mkSignedInMember(opts: { isAdmin?: boolean } = {}) {
    const email = `del-${RUN}-${crypto.randomUUID().slice(0, 8)}@test.local`
    const { data: p, error: pErr } = await admin
      .from('player')
      .insert({ name: `DEL ${RUN}`, email, is_admin: opts.isAdmin ?? false })
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

  async function tournamentExists(id: string) {
    const { count } = await admin
      .from('tournament')
      .select('id', { count: 'exact', head: true })
      .eq('id', id)
    return (count ?? 0) === 1
  }

  beforeAll(async () => {
    await admin.from('player').delete().like('email', 'del-%@test.local')
    seasonId = await mkSeason()

    const member = await mkSignedInMember()
    memberClient = member.client
    subjectPlayerId = member.playerId
    adminClient = (await mkSignedInMember({ isAdmin: true })).client
  }, 40_000)

  afterAll(async () => {
    for (const id of tournamentIds) await admin.from('tournament').delete().eq('id', id)
    await admin.from('season').delete().eq('id', seasonId)
    if (playerIds.length) await admin.from('player').delete().in('id', playerIds)
    for (const uid of authUserIds) await admin.auth.admin.deleteUser(uid)
  })

  // ------------------------------------------------------------------------
  it('rejects a non-admin member and deletes nothing', async () => {
    const tid = await mkTournament()
    await mkEntry(tid)

    const { error } = await memberClient.rpc('delete_tournament', { p_id: tid })
    expect(error).not.toBeNull() // the internal admin gate raised

    // Server truth: the fecha is still there.
    expect(await tournamentExists(tid)).toBe(true)
  })

  // ------------------------------------------------------------------------
  it('lets an admin hard-delete the fecha and cascades entries + gallery', async () => {
    const tid = await mkTournament()
    await mkEntry(tid)
    await mkGalleryPhoto(tid)

    const { error } = await adminClient.rpc('delete_tournament', { p_id: tid })
    expect(error).toBeNull()

    // Tournament gone.
    expect(await tournamentExists(tid)).toBe(false)

    // Its entries gone.
    const { count: entryCount } = await admin
      .from('entry')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tid)
    expect(entryCount ?? 0).toBe(0)

    // Its gallery photos gone.
    const { count: galCount } = await admin
      .from('gallery_photo')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tid)
    expect(galCount ?? 0).toBe(0)
  })

  // ------------------------------------------------------------------------
  it('raises for a non-existent fecha (admin caller)', async () => {
    const { error } = await adminClient.rpc('delete_tournament', {
      p_id: crypto.randomUUID(),
    })
    expect(error).not.toBeNull()
  })
})
