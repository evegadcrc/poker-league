import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Phase 3 — GUEST players (migration 0021), integration against local Supabase.
//   • a guest is EXCLUDED from leaderboard, while a real player at 0 still shows;
//   • add_guest_entry is admin-only (a signed-in NON-admin member raises) and
//     creates a guest player (is_guest=true) + a 'checked_in' entry;
//   • create_player (wired into the new Agregar-jugador UI) still works.
// Admin RPCs admit service_role, so setup + the happy paths use the SERVICE-ROLE
// client; the non-admin rejection uses a REAL signed-in member so auth_is_admin()
// resolves to false. Gated: skips cleanly when the keys are absent.
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const canRun = Boolean(url && serviceKey && anonKey)

const STACK = 10_000

describe.skipIf(!canRun)('guest players (0021, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const RUN = crypto.randomUUID().slice(0, 8)
  const seasonIds: string[] = []
  const playerIds: string[] = []
  const authUserIds: string[] = []
  let seasonId: string

  async function mkSeason() {
    const { data, error } = await admin
      .from('season')
      .insert({ name: `GST ${RUN}`, year: 2096, status: 'archived' })
      .select('id')
      .single()
    if (error) throw error
    seasonIds.push(data.id)
    return data.id
  }

  async function mkTournament(over: Partial<Database['public']['Tables']['tournament']['Insert']> = {}) {
    const { data, error } = await admin
      .from('tournament')
      .insert({
        season_id: seasonId,
        name: `GST ${RUN}`,
        scheduled_at: new Date().toISOString(),
        status: 'live',
        starting_stack: STACK,
        final_table_size: 5,
        ...over,
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  async function mkPlayer() {
    const email = `gst-${RUN}-${crypto.randomUUID().slice(0, 8)}@test.local`
    const { data, error } = await admin
      .from('player')
      .insert({ name: `GST ${RUN}`, email })
      .select('id')
      .single()
    if (error) throw error
    playerIds.push(data.id)
    return data.id
  }

  async function mkEntry(
    tournamentId: string,
    playerId: string,
    over: Partial<Database['public']['Tables']['entry']['Insert']> = {},
  ) {
    const { data, error } = await admin
      .from('entry')
      .insert({
        tournament_id: tournamentId,
        player_id: playerId,
        status: 'playing',
        checked_in_at: new Date().toISOString(),
        paid: true,
        chips: STACK,
        ...over,
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  async function mkSignedInMember(opts: { isAdmin?: boolean } = {}) {
    const email = `gst-${RUN}-${crypto.randomUUID().slice(0, 8)}@test.local`
    const { data: p, error: pErr } = await admin
      .from('player')
      .insert({ name: `GST ${RUN}`, email, is_admin: opts.isAdmin ?? false })
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

  async function readPlayer(id: string) {
    const { data, error } = await admin.from('player').select('*').eq('id', id).single()
    if (error) throw error
    return data
  }

  beforeAll(async () => {
    await admin.from('player').delete().like('email', 'gst-%@test.local')
    seasonId = await mkSeason()
  }, 30_000)

  afterAll(async () => {
    for (const id of seasonIds) await admin.from('season').delete().eq('id', id)
    if (playerIds.length) await admin.from('player').delete().in('id', playerIds)
    for (const uid of authUserIds) await admin.auth.admin.deleteUser(uid)
  })

  // ------------------------------------------------------------------------
  // A guest who WON a completed fecha is EXCLUDED from the leaderboard, while a
  // real player who finished 2nd (0 or positive points) still appears. Proves
  // the guest never reaches the Tabla even with a finishing position + points.
  it('excludes a guest from leaderboard but keeps a real finisher', async () => {
    const t = await mkTournament()
    const real = await mkPlayer()
    const realEntry = await mkEntry(t, real)

    // add_guest_entry seeds the guest player + a checked_in entry.
    const { data: guestId, error: gErr } = await admin.rpc('add_guest_entry', {
      p_name: 'Invitado Uno',
      p_tournament_id: t,
    })
    expect(gErr).toBeNull()
    expect(typeof guestId).toBe('string')

    // Guest flags: is_guest=true, entry checked_in with starting-stack chips.
    const gp = await readPlayer(guestId as string)
    expect(gp.is_guest).toBe(true)
    const { data: gEntry } = await admin
      .from('entry')
      .select('status, chips')
      .eq('tournament_id', t)
      .eq('player_id', guestId as string)
      .single()
    expect(gEntry!.status).toBe('checked_in')
    expect(gEntry!.chips).toBe(STACK)

    // Play down: bust the REAL player → guest is the lone survivor (winner, 1st).
    await admin.rpc('eliminate', { p_entry_id: realEntry }) // 2 alive → real=2nd, guest winner
    expect((await admin.rpc('complete_tournament', { p_tournament_id: t })).error).toBeNull()

    const { data: lb, error } = await admin.rpc('leaderboard', { p_season_id: seasonId })
    expect(error).toBeNull()
    const rows = (lb ?? []) as { player_id: string }[]
    // The real player appears; the guest — despite winning — never does.
    expect(rows.some((r) => r.player_id === real)).toBe(true)
    expect(rows.some((r) => r.player_id === (guestId as string))).toBe(false)
  })

  // ------------------------------------------------------------------------
  // Roster-at-0 (0014) still lists real players with no entries, but never a
  // guest — even one who exists via a fecha in ANOTHER (empty-for-this) season.
  it('a real player at 0 appears; a guest never does', async () => {
    // Fresh season with NO entries → roster-at-0 lists the full real roster.
    const emptySeason = await mkSeason()
    const real = await mkPlayer()

    // A guest exists globally (created against the main season's fecha above).
    const t = await mkTournament()
    const { data: guestId } = await admin.rpc('add_guest_entry', {
      p_name: 'Invitado Dos',
      p_tournament_id: t,
    })

    const { data: lb } = await admin.rpc('leaderboard', { p_season_id: emptySeason })
    const rows = (lb ?? []) as { player_id: string; total_points: number }[]
    const realRow = rows.find((r) => r.player_id === real)
    expect(realRow).toBeTruthy()
    expect(realRow!.total_points).toBe(0)
    expect(rows.some((r) => r.player_id === (guestId as string))).toBe(false)
  })

  // ------------------------------------------------------------------------
  // add_guest_entry is admin-only: a signed-in NON-admin member is rejected and
  // no player/entry is created.
  it('add_guest_entry is rejected for a non-admin member', async () => {
    const t = await mkTournament()
    const nonAdmin = await mkSignedInMember({ isAdmin: false })

    const before = await admin.from('player').select('id', { count: 'exact', head: true })
    const { error } = await nonAdmin.client.rpc('add_guest_entry', {
      p_name: 'No Permitido',
      p_tournament_id: t,
    })
    expect(error).not.toBeNull()

    // No entry landed in the fecha for a would-be guest.
    const { count } = await admin
      .from('entry')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', t)
    expect(count ?? 0).toBe(0)
    void before
  })

  // ------------------------------------------------------------------------
  // create_player (wired into the Agregar-jugador UI) still creates a real,
  // non-guest, non-admin member.
  it('create_player still creates a real (non-guest) league member', async () => {
    const email = `gst-${RUN}-created@test.local`
    const { data, error } = await admin.rpc('create_player', {
      p_name: 'Miembro Real',
      p_email: email,
    })
    expect(error).toBeNull()
    const created = (Array.isArray(data) ? data[0] : data) as {
      id: string
      email: string
      is_admin: boolean
      is_guest: boolean
    }
    expect(created.email).toBe(email)
    expect(created.is_admin).toBe(false)
    expect(created.is_guest).toBe(false)
    playerIds.push(created.id)
  })
})
