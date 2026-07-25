import { describe, expect, it } from 'vitest'
import { parseCards } from './cards'
import { estimateEquity, mulberry32 } from './equity'

// Seeded so the Monte-Carlo can't flake (project flaky-test lesson). Tolerance
// on the classic-equity fixtures is the plan's ±1.5%.
const ITER = 50_000

describe('equity — seeded Monte-Carlo against known equities', () => {
  it('AA vs KK preflop ≈ 82/18', () => {
    const res = estimateEquity({
      hole: parseCards('AsAh'),
      opponents: [parseCards('KsKh')],
      iterations: ITER,
      rng: mulberry32(0xa1),
    })
    expect(res.win + res.tie + res.lose).toBeCloseTo(1, 10)
    expect(res.win).toBeGreaterThan(0.805)
    expect(res.win).toBeLessThan(0.835)
  })

  // NOTE: the plan quotes "AKs vs 22 ≈ 46/54". That 46/54 figure is actually the
  // OFFSUIT matchup (AKo vs 22). Suited AK vs 22 is a dead-even coin flip
  // (~49.9/49.2/0.9 per PokerStove); our engine reproduces both. See two tests
  // below — the engine is the correctness authority, so we assert the TRUE values.
  it('AKs vs 22 is a dead-even coin-flip (~49.7/49.7)', () => {
    const res = estimateEquity({
      hole: parseCards('AsKs'),
      opponents: [parseCards('2h2d')],
      iterations: ITER,
      rng: mulberry32(0xb2),
    })
    expect(res.win).toBeGreaterThan(0.482)
    expect(res.win).toBeLessThan(0.512)
    expect(Math.abs(res.win - res.lose)).toBeLessThan(0.02) // essentially even
  })

  it('AKo vs 22 ≈ 46/54 (the plan\'s "coin-flip" figure — offsuit, pair favored)', () => {
    const res = estimateEquity({
      hole: parseCards('AsKh'),
      opponents: [parseCards('2c2d')],
      iterations: ITER,
      rng: mulberry32(0xb2),
    })
    expect(res.win).toBeGreaterThan(0.451)
    expect(res.win).toBeLessThan(0.481)
    expect(res.lose).toBeGreaterThan(res.win) // the pair is the favorite
  })
})

describe('equity — exact enumeration (0 variance)', () => {
  it('river with 0 unknowns: made flush beats a made straight 100/0', () => {
    // Board: Th Jh 2h 7c 4s. Hero A♥K♥ → nut flush. Villain 8♦9♣ → 7-8-9-T-J.
    const res = estimateEquity({
      hole: parseCards('AhKh'),
      board: parseCards('ThJh2h7c4s'),
      opponents: [parseCards('8d9c')],
    })
    expect(res).toEqual({ win: 1, tie: 0, lose: 0 })
  })

  it('river with 0 unknowns: board plays for both → exact split', () => {
    // Board is a K-high straight; both players play the board.
    const res = estimateEquity({
      hole: parseCards('2c3d'),
      board: parseCards('TsJhQdKc9s'),
      opponents: [parseCards('4h5c')],
    })
    expect(res).toEqual({ win: 0, tie: 1, lose: 0 })
  })

  it('turn (1 unknown) enumerates exactly and is seed-independent', () => {
    const spot = {
      hole: parseCards('AhKh'),
      board: parseCards('ThJh2h7c'),
      opponents: [parseCards('8d9c')],
    } as const
    const withSeed = estimateEquity({ ...spot, rng: mulberry32(1) })
    const otherSeed = estimateEquity({ ...spot, rng: mulberry32(999) })
    expect(withSeed).toEqual(otherSeed) // enumeration ignores the rng
    expect(withSeed.win + withSeed.tie + withSeed.lose).toBeCloseTo(1, 10)
  })
})

describe('equity — determinism', () => {
  it('same seed → identical result across two calls', () => {
    const spot = {
      hole: parseCards('AsAh'),
      opponents: [parseCards('KsKh')],
      iterations: 3000,
    } as const
    const r1 = estimateEquity({ ...spot, rng: mulberry32(7) })
    const r2 = estimateEquity({ ...spot, rng: mulberry32(7) })
    expect(r1).toEqual(r2)
  })

  it('supports random opponents by count (UI path)', () => {
    const res = estimateEquity({
      hole: parseCards('AsAh'),
      opponents: 1,
      iterations: 20_000,
      rng: mulberry32(0xc3),
    })
    expect(res.win + res.tie + res.lose).toBeCloseTo(1, 10)
    expect(res.win).toBeGreaterThan(0.8) // AA vs one random hand ≈ 85%
  })

  it('rejects duplicate cards', () => {
    expect(() =>
      estimateEquity({ hole: parseCards('AsAs'), opponents: 1 }),
    ).toThrow(/duplicate/)
  })
})
