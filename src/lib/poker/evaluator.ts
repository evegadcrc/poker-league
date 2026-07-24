// 7-card Texas Hold'em hand evaluator (Phase 2, plan step 9).
//
// evaluate7 picks the best 5-card hand out of 5..7 cards and returns a single
// packed integer "score". Higher score = stronger hand, so two hands compare
// with a plain numeric comparison — no allocation on the hot path beyond the
// per-call count arrays. The score packs the category in the high nibble and up
// to five ordered tie-break ranks in the low nibbles:
//
//   score = category*16^5 + t0*16^4 + t1*16^3 + t2*16^2 + t3*16 + t4
//
// Each tie-break rank is 0..14 (one nibble); category is 0..8. Max score is
// well under 2^31, so it stays a safe integer. Wheel straights (A-2-3-4-5) rank
// as 5-high; kickers follow standard poker ordering.

import { rankOf, suitIndexOf, type Card } from './cards'

export const HAND_CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
} as const

export const CATEGORY_NAMES: readonly string[] = [
  'High Card',
  'Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
]

/** Highest straight high-card in a rank bitmask, or 0 if none (wheel → 5). */
function straightHighFromMask(mask: number): number {
  // Duplicate the ace (bit 14) down to bit 1 so A-2-3-4-5 is detectable.
  const m = mask | (((mask >> 14) & 1) << 1)
  for (let high = 14; high >= 5; high--) {
    if (((m >> (high - 4)) & 0b11111) === 0b11111) return high
  }
  return 0
}

/** Top `n` distinct ranks (high→low) present in `rankMask`, skipping `exclude`. */
function topKickers(rankMask: number, exclude: readonly number[], n: number): number[] {
  const out: number[] = []
  for (let r = 14; r >= 2 && out.length < n; r--) {
    if ((rankMask >> r) & 1 && !exclude.includes(r)) out.push(r)
  }
  return out
}

/** Pack a category + up to five tie-break ranks into a comparable integer. */
function pack(category: number, tiebreak: readonly number[]): number {
  let score = category
  for (let i = 0; i < 5; i++) score = score * 16 + (tiebreak[i] ?? 0)
  return score
}

/**
 * Evaluate the best 5-card hand from 5, 6, or 7 cards. Returns a packed score
 * (see module header). Larger is stronger.
 */
export function evaluate7(cards: readonly Card[]): number {
  const rankCount = Array.from<number>({ length: 15 }).fill(0)
  const suitCount = [0, 0, 0, 0]
  const suitRankMask = [0, 0, 0, 0]
  let rankMask = 0

  for (const c of cards) {
    const r = rankOf(c)
    const s = suitIndexOf(c)
    rankCount[r]++
    suitCount[s]++
    suitRankMask[s] |= 1 << r
    rankMask |= 1 << r
  }

  // Grouped ranks, discovered high→low so the first of each kind is the best.
  let quad = 0
  let tripsA = 0
  let tripsB = 0
  let pairA = 0
  let pairB = 0
  for (let r = 14; r >= 2; r--) {
    const c = rankCount[r]
    if (c === 4) quad = r
    else if (c === 3) {
      if (!tripsA) tripsA = r
      else if (!tripsB) tripsB = r
    } else if (c === 2) {
      if (!pairA) pairA = r
      else if (!pairB) pairB = r
    }
  }

  const flushSuit = suitCount.findIndex((c) => c >= 5)

  // Straight flush (incl. royal) — check straights within the flush suit only.
  if (flushSuit >= 0) {
    const sfHigh = straightHighFromMask(suitRankMask[flushSuit])
    if (sfHigh) return pack(HAND_CATEGORY.STRAIGHT_FLUSH, [sfHigh])
  }

  if (quad) {
    const [k] = topKickers(rankMask, [quad], 1)
    return pack(HAND_CATEGORY.QUADS, [quad, k])
  }

  // Full house: a trip plus any other pair (a second trip contributes a pair).
  if (tripsA && (tripsB || pairA)) {
    const pairRank = Math.max(tripsB, pairA)
    return pack(HAND_CATEGORY.FULL_HOUSE, [tripsA, pairRank])
  }

  if (flushSuit >= 0) {
    const flushRanks: number[] = []
    for (let r = 14; r >= 2 && flushRanks.length < 5; r--) {
      if ((suitRankMask[flushSuit] >> r) & 1) flushRanks.push(r)
    }
    return pack(HAND_CATEGORY.FLUSH, flushRanks)
  }

  const straightHigh = straightHighFromMask(rankMask)
  if (straightHigh) return pack(HAND_CATEGORY.STRAIGHT, [straightHigh])

  if (tripsA) {
    const [k1, k2] = topKickers(rankMask, [tripsA], 2)
    return pack(HAND_CATEGORY.TRIPS, [tripsA, k1, k2])
  }

  if (pairA && pairB) {
    const [k] = topKickers(rankMask, [pairA, pairB], 1)
    return pack(HAND_CATEGORY.TWO_PAIR, [pairA, pairB, k])
  }

  if (pairA) {
    const [k1, k2, k3] = topKickers(rankMask, [pairA], 3)
    return pack(HAND_CATEGORY.PAIR, [pairA, k1, k2, k3])
  }

  return pack(HAND_CATEGORY.HIGH_CARD, topKickers(rankMask, [], 5))
}

/** Decode a packed score into its category and five tie-break ranks (for tests/UI). */
export function decodeHand(score: number): { category: number; tiebreak: number[] } {
  const tiebreak: number[] = []
  let s = score
  for (let i = 0; i < 5; i++) {
    tiebreak.unshift(s % 16)
    s = Math.floor(s / 16)
  }
  return { category: s, tiebreak }
}

/** Category (0..8) of a packed score. */
export function categoryOf(score: number): number {
  return Math.floor(score / 16 ** 5)
}

/** Compare two 5..7-card hands: >0 if `a` beats `b`, 0 if tied, <0 if `a` loses. */
export function compareHands(a: readonly Card[], b: readonly Card[]): number {
  return evaluate7(a) - evaluate7(b)
}
