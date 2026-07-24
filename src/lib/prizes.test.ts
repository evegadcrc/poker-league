import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Slice 6 — pot + prize distribution, integration tests against the local
// Supabase stack using the SERVICE-ROLE client (bypasses RLS + satisfies the
// admin guard's service_role branch). Gated: skips cleanly when URL /
// service-role key are absent from the env.
//
// Each scenario builds a throwaway season + tournament (+ entries), runs the
// SQL, asserts EXACT amounts, and tears the fixture down in afterAll (deleting
// seasons cascades tournaments→entries; throwaway players deleted too).
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const canRun = Boolean(url && serviceKey)

const TEMPLATE = [0.6, 0.28, 0.12] as Json // top-3 %, be-contract default

type PrizeSlice = { position: number; pct: number; amount: number; overridden: boolean }

describe.skipIf(!canRun)('pot + prizes (slice 6, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const seasonIds: string[] = []
  const playerIds: string[] = []
  const RUN = crypto.randomUUID().slice(0, 8)

  async function mkSeason() {
    const { data, error } = await admin
      .from('season')
      .insert({ name: `PZ ${RUN}`, year: 2099, status: 'archived', payout_template: TEMPLATE })
      .select('id')
      .single()
    if (error) throw error
    seasonIds.push(data.id)
    return data.id
  }

  async function mkTournament(
    seasonId: string,
    opts: { buyIn?: number; rebuyAmount?: number; prizePoolOverride?: number } = {},
  ) {
    const { data, error } = await admin
      .from('tournament')
      .insert({
        season_id: seasonId,
        name: `T ${RUN}`,
        scheduled_at: '2099-06-01T20:00:00Z',
        status: 'completed',
        buy_in: opts.buyIn ?? 0,
        rebuy_amount: opts.rebuyAmount ?? null,
        prize_pool_override: opts.prizePoolOverride ?? null,
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  async function mkEntry(
    tournamentId: string,
    f: { paid?: boolean; rebuys?: number } = {},
  ) {
    const { data: p, error: pe } = await admin
      .from('player')
      .insert({ name: `PZ ${RUN}`, email: `pz-${RUN}-${crypto.randomUUID()}@test.local` })
      .select('id')
      .single()
    if (pe) throw pe
    playerIds.push(p.id)
    const { error } = await admin.from('entry').insert({
      tournament_id: tournamentId,
      player_id: p.id,
      paid: f.paid ?? false,
      rebuys_count: f.rebuys ?? 0,
    })
    if (error) throw error
  }

  async function pot(tournamentId: string): Promise<number> {
    const { data, error } = await admin.rpc('fn_pot', { p_tournament_id: tournamentId })
    if (error) throw error
    return Number(data)
  }

  async function setPrizes(tournamentId: string): Promise<PrizeSlice[]> {
    const { data, error } = await admin.rpc('set_prizes', { p_tournament_id: tournamentId })
    if (error) throw error
    return data as unknown as PrizeSlice[]
  }

  async function setPrizesManual(tournamentId: string, amounts: Json): Promise<PrizeSlice[]> {
    const { data, error } = await admin.rpc('set_prizes_manual', {
      p_tournament_id: tournamentId,
      p_amounts: amounts,
    })
    if (error) throw error
    return data as unknown as PrizeSlice[]
  }

  /** Read tournament.prizes back from the table (proves persistence). */
  async function readPrizes(tournamentId: string): Promise<PrizeSlice[]> {
    const { data, error } = await admin
      .from('tournament')
      .select('prizes')
      .eq('id', tournamentId)
      .single()
    if (error) throw error
    return data.prizes as unknown as PrizeSlice[]
  }

  const amt = (prizes: PrizeSlice[], position: number) =>
    prizes.find((p) => p.position === position)!.amount
  const sum = (prizes: PrizeSlice[]) => prizes.reduce((s, p) => s + p.amount, 0)

  beforeAll(async () => {
    await admin.from('player').delete().like('email', `pz-%@test.local`)
  })

  afterAll(async () => {
    for (const id of seasonIds) await admin.from('season').delete().eq('id', id)
    if (playerIds.length) await admin.from('player').delete().in('id', playerIds)
  })

  // ------------------------------------------------------------------------
  it('fn_pot: paid_count×buy_in + Σrebuys×rebuy_amount, and prize_pool_override wins', async () => {
    const s = await mkSeason()
    const t = await mkTournament(s, { buyIn: 10000, rebuyAmount: 5000 })
    // 4 paid entries (2 with 1 & 2 rebuys → Σrebuys=3), 1 unpaid entry.
    await mkEntry(t, { paid: true, rebuys: 1 })
    await mkEntry(t, { paid: true, rebuys: 2 })
    await mkEntry(t, { paid: true })
    await mkEntry(t, { paid: true })
    await mkEntry(t, { paid: false, rebuys: 0 })
    // 4×10000 + 3×5000 = 55000
    expect(await pot(t)).toBe(55000)

    // prize_pool_override short-circuits the computed pot.
    const { error } = await admin.from('tournament').update({ prize_pool_override: 99000 }).eq('id', t)
    expect(error).toBeNull()
    expect(await pot(t)).toBe(99000)
  })

  // ------------------------------------------------------------------------
  it('set_prizes: 60/28/12 on ₡140.000 → [85000,40000,15000] summing to exactly 140000', async () => {
    const s = await mkSeason()
    const t = await mkTournament(s, { prizePoolOverride: 140000 })
    const prizes = await setPrizes(t)

    expect(amt(prizes, 1)).toBe(85000) // 84.0K raw → absorbs remainder → 85K
    expect(amt(prizes, 2)).toBe(40000) // 39.2K → nearest 5K → 40K
    expect(amt(prizes, 3)).toBe(15000) // 16.8K → nearest 5K → 15K
    expect(sum(prizes)).toBe(140000)
    // persisted to tournament.prizes
    expect(sum(await readPrizes(t))).toBe(140000)
  })

  // ------------------------------------------------------------------------
  it('set_prizes: 1st absorbs the remainder when naive rounding would NOT sum to the pot', async () => {
    // Pot ₡155.000, template 60/28/12:
    //   raw 93.0 / 43.4 / 18.6K → naive round-to-5K = 95 / 45 / 20 = ₡160.000 ✗
    //   (overshoots by 5K). Absorption: pos2=45K, pos3=20K, pos1=155−45−20=90K.
    const s = await mkSeason()
    const t = await mkTournament(s, { prizePoolOverride: 155000 })
    const prizes = await setPrizes(t)

    expect(amt(prizes, 2)).toBe(45000)
    expect(amt(prizes, 3)).toBe(20000)
    expect(amt(prizes, 1)).toBe(90000) // NOT the naive 95000 — 1st absorbed −5000
    expect(sum(prizes)).toBe(155000) // exactly the pot despite naive sum ≠ pot
  })

  // ------------------------------------------------------------------------
  it('manual override persists across a subsequent set_prizes recompute', async () => {
    const s = await mkSeason()
    const t = await mkTournament(s, { prizePoolOverride: 140000 })
    await setPrizes(t) // baseline [85000,40000,15000]

    // Admin overrides 2nd place to ₡50.000 (authoritative, not re-rounded).
    const overridden = await setPrizesManual(t, [{ position: 2, amount: 50000 }] as Json)
    expect(amt(overridden, 2)).toBe(50000)
    expect(overridden.find((p) => p.position === 2)!.overridden).toBe(true)

    // Recompute: overridden slice preserved; absorber (1st) rebalances so the
    // grand total is still exactly the pot.
    const recomputed = await setPrizes(t)
    expect(amt(recomputed, 2)).toBe(50000) // override survived the recompute
    expect(recomputed.find((p) => p.position === 2)!.overridden).toBe(true)
    expect(amt(recomputed, 3)).toBe(15000) // non-overridden, re-rounded
    expect(amt(recomputed, 1)).toBe(75000) // 140000 − 50000 − 15000
    expect(sum(recomputed)).toBe(140000)
    // persisted
    expect(amt(await readPrizes(t), 2)).toBe(50000)
  })
})
