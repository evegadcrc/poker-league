import { describe, expect, it } from 'vitest'
import { parseCards } from './cards'
import { categoryOf, compareHands, decodeHand, evaluate7, HAND_CATEGORY } from './evaluator'

const cat = (s: string) => categoryOf(evaluate7(parseCards(s)))
const tb = (s: string) => decodeHand(evaluate7(parseCards(s))).tiebreak

describe('evaluator — category detection (best 5 of 7)', () => {
  it('straight flush (and royal)', () => {
    expect(cat('9h8h7h6h5h2c3d')).toBe(HAND_CATEGORY.STRAIGHT_FLUSH)
    expect(tb('9h8h7h6h5h2c3d')[0]).toBe(9)
    expect(cat('AhKhQhJhTh2c3d')).toBe(HAND_CATEGORY.STRAIGHT_FLUSH) // royal
    expect(tb('AhKhQhJhTh2c3d')[0]).toBe(14)
  })

  it('four of a kind with correct kicker', () => {
    expect(cat('AsAhAdAcKh2c3d')).toBe(HAND_CATEGORY.QUADS)
    expect(tb('AsAhAdAcKh2c3d').slice(0, 2)).toEqual([14, 13])
  })

  it('full house (trips over pair)', () => {
    expect(cat('AsAhAdKhKc2c3d')).toBe(HAND_CATEGORY.FULL_HOUSE)
    expect(tb('AsAhAdKhKc2c3d').slice(0, 2)).toEqual([14, 13])
  })

  it('flush, top five suited ranks', () => {
    expect(cat('AhKh9h5h2h7c8d')).toBe(HAND_CATEGORY.FLUSH)
    expect(tb('AhKh9h5h2h7c8d')).toEqual([14, 13, 9, 5, 2])
  })

  it('straight, ace-high (broadway)', () => {
    expect(cat('TsJhQcKdAh2c4s')).toBe(HAND_CATEGORY.STRAIGHT)
    expect(tb('TsJhQcKdAh2c4s')[0]).toBe(14)
  })

  it('wheel straight A-2-3-4-5 ranks as 5-high', () => {
    expect(cat('As2h3d4c5sKhQd')).toBe(HAND_CATEGORY.STRAIGHT)
    expect(tb('As2h3d4c5sKhQd')[0]).toBe(5)
  })

  it('three of a kind', () => {
    expect(cat('7s7h7dKc2d3h5s')).toBe(HAND_CATEGORY.TRIPS)
    expect(tb('7s7h7dKc2d3h5s').slice(0, 3)).toEqual([7, 13, 5])
  })

  it('two pair with kicker', () => {
    expect(cat('AsAhKcKd2c3h5s')).toBe(HAND_CATEGORY.TWO_PAIR)
    expect(tb('AsAhKcKd2c3h5s').slice(0, 3)).toEqual([14, 13, 5])
  })

  it('one pair with three kickers', () => {
    expect(cat('AsAhKcQd2c3h5s')).toBe(HAND_CATEGORY.PAIR)
    expect(tb('AsAhKcQd2c3h5s').slice(0, 4)).toEqual([14, 13, 12, 5])
  })

  it('high card', () => {
    expect(cat('AsKhQcJd9s3h2d')).toBe(HAND_CATEGORY.HIGH_CARD)
    expect(tb('AsKhQcJd9s3h2d')).toEqual([14, 13, 12, 11, 9])
  })
})

describe('evaluator — 5- and 6-card inputs (Calculadora flop/turn readout)', () => {
  // The "Tu mejor mano" readout calls evaluate7 with 2 hole + 3 board (5 cards,
  // flop) and 2 hole + 4 board (6 cards, turn). The counting evaluator has no
  // 7-card assumption; pin the shorter shipped, user-visible inputs.
  it('5 cards (flop): royal straight flush', () => {
    expect(cat('AhKhQhJhTh')).toBe(HAND_CATEGORY.STRAIGHT_FLUSH)
    expect(tb('AhKhQhJhTh')[0]).toBe(14)
  })

  it('5 cards (flop): two pair with kicker', () => {
    expect(cat('AsAhKcKd9s')).toBe(HAND_CATEGORY.TWO_PAIR)
    expect(tb('AsAhKcKd9s').slice(0, 3)).toEqual([14, 13, 9])
  })

  it('5 cards (flop): high card, all five kickers', () => {
    expect(cat('AsKhQcJd9s')).toBe(HAND_CATEGORY.HIGH_CARD)
    expect(tb('AsKhQcJd9s')).toEqual([14, 13, 12, 11, 9])
  })

  it('6 cards (turn): picks the best five — flush over the sixth card', () => {
    expect(cat('AhKh9h5h2h7c')).toBe(HAND_CATEGORY.FLUSH)
    expect(tb('AhKh9h5h2h7c')).toEqual([14, 13, 9, 5, 2])
  })

  it('6 cards (turn): full house from trips + pair', () => {
    expect(cat('AsAhAdKhKc2c')).toBe(HAND_CATEGORY.FULL_HOUSE)
    expect(tb('AsAhAdKhKc2c').slice(0, 2)).toEqual([14, 13])
  })

  it('6 cards (turn): one pair, best three kickers among the rest', () => {
    // Pair of 9s + A K Q kickers (the low 2 is dropped).
    expect(cat('9s9hAcKdQh2c')).toBe(HAND_CATEGORY.PAIR)
    expect(tb('9s9hAcKdQh2c').slice(0, 4)).toEqual([9, 14, 13, 12])
  })
})

describe('evaluator — comparison correctness', () => {
  it('ranks categories monotonically worst → best', () => {
    const ordered = [
      'AsKhQcJd9s3h2d', // high card
      '2s2hKdQc9h5s3d', // pair
      '2s2h5d5c9hKs3d', // two pair
      '7s7h7dKc2d4h9s', // trips
      'TsJhQcKdAh2c4s', // straight
      'AhKh9h5h2h7c8d', // flush
      'AsAhAdKhKc2c3d', // full house
      'AsAhAdAcKh2c3d', // quads
      '9h8h7h6h5h2c3d', // straight flush
    ].map((h) => evaluate7(parseCards(h)))
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]).toBeGreaterThan(ordered[i - 1])
    }
  })

  it('flush beats a straight', () => {
    const flush = parseCards('AhKh9h5h2h7c8d')
    const straight = parseCards('TsJhQcKd9s2c3d')
    expect(compareHands(flush, straight)).toBeGreaterThan(0)
  })

  it('breaks ties on kickers (higher third kicker wins)', () => {
    const better = parseCards('AsAhKdQc9h3s2d') // pair AA, kickers K Q 9
    const worse = parseCards('AdAcKhQd8h3c2s') // pair AA, kickers K Q 8
    expect(compareHands(better, worse)).toBeGreaterThan(0)
  })

  it('identical hand strength ties to zero', () => {
    // Both play the same board straight; holes are irrelevant blanks.
    const a = parseCards('TsJhQdKc9s2c3d')
    const b = parseCards('TsJhQdKc9s4h5c')
    expect(compareHands(a, b)).toBe(0)
  })
})
