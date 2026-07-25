import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/database.types'
import { chopPreview, type ScoringConfig } from '@/lib/admin'
import type { Prize } from '@/lib/live'

// ---------------------------------------------------------------------------
// verify-ui Tier 4 — prizes AUTO-materialize from the season payout_template
// (migration 0013). Integration tests against the local Supabase stack using the
// SERVICE-ROLE client (bypasses RLS + satisfies the admin guard's service_role
// branch). Gated: skips cleanly when URL / service-role key are absent.
//
// Each scenario builds a throwaway season + tournament (+ entries), drives the
// pot-changing RPCs (open_tournament / confirm_payment), and asserts that
// `tournament.prizes` materializes = template × pot, rounded to ₡5.000, summing
// EXACTLY to the pot — with admin overrides preserved across the auto-refreshes.
// Fixtures torn down in afterAll (deleting seasons cascades tournaments→entries;
// throwaway players deleted too). Suite is serial (vite.config fileParallelism:false).
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const canRun = Boolean(url && serviceKey)

const TEMPLATE = [0.6, 0.28, 0.12] as Json // top-3 %, be-contract default
const BUY_IN = 20000

type PrizeSlice = { position: number; pct: number; amount: number; overridden: boolean }

describe.skipIf(!canRun)('auto-materialize prizes (verify-ui tier 4, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const seasonIds: string[] = []
  const playerIds: string[] = []
  const RUN = crypto.randomUUID().slice(0, 8)

  async function mkSeason(payoutTemplate: Json = TEMPLATE) {
    const { data, error } = await admin
      .from('season')
      .insert({ name: `AP ${RUN}`, year: 2099, status: 'archived', payout_template: payoutTemplate })
      .select('id')
      .single()
    if (error) throw error
    seasonIds.push(data.id)
    return data.id
  }

  async function mkTournament(seasonId: string, buyIn: number = BUY_IN) {
    const { data, error } = await admin
      .from('tournament')
      .insert({
        season_id: seasonId,
        name: `T ${RUN}`,
        scheduled_at: '2099-06-01T20:00:00Z',
        status: 'scheduled',
        buy_in: buyIn,
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  /** Insert an entry; returns the entry id (for confirm_payment). */
  async function mkEntry(tournamentId: string, paid: boolean): Promise<string> {
    const { data: p, error: pe } = await admin
      .from('player')
      .insert({ name: `AP ${RUN}`, email: `ap-${RUN}-${crypto.randomUUID()}@test.local` })
      .select('id')
      .single()
    if (pe) throw pe
    playerIds.push(p.id)
    const { data, error } = await admin
      .from('entry')
      .insert({ tournament_id: tournamentId, player_id: p.id, paid })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  async function open(tournamentId: string) {
    return admin.rpc('open_tournament', { p_tournament_id: tournamentId })
  }

  async function confirmPayment(entryId: string) {
    return admin.rpc('confirm_payment', { p_entry_id: entryId })
  }

  async function setPrizesManual(tournamentId: string, amounts: Json): Promise<PrizeSlice[]> {
    const { data, error } = await admin.rpc('set_prizes_manual', {
      p_tournament_id: tournamentId,
      p_amounts: amounts,
    })
    if (error) throw error
    return data as unknown as PrizeSlice[]
  }

  /** Read tournament.prizes back from the table (this is what the FE reads). */
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
  const ovr = (prizes: PrizeSlice[], position: number) =>
    prizes.find((p) => p.position === position)!.overridden

  beforeAll(async () => {
    await admin.from('player').delete().like('email', `ap-%@test.local`)
  })

  afterAll(async () => {
    for (const id of seasonIds) await admin.from('season').delete().eq('id', id)
    if (playerIds.length) await admin.from('player').delete().in('id', playerIds)
  })

  // ------------------------------------------------------------------------
  it('open_tournament materializes prizes = template × pot, rounded, summing to the pot', async () => {
    const s = await mkSeason()
    const t = await mkTournament(s) // buy_in 20000
    for (let i = 0; i < 7; i++) await mkEntry(t, true) // 7 paid → pot 140000

    // BEFORE open: no prizes materialized yet (column default is null).
    expect(await readPrizes(t)).toBeNull()

    const { error } = await open(t)
    expect(error).toBeNull()

    const prizes = await readPrizes(t)
    expect(prizes.length).toBe(3)
    expect(amt(prizes, 1)).toBe(85000) // 84.0K raw → absorbs remainder → 85K
    expect(amt(prizes, 2)).toBe(40000) // 39.2K → nearest 5K → 40K
    expect(amt(prizes, 3)).toBe(15000) // 16.8K → nearest 5K → 15K
    expect(sum(prizes)).toBe(140000) // exactly the pot
  })

  // ------------------------------------------------------------------------
  it('confirm_payment refreshes prizes to the grown pot', async () => {
    const s = await mkSeason()
    const t = await mkTournament(s)
    for (let i = 0; i < 6; i++) await mkEntry(t, true) // 6 paid → pot 120000
    const unpaid = await mkEntry(t, false) // 7th, not yet paid

    await open(t)
    // At open the pot is 120000 → pos1 absorbs to 70000.
    expect(sum(await readPrizes(t))).toBe(120000)
    expect(amt(await readPrizes(t), 1)).toBe(70000)

    // Confirming the 7th payment grows the pot by one buy-in → 140000.
    const { error } = await confirmPayment(unpaid)
    expect(error).toBeNull()

    const prizes = await readPrizes(t)
    expect(sum(prizes)).toBe(140000) // refreshed to the new pot
    expect(amt(prizes, 1)).toBe(85000) // pos1 rose 70K → 85K
    expect(amt(prizes, 2)).toBe(40000)
    expect(amt(prizes, 3)).toBe(15000)
  })

  // ------------------------------------------------------------------------
  it('an admin override survives auto-refresh on both open and payment', async () => {
    const s = await mkSeason()
    const t = await mkTournament(s)
    for (let i = 0; i < 7; i++) await mkEntry(t, true) // 7 paid → pot 140000

    // Admin overrides 2nd place to ₡50.000 while still scheduled (set_prizes_manual
    // seeds the template baseline first, then overlays the override).
    const overridden = await setPrizesManual(t, [{ position: 2, amount: 50000 }] as Json)
    expect(amt(overridden, 2)).toBe(50000)
    expect(ovr(overridden, 2)).toBe(true)

    // OPEN auto-refreshes prizes → override preserved; absorber (1st) rebalances so
    // the grand total is still exactly the pot.
    await open(t)
    let prizes = await readPrizes(t)
    expect(amt(prizes, 2)).toBe(50000) // override survived open
    expect(ovr(prizes, 2)).toBe(true)
    expect(amt(prizes, 3)).toBe(15000) // non-overridden, re-rounded
    expect(amt(prizes, 1)).toBe(75000) // 140000 − 50000 − 15000
    expect(sum(prizes)).toBe(140000)

    // A subsequent PAYMENT grows the pot to 160000 → override STILL preserved.
    const extra = await mkEntry(t, false)
    await confirmPayment(extra)
    prizes = await readPrizes(t)
    expect(amt(prizes, 2)).toBe(50000) // override survived the payment refresh too
    expect(ovr(prizes, 2)).toBe(true)
    expect(amt(prizes, 3)).toBe(20000) // 0.12 × 160000 = 19.2K → 20K
    expect(amt(prizes, 1)).toBe(90000) // 160000 − 50000 − 20000
    expect(sum(prizes)).toBe(160000)
  })

  // ------------------------------------------------------------------------
  it('empty payout_template → no error, prizes stay empty', async () => {
    const s = await mkSeason([] as Json) // season with an empty template
    const t = await mkTournament(s)
    const e1 = await mkEntry(t, true)
    await mkEntry(t, true)

    const { error: openErr } = await open(t)
    expect(openErr).toBeNull()
    expect(await readPrizes(t)).toEqual([]) // no-op, stayed empty

    // confirm_payment on a live fecha likewise no-ops gracefully.
    const { error: payErr } = await confirmPayment(e1)
    expect(payErr).toBeNull()
    expect(await readPrizes(t)).toEqual([])
  })

  // ------------------------------------------------------------------------
  it('chop money preview source (tournament.prizes) is non-empty for a live seeded fecha', async () => {
    const s = await mkSeason()
    const t = await mkTournament(s)
    for (let i = 0; i < 5; i++) await mkEntry(t, true) // 5 paid → pot 100000
    await open(t)

    // The FE feeds tournament.prizes straight into chopPreview (admin.ts). Prior
    // to 0013 this array was empty → moneyEach was ₡0. Now it is materialized.
    const prizes = (await readPrizes(t)) as unknown as Prize[]
    expect(prizes.length).toBeGreaterThan(0)

    const cfg: ScoringConfig = {
      points_multiplier: 5,
      bonus_final_table: 10,
      bonus_attendance: 15,
      top_finish_bonuses: [20, 15, 10, 5],
    }
    const preview = chopPreview(2, prizes, 3, cfg) // 2 choppers split top-2 amounts
    expect(preview.moneyEach).toBeGreaterThan(0)
  })
})
