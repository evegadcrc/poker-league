import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Slice 12 — admin console RPCs, integration tests against the local Supabase
// stack. Admin RPCs admit auth.role()='service_role', so they are driven with
// the SERVICE-ROLE client (no signed-in admin needed). self_bust is the one
// player-facing RPC → exercised via a REAL signed-in test member so
// auth_player_id() resolves. Gated: skips cleanly when the keys are absent.
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const canRun = Boolean(url && serviceKey && anonKey)

const STACK = 10_000
const SENTINEL = 99

describe.skipIf(!canRun)('admin console RPCs (slice 12, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const RUN = crypto.randomUUID().slice(0, 8)
  const seasonIds: string[] = []
  const playerIds: string[] = []
  const authUserIds: string[] = []
  let seasonId: string
  let structureId: string

  async function mkSeason() {
    const { data, error } = await admin
      .from('season')
      .insert({ name: `ADM ${RUN}`, year: 2098, status: 'archived' })
      .select('id')
      .single()
    if (error) throw error
    seasonIds.push(data.id)
    return data.id
  }

  async function mkStructure() {
    const { data, error } = await admin
      .from('blind_structure')
      .insert({ name: `S ${RUN}`, season_id: seasonId })
      .select('id')
      .single()
    if (error) throw error
    // three levels: L1 900s, L2 600s, L3 600s.
    const { error: lErr } = await admin.from('blind_level').insert([
      { structure_id: data.id, level_number: 1, small_blind: 25, big_blind: 50, duration_seconds: 900 },
      { structure_id: data.id, level_number: 2, small_blind: 50, big_blind: 100, duration_seconds: 600 },
      { structure_id: data.id, level_number: 3, small_blind: 100, big_blind: 200, duration_seconds: 600 },
    ])
    if (lErr) throw lErr
    return data.id
  }

  async function mkTournament(opts: {
    finalTableSize?: number
    currentLevel?: number
    rebuyUntil?: number | null
    withStructure?: boolean
    paused?: boolean
    levelStartedAt?: string | null
  }) {
    const { data, error } = await admin
      .from('tournament')
      .insert({
        season_id: seasonId,
        name: `T ${RUN}`,
        scheduled_at: new Date().toISOString(),
        status: 'live',
        starting_stack: STACK,
        rebuy_amount: 20_000,
        rebuy_until_level: opts.rebuyUntil === undefined ? 6 : opts.rebuyUntil,
        current_level: opts.currentLevel ?? 1,
        level_started_at: opts.levelStartedAt === undefined ? new Date().toISOString() : opts.levelStartedAt,
        is_paused: opts.paused ?? false,
        blind_structure_id: opts.withStructure === false ? null : structureId,
        final_table_size: opts.finalTableSize ?? 5,
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  async function mkPlayer() {
    const email = `adm-${RUN}-${crypto.randomUUID().slice(0, 8)}@test.local`
    const { data, error } = await admin
      .from('player')
      .insert({ name: `ADM ${RUN}`, email })
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

  async function readEntry(entryId: string) {
    const { data, error } = await admin.from('entry').select('*').eq('id', entryId).single()
    if (error) throw error
    return data
  }

  async function readTournament(id: string) {
    const { data, error } = await admin.from('tournament').select('*').eq('id', id).single()
    if (error) throw error
    return data
  }

  async function mkSignedInMember() {
    const email = `adm-${RUN}-${crypto.randomUUID().slice(0, 8)}@test.local`
    const { data: p, error: pErr } = await admin
      .from('player')
      .insert({ name: `ADM ${RUN}`, email })
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

  beforeAll(async () => {
    await admin.from('player').delete().like('email', 'adm-%@test.local')
    seasonId = await mkSeason()
    structureId = await mkStructure()
  }, 30_000)

  afterAll(async () => {
    for (const id of seasonIds) await admin.from('season').delete().eq('id', id)
    if (playerIds.length) await admin.from('player').delete().in('id', playerIds)
    for (const uid of authUserIds) await admin.auth.admin.deleteUser(uid)
  })

  // ------------------------------------------------------------------------
  // eliminate — total−1: final_position = alive count INCLUDING self.
  it('eliminate assigns the remaining count incl. self; alive==1 → winner pos 1', async () => {
    const t = await mkTournament({ finalTableSize: 5 })
    const p1 = await mkEntry(t, await mkPlayer())
    const p2 = await mkEntry(t, await mkPlayer())
    const p3 = await mkEntry(t, await mkPlayer())
    const p4 = await mkEntry(t, await mkPlayer())

    // 4 alive → bust p1 → position 4.
    expect((await admin.rpc('eliminate', { p_entry_id: p1 })).error).toBeNull()
    expect((await readEntry(p1)).final_position).toBe(4)
    expect((await readEntry(p1)).status).toBe('eliminated')

    // 3 alive → bust p2 → position 3.
    await admin.rpc('eliminate', { p_entry_id: p2 })
    expect((await readEntry(p2)).final_position).toBe(3)

    // 2 alive → bust p3 → position 2; one remains → p4 winner at position 1.
    await admin.rpc('eliminate', { p_entry_id: p3 })
    expect((await readEntry(p3)).final_position).toBe(2)
    const w = await readEntry(p4)
    expect(w.status).toBe('winner')
    expect(w.final_position).toBe(1)
    // size 5 ≥ all 4 → everyone made the final table.
    expect((await readEntry(p1)).made_final_table).toBe(true)
    expect(w.made_final_table).toBe(true)
  })

  // ------------------------------------------------------------------------
  it('undo_last_elimination restores the last bust and un-crowns the winner', async () => {
    const t = await mkTournament({ finalTableSize: 5 })
    const p1 = await mkEntry(t, await mkPlayer())
    const p2 = await mkEntry(t, await mkPlayer())
    const p3 = await mkEntry(t, await mkPlayer())

    await admin.rpc('eliminate', { p_entry_id: p1 }) // pos 3
    await admin.rpc('eliminate', { p_entry_id: p2 }) // pos 2 → p3 winner pos 1
    expect((await readEntry(p3)).status).toBe('winner')

    const { error } = await admin.rpc('undo_last_elimination', { p_tournament_id: t })
    expect(error).toBeNull()
    // p2 (last bust) reactivated, p3 un-crowned — both playing again.
    expect((await readEntry(p2)).status).toBe('playing')
    expect((await readEntry(p2)).final_position).toBeNull()
    expect((await readEntry(p3)).status).toBe('playing')
    expect((await readEntry(p3)).final_position).toBeNull()
    // p1 stays eliminated at position 3.
    expect((await readEntry(p1)).final_position).toBe(3)
  })

  // ------------------------------------------------------------------------
  it('add_rebuy reactivates an eliminated player but is REJECTED while playing', async () => {
    const t = await mkTournament({ finalTableSize: 5, currentLevel: 3, rebuyUntil: 6 })
    const eliminated = await mkEntry(t, await mkPlayer(), {
      status: 'eliminated',
      final_position: 7,
      eliminated_at: new Date().toISOString(),
    })
    const playing = await mkEntry(t, await mkPlayer(), { status: 'playing' })

    // eliminated + within period → reactivated.
    const { error } = await admin.rpc('add_rebuy', { p_entry_id: eliminated })
    expect(error).toBeNull()
    const re = await readEntry(eliminated)
    expect(re.status).toBe('playing')
    expect(re.final_position).toBeNull()
    expect(re.eliminated_at).toBeNull()
    expect(re.rebuys_count).toBe(1)
    expect(re.chips).toBe(STACK)

    // playing → rejected.
    const { error: err2 } = await admin.rpc('add_rebuy', { p_entry_id: playing })
    expect(err2).not.toBeNull()
    expect(err2!.message).toMatch(/mientras juega/i)
  })

  // ------------------------------------------------------------------------
  it('add_rebuy is rejected once the rebuy period has closed', async () => {
    const t = await mkTournament({ currentLevel: 7, rebuyUntil: 6 })
    const eliminated = await mkEntry(t, await mkPlayer(), {
      status: 'eliminated',
      final_position: 4,
      eliminated_at: new Date().toISOString(),
    })
    const { error } = await admin.rpc('add_rebuy', { p_entry_id: eliminated })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/recompra ya cerró/i)
  })

  // ------------------------------------------------------------------------
  it('mark_no_show: excused → 0, not excused → −15', async () => {
    const t = await mkTournament({})
    const excused = await mkEntry(t, await mkPlayer(), { status: 'confirmed', checked_in_at: null })
    const ghosted = await mkEntry(t, await mkPlayer(), { status: 'confirmed', checked_in_at: null })

    await admin.rpc('mark_no_show', { p_entry_id: excused, p_excused: true })
    await admin.rpc('mark_no_show', { p_entry_id: ghosted, p_excused: false })

    const ex = await readEntry(excused)
    expect(ex.status).toBe('no_show')
    expect(ex.points_earned).toBe(0)

    const gh = await readEntry(ghosted)
    expect(gh.status).toBe('no_show')
    expect(gh.points_earned).toBe(-15)
  })

  // ------------------------------------------------------------------------
  it('complete_tournament flips a confirmed ghost → no_show (−15) and recomputes final_table_size before points', async () => {
    const t = await mkTournament({ finalTableSize: SENTINEL })
    const p1 = await mkEntry(t, await mkPlayer())
    const p2 = await mkEntry(t, await mkPlayer())
    const p3 = await mkEntry(t, await mkPlayer())
    // a confirmed-but-never-checked-in ghost.
    const ghost = await mkEntry(t, await mkPlayer(), { status: 'confirmed', checked_in_at: null })

    await admin.rpc('eliminate', { p_entry_id: p1 }) // pos 3
    await admin.rpc('eliminate', { p_entry_id: p2 }) // pos 2 → p3 winner

    const { error } = await admin.rpc('complete_tournament', { p_tournament_id: t })
    expect(error).toBeNull()

    // final_table_size recomputed from real turnout (3 checked-in ≤10 → 5), no longer the sentinel.
    expect((await readTournament(t)).final_table_size).toBe(5)
    expect((await readTournament(t)).status).toBe('completed')

    // ghost → no_show at −15.
    const g = await readEntry(ghost)
    expect(g.status).toBe('no_show')
    expect(g.points_earned).toBe(-15)

    // winner points: N=3 finishers → (3−1)×10 + bmf 5 + top3 8 + attendance 2 = 35.
    expect((await readEntry(p3)).points_earned).toBe(35)
  })

  // ------------------------------------------------------------------------
  it('complete_tournament with a chop of the final 2 → equal points + BOTH co-champions', async () => {
    const t = await mkTournament({ finalTableSize: 5 })
    const p1 = await mkEntry(t, await mkPlayer())
    const p2 = await mkEntry(t, await mkPlayer())
    const chopA = await mkEntry(t, await mkPlayer())
    const chopB = await mkEntry(t, await mkPlayer())

    // Play down to the final 2 (chopA + chopB alive).
    await admin.rpc('eliminate', { p_entry_id: p1 }) // pos 4
    await admin.rpc('eliminate', { p_entry_id: p2 }) // pos 3

    const { error } = await admin.rpc('complete_tournament', {
      p_tournament_id: t,
      p_chop_entry_ids: [chopA, chopB],
    })
    expect(error).toBeNull()

    const a = await readEntry(chopA)
    const b = await readEntry(chopB)
    // N=4. point-value(1)=(4−1)×10+5+8+2=45 ; point-value(2)=(4−2)×10+5+8+2=35 ; avg=40.
    expect(a.points_earned).toBe(40)
    expect(b.points_earned).toBe(40)
    expect(a.chopped).toBe(true)
    expect(b.chopped).toBe(true)
    expect(a.chop_group).toBe(b.chop_group)
    expect(a.status).toBe('winner')
    expect(b.status).toBe('winner')

    // Leaderboard counts BOTH as champions (wins) for the season.
    const { data: lb, error: lbErr } = await admin.rpc('leaderboard', { p_season_id: seasonId })
    expect(lbErr).toBeNull()
    const rows = (lb ?? []) as { player_id: string; wins: number; total_points: number; form: string[] }[]
    const [pa, pb] = await Promise.all([readEntry(chopA), readEntry(chopB)])
    const rowA = rows.find((r) => r.player_id === pa.player_id)!
    const rowB = rows.find((r) => r.player_id === pb.player_id)!
    expect(rowA.wins).toBe(1)
    expect(rowB.wins).toBe(1)
    expect(rowA.total_points).toBe(40)
    expect(rowA.form[0]).toBe('champion')
    expect(rowB.form[0]).toBe('champion')
  })

  // ------------------------------------------------------------------------
  // chop of K while >K are still in play → the remainder is NOT stranded
  // (review iter 1 fix): they finish at positions K+1.. (chip leader first),
  // status eliminated, with real points — never final_position NULL / 0 pts.
  it('complete_tournament chop of 2 with 3 others in play → remainder ranked K+1.. (not stranded)', async () => {
    const t = await mkTournament({ finalTableSize: 5 })
    const chopA = await mkEntry(t, await mkPlayer(), { chips: 40_000 })
    const chopB = await mkEntry(t, await mkPlayer(), { chips: 35_000 })
    const r1 = await mkEntry(t, await mkPlayer(), { chips: 30_000 })
    const r2 = await mkEntry(t, await mkPlayer(), { chips: 20_000 })
    const r3 = await mkEntry(t, await mkPlayer(), { chips: 10_000 })

    const { error } = await admin.rpc('complete_tournament', {
      p_tournament_id: t,
      p_chop_entry_ids: [chopA, chopB],
    })
    expect(error).toBeNull()
    expect((await readTournament(t)).status).toBe('completed')

    // Choppers share the top as co-champions (positions 1..K).
    expect((await readEntry(chopA)).chopped).toBe(true)
    expect((await readEntry(chopB)).chopped).toBe(true)

    // The 3 still-in-play non-choppers rank below, chip leader first (K+1..).
    const [e1, e2, e3] = [await readEntry(r1), await readEntry(r2), await readEntry(r3)]
    expect([e1.final_position, e2.final_position, e3.final_position]).toEqual([3, 4, 5])
    for (const e of [e1, e2, e3]) {
      expect(e.status).toBe('eliminated')
      expect(e.final_position).not.toBeNull()
      expect(e.points_earned).not.toBe(0) // proves they were scored, not stranded at 0
    }
  })

  // ------------------------------------------------------------------------
  // clock — pause / resume / ±1 min / next / prev / edit_blinds.
  it('clock pause captures remaining and freezes; resume unfreezes', async () => {
    // level started 100s ago on a 900s level → ~800s remaining.
    const startedAt = new Date(Date.now() - 100_000).toISOString()
    const t = await mkTournament({ levelStartedAt: startedAt, paused: false })

    await admin.rpc('clock', { p_tournament_id: t, p_action: 'pause' })
    let row = await readTournament(t)
    expect(row.is_paused).toBe(true)
    expect(row.paused_remaining_seconds).toBeGreaterThan(790)
    expect(row.paused_remaining_seconds).toBeLessThanOrEqual(801)

    await admin.rpc('clock', { p_tournament_id: t, p_action: 'resume' })
    row = await readTournament(t)
    expect(row.is_paused).toBe(false)
    expect(row.level_started_at).not.toBeNull()
  })

  it('clock +1/−1 min adjusts paused_remaining_seconds while paused', async () => {
    const t = await mkTournament({ paused: true })
    // seed a known paused remaining.
    await admin.from('tournament').update({ paused_remaining_seconds: 300 }).eq('id', t)

    await admin.rpc('clock', { p_tournament_id: t, p_action: 'plus_min' })
    expect((await readTournament(t)).paused_remaining_seconds).toBe(360)

    await admin.rpc('clock', { p_tournament_id: t, p_action: 'minus_min' })
    expect((await readTournament(t)).paused_remaining_seconds).toBe(300)
  })

  it('clock next_level / prev_level move within bounds', async () => {
    const t = await mkTournament({ currentLevel: 1 })
    await admin.rpc('clock', { p_tournament_id: t, p_action: 'next_level' })
    expect((await readTournament(t)).current_level).toBe(2)

    await admin.rpc('clock', { p_tournament_id: t, p_action: 'prev_level' })
    expect((await readTournament(t)).current_level).toBe(1)

    // prev at level 1 is bounded (stays 1).
    await admin.rpc('clock', { p_tournament_id: t, p_action: 'prev_level' })
    expect((await readTournament(t)).current_level).toBe(1)

    // next past the last level (3) is a silent no-op.
    await admin.from('tournament').update({ current_level: 3 }).eq('id', t)
    await admin.rpc('clock', { p_tournament_id: t, p_action: 'next_level' })
    expect((await readTournament(t)).current_level).toBe(3)
  })

  it('clock edit_blinds overrides the current level SB/BB/ante', async () => {
    const t = await mkTournament({ currentLevel: 1 })
    await admin.rpc('clock', {
      p_tournament_id: t,
      p_action: 'edit_blinds',
      p_payload: { small_blind: 75, big_blind: 150, ante: 25 },
    })
    const { data, error } = await admin
      .from('blind_level')
      .select('small_blind, big_blind, ante')
      .eq('structure_id', structureId)
      .eq('level_number', 1)
      .single()
    expect(error).toBeNull()
    expect(data!.small_blind).toBe(75)
    expect(data!.big_blind).toBe(150)
    expect(data!.ante).toBe(25)
    // restore so other tests are unaffected.
    await admin
      .from('blind_level')
      .update({ small_blind: 25, big_blind: 50, ante: null })
      .eq('structure_id', structureId)
      .eq('level_number', 1)
  })

  // ------------------------------------------------------------------------
  it('self_bust lets the calling player bust their own entry (total−1)', async () => {
    const t = await mkTournament({ finalTableSize: 5 })
    const { client, playerId } = await mkSignedInMember()
    const mine = await mkEntry(t, playerId, { status: 'playing' })
    await mkEntry(t, await mkPlayer(), { status: 'playing' })

    // 2 alive incl self → self_bust → position 2, and the other becomes winner.
    const { error } = await client.rpc('self_bust', { p_tournament_id: t })
    expect(error).toBeNull()
    expect((await readEntry(mine)).final_position).toBe(2)
    expect((await readEntry(mine)).status).toBe('eliminated')
  })
})
