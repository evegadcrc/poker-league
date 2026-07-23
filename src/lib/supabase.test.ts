import { describe, it, expect } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// Local-stack integration test. Skips cleanly when env is absent so CI without
// a running Supabase stack does not hard-fail.
const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const hasEnv = Boolean(url && anonKey)

describe.skipIf(!hasEnv)('supabase client (local integration)', () => {
  it('exported anon client connects and runs a typed query on season', async () => {
    // Uses the real exported client (throws at import if env is misconfigured).
    const { supabase } = await import('@/lib/supabase')
    const { data, error } = await supabase.from('season').select('id, name, year')
    // Connectivity + typing proof. RLS restricts season SELECT to `authenticated`
    // (see 0001_init.sql), so an unauthenticated anon client legitimately gets []
    // (not an error). Authenticated reads land in slice 4 (auth).
    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)
  })

  it.skipIf(!serviceKey)('sees the seeded "Liga 2026" season (RLS bypass)', async () => {
    // Service-role client bypasses RLS to assert the seed row exists.
    const admin = createClient<Database>(url, serviceKey as string)
    const { data, error } = await admin
      .from('season')
      .select('name, year, status')
      .eq('name', 'Liga 2026')
      .single()
    expect(error).toBeNull()
    expect(data?.year).toBe(2026)
    expect(data?.status).toBe('active')
  })
})
