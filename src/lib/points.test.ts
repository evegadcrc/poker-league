import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Slice 5 — points engine + leaderboard, integration tests against the local
// Supabase stack using the SERVICE-ROLE client (bypasses RLS to build fixtures).
// Gated: skips cleanly when URL / service-role key are absent from the env.
//
// Each scenario builds its own throwaway season + tournaments + entries, runs
// the SQL, asserts EXACT point numbers, and tears the fixture down in afterAll
// (deleting seasons cascades tournaments→entries; players are also throwaway).
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const canRun = Boolean(url && serviceKey)

// Scoring v2 (mig 0019): (N−P)×5 · MF +10 · Asist +15 · graduated top-4
// [20,15,10,5] (index 0 = 1st) · no-show −15 · cancel bands 0/−5/−10/−15.
// bonus_top3 is a retained-but-unused column (the engine no longer reads it).
const CONFIG = {
  points_multiplier: 5,
  bonus_final_table: 10,
  bonus_top3: 8,
  bonus_attendance: 15,
  no_show_penalty: -15,
  early_bird_bonus_chips: 2000,
  top_finish_bonuses: [20, 15, 10, 5] as Json,
  cancel_bands: [
    { hours_before: 24, penalty: 0 },
    { hours_before: 12, penalty: -5 },
    { hours_before: 6, penalty: -10 },
    { hours_before: 0, penalty: -15 },
  ] as Json,
  payout_template: [0.6, 0.28, 0.12] as Json,
}

describe.skipIf(!canRun)('points engine + leaderboard (slice 5, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const seasonIds: string[] = []
  const playerIds: string[] = []
  const RUN = crypto.randomUUID().slice(0, 8) // namespace throwaway player emails
  let playerSeq = 0 // monotonic so repeated mkPlayers() calls never collide on email

  // ---- fixture helpers ----------------------------------------------------
  async function mkPlayers(count: number): Promise<string[]> {
    const start = playerSeq
    playerSeq += count
    const rows = Array.from({ length: count }, (_, i) => ({
      name: `PtsTest ${RUN}-${start + i}`,
      email: `pts-${RUN}-${start + i}@test.local`,
      is_admin: false,
    }))
    const { data, error } = await admin.from('player').insert(rows).select('id')
    if (error) throw error
    const ids = (data ?? []).map((r) => r.id)
    playerIds.push(...ids)
    return ids
  }

  async function mkSeason(override: Partial<typeof CONFIG> & { final_table_size_override?: number } = {}) {
    const { data, error } = await admin
      .from('season')
      .insert({ name: `S ${RUN}`, year: 2099, status: 'archived', ...CONFIG, ...override })
      .select('id')
      .single()
    if (error) throw error
    seasonIds.push(data.id)
    return data.id
  }

  async function mkTournament(
    seasonId: string,
    opts: { status?: 'scheduled' | 'live' | 'completed'; scheduledAt?: string; finalTableSize?: number } = {},
  ) {
    const { data, error } = await admin
      .from('tournament')
      .insert({
        season_id: seasonId,
        name: `T ${RUN}`,
        scheduled_at: opts.scheduledAt ?? '2099-06-01T20:00:00Z',
        status: opts.status ?? 'completed',
        final_table_size: opts.finalTableSize ?? null,
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  type EntryFields = {
    status?: Database['public']['Enums']['entry_status']
    final_position?: number | null
    made_final_table?: boolean
    paid?: boolean
    chopped?: boolean
    chop_group?: number | null
    cancelled_at?: string | null
    points_earned?: number | null
  }

  async function mkEntry(tournamentId: string, playerId: string, f: EntryFields) {
    const { error } = await admin.from('entry').insert({
      tournament_id: tournamentId,
      player_id: playerId,
      status: f.status ?? 'eliminated',
      final_position: f.final_position ?? null,
      made_final_table: f.made_final_table ?? false,
      paid: f.paid ?? false,
      chopped: f.chopped ?? false,
      chop_group: f.chop_group ?? null,
      cancelled_at: f.cancelled_at ?? null,
      points_earned: f.points_earned ?? null,
    })
    if (error) throw error
  }

  async function runPoints(tournamentId: string) {
    const { error } = await admin.rpc('fn_tournament_points', { p_tournament_id: tournamentId })
    if (error) throw error
  }

  /** points_earned keyed by player_id for a tournament. */
  async function pointsByPlayer(tournamentId: string): Promise<Map<string, number>> {
    const { data, error } = await admin
      .from('entry')
      .select('player_id, points_earned')
      .eq('tournament_id', tournamentId)
    if (error) throw error
    return new Map((data ?? []).map((r) => [r.player_id, r.points_earned as number]))
  }

  async function fetchLeaderboard(seasonId: string) {
    const { data, error } = await admin.rpc('leaderboard', { p_season_id: seasonId })
    if (error) throw error
    return data ?? []
  }

  function hoursBefore(base: string, h: number): string {
    return new Date(new Date(base).getTime() - h * 3600_000).toISOString()
  }

  beforeAll(async () => {
    // clean any leftovers from a prior aborted run (idempotent)
    await admin.from('player').delete().like('email', `pts-%@test.local`)
    await mkPlayers(12)
  })

  afterAll(async () => {
    for (const id of seasonIds) await admin.from('season').delete().eq('id', id)
    if (playerIds.length) await admin.from('player').delete().in('id', playerIds)
  })

  // ------------------------------------------------------------------------
  // Scoring v2 (mig 0019) — the canonical fixture values, asserted EXACTLY via
  // fn_tournament_points on isolated tournaments. paid=true and made_final_table
  // is set per (final_position ≤ final_table_size) for every seat.
  it('scoring v2 canonical fixtures: 140/100/60 (20p) · 90/60 (10p) · −15 no-show', async () => {
    const s = await mkSeason()

    // 20-player field → final-table SIZE 10 (>10 → top 10).
    const t20 = await mkTournament(s, { finalTableSize: 10 })
    const ps20 = await mkPlayers(20)
    for (let pos = 1; pos <= 20; pos++) {
      await mkEntry(t20, ps20[pos - 1]!, {
        status: pos === 1 ? 'winner' : 'eliminated',
        final_position: pos,
        made_final_table: pos <= 10,
        paid: true,
      })
    }
    await runPoints(t20)
    const p20 = await pointsByPlayer(t20)
    expect(p20.get(ps20[0]!)).toBe(140) // 1st : (20−1)×5=95 +15 att +10 FT +20 (1st)
    expect(p20.get(ps20[4]!)).toBe(100) // 5th : (20−5)×5=75 +15 +10 (in top10) +0
    expect(p20.get(ps20[10]!)).toBe(60) // 11th: (20−11)×5=45 +15 +0 (>top10) +0

    // 10-player field → final-table SIZE 5 (≤10 → top 5).
    const t10 = await mkTournament(s, { finalTableSize: 5 })
    const ps10 = await mkPlayers(10)
    for (let pos = 1; pos <= 10; pos++) {
      await mkEntry(t10, ps10[pos - 1]!, {
        status: pos === 1 ? 'winner' : 'eliminated',
        final_position: pos,
        made_final_table: pos <= 5,
        paid: true,
      })
    }
    await runPoints(t10)
    const p10 = await pointsByPlayer(t10)
    expect(p10.get(ps10[0]!)).toBe(90) // 1st: (10−1)×5=45 +15 +10 (in top5) +20 (1st)
    expect(p10.get(ps10[3]!)).toBe(60) // 4th: (10−4)×5=30 +15 +10 (4≤5) +5 (4th)

    // no-show → −15 (penalty unchanged).
    const tns = await mkTournament(s)
    const [pns] = await mkPlayers(1)
    await mkEntry(tns, pns!, { status: 'no_show', final_position: null })
    await runPoints(tns)
    expect((await pointsByPlayer(tns)).get(pns!)).toBe(-15)
  })

  // ------------------------------------------------------------------------
  it('scores a full field: solo win, podium, final-table, out, attendance gate, no-show', async () => {
    const s = await mkSeason()
    const t = await mkTournament(s, { finalTableSize: 5 })
    const [p1, p2, p3, p4, p5, p6, p7, p8, p9] = playerIds
    // 8 finishers (N=8). Top 5 made the final table. All paid except pos 8.
    await mkEntry(t, p1, { status: 'winner', final_position: 1, made_final_table: true, paid: true })
    await mkEntry(t, p2, { final_position: 2, made_final_table: true, paid: true })
    await mkEntry(t, p3, { final_position: 3, made_final_table: true, paid: true })
    await mkEntry(t, p4, { final_position: 4, made_final_table: true, paid: true })
    await mkEntry(t, p5, { final_position: 5, made_final_table: true, paid: true })
    await mkEntry(t, p6, { final_position: 6, made_final_table: false, paid: true })
    await mkEntry(t, p7, { final_position: 7, made_final_table: false, paid: true })
    await mkEntry(t, p8, { final_position: 8, made_final_table: false, paid: false }) // attendance gate
    await mkEntry(t, p9, { status: 'no_show', final_position: null }) // ghost → −15

    await runPoints(t)
    const pts = await pointsByPlayer(t)
    // (N−P)×5 + MF(10 if final table) + graduated top-4 [20,15,10,5] + Asist(15 if paid)
    expect(pts.get(p1)).toBe(80) // 35+10+20+15  solo win (1st)
    expect(pts.get(p2)).toBe(70) // 30+10+15+15  (2nd)
    expect(pts.get(p3)).toBe(60) // 25+10+10+15  podium (3rd)
    expect(pts.get(p4)).toBe(50) // 20+10+5+15   final table, 4th
    expect(pts.get(p5)).toBe(40) // 15+10+0+15   final table, 5th (no top-4)
    expect(pts.get(p6)).toBe(25) // 10+0+0+15    out
    expect(pts.get(p7)).toBe(20) //  5+0+0+15
    expect(pts.get(p8)).toBe(0) //   0+0+0+0     unpaid → no attendance bonus
    expect(pts.get(p9)).toBe(-15) // no-show penalty

    // Leaderboard form tiers for this single-tournament season.
    const lb = await fetchLeaderboard(s)
    const row = (pid: string) => lb.find((r) => r.player_id === pid)!
    expect(row(p1).form).toEqual(['champion'])
    expect(row(p3).form).toEqual(['podium'])
    expect(row(p4).form).toEqual(['final'])
    expect(row(p6).form).toEqual(['out'])
    // form_positions (mig 0018): each entry's final_position, aligned with form.
    expect(row(p1).form_positions).toEqual([1])
    expect(row(p3).form_positions).toEqual([3])
    expect(row(p4).form_positions).toEqual([4])
    expect(row(p6).form_positions).toEqual([6])
    // form and form_positions are the SAME length / order for every row.
    for (const r of lb) expect(r.form_positions.length).toBe(r.form.length)
    expect(row(p1).total_points).toBe(80)
    expect(row(p1).wins).toBe(1)
    expect(row(p1).games_played).toBe(1)
    // no-show: counts in points total but not games/form
    expect(row(p9).total_points).toBe(-15)
    expect(row(p9).games_played).toBe(0)
    expect(row(p9).form).toEqual([])
    expect(row(p9).form_positions).toEqual([])
    // leaderboard ordered by points desc → winner first, no-show last
    expect(lb[0].player_id).toBe(p1)
    expect(lb[lb.length - 1].player_id).toBe(p9)
  })

  // ------------------------------------------------------------------------
  it('chop of 1º+2º: both get equal averaged points AND both count as champion', async () => {
    const s = await mkSeason()
    const t = await mkTournament(s, { finalTableSize: 5 })
    const [p1, p2, p3, p4, p5] = playerIds
    // N=5 finishers; positions 1 & 2 chop (co-champions), 3/4/5 regular.
    await mkEntry(t, p1, { final_position: 1, made_final_table: true, paid: true, chopped: true, chop_group: 1 })
    await mkEntry(t, p2, { final_position: 2, made_final_table: true, paid: true, chopped: true, chop_group: 1 })
    await mkEntry(t, p3, { final_position: 3, made_final_table: true, paid: true })
    await mkEntry(t, p4, { final_position: 4, made_final_table: true, paid: true })
    await mkEntry(t, p5, { final_position: 5, made_final_table: true, paid: true })

    await runPoints(t)
    const pts = await pointsByPlayer(t)
    // pos1 value = (5−1)×5+10+20+15 = 65; pos2 value = (5−2)×5+10+15+15 = 55;
    // chop = round((65+55)/2) = 60 for BOTH.
    expect(pts.get(p1)).toBe(60)
    expect(pts.get(p2)).toBe(60)
    expect(pts.get(p3)).toBe(45) // 10+10+10+15
    expect(pts.get(p4)).toBe(35) //  5+10+5+15
    expect(pts.get(p5)).toBe(25) //  0+10+0+15

    // Both choppers are co-champions on the leaderboard: win + champion form pill.
    const lb = await fetchLeaderboard(s)
    const row = (pid: string) => lb.find((r) => r.player_id === pid)!
    expect(row(p1).wins).toBe(1)
    expect(row(p2).wins).toBe(1)
    expect(row(p1).podiums).toBe(1)
    expect(row(p2).podiums).toBe(1)
    expect(row(p1).form).toEqual(['champion'])
    expect(row(p2).form).toEqual(['champion'])
    expect(row(p1).total_points).toBe(60)
    expect(row(p2).total_points).toBe(60)
  })

  // ------------------------------------------------------------------------
  it('applies each late-cancel band (0 / −5 / −10 / −15) from cancel timing', async () => {
    const s = await mkSeason()
    const base = '2099-06-01T20:00:00Z'
    const t = await mkTournament(s, { scheduledAt: base })
    const [p1, p2, p3, p4, p5, p6] = playerIds
    // cancelled at 30h / 18h / 9h / 3h before start → bands 0 / −5 / −10 / −15
    await mkEntry(t, p1, { status: 'declined', cancelled_at: hoursBefore(base, 30) })
    await mkEntry(t, p2, { status: 'declined', cancelled_at: hoursBefore(base, 18) })
    await mkEntry(t, p3, { status: 'declined', cancelled_at: hoursBefore(base, 9) })
    await mkEntry(t, p4, { status: 'declined', cancelled_at: hoursBefore(base, 3) })
    // preserve a penalty already applied at cancel time
    await mkEntry(t, p5, { status: 'declined', cancelled_at: hoursBefore(base, 9), points_earned: -99 })
    // declined-early (never confirmed, no cancel) → 0
    await mkEntry(t, p6, { status: 'declined', cancelled_at: null })

    await runPoints(t)
    const pts = await pointsByPlayer(t)
    expect(pts.get(p1)).toBe(0) // >24h
    expect(pts.get(p2)).toBe(-5) // 24–12h
    expect(pts.get(p3)).toBe(-10) // 12–6h
    expect(pts.get(p4)).toBe(-15) // <6h
    expect(pts.get(p5)).toBe(-99) // preserved
    expect(pts.get(p6)).toBe(0) // non-participant
  })

  // ------------------------------------------------------------------------
  it('fn_final_table_size: two-tier threshold + season override', async () => {
    const s = await mkSeason()
    const call = async (n: number, seasonId = s) =>
      (await admin.rpc('fn_final_table_size', { p_checked_in: n, p_season_id: seasonId })).data
    expect(await call(1)).toBe(5)
    expect(await call(10)).toBe(5) // ≤10 → 5
    expect(await call(11)).toBe(10) // >10 → 10
    expect(await call(20)).toBe(10)

    const sOverride = await mkSeason({ final_table_size_override: 7 })
    expect(await call(3, sOverride)).toBe(7) // override wins regardless of count
    expect(await call(30, sOverride)).toBe(7)
  })

  // ------------------------------------------------------------------------
  it('leaderboard: sums across tournaments, orders by tiebreakers, form is most-recent-first', async () => {
    const s = await mkSeason()
    const early = await mkTournament(s, { scheduledAt: '2099-03-01T20:00:00Z', finalTableSize: 5 })
    const late = await mkTournament(s, { scheduledAt: '2099-04-01T20:00:00Z', finalTableSize: 5 })
    const scheduled = await mkTournament(s, { status: 'scheduled', scheduledAt: '2099-05-01T20:00:00Z' })
    const [pa, pb, pc, , , , , , , , , pz] = playerIds

    // EARLY (N=3): A pos1(55), B pos2(45), C pos3(35)
    await mkEntry(early, pa, { final_position: 1, made_final_table: true, paid: true })
    await mkEntry(early, pb, { final_position: 2, made_final_table: true, paid: true })
    await mkEntry(early, pc, { final_position: 3, made_final_table: true, paid: true })
    // LATE (N=3): A pos3(35), B pos1(55), C pos2(45)
    await mkEntry(late, pa, { final_position: 3, made_final_table: true, paid: true })
    await mkEntry(late, pb, { final_position: 1, made_final_table: true, paid: true })
    await mkEntry(late, pc, { final_position: 2, made_final_table: true, paid: true })
    // roster-at-0: Z only in a scheduled (not completed) tournament
    await mkEntry(scheduled, pz, { status: 'confirmed', final_position: null })

    await runPoints(early)
    await runPoints(late)

    const lb = await fetchLeaderboard(s)
    const row = (pid: string) => lb.find((r) => r.player_id === pid)!
    // totals: A=90, B=100, C=80, Z=0
    expect(row(pa).total_points).toBe(90)
    expect(row(pb).total_points).toBe(100)
    expect(row(pc).total_points).toBe(80)
    expect(row(pz).total_points).toBe(0)
    expect(row(pz).games_played).toBe(0)
    expect(row(pz).form).toEqual([])
    expect(row(pz).form_positions).toEqual([]) // roster-at-0 → empty positions
    // order by points desc → B, A, C, then Z (roster at 0) last
    const order = lb.map((r) => r.player_id)
    expect(order.indexOf(pb)).toBeLessThan(order.indexOf(pa))
    expect(order.indexOf(pa)).toBeLessThan(order.indexOf(pc))
    expect(order.indexOf(pc)).toBeLessThan(order.indexOf(pz))
    // games / wins / podiums
    expect(row(pa).games_played).toBe(2)
    expect(row(pa).wins).toBe(1)
    expect(row(pb).wins).toBe(1)
    expect(row(pc).wins).toBe(0)
    // form MOST-RECENT-FIRST (late then early)
    expect(row(pa).form).toEqual(['podium', 'champion']) // late pos3, early pos1
    expect(row(pb).form).toEqual(['champion', 'podium']) // late pos1, early pos2
    // form_positions aligned 1:1 with form, same most-recent-first order.
    expect(row(pa).form_positions).toEqual([3, 1]) // late final_position 3, early 1
    expect(row(pb).form_positions).toEqual([1, 2]) // late final_position 1, early 2
  })

  // ------------------------------------------------------------------------
  it('leaderboard tiebreak: equal points, more wins ranks higher', async () => {
    const s = await mkSeason()
    const t1 = await mkTournament(s, { scheduledAt: '2099-07-01T20:00:00Z', finalTableSize: 5 })
    const t2 = await mkTournament(s, { scheduledAt: '2099-08-01T20:00:00Z', finalTableSize: 5 })
    const [pa, pb, , pc, pd, pe, pf] = playerIds

    // A: T1 pos1 in N=3 → (3−1)×5+10 FT+20 (1st)+15 att = 55, ONE win.
    await mkEntry(t1, pa, { final_position: 1, made_final_table: true, paid: true })
    await mkEntry(t1, pc, { final_position: 2, made_final_table: true, paid: true })
    await mkEntry(t1, pd, { final_position: 3, made_final_table: true, paid: true })
    // B: T2 pos2 in N=5 → (5−2)×5+10 FT+15 (2nd)+15 att = 55, ZERO wins (ties A).
    await mkEntry(t2, pe, { final_position: 1, made_final_table: true, paid: true })
    await mkEntry(t2, pb, { final_position: 2, made_final_table: true, paid: true })
    await mkEntry(t2, pf, { final_position: 3, made_final_table: true, paid: true })
    await mkEntry(t2, pc, { final_position: 4, made_final_table: true, paid: true })
    await mkEntry(t2, pd, { final_position: 5, made_final_table: true, paid: true })

    await runPoints(t1)
    await runPoints(t2)

    const lb = await fetchLeaderboard(s)
    const row = (pid: string) => lb.find((r) => r.player_id === pid)!
    expect(row(pa).total_points).toBe(55)
    expect(row(pb).total_points).toBe(55)
    expect(row(pa).wins).toBe(1)
    expect(row(pb).wins).toBe(0)
    const order = lb.map((r) => r.player_id)
    // equal points, A has more wins → A ranks above B
    expect(order.indexOf(pa)).toBeLessThan(order.indexOf(pb))
  })
})
