import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Slice 9 — rsvp / cancel_rsvp, integration tests against the local Supabase
// stack. Fixtures (season / tournament / player rows) are created via the
// SERVICE-ROLE client. The RSVP/cancel calls themselves are driven by a REAL
// signed-in test user (anon key → sign-up → immediate session, then bound to a
// pre-created player row) so auth_player_id() resolves for real and the SECURITY
// DEFINER path is exercised end-to-end.
// Gated: skips cleanly when URL / service-role / anon keys are absent.
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const canRun = Boolean(url && serviceKey && anonKey)

const HOUR_MS = 3_600_000

describe.skipIf(!canRun)('rsvp / cancel_rsvp (slice 9, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const RUN = crypto.randomUUID().slice(0, 8)
  const seasonIds: string[] = []
  const playerIds: string[] = []
  const authUserIds: string[] = []

  let seasonId: string
  // Primary signed-in test user (a bound league member).
  let member: SupabaseClient<Database>
  let memberPlayerId: string

  // ---- fixtures -----------------------------------------------------------
  async function mkSeason() {
    const { data, error } = await admin
      .from('season')
      .insert({ name: `RSVP ${RUN}`, year: 2099, status: 'archived' })
      .select('id')
      .single()
    if (error) throw error
    seasonIds.push(data.id)
    return data.id
  }

  async function mkTournament(scheduledAt: string, status: 'scheduled' | 'live' = 'scheduled') {
    const { data, error } = await admin
      .from('tournament')
      .insert({ season_id: seasonId, name: `T ${RUN}`, scheduled_at: scheduledAt, status })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  /** Create a player row, sign up a matching auth user, bind the two, return a client. */
  async function mkSignedInMember() {
    const email = `rsvp-${RUN}-${crypto.randomUUID().slice(0, 8)}@test.local`
    const { data: p, error: pErr } = await admin
      .from('player')
      .insert({ name: `RSVP ${RUN}`, email })
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

  async function readEntry(tournamentId: string, playerId: string) {
    const { data, error } = await admin
      .from('entry')
      .select('*')
      .eq('tournament_id', tournamentId)
      .eq('player_id', playerId)
      .maybeSingle()
    if (error) throw error
    return data
  }

  beforeAll(async () => {
    await admin.from('player').delete().like('email', 'rsvp-%@test.local')
    seasonId = await mkSeason()
    const m = await mkSignedInMember()
    member = m.client
    memberPlayerId = m.playerId
  }, 30_000)

  afterAll(async () => {
    for (const id of seasonIds) await admin.from('season').delete().eq('id', id)
    if (playerIds.length) await admin.from('player').delete().in('id', playerIds)
    for (const uid of authUserIds) await admin.auth.admin.deleteUser(uid)
  })

  // ------------------------------------------------------------------------
  it("rsvp('confirm') upserts the caller's entry to confirmed + stamps rsvp_at", async () => {
    const t = await mkTournament(new Date(Date.now() + 48 * HOUR_MS).toISOString())

    const { data, error } = await member.rpc('rsvp', { p_tournament_id: t, p_choice: 'confirm' })
    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)
    expect(data!.length).toBe(1)

    const entry = await readEntry(t, memberPlayerId)
    expect(entry!.status).toBe('confirmed')
    expect(entry!.rsvp_at).not.toBeNull()
    expect(entry!.points_earned).toBeNull()
  })

  // ------------------------------------------------------------------------
  it("rsvp('decline') is penalty-free (declined, no points deducted)", async () => {
    const t = await mkTournament(new Date(Date.now() + 3 * HOUR_MS).toISOString())

    const { error } = await member.rpc('rsvp', { p_tournament_id: t, p_choice: 'decline' })
    expect(error).toBeNull()

    const entry = await readEntry(t, memberPlayerId)
    expect(entry!.status).toBe('declined')
    // Plain "No voy" carries no penalty even inside the <6h window.
    expect(entry!.points_earned).toBeNull()
    expect(entry!.cancelled_at).toBeNull()
  })

  // ------------------------------------------------------------------------
  it.each([
    { hours: 30, penalty: 0 },
    { hours: 20, penalty: -5 },
    { hours: 9, penalty: -10 },
    { hours: 3, penalty: -15 },
  ])('cancel_rsvp at ~%s applies the graduated band penalty', async ({ hours, penalty }) => {
    const t = await mkTournament(new Date(Date.now() + hours * HOUR_MS).toISOString())
    // Confirm first, then cancel.
    await member.rpc('rsvp', { p_tournament_id: t, p_choice: 'confirm' })

    const { error } = await member.rpc('cancel_rsvp', { p_tournament_id: t })
    expect(error).toBeNull()

    const entry = await readEntry(t, memberPlayerId)
    expect(entry!.status).toBe('declined')
    expect(entry!.cancelled_at).not.toBeNull()
    expect(entry!.points_earned).toBe(penalty)
  })

  // ------------------------------------------------------------------------
  it('cancel_rsvp is idempotent — a second call does not double-charge', async () => {
    const t = await mkTournament(new Date(Date.now() + 9 * HOUR_MS).toISOString())
    await member.rpc('rsvp', { p_tournament_id: t, p_choice: 'confirm' })

    await member.rpc('cancel_rsvp', { p_tournament_id: t })
    const first = await readEntry(t, memberPlayerId)
    expect(first!.points_earned).toBe(-10)

    // Repeat — already declined → no-op, penalty unchanged.
    const { error } = await member.rpc('cancel_rsvp', { p_tournament_id: t })
    expect(error).toBeNull()
    const second = await readEntry(t, memberPlayerId)
    expect(second!.points_earned).toBe(-10)
    expect(second!.status).toBe('declined')
  })

  // ------------------------------------------------------------------------
  it('rejects rsvp once the fecha is opened (status = live)', async () => {
    const t = await mkTournament(new Date(Date.now() + 24 * HOUR_MS).toISOString(), 'live')

    const { error } = await member.rpc('rsvp', { p_tournament_id: t, p_choice: 'confirm' })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/locked once the fecha is opened/i)
  })

  // ------------------------------------------------------------------------
  it('rejects cancel_rsvp once the fecha is opened (status = live)', async () => {
    // Confirm while scheduled, then the admin opens the fecha → cancel is frozen.
    const t = await mkTournament(new Date(Date.now() + 9 * HOUR_MS).toISOString(), 'scheduled')
    await member.rpc('rsvp', { p_tournament_id: t, p_choice: 'confirm' })
    await admin.from('tournament').update({ status: 'live' }).eq('id', t)

    const { error } = await member.rpc('cancel_rsvp', { p_tournament_id: t })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/locked once the fecha is opened/i)

    // Entry stays confirmed + unpenalized.
    const entry = await readEntry(t, memberPlayerId)
    expect(entry!.status).toBe('confirmed')
    expect(entry!.points_earned).toBeNull()
  })

  // ------------------------------------------------------------------------
  it('rejects a signed-in user who is not a league member', async () => {
    const t = await mkTournament(new Date(Date.now() + 24 * HOUR_MS).toISOString())
    // A fresh auth user with NO bound player row.
    const stranger = createClient<Database>(url, anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: su } = await stranger.auth.signUp({
      email: `rsvp-stranger-${RUN}-${crypto.randomUUID().slice(0, 8)}@test.local`,
      password: `Pw-${crypto.randomUUID()}`,
    })
    if (su.user) authUserIds.push(su.user.id)

    const { error } = await stranger.rpc('rsvp', { p_tournament_id: t, p_choice: 'confirm' })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/not a league member/i)
  })
})
