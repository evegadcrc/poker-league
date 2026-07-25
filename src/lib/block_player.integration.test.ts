import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Migration 0023 — block a player. Proves:
//   * set_player_blocked is admin-only (a non-admin member is rejected),
//   * it blocks + unblocks a normal player,
//   * an admin cannot block THEMSELVES nor another admin,
//   * a BLOCKED player's claim_player returns no rows (can't log in / bind)
//     while a normal player still binds.
//
// Isolation: every player hangs off unique `blk-…@test.local` emails and is torn
// down in afterAll; the suite runs serial (fileParallelism:false) so it never
// overlaps other DB files. Setup uses the SERVICE-ROLE client (bypasses RLS);
// the assertions run through REAL signed-in members so the gates are under test.
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const canRun = Boolean(url && serviceKey && anonKey)

describe.skipIf(!canRun)('set_player_blocked + claim_player block (0023, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const RUN = crypto.randomUUID().slice(0, 8)
  const playerIds: string[] = []
  const authUserIds: string[] = []

  // Sign up a fresh auth user + its player row. `bind` mirrors first-login: when
  // true we set auth_user_id via service-role so auth_player_id() resolves for
  // the member (needed for the self-block guard); when false we leave the row
  // unbound so claim_player can attempt (or refuse) the bind itself.
  async function mkMember(opts: { isAdmin?: boolean; bind?: boolean } = {}) {
    const email = `blk-${RUN}-${crypto.randomUUID().slice(0, 8)}@test.local`
    const { data: p, error: pErr } = await admin
      .from('player')
      .insert({ name: `BLK ${RUN}`, email, is_admin: opts.isAdmin ?? false })
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

    if (opts.bind ?? true) {
      const { error: bindErr } = await admin
        .from('player')
        .update({ auth_user_id: su.user!.id })
        .eq('id', p.id)
      if (bindErr) throw bindErr
    }
    return { client, playerId: p.id, email, authUserId: su.user!.id }
  }

  async function readPlayer(id: string) {
    const { data, error } = await admin.from('player').select('*').eq('id', id).single()
    if (error) throw error
    return data
  }

  beforeAll(async () => {
    await admin.from('player').delete().like('email', 'blk-%@test.local')
  }, 30_000)

  afterAll(async () => {
    if (playerIds.length) await admin.from('player').delete().in('id', playerIds)
    for (const uid of authUserIds) await admin.auth.admin.deleteUser(uid)
  })

  // ------------------------------------------------------------------------
  it('rejects set_player_blocked from a non-admin member', async () => {
    const nonAdmin = await mkMember({ isAdmin: false })
    const target = await mkMember({ isAdmin: false })

    const { error } = await nonAdmin.client.rpc('set_player_blocked', {
      p_player_id: target.playerId,
      p_blocked: true,
    })
    expect(error).not.toBeNull()
    // Server truth: unchanged.
    expect((await readPlayer(target.playerId)).blocked).toBe(false)
  })

  // ------------------------------------------------------------------------
  it('lets an admin block then unblock a normal player', async () => {
    const adminMember = await mkMember({ isAdmin: true })
    const target = await mkMember({ isAdmin: false })

    const block = await adminMember.client.rpc('set_player_blocked', {
      p_player_id: target.playerId,
      p_blocked: true,
    })
    expect(block.error).toBeNull()
    expect((await readPlayer(target.playerId)).blocked).toBe(true)

    const unblock = await adminMember.client.rpc('set_player_blocked', {
      p_player_id: target.playerId,
      p_blocked: false,
    })
    expect(unblock.error).toBeNull()
    expect((await readPlayer(target.playerId)).blocked).toBe(false)
  })

  // ------------------------------------------------------------------------
  it('forbids an admin from blocking themselves or another admin', async () => {
    const adminMember = await mkMember({ isAdmin: true })
    const otherAdmin = await mkMember({ isAdmin: true })

    const self = await adminMember.client.rpc('set_player_blocked', {
      p_player_id: adminMember.playerId,
      p_blocked: true,
    })
    expect(self.error).not.toBeNull()
    expect((await readPlayer(adminMember.playerId)).blocked).toBe(false)

    const peer = await adminMember.client.rpc('set_player_blocked', {
      p_player_id: otherAdmin.playerId,
      p_blocked: true,
    })
    expect(peer.error).not.toBeNull()
    expect((await readPlayer(otherAdmin.playerId)).blocked).toBe(false)
  })

  // ------------------------------------------------------------------------
  // A blocked player's claim_player returns 0 rows AND does not bind, while a
  // normal (unblocked) player binds on first login.
  it('claim_player returns no rows for a blocked player but binds a normal one', async () => {
    // Blocked, unbound member: block via service-role BEFORE the first claim.
    const blocked = await mkMember({ isAdmin: false, bind: false })
    const setBlk = await admin.rpc('set_player_blocked', {
      p_player_id: blocked.playerId,
      p_blocked: true,
    })
    expect(setBlk.error).toBeNull()

    const blockedClaim = await blocked.client.rpc('claim_player')
    expect(blockedClaim.error).toBeNull()
    expect(blockedClaim.data ?? []).toHaveLength(0)
    // Not bound — unblocking later still permits a clean first-login bind.
    expect((await readPlayer(blocked.playerId)).auth_user_id).toBeNull()

    // Normal, unbound member: claim binds on first login.
    const normal = await mkMember({ isAdmin: false, bind: false })
    const normalClaim = await normal.client.rpc('claim_player')
    expect(normalClaim.error).toBeNull()
    expect(normalClaim.data ?? []).toHaveLength(1)
    expect(normalClaim.data?.[0]?.auth_user_id).toBe(normal.authUserId)
  })
})
