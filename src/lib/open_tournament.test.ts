import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Slice 7 — open_tournament (scheduled → live) + final-table sizing, integration
// tests against the local Supabase stack. Fixtures + the positive path run via
// the SERVICE-ROLE client (bypasses RLS, satisfies the guard's service_role
// branch). The "non-admin rejected" case signs up a real authenticated user via
// the ANON key so the internal admin guard is exercised for real.
// Gated: skips cleanly when the URL / service-role key are absent.
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const canRun = Boolean(url && serviceKey)

const LEVEL1_SECS = 1200 // level-1 duration cached into paused_remaining_seconds

describe.skipIf(!canRun)('open_tournament (slice 7, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const seasonIds: string[] = []
  const playerIds: string[] = []
  const authUserIds: string[] = []
  const RUN = crypto.randomUUID().slice(0, 8)

  // ---- fixture helpers ----------------------------------------------------
  async function mkSeason(override: Record<string, unknown> = {}) {
    const { data, error } = await admin
      .from('season')
      .insert({ name: `OT ${RUN}`, year: 2099, status: 'archived', ...override })
      .select('id')
      .single()
    if (error) throw error
    seasonIds.push(data.id)
    return data.id
  }

  async function mkBlindStructure(seasonId: string) {
    const { data, error } = await admin
      .from('blind_structure')
      .insert({ name: `BS ${RUN}`, season_id: seasonId })
      .select('id')
      .single()
    if (error) throw error
    const { error: le } = await admin.from('blind_level').insert({
      structure_id: data.id,
      level_number: 1,
      small_blind: 25,
      big_blind: 50,
      duration_seconds: LEVEL1_SECS,
    })
    if (le) throw le
    return data.id
  }

  async function mkTournament(
    seasonId: string,
    opts: {
      status?: Database['public']['Enums']['tournament_status']
      blindStructureId?: string | null
    } = {},
  ) {
    const { data, error } = await admin
      .from('tournament')
      .insert({
        season_id: seasonId,
        name: `T ${RUN}`,
        scheduled_at: '2099-06-01T20:00:00Z',
        status: opts.status ?? 'scheduled',
        blind_structure_id: opts.blindStructureId ?? null,
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  /** Insert `count` entries already checked in (checked_in_at set = turnout). */
  async function addCheckedIn(tournamentId: string, count: number) {
    const rows = playerIds.slice(0, count).map((pid) => ({
      tournament_id: tournamentId,
      player_id: pid,
      status: 'checked_in' as const,
      checked_in_at: '2099-06-01T19:30:00Z',
    }))
    const { error } = await admin.from('entry').insert(rows)
    if (error) throw error
  }

  async function open(tournamentId: string) {
    return admin.rpc('open_tournament', { p_tournament_id: tournamentId })
  }

  async function readTournament(tournamentId: string) {
    const { data, error } = await admin
      .from('tournament')
      .select('*')
      .eq('id', tournamentId)
      .single()
    if (error) throw error
    return data
  }

  beforeAll(async () => {
    await admin.from('player').delete().like('email', `ot-%@test.local`)
    const rows = Array.from({ length: 12 }, (_, i) => ({
      name: `OT ${RUN}-${i}`,
      email: `ot-${RUN}-${i}@test.local`,
    }))
    const { data, error } = await admin.from('player').insert(rows).select('id')
    if (error) throw error
    playerIds.push(...(data ?? []).map((r) => r.id))
  })

  afterAll(async () => {
    for (const id of seasonIds) await admin.from('season').delete().eq('id', id)
    if (playerIds.length) await admin.from('player').delete().in('id', playerIds)
    for (const uid of authUserIds) await admin.auth.admin.deleteUser(uid)
  })

  // ------------------------------------------------------------------------
  it('opens a scheduled fecha → live, clock initialized (paused @ level 1), small field ≤10 → 5', async () => {
    const s = await mkSeason()
    const bs = await mkBlindStructure(s)
    const t = await mkTournament(s, { blindStructureId: bs })
    await addCheckedIn(t, 6) // small turnout (≤10)

    const { data, error } = await open(t)
    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)
    expect(data!.length).toBe(1)

    const row = await readTournament(t)
    expect(row.status).toBe('live')
    // clock: paused at level 1, level_started_at stamped, remaining = level-1 dur
    expect(row.current_level).toBe(1)
    expect(row.is_paused).toBe(true)
    expect(row.level_started_at).not.toBeNull()
    expect(row.paused_remaining_seconds).toBe(LEVEL1_SECS)
    // final_table_size resolved from turnout: 6 checked in (≤10) → 5
    expect(row.final_table_size).toBe(5)
  })

  // ------------------------------------------------------------------------
  it('final_table_size tracks real turnout: 0 at open → 5, then recompute after 12 check-ins → 10', async () => {
    const s = await mkSeason()
    const t = await mkTournament(s) // no blind structure → paused_remaining_seconds null

    // At open, nobody has checked in yet → provisional 5 (documents that a value
    // frozen at open would be wrong; the size must follow turnout).
    const { error } = await open(t)
    expect(error).toBeNull()
    expect((await readTournament(t)).final_table_size).toBe(5)
    expect((await readTournament(t)).paused_remaining_seconds).toBeNull()

    // Simulate slice-10 check-in: 12 players check in, then recompute (this is
    // the cadence slice-10's check_in RPC MUST run after each check-in).
    await addCheckedIn(t, 12)
    const { data: size, error: rErr } = await admin.rpc('recompute_final_table_size', {
      p_tournament_id: t,
    })
    expect(rErr).toBeNull()
    expect(size).toBe(10) // 12 checked in (>10) → 10
    expect((await readTournament(t)).final_table_size).toBe(10) // stored/refreshed
  })

  // ------------------------------------------------------------------------
  it('rejects re-opening a live tournament', async () => {
    const s = await mkSeason()
    const t = await mkTournament(s, { status: 'live' })
    const { error } = await open(t)
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/only a scheduled tournament/i)
  })

  // ------------------------------------------------------------------------
  it('rejects re-opening a completed tournament', async () => {
    const s = await mkSeason()
    const t = await mkTournament(s, { status: 'completed' })
    const { error } = await open(t)
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/only a scheduled tournament/i)
  })

  // ------------------------------------------------------------------------
  it.skipIf(!anonKey)('rejects a non-admin (authenticated, non-owner) caller', async () => {
    const s = await mkSeason()
    const t = await mkTournament(s) // scheduled + real → hits the admin guard

    // Sign up a fresh authenticated user (enable_confirmations=false → immediate
    // session) with the anon key; they have no player row → not admin, not owner.
    const userClient = createClient<Database>(url, anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const email = `ot-nonadmin-${RUN}-${crypto.randomUUID().slice(0, 8)}@test.local`
    const { data: signUp, error: suErr } = await userClient.auth.signUp({
      email,
      password: `Pw-${crypto.randomUUID()}`,
    })
    expect(suErr).toBeNull()
    expect(signUp.session).not.toBeNull() // authenticated non-admin session
    if (signUp.user) authUserIds.push(signUp.user.id)

    const { error } = await userClient.rpc('open_tournament', { p_tournament_id: t })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/admin only/i)

    // Guard actually blocked the write: status stays scheduled.
    expect((await readTournament(t)).status).toBe('scheduled')
  })
})
