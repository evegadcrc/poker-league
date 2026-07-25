import { describe, expect, it } from 'vitest'
import {
  chopAdjustedPrizes,
  chopPreview,
  isInPlay,
  playerActions,
  pointValueForPosition,
  tieSplitMoneyEach,
  type ScoringConfig,
} from '@/lib/admin'
import type { Prize } from '@/lib/live'

const CFG: ScoringConfig = {
  points_multiplier: 5,
  bonus_final_table: 10,
  bonus_attendance: 15,
  top_finish_bonuses: [20, 15, 10, 5],
}

describe('pointValueForPosition (scoring v2, finalist assumptions)', () => {
  it('scores position 1 in a field of 4 with the graduated 1st bonus', () => {
    // (4−1)×5 + 10 (MF) + 20 (1st) + 15 (att) = 60
    expect(pointValueForPosition(1, 4, CFG)).toBe(60)
  })
  it('applies the graduated top-4 bonus at 4th and drops it past 4th', () => {
    // 4th: (6−4)×5 + 10 + 5 (top4[3]) + 15 = 40
    expect(pointValueForPosition(4, 6, CFG)).toBe(40)
    // 5th: (6−5)×5 + 10 + 0 (past top-4) + 15 = 30
    expect(pointValueForPosition(5, 6, CFG)).toBe(30)
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
    // money = (85k + 40k)/2 = 62.5k → 62500 ; points = (60 + 50)/2 = 55
    const p = chopPreview(2, prizes, 2, CFG)
    expect(p.k).toBe(2)
    expect(p.n).toBe(4)
    expect(p.moneyEach).toBe(62_500)
    expect(p.pointsEach).toBe(55)
  })

  it('handles a 3-way chop', () => {
    // N = 0 placed + 3 = 3 ; money = (85+40+15)/3 = 46666.67 → 46667
    const p = chopPreview(3, prizes, 0, CFG)
    expect(p.n).toBe(3)
    expect(p.moneyEach).toBe(46_667)
    // points = (pv1 + pv2 + pv3)/3 with N=3, graduated top-4 [20,15,10,5]:
    // pv1=(2)×5+10+20+15=55 ; pv2=(1)×5+10+15+15=45 ; pv3=(0)×5+10+10+15=35 ; avg=45
    expect(p.pointsEach).toBe(45)
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

describe('chopAdjustedPrizes (completed-fecha payout per place)', () => {
  const prizes: Prize[] = [
    { position: 1, pct: 0.5, amount: 80_000 },
    { position: 2, pct: 0.3, amount: 50_000 },
    { position: 3, pct: 0.2, amount: 30_000 },
  ]

  it('no chop → returns the template amounts unchanged (fresh copy)', () => {
    const out = chopAdjustedPrizes(prizes, [
      { final_position: 1, chopped: false, chop_group: null },
      { final_position: 2, chopped: false, chop_group: null },
    ])
    expect(out.map((p) => p.amount)).toEqual([80_000, 50_000, 30_000])
    expect(out[0]).not.toBe(prizes[0]) // does not mutate/alias the input
  })

  it('a two-way top chop pools 1º+2º and pays each the equal split', () => {
    const out = chopAdjustedPrizes(prizes, [
      { final_position: 1, chopped: true, chop_group: 1 },
      { final_position: 2, chopped: true, chop_group: 1 },
      { final_position: 3, chopped: false, chop_group: null },
    ])
    // (80k + 50k)/2 = 65k for the two chopped places; 3º stays 30k.
    expect(out.find((p) => p.position === 1)!.amount).toBe(65_000)
    expect(out.find((p) => p.position === 2)!.amount).toBe(65_000)
    expect(out.find((p) => p.position === 3)!.amount).toBe(30_000)
  })

  it('splits a dead-even mid-field tie (chopped:false) sharing a chop_group at paid places', () => {
    // eliminate_multi tie (mig 0015) sets chop_group but leaves chopped=false by
    // design; decision 2026-07-24 (A) still splits money equally. Survivor crowned
    // 1º, the two tied players take paid places 2º/3º sharing chop_group 3.
    const out = chopAdjustedPrizes(prizes, [
      { final_position: 1, chopped: false, chop_group: null },
      { final_position: 2, chopped: false, chop_group: 3 },
      { final_position: 3, chopped: false, chop_group: 3 },
    ])
    // pooled = round((50k + 30k) / 2) = 40k each; non-tied 1º unaffected.
    const each = Math.round((50_000 + 30_000) / 2)
    expect(out.find((p) => p.position === 1)!.amount).toBe(80_000)
    expect(out.find((p) => p.position === 2)!.amount).toBe(each)
    expect(out.find((p) => p.position === 3)!.amount).toBe(each)
  })

  it('splits independent chop_groups separately', () => {
    const out = chopAdjustedPrizes(prizes, [
      { final_position: 1, chopped: false, chop_group: null },
      { final_position: 2, chopped: true, chop_group: 7 },
      { final_position: 3, chopped: true, chop_group: 7 },
    ])
    // group 7 pools 2º+3º → (50k + 30k)/2 = 40k each; 1º untouched.
    expect(out.find((p) => p.position === 1)!.amount).toBe(80_000)
    expect(out.find((p) => p.position === 2)!.amount).toBe(40_000)
    expect(out.find((p) => p.position === 3)!.amount).toBe(40_000)
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
