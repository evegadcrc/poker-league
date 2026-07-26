import { describe, expect, it } from 'vitest'
import {
  chipsInPlay,
  compactChips,
  findLevel,
  formatClock,
  isAlive,
  liveStandings,
  nextLevel,
  ordinal,
  parsePrizes,
  pctLabel,
  remainingSeconds,
  showAnte,
  type BlindLevel,
  type StandingEntry,
} from './live'

const LEVELS: BlindLevel[] = [
  { level_number: 1, small_blind: 25, big_blind: 50, ante: 0, duration_seconds: 1200, is_break: false },
  { level_number: 2, small_blind: 50, big_blind: 100, ante: 0, duration_seconds: 1200, is_break: false },
  { level_number: 5, small_blind: 0, big_blind: 0, ante: 0, duration_seconds: 600, is_break: true },
  { level_number: 7, small_blind: 200, big_blind: 400, ante: 25, duration_seconds: 1200, is_break: false },
]

describe('remainingSeconds (state-based clock)', () => {
  it('running: level_duration − elapsed since level_started_at', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0)
    const startedAt = new Date(now - 5 * 60 * 1000).toISOString() // 5 min ago
    const r = remainingSeconds(
      { isPaused: false, pausedRemainingSeconds: null, levelStartedAt: startedAt, levelDurationSeconds: 1200 },
      now,
    )
    expect(r).toBe(1200 - 300) // 900s left
  })

  it('paused: shows paused_remaining_seconds, ignoring the wall clock', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0)
    const startedAt = new Date(now - 99 * 60 * 1000).toISOString() // long past
    const r = remainingSeconds(
      { isPaused: true, pausedRemainingSeconds: 512, levelStartedAt: startedAt, levelDurationSeconds: 1200 },
      now,
    )
    expect(r).toBe(512)
  })

  it('clamps at 0 when the level has expired', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0)
    const startedAt = new Date(now - 30 * 60 * 1000).toISOString() // 30 min ago > 20 min level
    const r = remainingSeconds(
      { isPaused: false, pausedRemainingSeconds: null, levelStartedAt: startedAt, levelDurationSeconds: 1200 },
      now,
    )
    expect(r).toBe(0)
  })

  it('falls back to full duration when level_started_at is null', () => {
    const r = remainingSeconds(
      { isPaused: false, pausedRemainingSeconds: null, levelStartedAt: null, levelDurationSeconds: 900 },
      Date.now(),
    )
    expect(r).toBe(900)
  })
})

describe('formatClock', () => {
  it('formats mm:ss zero-padded', () => {
    expect(formatClock(900)).toBe('15:00')
    expect(formatClock(512)).toBe('08:32')
    expect(formatClock(5)).toBe('00:05')
  })
  it('clamps negatives to 00:00', () => {
    expect(formatClock(-10)).toBe('00:00')
  })
})

describe('blind levels', () => {
  it('findLevel returns the matching level, else the first', () => {
    expect(findLevel(LEVELS, 2)?.big_blind).toBe(100)
    expect(findLevel(LEVELS, 99)?.level_number).toBe(1)
  })
  it('nextLevel returns the next-higher level number', () => {
    expect(nextLevel(LEVELS, 2)?.level_number).toBe(5)
    expect(nextLevel(LEVELS, 7)).toBeNull()
  })
  it('showAnte only when enabled AND the level ante is positive', () => {
    expect(showAnte(findLevel(LEVELS, 1), true)).toBe(false) // ante 0
    expect(showAnte(findLevel(LEVELS, 7), true)).toBe(true) // ante 25
    expect(showAnte(findLevel(LEVELS, 7), false)).toBe(false) // tournament ante disabled
  })
})

describe('prizes', () => {
  it('parses + sorts by position, tolerates junk', () => {
    const prizes = parsePrizes([
      { position: 3, pct: 0.12, amount: 15000 },
      { position: 1, pct: 0.6, amount: 85000, overridden: false },
      { garbage: true },
      { position: 2, pct: 0.28, amount: 40000 },
    ])
    expect(prizes.map((p) => p.position)).toEqual([1, 2, 3])
    expect(prizes[0]!.amount).toBe(85000)
  })
  it('returns [] for null / non-array', () => {
    expect(parsePrizes(null)).toEqual([])
    expect(parsePrizes('nope')).toEqual([])
  })
  it('pctLabel + ordinal', () => {
    expect(pctLabel(0.6)).toBe('60%')
    expect(pctLabel(null)).toBe('')
    expect(ordinal(2)).toBe('2º')
  })
})

const entry = (over: Partial<StandingEntry>): StandingEntry => ({
  id: crypto.randomUUID(),
  status: 'playing',
  final_position: null,
  chips: 10000,
  paid: true,
  points_earned: null,
  made_final_table: false,
  chop_group: null,
  player: { name: 'X', avatar_url: null },
  ...over,
})

describe('live standings', () => {
  it('alive first (chip-leader first), then eliminated by final_position asc', () => {
    const rows: StandingEntry[] = [
      entry({ id: 'a', status: 'playing', chips: 12000, player: { name: 'Ana', avatar_url: null } }),
      entry({ id: 'b', status: 'eliminated', final_position: 8, player: { name: 'Ben', avatar_url: null } }),
      entry({ id: 'c', status: 'playing', chips: 30000, player: { name: 'Cid', avatar_url: null } }),
      entry({ id: 'd', status: 'eliminated', final_position: 7, player: { name: 'Dee', avatar_url: null } }),
      entry({ id: 'e', status: 'confirmed', final_position: null, player: { name: 'Eve', avatar_url: null } }),
    ]
    const sorted = liveStandings(rows)
    expect(sorted.map((s) => s.id)).toEqual(['c', 'a', 'd', 'b']) // 'e' dropped (never seated)
  })

  it('isAlive + chipsInPlay only count seated-and-playing stacks', () => {
    const rows: StandingEntry[] = [
      entry({ status: 'playing', chips: 12000 }),
      entry({ status: 'checked_in', chips: 10000 }),
      entry({ status: 'eliminated', chips: 0, final_position: 9 }),
      entry({ status: 'confirmed', chips: null }),
    ]
    expect(chipsInPlay(rows)).toBe(22000)
    expect(isAlive('playing')).toBe(true)
    expect(isAlive('eliminated')).toBe(false)
  })
})

describe('compactChips', () => {
  it('abbreviates thousands', () => {
    expect(compactChips(124000)).toBe('124K')
    expect(compactChips(97000)).toBe('97K')
    expect(compactChips(2500)).toBe('2.5K')
    expect(compactChips(500)).toBe('500')
  })
})
