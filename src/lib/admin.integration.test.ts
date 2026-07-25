import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { tieSplitMoneyEach } from '@/lib/admin'
import { parsePrizes } from '@/lib/live'

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
    countsForLeague?: boolean
    scheduledAt?: string
  }) {
    const { data, error } = await admin
      .from('tournament')
      .insert({
        season_id: seasonId,
        name: `T ${RUN}`,
        scheduled_at: opts.scheduledAt ?? new Date().toISOString(),
        status: 'live',
        starting_stack: STACK,
        rebuy_amount: 20_000,
        rebuy_until_level: opts.rebuyUntil === undefined ? 6 : opts.rebuyUntil,
        current_level: opts.currentLevel ?? 1,
        level_started_at: opts.levelStartedAt === undefined ? new Date().toISOString() : opts.levelStartedAt,
        is_paused: opts.paused ?? false,
        blind_structure_id: opts.withStructure === false ? null : structureId,
        final_table_size: opts.finalTableSize ?? 5,
        ...(opts.countsForLeague === undefined ? {} : { counts_for_league: opts.countsForLeague }),
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

    // winner points (scoring v2): N=3 → (3−1)×5 + bmf 10 + top-4[0]=20 (1st) + attendance 15 = 55.
    expect((await readEntry(p3)).points_earned).toBe(55)
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
    // N=4 (scoring v2). pv(1)=(4−1)×5+10+20+15=60 ; pv(2)=(4−2)×5+10+15+15=50 ; avg=55.
    expect(a.points_earned).toBe(55)
    expect(b.points_earned).toBe(55)
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
    expect(rowA.total_points).toBe(55)
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

  // ========================================================================
  // Phase-2 step 6 — simultaneous multi-bust (ordered + dead-even tie split).
  // ========================================================================

  // ------------------------------------------------------------------------
  // Ordered: the entry LISTED FIRST (shortest starting stack) takes the WORST
  // position; sequential total−1. No chop_group (ordered is not a tie).
  it('eliminate_multi ordered: shortest-first → worse position (sequential total−1)', async () => {
    const t = await mkTournament({ finalTableSize: 5 })
    const short = await mkEntry(t, await mkPlayer())
    const tall = await mkEntry(t, await mkPlayer())
    const c = await mkEntry(t, await mkPlayer())
    const d = await mkEntry(t, await mkPlayer())

    // 4 alive → bust [short, tall] in order → short=4 (worst), tall=3.
    const { error } = await admin.rpc('eliminate_multi', { p_entry_ids: [short, tall], p_tied: false })
    expect(error).toBeNull()

    const s = await readEntry(short)
    const ta = await readEntry(tall)
    expect(s.final_position).toBe(4)
    expect(ta.final_position).toBe(3)
    expect(s.status).toBe('eliminated')
    expect(ta.status).toBe('eliminated')
    // Ordered mode is NOT a tie → no chop_group, no champion flags.
    expect(s.chop_group).toBeNull()
    expect(ta.chop_group).toBeNull()
    expect(s.chopped).toBe(false)
    // The other two stay in play.
    expect((await readEntry(c)).status).toBe('playing')
    expect((await readEntry(d)).status).toBe('playing')
  })

  // ------------------------------------------------------------------------
  // Dead-even tie at 7th/8th (mid-field): SPLIT points + money equally, and are
  // NOT co-champions. THE TRAP — chop_group is set (for the points split) but
  // chopped / status='winner' / made_final_table stay FALSE (else a gold form
  // pill + phantom win via leaderboard's `final_position=1 OR chopped`).
  it('eliminate_multi tie: mid-field 2-bust splits points+money, NOT champions', async () => {
    const t = await mkTournament({ finalTableSize: 5 })
    const players = []
    for (let i = 0; i < 8; i++) players.push(await mkEntry(t, await mkPlayer()))
    const [tieA, tieB, r1, r2, r3, r4, r5] = players // players[7] is the eventual winner

    // 8 alive → tie-bust two → they occupy the bottom 2 positions (8 & 7).
    const { error } = await admin.rpc('eliminate_multi', { p_entry_ids: [tieA!, tieB!], p_tied: true })
    expect(error).toBeNull()

    const a = await readEntry(tieA!)
    const b = await readEntry(tieB!)
    expect([a.final_position, b.final_position].sort()).toEqual([7, 8])
    // Shared chop_group drives the equal points split…
    expect(a.chop_group).not.toBeNull()
    expect(a.chop_group).toBe(b.chop_group)
    // …but NONE of the champion flags are set (the trap):
    expect(a.chopped).toBe(false)
    expect(b.chopped).toBe(false)
    expect(a.status).toBe('eliminated')
    expect(b.status).toBe('eliminated')
    expect(a.made_final_table).toBe(false) // pos 7/8 > final-table size 5
    expect(b.made_final_table).toBe(false)

    // MONEY: give positions 7 & 8 distinct prize amounts; the tie splits their
    // SUM equally (mirrors the chop money-split rounding) → both get the same.
    await admin
      .from('tournament')
      .update({
        prizes: [
          { position: 7, pct: null, amount: 30_000 },
          { position: 8, pct: null, amount: 10_000 },
        ],
      })
      .eq('id', t)
    const prizes = parsePrizes((await readTournament(t)).prizes)
    expect(tieSplitMoneyEach(prizes, [7, 8])).toBe(20_000) // (30k+10k)/2, equal for both

    // Play the rest down to a single winner, then complete → points computed.
    for (const id of [r1!, r2!, r3!, r4!, r5!]) await admin.rpc('eliminate', { p_entry_id: id })
    expect((await admin.rpc('complete_tournament', { p_tournament_id: t })).error).toBeNull()

    // POINTS: N=8 (scoring v2). pv(7)=(8−7)×5+att 15=20 ; pv(8)=0+15=15 ; avg=round(17.5)=18.
    const aDone = await readEntry(tieA!)
    const bDone = await readEntry(tieB!)
    expect(aDone.points_earned).toBe(18)
    expect(bDone.points_earned).toBe(18)
    expect(aDone.chopped).toBe(false)
    expect(aDone.made_final_table).toBe(false)

    // LEADERBOARD: NOT counted as wins/champions — no gold ('champion') form pill.
    const { data: lb } = await admin.rpc('leaderboard', { p_season_id: seasonId })
    const rows = (lb ?? []) as { player_id: string; wins: number; podiums: number; form: string[] }[]
    for (const done of [aDone, bDone]) {
      const row = rows.find((r) => r.player_id === done.player_id)!
      expect(row.wins).toBe(0)
      expect(row.podiums).toBe(0)
      expect(row.form[0]).toBe('out')
      expect(row.form[0]).not.toBe('champion')
    }
  })

  // ------------------------------------------------------------------------
  // Composition: a mid-field tie-split still composes with a LATER real chop at
  // the final table — champion flags land ONLY on the final chop.
  it('eliminate_multi tie composes with a later real final-table chop', async () => {
    const t = await mkTournament({ finalTableSize: 5 })
    const players = []
    for (let i = 0; i < 8; i++) players.push(await mkEntry(t, await mkPlayer()))
    const [tieA, tieB, m1, m2, m3, m4, finA, finB] = players

    // Mid-field tie at 7/8.
    await admin.rpc('eliminate_multi', { p_entry_ids: [tieA!, tieB!], p_tied: true })
    // Bust 4 more down to the final 2 (finA, finB).
    for (const id of [m1!, m2!, m3!, m4!]) await admin.rpc('eliminate', { p_entry_id: id })
    // Real chop of the final 2 → co-champions.
    const { error } = await admin.rpc('complete_tournament', {
      p_tournament_id: t,
      p_chop_entry_ids: [finA!, finB!],
    })
    expect(error).toBeNull()

    const fa = await readEntry(finA!)
    const fb = await readEntry(finB!)
    const a = await readEntry(tieA!)
    const b = await readEntry(tieB!)

    // Final chop → champions (chopped, winner). Points v2: pv1=(8−1)×5+10+20+15=80 ;
    // pv2=(8−2)×5+10+15+15=70 ; avg=75.
    expect(fa.chopped).toBe(true)
    expect(fb.chopped).toBe(true)
    expect(fa.status).toBe('winner')
    expect(fa.points_earned).toBe(75)
    expect(fb.points_earned).toBe(75)
    // The two chop cohorts are DISTINCT groups.
    expect(fa.chop_group).toBe(fb.chop_group)
    expect(a.chop_group).toBe(b.chop_group)
    expect(a.chop_group).not.toBe(fa.chop_group)
    // Tie group stays NON-champion (chopped false, mid-field points).
    expect(a.chopped).toBe(false)
    expect(b.chopped).toBe(false)
    expect(a.points_earned).toBe(18)

    // Leaderboard: finalists are wins/champions; the tie group is not.
    const { data: lb } = await admin.rpc('leaderboard', { p_season_id: seasonId })
    const rows = (lb ?? []) as { player_id: string; wins: number; form: string[] }[]
    expect(rows.find((r) => r.player_id === fa.player_id)!.wins).toBe(1)
    expect(rows.find((r) => r.player_id === fa.player_id)!.form[0]).toBe('champion')
    expect(rows.find((r) => r.player_id === a.player_id)!.wins).toBe(0)
    expect(rows.find((r) => r.player_id === a.player_id)!.form[0]).toBe('out')
  })

  // ------------------------------------------------------------------------
  // REQUIRED (review iter 1): a multi-bust must leave ≥1 survivor. Selecting the
  // WHOLE in-play field raises in BOTH modes (a real final-table/heads-up chop
  // goes through complete_tournament, not eliminate_multi). Leaving ≥1 works.
  it('eliminate_multi RAISES when it would empty the field (ordered, all selected)', async () => {
    const t = await mkTournament({ finalTableSize: 5 })
    const a = await mkEntry(t, await mkPlayer())
    const b = await mkEntry(t, await mkPlayer())
    const c = await mkEntry(t, await mkPlayer())

    const { error } = await admin.rpc('eliminate_multi', { p_entry_ids: [a, b, c], p_tied: false })
    expect(error).not.toBeNull()
    // Field untouched — nothing eliminated (whole tx rolled back).
    for (const id of [a, b, c]) expect((await readEntry(id)).status).toBe('playing')
  })

  it('eliminate_multi RAISES when it would empty the field (tie, all selected)', async () => {
    const t = await mkTournament({ finalTableSize: 5 })
    const a = await mkEntry(t, await mkPlayer())
    const b = await mkEntry(t, await mkPlayer())

    const { error } = await admin.rpc('eliminate_multi', { p_entry_ids: [a, b], p_tied: true })
    expect(error).not.toBeNull()
    for (const id of [a, b]) {
      const e = await readEntry(id)
      expect(e.status).toBe('playing')
      expect(e.final_position).toBeNull()
      expect(e.chop_group).toBeNull()
    }
  })

  it('eliminate_multi allows leaving exactly one survivor (tie of N−1 → lone winner)', async () => {
    const t = await mkTournament({ finalTableSize: 5 })
    const a = await mkEntry(t, await mkPlayer())
    const b = await mkEntry(t, await mkPlayer())
    const survivor = await mkEntry(t, await mkPlayer())

    // 3 alive → tie-bust 2 → survivor is crowned winner at pos 1.
    const { error } = await admin.rpc('eliminate_multi', { p_entry_ids: [a, b], p_tied: true })
    expect(error).toBeNull()
    expect([(await readEntry(a)).final_position, (await readEntry(b)).final_position].sort()).toEqual([2, 3])
    const s = await readEntry(survivor)
    expect(s.status).toBe('winner')
    expect(s.final_position).toBe(1)
  })

  // ========================================================================
  // Phase-2 step 7 — standalone fecha (counts_for_league).
  // ========================================================================
  it('standalone fecha runs fully but adds 0 to the season standings', async () => {
    const p1 = await mkPlayer()
    const p2 = await mkPlayer()

    // A LEAGUE fecha (counts) and a STANDALONE fecha (does not) in the SAME
    // season, with the SAME two players finishing 1st / 2nd in each.
    const runFecha = async (countsForLeague: boolean) => {
      const t = await mkTournament({ finalTableSize: 5, countsForLeague })
      const e1 = await mkEntry(t, p1)
      const e2 = await mkEntry(t, p2)
      await admin.rpc('eliminate', { p_entry_id: e2 }) // 2 alive → e2 pos 2, e1 winner pos 1
      // Prizes exist for the fecha regardless of league-counting.
      await admin
        .from('tournament')
        .update({ prizes: [{ position: 1, pct: 1, amount: 50_000 }] })
        .eq('id', t)
      expect((await admin.rpc('complete_tournament', { p_tournament_id: t })).error).toBeNull()
      return { t, e1, e2 }
    }

    const league = await runFecha(true)
    const solo = await runFecha(false)

    // Both fechas ran fully: positions, points, prizes all materialized.
    expect((await readTournament(solo.t)).status).toBe('completed')
    expect((await readTournament(solo.t)).counts_for_league).toBe(false)
    expect((await readEntry(solo.e1)).points_earned).not.toBeNull()
    expect((await readEntry(solo.e1)).final_position).toBe(1)
    expect(parsePrizes((await readTournament(solo.t)).prizes).length).toBeGreaterThan(0)

    // Per-fecha points identical in both (winner pos 1, N=2, scoring v2):
    //   (2−1)×5 + bmf 10 + top-4[0]=20 (1st) + attendance 15 = 50.
    expect((await readEntry(league.e1)).points_earned).toBe(50)
    expect((await readEntry(solo.e1)).points_earned).toBe(50)

    // SEASON standings: only the LEAGUE fecha moves the leaderboard — the
    // standalone one adds 0 (points, games, wins all reflect one fecha).
    const { data: lb, error } = await admin.rpc('leaderboard', { p_season_id: seasonId })
    expect(error).toBeNull()
    const rows = (lb ?? []) as {
      player_id: string
      total_points: number
      games_played: number
      wins: number
    }[]
    const row1 = rows.find((r) => r.player_id === p1)!
    const row2 = rows.find((r) => r.player_id === p2)!
    expect(row1.total_points).toBe(50) // league 50 only, NOT 100 (would be both)
    expect(row1.games_played).toBe(1) // one counting fecha, not two
    expect(row1.wins).toBe(1)
    expect(row2.total_points).toBe(40) // pos 2 (v2): (2−2)×5 + bmf 10 + top-4[1]=15 (2nd) + att 15 = 40
    expect(row2.games_played).toBe(1)
  })
})
