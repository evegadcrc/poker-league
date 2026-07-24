import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// Gated local-stack integration test for the first-login binding RPC
// (migration 0002 `claim_player`). Needs the service-role key to create/delete
// throwaway auth users; skips cleanly when it's absent.
const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const canRun = Boolean(url && anonKey && serviceKey)

const PASSWORD = 'poker-friends-test-pw-1!'
const SEEDED_EMAIL = 'maria.rodriguez@example.com' // pre-created (non-admin) seed player
const UNKNOWN_EMAIL = 'no-such-member-8842@example.com' // no player row

describe.skipIf(!canRun)('claim_player (first-login binding, local integration)', () => {
  const admin = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  /** Delete any leftover auth user for an email so re-runs are idempotent. */
  async function deleteAuthUserByEmail(email: string) {
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
    for (const u of data.users) {
      if (u.email?.toLowerCase() === email.toLowerCase()) {
        await admin.auth.admin.deleteUser(u.id)
      }
    }
  }

  async function signedInClient(email: string): Promise<SupabaseClient<Database>> {
    const client = createClient<Database>(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD })
    if (error) throw error
    return client
  }

  beforeAll(async () => {
    await deleteAuthUserByEmail(SEEDED_EMAIL)
    await deleteAuthUserByEmail(UNKNOWN_EMAIL)
    // Ensure the seed player starts unbound.
    await admin.from('player').update({ auth_user_id: null }).eq('email', SEEDED_EMAIL)
  })

  afterAll(async () => {
    await deleteAuthUserByEmail(SEEDED_EMAIL)
    await deleteAuthUserByEmail(UNKNOWN_EMAIL)
    await admin.from('player').update({ auth_user_id: null }).eq('email', SEEDED_EMAIL)
  })

  it('binds the matching seeded player and is idempotent', async () => {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: SEEDED_EMAIL,
      password: PASSWORD,
      email_confirm: true,
    })
    expect(createErr).toBeNull()
    const authUserId = created.user?.id
    expect(authUserId).toBeTruthy()

    const client = await signedInClient(SEEDED_EMAIL)

    const first = await client.rpc('claim_player')
    expect(first.error).toBeNull()
    expect(first.data?.length).toBe(1)
    expect(first.data?.[0]?.email).toBe(SEEDED_EMAIL)
    expect(first.data?.[0]?.auth_user_id).toBe(authUserId)
    const boundPlayerId = first.data?.[0]?.id

    // Second call → same row, still bound to the same auth user (no error).
    const second = await client.rpc('claim_player')
    expect(second.error).toBeNull()
    expect(second.data?.[0]?.id).toBe(boundPlayerId)
    expect(second.data?.[0]?.auth_user_id).toBe(authUserId)
  })

  it('returns null when the email has no pre-created player', async () => {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: UNKNOWN_EMAIL,
      password: PASSWORD,
      email_confirm: true,
    })
    expect(createErr).toBeNull()
    expect(created.user?.id).toBeTruthy()

    const client = await signedInClient(UNKNOWN_EMAIL)
    const { data, error } = await client.rpc('claim_player')
    expect(error).toBeNull()
    expect(data).toEqual([]) // no pre-created player → empty set
  })
})
