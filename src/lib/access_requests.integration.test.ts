import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Phase 3 — access requests + admin approval (migration 0022), integration
// against the local Supabase stack.
//   • request_access → 'member' for an existing player (case-insensitive), and
//     'pending' for an unknown email (creating exactly one normalized row).
//   • approve_request (admin/service_role) creates the player, marks the request
//     approved (+decided_at) and RETURNS the email; request_access then flips to
//     'member'. Non-admin approve/reject raises and mutates nothing.
//   • reject_request marks the request rejected and request_access keeps
//     returning 'rejected' (no silent re-open); no player is created.
//
// request_access is ANON-callable, so the gate assertions use a keyless anon
// client. Setup + admin RPCs use the SERVICE-ROLE client. Everything created is
// tagged `acc-<RUN>-…@test.local` and torn down in afterAll. Gated: skips when
// the URL / service-role / anon keys are absent.
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const canRun = Boolean(url && serviceKey && anonKey)

describe.skipIf(!canRun)('access requests (0022, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const anon: SupabaseClient<Database> = createClient<Database>(url, anonKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const RUN = crypto.randomUUID().slice(0, 8)
  const playerIds: string[] = []
  const authUserIds: string[] = []
  const email = (tag: string) => `acc-${RUN}-${tag}@test.local`

  async function mkPlayer(addr: string) {
    const { data, error } = await admin
      .from('player')
      .insert({ name: `ACC ${RUN}`, email: addr })
      .select('id')
      .single()
    if (error) throw error
    playerIds.push(data.id)
    return data.id
  }

  async function mkSignedInMember(opts: { isAdmin?: boolean } = {}) {
    const addr = email(`m-${crypto.randomUUID().slice(0, 8)}`)
    const { data: p, error: pErr } = await admin
      .from('player')
      .insert({ name: `ACC ${RUN}`, email: addr, is_admin: opts.isAdmin ?? false })
      .select('id')
      .single()
    if (pErr) throw pErr
    playerIds.push(p.id)
    const client = createClient<Database>(url, anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: su, error: suErr } = await client.auth.signUp({
      email: addr,
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

  async function requestId(addr: string) {
    const { data, error } = await admin
      .from('signup_request')
      .select('id')
      .eq('email', addr)
      .single()
    if (error) throw error
    return data.id
  }

  beforeAll(async () => {
    await admin.from('signup_request').delete().like('email', `acc-%@test.local`)
    await admin.from('player').delete().like('email', `acc-%@test.local`)
  }, 30_000)

  afterAll(async () => {
    // signup_request first (decided_by FK → player), then players, then auth users.
    await admin.from('signup_request').delete().like('email', `acc-%@test.local`)
    if (playerIds.length) await admin.from('player').delete().in('id', playerIds)
    await admin.from('player').delete().like('email', `acc-%@test.local`)
    for (const uid of authUserIds) await admin.auth.admin.deleteUser(uid)
  })

  // ------------------------------------------------------------------------
  it("returns 'member' for an existing player's email (case-insensitive)", async () => {
    const addr = email('member')
    await mkPlayer(addr)

    const { data, error } = await anon.rpc('request_access', { p_email: addr })
    expect(error).toBeNull()
    expect(data).toBe('member')

    // Case + whitespace insensitive.
    const upper = await anon.rpc('request_access', { p_email: `  ${addr.toUpperCase()} ` })
    expect(upper.data).toBe('member')

    // A member never leaves a signup_request row.
    const { count } = await admin
      .from('signup_request')
      .select('id', { count: 'exact', head: true })
      .eq('email', addr)
    expect(count ?? 0).toBe(0)
  })

  // ------------------------------------------------------------------------
  it("returns 'pending' for an unknown email and creates exactly one normalized row", async () => {
    const addr = email('unknown')

    // Sent messy (mixed case + padding); stored normalized (lower/trim).
    const { data, error } = await anon.rpc('request_access', { p_email: `  ${addr.toUpperCase()} ` })
    expect(error).toBeNull()
    expect(data).toBe('pending')

    const { data: row } = await admin
      .from('signup_request')
      .select('email, status')
      .eq('email', addr)
      .maybeSingle()
    expect(row).toBeTruthy()
    expect(row!.email).toBe(addr) // normalized
    expect(row!.status).toBe('pending')

    // Idempotent: a second attempt stays 'pending' with no duplicate row.
    const again = await anon.rpc('request_access', { p_email: addr })
    expect(again.data).toBe('pending')
    const { count } = await admin
      .from('signup_request')
      .select('id', { count: 'exact', head: true })
      .eq('email', addr)
    expect(count ?? 0).toBe(1)
  })

  // ------------------------------------------------------------------------
  it('approve_request creates the player, marks approved and returns the email', async () => {
    const addr = email('approve')
    await anon.rpc('request_access', { p_email: addr })
    const id = await requestId(addr)

    const { data: returned, error } = await admin.rpc('approve_request', { p_id: id })
    expect(error).toBeNull()
    expect(returned).toBe(addr)

    // A real, non-admin, non-guest player now exists for that email.
    const { data: p, error: pErr } = await admin
      .from('player')
      .select('id, is_admin, is_guest')
      .eq('email', addr)
      .single()
    expect(pErr).toBeNull()
    expect(p!.is_admin).toBe(false)
    expect(p!.is_guest).toBe(false)
    playerIds.push(p!.id)

    // The request is stamped approved.
    const { data: after } = await admin
      .from('signup_request')
      .select('status, decided_at')
      .eq('id', id)
      .single()
    expect(after!.status).toBe('approved')
    expect(after!.decided_at).not.toBeNull()

    // request_access now recognizes them as a member.
    const gate = await anon.rpc('request_access', { p_email: addr })
    expect(gate.data).toBe('member')
  })

  // ------------------------------------------------------------------------
  it('non-admin approve/reject raises and mutates nothing', async () => {
    const addr = email('guard')
    await anon.rpc('request_access', { p_email: addr })
    const id = await requestId(addr)
    const nonAdmin = await mkSignedInMember({ isAdmin: false })

    const denyApprove = await nonAdmin.client.rpc('approve_request', { p_id: id })
    expect(denyApprove.error).not.toBeNull()
    const denyReject = await nonAdmin.client.rpc('reject_request', { p_id: id })
    expect(denyReject.error).not.toBeNull()

    // Still pending; no player was created.
    const { data: st } = await admin
      .from('signup_request')
      .select('status')
      .eq('id', id)
      .single()
    expect(st!.status).toBe('pending')
    const { count } = await admin
      .from('player')
      .select('id', { count: 'exact', head: true })
      .eq('email', addr)
    expect(count ?? 0).toBe(0)
  })

  // ------------------------------------------------------------------------
  it('reject_request marks rejected; request_access keeps returning rejected', async () => {
    const addr = email('reject')
    await anon.rpc('request_access', { p_email: addr })
    const id = await requestId(addr)

    const { error } = await admin.rpc('reject_request', { p_id: id })
    expect(error).toBeNull()

    const { data: after } = await admin
      .from('signup_request')
      .select('status, decided_at')
      .eq('id', id)
      .single()
    expect(after!.status).toBe('rejected')
    expect(after!.decided_at).not.toBeNull()

    // Does NOT silently re-open, and never creates a player.
    const gate = await anon.rpc('request_access', { p_email: addr })
    expect(gate.data).toBe('rejected')
    const { count } = await admin
      .from('player')
      .select('id', { count: 'exact', head: true })
      .eq('email', addr)
    expect(count ?? 0).toBe(0)
  })
})
