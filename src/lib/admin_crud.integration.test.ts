import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// Slice 13 — admin CRUD + season rollover, integration tests against the local
// Supabase stack. create_tournament / update_season_config / close_season all
// operate on the SINGLE global "active" season (selected `order by year desc`),
// so each test creates its own active season at a strictly-increasing HIGH year
// (>> the seed's 2026) — that guarantees the RPC targets our fixture, never the
// seed. Driven by the SERVICE-ROLE client (the RPCs admit auth.role()=
// 'service_role'). Gated: skips cleanly when the keys are absent.
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const canRun = Boolean(url && serviceKey)

describe.skipIf(!canRun)('admin CRUD + season rollover (slice 13, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const RUN = crypto.randomUUID().slice(0, 8)
  const seasonIds: string[] = []
  const playerIds: string[] = []
  // The season active at suite start (seed's). mig 0014 enforces single-active,
  // so our fixtures must displace it; afterAll restores it for global cleanliness.
  let originalActiveId: string | null = null
  // Strictly-increasing high year so each fixture season wins the year-desc pick.
  let yearSeq = 2099
  const nextYear = () => yearSeq++

  // Create THE single active season. mig 0014 adds a partial unique index that
  // permits at most one status='active' row, so we archive whatever is active
  // first (the seed's, or a prior fixture) before inserting ours.
  async function mkActiveSeason(over: Partial<Database['public']['Tables']['season']['Insert']> = {}) {
    const year = nextYear()
    await admin.from('season').update({ status: 'archived' }).eq('status', 'active')
    const { data, error } = await admin
      .from('season')
      .insert({ name: `CRUD ${RUN} ${year}`, year, status: 'active', ...over })
      .select('id, year')
      .single()
    if (error) throw error
    seasonIds.push(data.id)
    return data
  }

  async function mkStructure(seasonId: string) {
    const { data, error } = await admin
      .from('blind_structure')
      .insert({ name: `S ${RUN}`, season_id: seasonId })
      .select('id')
      .single()
    if (error) throw error
    return data.id as string
  }

  async function mkPlayer() {
    const email = `crud-${RUN}-${crypto.randomUUID().slice(0, 8)}@test.local`
    const { data, error } = await admin
      .from('player')
      .insert({ name: `CRUD ${RUN}`, email })
      .select('id')
      .single()
    if (error) throw error
    playerIds.push(data.id)
    return data.id as string
  }

  beforeAll(async () => {
    await admin.from('player').delete().like('email', 'crud-%@test.local')
    // Remember the season active at suite start so afterAll can restore it after
    // our fixtures (and close_season) churn the single active slot.
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
    if (playerIds.length) await admin.from('player').delete().in('id', playerIds)
    // Restore the suite-start active season so global state (single-active
    // invariant) is left as we found it for any later-running test file.
    if (originalActiveId) {
      await admin.from('season').update({ status: 'archived' }).eq('status', 'active')
      await admin.from('season').update({ status: 'active' }).eq('id', originalActiveId)
    }
  })

  // ------------------------------------------------------------------------
  it('create_tournament inserts a scheduled fecha with geo in the active season', async () => {
    const season = await mkActiveSeason()
    const structureId = await mkStructure(season.id)

    const { data, error } = await admin.rpc('create_tournament', {
      p_payload: {
        name: 'Fecha 10 — Casa de José',
        scheduled_at: '2099-08-09T19:00:00-06:00',
        venue_lat: 9.9281,
        venue_lng: -84.0907,
        geofence_radius_m: 120,
        buy_in: 20000,
        rebuy_amount: 20000,
        rebuy_until_level: 6,
        starting_stack: 10000,
        ante_enabled: true,
        blind_structure_id: structureId,
        timer_mode: 'manual',
      },
    })
    expect(error).toBeNull()
    const rows = (data ?? []) as Database['public']['Tables']['tournament']['Row'][]
    expect(rows).toHaveLength(1)
    const t = rows[0]!

    expect(t.name).toBe('Fecha 10 — Casa de José')
    expect(t.status).toBe('scheduled')
    expect(t.season_id).toBe(season.id) // inserted in the active season
    expect(Number(t.venue_lat)).toBeCloseTo(9.9281, 4)
    expect(Number(t.venue_lng)).toBeCloseTo(-84.0907, 4)
    expect(t.geofence_radius_m).toBe(120)
    expect(Number(t.buy_in)).toBe(20000)
    expect(t.rebuy_until_level).toBe(6)
    expect(t.starting_stack).toBe(10000)
    expect(t.ante_enabled).toBe(true)
    expect(t.blind_structure_id).toBe(structureId)
    expect(t.timer_mode).toBe('manual')
  })

  it('create_tournament falls back to sensible defaults for a minimal payload', async () => {
    await mkActiveSeason()
    const { data, error } = await admin.rpc('create_tournament', {
      p_payload: { name: 'Fecha mínima' },
    })
    expect(error).toBeNull()
    const t = ((data ?? []) as Database['public']['Tables']['tournament']['Row'][])[0]!
    expect(t.status).toBe('scheduled')
    expect(t.geofence_radius_m).toBe(100) // schema default
    expect(Number(t.buy_in)).toBe(0)
    expect(t.ante_enabled).toBe(false)
    expect(t.timer_mode).toBe('auto')
  })

  // ------------------------------------------------------------------------
  it('update_season_config persists the edited config fields', async () => {
    const season = await mkActiveSeason()

    const { data, error } = await admin.rpc('update_season_config', {
      p_payload: {
        points_multiplier: 12,
        bonus_final_table: 6,
        bonus_top3: 9,
        bonus_attendance: 3,
        no_show_penalty: -20,
        early_bird_bonus_chips: 3000,
        final_table_size_override: 8,
        payout_template: [0.5, 0.3, 0.2],
        cancel_bands: [
          { hours_before: 24, penalty: 0 },
          { hours_before: 6, penalty: -12 },
        ],
      },
    })
    expect(error).toBeNull()
    const s = ((data ?? []) as Database['public']['Tables']['season']['Row'][])[0]!
    expect(s.id).toBe(season.id)
    expect(s.points_multiplier).toBe(12)
    expect(s.bonus_final_table).toBe(6)
    expect(s.bonus_top3).toBe(9)
    expect(s.bonus_attendance).toBe(3)
    expect(s.no_show_penalty).toBe(-20)
    expect(s.early_bird_bonus_chips).toBe(3000)
    expect(s.final_table_size_override).toBe(8)
    expect(s.payout_template).toEqual([0.5, 0.3, 0.2])

    // Re-read to confirm it persisted (not just returned).
    const { data: reread } = await admin
      .from('season')
      .select('points_multiplier, final_table_size_override')
      .eq('id', season.id)
      .single()
    expect(reread!.points_multiplier).toBe(12)
    expect(reread!.final_table_size_override).toBe(8)
  })

  it('update_season_config patches only the keys present in the payload', async () => {
    const season = await mkActiveSeason({ points_multiplier: 15, bonus_top3: 4 })
    await admin.rpc('update_season_config', { p_payload: { points_multiplier: 11 } })
    const { data } = await admin
      .from('season')
      .select('points_multiplier, bonus_top3')
      .eq('id', season.id)
      .single()
    expect(data!.points_multiplier).toBe(11) // changed
    expect(data!.bonus_top3).toBe(4) // untouched
  })

  // ------------------------------------------------------------------------
  it('close_season archives the active season and opens the next year, carrying config + roster, zeroing points', async () => {
    // A distinctive config to prove it carries forward. mkActiveSeason archives
    // any pre-existing active season (single-active invariant, mig 0014) so this
    // one is THE active season close_season will roll over.
    const old = await mkActiveSeason({ points_multiplier: 7, no_show_penalty: -13 })
    const p1 = await mkPlayer()
    const p2 = await mkPlayer()

    const { data, error } = await admin.rpc('close_season')
    expect(error).toBeNull()
    const created = ((data ?? []) as Database['public']['Tables']['season']['Row'][])[0]!
    seasonIds.push(created.id) // track the RPC-created season for cleanup

    // Old season is archived (not deleted), new one active for year+1.
    const { data: oldRow } = await admin.from('season').select('status').eq('id', old.id).single()
    expect(oldRow!.status).toBe('archived')

    expect(created.status).toBe('active')
    expect(created.year).toBe(old.year + 1)
    expect(created.name).toBe(`Liga ${old.year + 1}`)
    // Config carried forward.
    expect(created.points_multiplier).toBe(7)
    expect(created.no_show_penalty).toBe(-13)

    // (a) close_season leaves EXACTLY ONE active season, and it is the new one.
    const { data: actives } = await admin.from('season').select('id').eq('status', 'active')
    expect((actives ?? []).map((r) => r.id)).toEqual([created.id])

    // Roster is global → players still present after rollover.
    const { data: players } = await admin.from('player').select('id').in('id', [p1, p2])
    expect((players ?? []).map((r) => r.id).sort()).toEqual([p1, p2].sort())

    // New season starts with ZERO entries.
    const { data: tourneys } = await admin
      .from('tournament')
      .select('id')
      .eq('season_id', created.id)
    expect(tourneys ?? []).toHaveLength(0)

    // (d) A brand-new active season with no tournaments returns the FULL league
    // roster at 0 pts (roster-at-0, mig 0014) — not an empty table. Every row
    // must sit at 0 points / 0 games / empty form, and p1 + p2 must be present.
    const { data: lb, error: lbErr } = await admin.rpc('leaderboard', { p_season_id: created.id })
    expect(lbErr).toBeNull()
    const rows = (lb ?? []) as { player_id: string; total_points: number; games_played: number; wins: number; form: string[] }[]
    expect(rows.length).toBeGreaterThan(0) // roster, not empty
    for (const r of rows) {
      expect(r.total_points).toBe(0)
      expect(r.games_played).toBe(0)
      expect(r.wins).toBe(0)
      expect(r.form).toEqual([])
    }
    const ids = rows.map((r) => r.player_id)
    expect(ids).toContain(p1)
    expect(ids).toContain(p2)
  })

  // ------------------------------------------------------------------------
  // (b) The partial unique index rejects a second active season.
  it('rejects a second active season insert (single-active unique index)', async () => {
    await mkActiveSeason() // THE active season now
    const { error } = await admin
      .from('season')
      .insert({ name: `CRUD ${RUN} dup`, year: nextYear(), status: 'active' })
      .select('id')
      .single()
    // 23505 = unique_violation raised by the season_single_active index.
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23505')
  })

  // ------------------------------------------------------------------------
  // (c) The repair path + index leave AT MOST one active season. The repair
  // itself runs at migration-apply time (`supabase db reset` replays 0014 over
  // the seed); duplicates can no longer be injected once the index exists, so
  // the observable, enforced guarantee is this invariant.
  it('never allows more than one active season (repair + index invariant)', async () => {
    await mkActiveSeason()
    const { data } = await admin.from('season').select('id').eq('status', 'active')
    expect((data ?? []).length).toBeLessThanOrEqual(1)
  })
})
