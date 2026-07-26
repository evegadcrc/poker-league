import { describe, expect, it } from 'vitest'
import {
  attendanceCounts,
  attendanceSort,
  aliveCount,
  colonesCompact,
  computePot,
  parseBands,
  parseLeagueConfig,
  pickBand,
  playedCount,
  pointsExample,
  statusPill,
  type EntryStatus,
} from '@/lib/fechas'

const DEFAULT_BANDS = parseBands([
  { hours_before: 24, penalty: 0 },
  { hours_before: 12, penalty: -5 },
  { hours_before: 6, penalty: -10 },
  { hours_before: 0, penalty: -15 },
])

const e = (status: EntryStatus, paid = false, rebuys = 0) => ({
  status,
  paid,
  rebuys_count: rebuys,
})

describe('fechas helpers', () => {
  it('groups attendance into Voy / Cancelaron / Sin resp.', () => {
    const entries = [
      e('confirmed'),
      e('checked_in'),
      e('playing'),
      e('winner'),
      e('declined'),
      e('declined'),
      e('invited'),
    ]
    expect(attendanceCounts(entries)).toEqual({ voy: 4, cancelaron: 2, sinResp: 1 })
  })

  it('counts alive and played for a live fecha', () => {
    const entries = [e('playing'), e('checked_in'), e('eliminated'), e('winner'), e('confirmed')]
    expect(aliveCount(entries)).toBe(2) // playing + checked_in
    expect(playedCount(entries)).toBe(4) // playing + checked_in + eliminated + winner
  })

  it('picks the graduated cancel band by hours remaining (SQL parity)', () => {
    expect(pickBand(DEFAULT_BANDS, 30).penalty).toBe(0)
    expect(pickBand(DEFAULT_BANDS, 20).penalty).toBe(-5)
    expect(pickBand(DEFAULT_BANDS, 9).penalty).toBe(-10)
    expect(pickBand(DEFAULT_BANDS, 3).penalty).toBe(-15)
    expect(pickBand(DEFAULT_BANDS, 0).penalty).toBe(-15)
  })

  it('falls back to default bands when jsonb is malformed', () => {
    expect(parseBands(null)).toHaveLength(4)
    expect(parseBands('nope')).toHaveLength(4)
    expect(parseBands([])).toHaveLength(4)
  })

  it('computes the pot from paid + rebuys, honoring an override', () => {
    const entries = [e('playing', true, 1), e('playing', true, 0), e('confirmed', false, 0)]
    expect(computePot(entries, 20000, 20000, null)).toBe(60000) // 2 paid * 20k + 1 rebuy * 20k
    expect(computePot(entries, 20000, 20000, 140000)).toBe(140000) // override wins
  })

  it('formats colones compactly', () => {
    expect(colonesCompact(20000)).toBe('₡20K')
    expect(colonesCompact(140000)).toBe('₡140K')
    expect(colonesCompact(500)).toBe('₡500')
  })

  it('pointsExample uses the scoring-v2 formula (graduated top-4, +MF, +att)', () => {
    // Scoring v2: (N−P)×5 + graduatedTop4 + final-table(10) + attendance(15).
    const cfg = parseLeagueConfig({
      points_multiplier: 5,
      bonus_final_table: 10,
      bonus_attendance: 15,
      top_finish_bonuses: [20, 15, 10, 5],
    })
    // Default (N=10, P=3): (10−3)×5=35 + 10 (3rd) + 10 (MF) + 15 (att) = 70.
    const ex = pointsExample(cfg)
    expect(ex.base).toBe(35)
    expect(ex.graduatedTop4).toBe(10)
    expect(ex.total).toBe(70)
    // 1st in a 8-field: (8−1)×5=35 + 20 (1st) + 10 + 15 = 80.
    expect(pointsExample(cfg, 8, 1).total).toBe(80)
    // 5th (past top-4) drops the graduated bonus: (8−5)×5=15 + 0 + 10 + 15 = 40.
    expect(pointsExample(cfg, 8, 5).graduatedTop4).toBe(0)
    expect(pointsExample(cfg, 8, 5).total).toBe(40)
  })

  it('attendanceSort orders alive → finishers(by place asc) → the RSVP remainder', () => {
    const s = (status: EntryStatus, final_position: number | null = null) => ({
      status,
      final_position,
    })
    // Deliberately scrambled: a champion (place 1), mid + late eliminations, an
    // alive checked-in + playing pair, and confirmed/no_show/declined trailers.
    const rows = [
      s('eliminated', 14),
      s('confirmed'),
      s('winner', 1),
      s('checked_in'),
      s('no_show'),
      s('eliminated', 2),
      s('playing'),
      s('declined'),
    ]
    const sorted = [...rows].sort(attendanceSort)

    const seq = sorted.map((r) => `${r.status}${r.final_position ?? ''}`)
    // Alive (checked_in + playing, stable) first, then finishers 1 < 2 < 14,
    // then the remainder by statusRank (confirmed < no_show < declined).
    expect(seq).toEqual([
      'checked_in',
      'playing',
      'winner1',
      'eliminated2',
      'eliminated14',
      'confirmed',
      'no_show',
      'declined',
    ])
  })

  it('attendanceSort keeps every alive player ahead of any finisher', () => {
    const alive = { status: 'playing' as EntryStatus, final_position: null }
    const winner = { status: 'winner' as EntryStatus, final_position: 1 }
    expect(attendanceSort(alive, winner)).toBeLessThan(0)
    expect(attendanceSort(winner, alive)).toBeGreaterThan(0)
  })

  it('attendanceSort ranks a better finish (lower place) ahead of a worse one', () => {
    const first = { status: 'winner' as EntryStatus, final_position: 1 }
    const second = { status: 'eliminated' as EntryStatus, final_position: 2 }
    const last = { status: 'eliminated' as EntryStatus, final_position: 14 }
    expect(attendanceSort(first, second)).toBeLessThan(0)
    expect(attendanceSort(second, last)).toBeLessThan(0)
  })

  it('attendanceSort drops confirmed / no_show below any finisher', () => {
    const finisher = { status: 'eliminated' as EntryStatus, final_position: 2 }
    const confirmed = { status: 'confirmed' as EntryStatus, final_position: null }
    const noShow = { status: 'no_show' as EntryStatus, final_position: null }
    expect(attendanceSort(finisher, confirmed)).toBeLessThan(0)
    expect(attendanceSort(finisher, noShow)).toBeLessThan(0)
  })

  it('maps every entry status to a pill label + class (all 8 states)', () => {
    // Full-enum contract — the map is a Record<EntryStatus, …>, so every one of
    // the 8 lifecycle states must have its label + class pinned (TS guarantees
    // the keys exist, not their values).
    const expected: Record<EntryStatus, { label: string; cls: string }> = {
      invited: { label: 'Sin resp.', cls: 's-none' },
      confirmed: { label: 'Confirmado', cls: 's-confirmed' },
      declined: { label: 'Canceló', cls: 's-declined' },
      checked_in: { label: 'Check-in', cls: 's-checked' },
      playing: { label: 'Jugando', cls: 's-playing' },
      no_show: { label: 'No-show', cls: 's-noshow' },
      eliminated: { label: 'Fuera', cls: 's-out' },
      winner: { label: 'Campeón', cls: 's-win' },
    }
    for (const status of Object.keys(expected) as EntryStatus[]) {
      expect(statusPill(status)).toEqual(expected[status])
    }
  })
})
