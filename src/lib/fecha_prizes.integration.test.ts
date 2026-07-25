import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Phase 2, step 4 — per-FECHA prize distribution (migration 0015). Integration
// tests against the local Supabase stack via the SERVICE-ROLE client (bypasses
// RLS + satisfies the admin guard's service_role branch). Gated: skips cleanly
// when URL / service-role key are absent.
//
// ISOLATION (flaky-test lesson): the pot/fallback/manual scenarios build
// throwaway ARCHIVED seasons + directly-inserted tournaments with a fixed
// prize_pool_override (deterministic pot) — they never touch the single active
// slot. The create_tournament scaling test needs an ACTIVE season, so it
// archives whatever is active, inserts its own, and afterAll RESTORES the
// suite-start active season (matches admin_crud.integration.test.ts). Fixtures
// torn down in afterAll (deleting a season cascades tournaments→entries). Suite
// is serial (vite.config fileParallelism:false).
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const canRun = Boolean(url && serviceKey)

const DEFAULT_TEMPLATE = [0.6, 0.28, 0.12] as Json // seed / be-contract default

type PrizeSlice = { position: number; pct: number; amount: number; overridden: boolean }
type DistSlice = { place: number; pct: number }

describe.skipIf(!canRun)('per-fecha payout_distribution (step 4, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const seasonIds: string[] = []
  let originalActiveId: string | null = null
  let yearSeq = 2099
  const nextYear = () => yearSeq++

  async function mkArchivedSeason(template: Json = DEFAULT_TEMPLATE) {
    const { data, error } = await admin
      .from('season')
      .insert({ name: `FP ${nextYear()}`, year: yearSeq, status: 'archived', payout_template: template })
      .select('id')
      .single()
    if (error) throw error
    seasonIds.push(data.id)
    return data.id
  }

  // Displace the single active season (mig 0014 single-active index) with our own.
  async function mkActiveSeason(template: Json) {
    const year = nextYear()
    await admin.from('season').update({ status: 'archived' }).eq('status', 'active')
    const { data, error } = await admin
      .from('season')
      .insert({ name: `FP active ${year}`, year, status: 'active', payout_template: template })
      .select('id')
      .single()
    if (error) throw error
    seasonIds.push(data.id)
    return data.id
  }

  /** Direct insert (simulates any fecha); prize_pool_override → deterministic pot. */
  async function mkTournament(
    seasonId: string,
    opts: { pot?: number; distribution?: Json } = {},
  ) {
    const row: Database['public']['Tables']['tournament']['Insert'] = {
      season_id: seasonId,
      name: 'T fp',
      scheduled_at: '2099-06-01T20:00:00Z',
      status: 'completed',
      prize_pool_override: opts.pot ?? null,
    }
    if (opts.distribution !== undefined) row.payout_distribution = opts.distribution
    const { data, error } = await admin.from('tournament').insert(row).select('id').single()
    if (error) throw error
    return data.id
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

  async function readDistribution(tournamentId: string): Promise<DistSlice[] | null> {
    const { data, error } = await admin
      .from('tournament')
      .select('payout_distribution')
      .eq('id', tournamentId)
      .single()
    if (error) throw error
    return data.payout_distribution as unknown as DistSlice[] | null
  }

  const amt = (prizes: PrizeSlice[], position: number) =>
    prizes.find((p) => p.position === position)!.amount
  const sum = (prizes: PrizeSlice[]) => prizes.reduce((s, p) => s + p.amount, 0)
  const ovr = (prizes: PrizeSlice[], position: number) =>
    prizes.find((p) => p.position === position)!.overridden

  beforeAll(async () => {
    const { data } = await admin
      .from('season')
      .select('id')
      .eq('status', 'active')
      .order('year', { ascending: false })
      .limit(1)
    originalActiveId = data?.[0]?.id ?? null
  }, 30_000)

  afterAll(async () => {
    for (const id of seasonIds) await admin.from('season').delete().eq('id', id)
    // Restore the suite-start active season (leave single-active as we found it).
    if (originalActiveId) {
      await admin.from('season').update({ status: 'archived' }).eq('status', 'active')
      await admin.from('season').update({ status: 'active' }).eq('id', originalActiveId)
    }
  })

  // ------------------------------------------------------------------------
  it("a fecha's own payout_distribution drives set_prizes (not the season template)", async () => {
    // Distribution 50/30/20 differs from the season default 60/28/12, proving the
    // per-fecha split — not the template — is used. Pot ₡140.000:
    //   pos2 0.30×140k=42k → 40k; pos3 0.20×140k=28k → 30k; pos1 absorbs = 70k.
    const s = await mkArchivedSeason() // default 60/28/12 template
    const t = await mkTournament(s, {
      pot: 140000,
      distribution: [{ place: 1, pct: 0.5 }, { place: 2, pct: 0.3 }, { place: 3, pct: 0.2 }] as Json,
    })
    const prizes = await setPrizes(t)

    expect(prizes).toHaveLength(3)
    expect(amt(prizes, 1)).toBe(70000) // NOT the template's 85000
    expect(amt(prizes, 2)).toBe(40000)
    expect(amt(prizes, 3)).toBe(30000) // NOT the template's 15000
    expect(sum(prizes)).toBe(140000) // exactly the pot
  })

  // ------------------------------------------------------------------------
  it('a variable place count (5-place distribution) materializes 5 slices summing to the pot', async () => {
    // 40/25/15/12/8 on pot ₡200.000:
    //   pos2 50k; pos3 30k; pos4 24k→25k; pos5 16k→15k; pos1 absorbs = 80k.
    const s = await mkArchivedSeason()
    const t = await mkTournament(s, {
      pot: 200000,
      distribution: [
        { place: 1, pct: 0.4 }, { place: 2, pct: 0.25 }, { place: 3, pct: 0.15 },
        { place: 4, pct: 0.12 }, { place: 5, pct: 0.08 },
      ] as Json,
    })
    const prizes = await setPrizes(t)

    expect(prizes).toHaveLength(5)
    expect(amt(prizes, 1)).toBe(80000)
    expect(amt(prizes, 2)).toBe(50000)
    expect(amt(prizes, 3)).toBe(30000)
    expect(amt(prizes, 4)).toBe(25000)
    expect(amt(prizes, 5)).toBe(15000)
    expect(sum(prizes)).toBe(200000)
  })

  // ------------------------------------------------------------------------
  it('a fecha with NULL distribution falls back to the season template', async () => {
    const s = await mkArchivedSeason() // default 60/28/12
    const t = await mkTournament(s, { pot: 140000 }) // no distribution → null
    expect(await readDistribution(t)).toBeNull() // confirms it truly falls back

    const prizes = await setPrizes(t)
    expect(prizes).toHaveLength(3)
    expect(amt(prizes, 1)).toBe(85000) // the template path
    expect(amt(prizes, 2)).toBe(40000)
    expect(amt(prizes, 3)).toBe(15000)
    expect(sum(prizes)).toBe(140000)
  })

  // ------------------------------------------------------------------------
  it('BACKFILL: a fecha carrying the backfilled distribution behaves identically to the template', async () => {
    // The migration backfills pre-existing rows with the FULL season template
    // mapped to [{place,pct}] (verified against a real pre-existing row in psql;
    // in local `db reset` migrations precede the seed, so seed rows stay null and
    // use the fallback path instead). This asserts the guarantee that matters:
    // an existing fecha whose distribution was backfilled from 60/28/12 produces
    // the SAME prizes as the template path — so live/completed fechas keep working.
    const s = await mkArchivedSeason() // default 60/28/12
    const backfilled = await mkTournament(s, {
      pot: 140000,
      distribution: [{ place: 1, pct: 0.6 }, { place: 2, pct: 0.28 }, { place: 3, pct: 0.12 }] as Json,
    })
    const fallback = await mkTournament(s, { pot: 140000 }) // null → template fallback

    const bf = await setPrizes(backfilled)
    const fb = await setPrizes(fallback)

    // Backfilled distribution == template default, place-for-place.
    for (const pos of [1, 2, 3]) expect(amt(bf, pos)).toBe(amt(fb, pos))
    expect(amt(bf, 1)).toBe(85000)
    expect(amt(bf, 2)).toBe(40000)
    expect(amt(bf, 3)).toBe(15000)
    expect(sum(bf)).toBe(140000)
  })

  // ------------------------------------------------------------------------
  it('a manual override still wins over the per-fecha distribution on recompute', async () => {
    const s = await mkArchivedSeason()
    const t = await mkTournament(s, {
      pot: 140000,
      distribution: [{ place: 1, pct: 0.5 }, { place: 2, pct: 0.3 }, { place: 3, pct: 0.2 }] as Json,
    })
    await setPrizes(t) // baseline [70000,40000,30000]

    const overridden = await setPrizesManual(t, [{ position: 2, amount: 50000 }] as Json)
    expect(amt(overridden, 2)).toBe(50000)
    expect(ovr(overridden, 2)).toBe(true)

    // Recompute: override preserved; absorber (pos1) rebalances to keep Σ = pot.
    const recomputed = await setPrizes(t)
    expect(amt(recomputed, 2)).toBe(50000) // override survived
    expect(ovr(recomputed, 2)).toBe(true)
    expect(amt(recomputed, 3)).toBe(30000) // 0.20×140k, re-rounded
    expect(amt(recomputed, 1)).toBe(60000) // 140000 − 50000 − 30000
    expect(sum(recomputed)).toBe(140000)
  })

  // ------------------------------------------------------------------------
  it('create_tournament seeds a turnout-scaled distribution (top ~25%, min 3, capped at template length)', async () => {
    // 6-place template so scaling is observable (the default top-3 always → 3).
    const template = [0.4, 0.25, 0.15, 0.1, 0.06, 0.04] as Json
    const s = await mkActiveSeason(template)

    // Small turnout (8) → ceil(8×0.25)=2, floored to the min 3.
    const { data: small, error: e1 } = await admin.rpc('create_tournament', {
      p_payload: { name: 'FP small', expected_players: 8 },
    })
    expect(e1).toBeNull()
    const smallRow = ((small ?? []) as Database['public']['Tables']['tournament']['Row'][])[0]!
    expect(smallRow.season_id).toBe(s)
    const smallDist = (smallRow.payout_distribution as unknown as DistSlice[])
    expect(smallDist).toHaveLength(3) // min 3
    expect([...smallDist].map((d) => d.place).sort((a, b) => a - b)).toEqual([1, 2, 3])
    // Subset renormalized to sum ~1.0 (0.4/0.25/0.15 ÷ 0.8).
    expect(smallDist.reduce((acc, d) => acc + Number(d.pct), 0)).toBeCloseTo(1, 2)

    // Larger turnout (24) → ceil(24×0.25)=6, capped at the 6-place template.
    const { data: big, error: e2 } = await admin.rpc('create_tournament', {
      p_payload: { name: 'FP big', expected_players: 24 },
    })
    expect(e2).toBeNull()
    const bigRow = ((big ?? []) as Database['public']['Tables']['tournament']['Row'][])[0]!
    const bigDist = (bigRow.payout_distribution as unknown as DistSlice[])
    expect(bigDist).toHaveLength(6) // scaled up, capped at template length
    expect(bigDist.reduce((acc, d) => acc + Number(d.pct), 0)).toBeCloseTo(1, 2)
  })
})
