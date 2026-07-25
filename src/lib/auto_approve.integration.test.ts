import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Phase 3 — auto-approve access requests (migration 0026), integration against
// the local Supabase stack.
//   • OFF (default): an unknown email → 'pending' + a signup_request row.
//   • ON (set via set_auto_approve as admin/service_role): an unknown email →
//     'member' + a NEW non-admin player row + NO pending request; a member email
//     still → 'member'.
//   • set_auto_approve rejects a non-admin (flag unchanged).
//
// request_access is ANON-callable, so the gate assertions use a keyless anon
// client; setup + admin RPCs use the SERVICE-ROLE client. The flag lives on the
// single ACTIVE season (shared state) — every path here RESTORES it to false so
// no later file sees it on. Everything created is tagged `aa-<RUN>-…@test.local`
// and torn down in afterAll. Gated: skips when the keys are absent.
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const canRun = Boolean(url && serviceKey && anonKey)

describe.skipIf(!canRun)('auto-approve signups (0026, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const anon: SupabaseClient<Database> = createClient<Database>(url, anonKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const RUN = crypto.randomUUID().slice(0, 8)
  const playerIds: string[] = []
  const authUserIds: string[] = []
  const email = (tag: string) => `aa-${RUN}-${tag}@test.local`

  // Directly flip the flag on the active season (service_role bypasses RLS) —
  // used to restore the default regardless of what a test did.
  async function setFlag(on: boolean) {
    const { error } = await admin.from('season').update({ auto_approve_signups: on }).eq('status', 'active')
    if (error) throw error
  }

  async function readFlag(): Promise<boolean> {
    const { data, error } = await admin
      .from('season')
      .select('auto_approve_signups')
      .eq('status', 'active')
      .order('year', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return Boolean(data?.auto_approve_signups)
  }

  async function mkPlayer(addr: string) {
    const { data, error } = await admin
      .from('player')
      .insert({ name: `AA ${RUN}`, email: addr })
      .select('id')
      .single()
    if (error) throw error
    playerIds.push(data.id)
    return data.id
  }

  async function mkSignedInMember() {
    const addr = email(`m-${crypto.randomUUID().slice(0, 8)}`)
    const { data: p, error: pErr } = await admin
      .from('player')
      .insert({ name: `AA ${RUN}`, email: addr, is_admin: false })
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
    return { client }
  }

  beforeAll(async () => {
    await admin.from('signup_request').delete().like('email', `aa-%@test.local`)
    await admin.from('player').delete().like('email', `aa-%@test.local`)
    await setFlag(false)
  }, 30_000)

  afterAll(async () => {
    await setFlag(false)
    await admin.from('signup_request').delete().like('email', `aa-%@test.local`)
    if (playerIds.length) await admin.from('player').delete().in('id', playerIds)
    await admin.from('player').delete().like('email', `aa-%@test.local`)
    for (const uid of authUserIds) await admin.auth.admin.deleteUser(uid)
  })

  // ------------------------------------------------------------------------
  it("OFF (default): an unknown email → 'pending' + a signup_request row", async () => {
    await setFlag(false)
    const addr = email('off-unknown')

    const { data, error } = await anon.rpc('request_access', { p_email: addr })
    expect(error).toBeNull()
    expect(data).toBe('pending')

    const { data: row } = await admin
      .from('signup_request')
      .select('email, status')
      .eq('email', addr)
      .maybeSingle()
    expect(row).toBeTruthy()
    expect(row!.status).toBe('pending')

    // No player is created while OFF.
    const { count } = await admin
      .from('player')
      .select('id', { count: 'exact', head: true })
      .eq('email', addr)
    expect(count ?? 0).toBe(0)
  })

  // ------------------------------------------------------------------------
  it('set_auto_approve rejects a non-admin and leaves the flag unchanged', async () => {
    await setFlag(false)
    const nonAdmin = await mkSignedInMember()

    const { error } = await nonAdmin.client.rpc('set_auto_approve', { p_on: true })
    expect(error).not.toBeNull()
    expect(await readFlag()).toBe(false)
  })

  // ------------------------------------------------------------------------
  it("ON: an unknown email is onboarded immediately → 'member' + NEW non-admin player + NO pending request", async () => {
    try {
      const { error: setErr } = await admin.rpc('set_auto_approve', { p_on: true })
      expect(setErr).toBeNull()
      expect(await readFlag()).toBe(true)

      const addr = email('on-unknown')
      const { data, error } = await anon.rpc('request_access', { p_email: addr })
      expect(error).toBeNull()
      expect(data).toBe('member')

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

      // No pending signup_request lingers in the admin queue for that email.
      const { count } = await admin
        .from('signup_request')
        .select('id', { count: 'exact', head: true })
        .eq('email', addr)
        .eq('status', 'pending')
      expect(count ?? 0).toBe(0)

      // A KNOWN member email still resolves to 'member' under ON (unchanged).
      const memberAddr = email('on-member')
      await mkPlayer(memberAddr)
      const gate = await anon.rpc('request_access', { p_email: memberAddr })
      expect(gate.data).toBe('member')
    } finally {
      await setFlag(false)
    }
  })
})
