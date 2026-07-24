import { describe, expect, it } from 'vitest'
import {
  attendanceCounts,
  aliveCount,
  colonesCompact,
  computePot,
  parseBands,
  pickBand,
  playedCount,
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
