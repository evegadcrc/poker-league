import { describe, expect, it } from 'vitest'
import {
  chopPreview,
  isInPlay,
  playerActions,
  pointValueForPosition,
  tieSplitMoneyEach,
  type ScoringConfig,
} from '@/lib/admin'
import type { Prize } from '@/lib/live'

const CFG: ScoringConfig = {
  points_multiplier: 10,
  bonus_final_table: 5,
  bonus_top3: 8,
  bonus_attendance: 2,
}

describe('pointValueForPosition (§5, finalist assumptions)', () => {
  it('scores position 1 in a field of 4', () => {
    // (4−1)×10 + 5 + 8 + 2 = 45
    expect(pointValueForPosition(1, 4, CFG)).toBe(45)
  })
  it('drops the top-3 bonus past 3rd', () => {
    // (6−4)×10 + 5 + 0 + 2 = 27
    expect(pointValueForPosition(4, 6, CFG)).toBe(27)
  })
})

describe('chopPreview', () => {
  const prizes: Prize[] = [
    { position: 1, pct: 0.6, amount: 85_000 },
    { position: 2, pct: 0.28, amount: 40_000 },
    { position: 3, pct: 0.12, amount: 15_000 },
  ]

  it('splits money + points equally for a final-2 chop (N=4)', () => {
    // finishers already placed = 2 (positions 3,4) → N = 2 + 2 = 4
    // money = (85k + 40k)/2 = 62.5k → 62500 ; points = (45 + 35)/2 = 40
    const p = chopPreview(2, prizes, 2, CFG)
    expect(p.k).toBe(2)
    expect(p.n).toBe(4)
    expect(p.moneyEach).toBe(62_500)
    expect(p.pointsEach).toBe(40)
  })

  it('handles a 3-way chop', () => {
    // N = 0 placed + 3 = 3 ; money = (85+40+15)/3 = 46666.67 → 46667
    const p = chopPreview(3, prizes, 0, CFG)
    expect(p.n).toBe(3)
    expect(p.moneyEach).toBe(46_667)
    // points = (pv1 + pv2 + pv3)/3 with N=3 → ((2)+(1)+(0))×10 + per-slot bonuses
    // pv1=20+5+8+2=35 ; pv2=10+5+8+2=25 ; pv3=0+5+8+2=15 ; avg=25
    expect(p.pointsEach).toBe(25)
  })

  it('is safe with fewer prize slices than choppers', () => {
    const p = chopPreview(2, [{ position: 1, pct: 1, amount: 50_000 }], 0, CFG)
    expect(p.moneyEach).toBe(25_000)
  })
})

describe('tieSplitMoneyEach (dead-even multi-bust money split)', () => {
  const prizes: Prize[] = [
    { position: 1, pct: 0.6, amount: 85_000 },
    { position: 2, pct: 0.28, amount: 40_000 },
    { position: 3, pct: 0.12, amount: 15_000 },
  ]

  it('splits the summed prize amounts of the tied positions equally', () => {
    // tie at 2nd/3rd → (40k + 15k)/2 = 27.5k → 27500 (mirrors chop rounding)
    expect(tieSplitMoneyEach(prizes, [2, 3])).toBe(27_500)
  })

  it('a mid-field tie at unpaid positions splits ₡0', () => {
    // positions 7 & 8 have no prize slice → 0
    expect(tieSplitMoneyEach(prizes, [7, 8])).toBe(0)
  })

  it('rounds a 3-way split like chopPreview', () => {
    // (85k + 40k + 15k)/3 = 46666.67 → 46667
    expect(tieSplitMoneyEach(prizes, [1, 2, 3])).toBe(46_667)
  })

  it('is 0 with no positions', () => {
    expect(tieSplitMoneyEach(prizes, [])).toBe(0)
  })
})

describe('playerActions', () => {
  it('confirmed → pay + no-show', () => {
    const a = playerActions('confirmed', false)
    expect(a.map((x) => x.kind)).toEqual(['pay', 'noshow'])
  })
  it('playing → eliminate (with confirm)', () => {
    const a = playerActions('playing', true)
    expect(a).toHaveLength(1)
    expect(a[0]!.kind).toBe('eliminate')
    expect(a[0]!.confirm).toBe(true)
  })
  it('checked_in unpaid → pay + eliminate; paid → eliminate only', () => {
    expect(playerActions('checked_in', false).map((x) => x.kind)).toEqual(['pay', 'eliminate'])
    expect(playerActions('checked_in', true).map((x) => x.kind)).toEqual(['eliminate'])
  })
  it('eliminated → rebuy', () => {
    expect(playerActions('eliminated', true).map((x) => x.kind)).toEqual(['rebuy'])
  })
  it('winner / no_show / declined / invited → no actions', () => {
    expect(playerActions('winner', true)).toHaveLength(0)
    expect(playerActions('no_show', false)).toHaveLength(0)
    expect(playerActions('declined', false)).toHaveLength(0)
    expect(playerActions('invited', false)).toHaveLength(0)
  })
})

describe('isInPlay', () => {
  it('playing / checked_in / winner are in play; others are not', () => {
    expect(isInPlay('playing')).toBe(true)
    expect(isInPlay('checked_in')).toBe(true)
    expect(isInPlay('winner')).toBe(true)
    expect(isInPlay('eliminated')).toBe(false)
    expect(isInPlay('no_show')).toBe(false)
  })
})
