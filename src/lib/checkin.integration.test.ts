import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Slice 10 — check_in / admin_check_in, integration tests against the local
// Supabase stack. Fixtures (season / tournament / player / entry rows) are
// created via the SERVICE-ROLE client. The player-facing check_in is driven by
// a REAL signed-in test user (bound to a pre-created player) so auth_player_id()
// resolves and the SECURITY DEFINER path runs end-to-end. admin_check_in is
// exercised via the service-role client (admits auth.role()='service_role').
// Gated: skips cleanly when URL / service-role / anon keys are absent.
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const canRun = Boolean(url && serviceKey && anonKey)

const HOUR_MS = 3_600_000
const STACK = 10_000
const BONUS = 5_000 // season default early_bird_bonus_chips (mig 0025)
// San José-ish venue; a same-point fix is 0 m (inside), +0.01° lat ≈ 1.1 km (outside).
const VENUE = { lat: 9.9333, lng: -84.0833 }
const OUTSIDE = { lat: 9.9433, lng: -84.0833 }
const SENTINEL = 99 // pre-set final_table_size → proves recompute overwrote it

describe.skipIf(!canRun)('check_in / admin_check_in (slice 10, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const RUN = crypto.randomUUID().slice(0, 8)
  const seasonIds: string[] = []
  const playerIds: string[] = []
  const authUserIds: string[] = []

  let seasonId: string
  let member: SupabaseClient<Database>
  let memberPlayerId: string

  async function mkSeason() {
    const { data, error } = await admin
      .from('season')
      .insert({ name: `CHK ${RUN}`, year: 2099, status: 'archived' })
      .select('id')
      .single()
    if (error) throw error
    seasonIds.push(data.id)
    return data.id
  }

  async function mkTournament(opts: {
    scheduledAt: string
    status?: 'scheduled' | 'live' | 'completed'
    withVenue?: boolean
    cancelledAt?: string
  }) {
    const { data, error } = await admin
      .from('tournament')
      .insert({
        season_id: seasonId,
        name: `T ${RUN}`,
        scheduled_at: opts.scheduledAt,
        status: opts.status ?? 'live',
        cancelled_at: opts.cancelledAt ?? null,
        venue_lat: opts.withVenue === false ? null : VENUE.lat,
        venue_lng: opts.withVenue === false ? null : VENUE.lng,
        geofence_radius_m: 100,
        starting_stack: STACK,
        final_table_size: SENTINEL,
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  async function mkConfirmedEntry(tournamentId: string) {
    const { data, error } = await admin
      .from('entry')
      .insert({
        tournament_id: tournamentId,
        player_id: memberPlayerId,
        status: 'confirmed',
        rsvp_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  async function mkEntry(tournamentId: string, status: 'invited' | 'declined' | 'no_show') {
    const { data, error } = await admin
      .from('entry')
      .insert({ tournament_id: tournamentId, player_id: memberPlayerId, status })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  async function mkSignedInMember() {
    const email = `chk-${RUN}-${crypto.randomUUID().slice(0, 8)}@test.local`
    const { data: p, error: pErr } = await admin
      .from('player')
      .insert({ name: `CHK ${RUN}`, email })
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

  async function readEntry(tournamentId: string) {
    const { data, error } = await admin
      .from('entry')
      .select('*')
      .eq('tournament_id', tournamentId)
      .eq('player_id', memberPlayerId)
      .maybeSingle()
    if (error) throw error
    return data
  }

  async function readFinalTableSize(tournamentId: string) {
    const { data, error } = await admin
      .from('tournament')
      .select('final_table_size')
      .eq('id', tournamentId)
      .single()
    if (error) throw error
    return data.final_table_size
  }

  beforeAll(async () => {
    await admin.from('player').delete().like('email', 'chk-%@test.local')
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
  // NEW MODEL (mig 0031): on time ⇔ checked in while PRE-LIVE (status='scheduled').
  // A LIVE check-in earns NO early-bird bonus even if the scheduled start is still
  // in the future — the door has opened, so it is "late" by the bonus rule.
  it('live check-in (before scheduled start) → checked_in, NO early-bird (bonus is pre-live only)', async () => {
    const t = await mkTournament({ scheduledAt: new Date(Date.now() + 2 * HOUR_MS).toISOString() })
    await mkConfirmedEntry(t)

    const { error } = await member.rpc('check_in', {
      p_tournament_id: t,
      p_lat: VENUE.lat,
      p_lng: VENUE.lng,
    })
    expect(error).toBeNull()

    const entry = await readEntry(t)
    expect(entry!.status).toBe('checked_in')
    expect(entry!.check_in_geo_ok).toBe(true)
    expect(entry!.early_bird).toBe(false)
    expect(entry!.chips).toBe(STACK)
    expect(entry!.checked_in_at).not.toBeNull()
    // recompute overwrote the sentinel: 1 checked-in ≤10 → size 5.
    expect(await readFinalTableSize(t)).toBe(5)
  })

  // ------------------------------------------------------------------------
  it('live check-in (after start) → checked_in, no early-bird bonus', async () => {
    const t = await mkTournament({ scheduledAt: new Date(Date.now() - 2 * HOUR_MS).toISOString() })
    await mkConfirmedEntry(t)

    const { error } = await member.rpc('check_in', {
      p_tournament_id: t,
      p_lat: VENUE.lat,
      p_lng: VENUE.lng,
    })
    expect(error).toBeNull()

    const entry = await readEntry(t)
    expect(entry!.status).toBe('checked_in')
    expect(entry!.early_bird).toBe(false)
    expect(entry!.chips).toBe(STACK)
  })

  // ------------------------------------------------------------------------
  it('outside the geofence → rejected, entry stays confirmed', async () => {
    const t = await mkTournament({ scheduledAt: new Date(Date.now() + 2 * HOUR_MS).toISOString() })
    await mkConfirmedEntry(t)

    const { error } = await member.rpc('check_in', {
      p_tournament_id: t,
      p_lat: OUTSIDE.lat,
      p_lng: OUTSIDE.lng,
    })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/fuera de la sede/i)

    const entry = await readEntry(t)
    expect(entry!.status).toBe('confirmed')
    expect(entry!.checked_in_at).toBeNull()
  })

  // ------------------------------------------------------------------------
  // ON TIME (mig 0031): checked in while the fecha is still PRE-LIVE (scheduled,
  // before the admin opened it) → early-bird bonus + "A tiempo". This is the
  // canonical on-time case, independent of the scheduled start clock.
  it('scheduled (pre-live) → checked_in, early_bird, chips = stack+bonus (on time)', async () => {
    const t = await mkTournament({
      scheduledAt: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
      status: 'scheduled',
    })
    await mkConfirmedEntry(t)

    const { error } = await member.rpc('check_in', {
      p_tournament_id: t,
      p_lat: VENUE.lat,
      p_lng: VENUE.lng,
    })
    expect(error).toBeNull()

    const entry = await readEntry(t)
    expect(entry!.status).toBe('checked_in')
    expect(entry!.check_in_geo_ok).toBe(true)
    expect(entry!.early_bird).toBe(true)
    expect(entry!.chips).toBe(STACK + BONUS)
    expect(await readFinalTableSize(t)).toBe(5)
  })

  // ------------------------------------------------------------------------
  it('completed fecha → rejected (the night is over)', async () => {
    const t = await mkTournament({
      scheduledAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      status: 'completed',
    })
    await mkConfirmedEntry(t)

    const { error } = await member.rpc('check_in', {
      p_tournament_id: t,
      p_lat: VENUE.lat,
      p_lng: VENUE.lng,
    })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/no está abierto/i)

    const entry = await readEntry(t)
    expect(entry!.status).toBe('confirmed')
  })

  // ------------------------------------------------------------------------
  it('cancelled fecha (cancelled_at set) → rejected even while scheduled', async () => {
    const t = await mkTournament({
      scheduledAt: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
      status: 'scheduled',
      cancelledAt: new Date().toISOString(),
    })
    await mkConfirmedEntry(t)

    const { error } = await member.rpc('check_in', {
      p_tournament_id: t,
      p_lat: VENUE.lat,
      p_lng: VENUE.lng,
    })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/cancelada/i)

    const entry = await readEntry(t)
    expect(entry!.status).toBe('confirmed')
  })

  // ------------------------------------------------------------------------
  it('non-confirmed entry (invited) → rejected', async () => {
    const t = await mkTournament({
      scheduledAt: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
      status: 'scheduled',
    })
    await mkEntry(t, 'invited')

    const { error } = await member.rpc('check_in', {
      p_tournament_id: t,
      p_lat: VENUE.lat,
      p_lng: VENUE.lng,
    })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/no estás confirmado/i)

    const entry = await readEntry(t)
    expect(entry!.status).toBe('invited')
  })

  // ------------------------------------------------------------------------
  it('admin_check_in bypasses geo (check_in_geo_ok=false) and recomputes; live → no bonus', async () => {
    const t = await mkTournament({ scheduledAt: new Date(Date.now() + 2 * HOUR_MS).toISOString() })
    const entryId = await mkConfirmedEntry(t)

    const { error } = await admin.rpc('admin_check_in', { p_entry_id: entryId })
    expect(error).toBeNull()

    const entry = await readEntry(t)
    expect(entry!.status).toBe('checked_in')
    expect(entry!.check_in_geo_ok).toBe(false)
    expect(entry!.early_bird).toBe(false) // live (default) → late by the bonus rule
    expect(entry!.chips).toBe(STACK)
    expect(await readFinalTableSize(t)).toBe(5)
  })

  // ------------------------------------------------------------------------
  it('admin_check_in works on a SCHEDULED fecha (before open → on time, bonus)', async () => {
    const t = await mkTournament({
      scheduledAt: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
      status: 'scheduled',
    })
    const entryId = await mkConfirmedEntry(t)

    const { error } = await admin.rpc('admin_check_in', { p_entry_id: entryId })
    expect(error).toBeNull()

    const entry = await readEntry(t)
    expect(entry!.status).toBe('checked_in')
    expect(entry!.check_in_geo_ok).toBe(false)
    expect(entry!.early_bird).toBe(true)
    expect(entry!.chips).toBe(STACK + BONUS)
  })

  // ------------------------------------------------------------------------
  it('admin_check_in rejects a non-admin caller', async () => {
    const t = await mkTournament({
      scheduledAt: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
      status: 'scheduled',
    })
    const entryId = await mkConfirmedEntry(t)

    // `member` is a signed-in, non-admin league member → gate rejects.
    const { error } = await member.rpc('admin_check_in', { p_entry_id: entryId })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/solo un admin/i)

    const entry = await readEntry(t)
    expect(entry!.status).toBe('confirmed')
  })
})
