// Monte-Carlo / exact-enumeration equity estimator (Phase 2, plan step 9).
//
// estimateEquity is PURE: given hero hole cards, an optional board, opponents
// (either a random count or explicit hole cards), and an injectable RNG, it
// returns win/tie/lose fractions that sum to 1. Determinism is by design — the
// RNG is threaded in (never Math.random) so seeded tests can't flake, per the
// project's flaky-test lesson.
//
// When the only unknowns are a small number of board cards AND every opponent
// hand is fixed, the estimator ENUMERATES every board runout exactly (0
// variance) instead of sampling. Otherwise it runs a seeded Monte-Carlo.

import { formatCard, type Card } from './cards'
import { evaluate7 } from './evaluator'

export interface EquityInput {
  /** Hero's two hole cards. */
  hole: readonly Card[]
  /** 0..5 community cards already dealt. */
  board?: readonly Card[]
  /** Number of random opponents, OR explicit two-card opponent hands. */
  opponents: number | readonly (readonly Card[])[]
  /** Monte-Carlo sample count (ignored when the exact path is taken). */
  iterations?: number
  /** Injectable PRNG returning [0,1). Defaults to a fixed-seed mulberry32. */
  rng?: () => number
}

export interface EquityResult {
  win: number
  tie: number
  lose: number
}

export const DEFAULT_ITERATIONS = 50_000
/** Exact enumeration is used only when unknown board cards ≤ this and opps are fixed. */
export const MAX_ENUM_BOARD = 2

/** Deterministic, fast PRNG (mulberry32). Same seed → same [0,1) sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function tally(heroScore: number, maxOppScore: number, out: EquityCounts): void {
  if (heroScore > maxOppScore) out.win++
  else if (heroScore === maxOppScore) out.tie++
  else out.lose++
}

interface EquityCounts {
  win: number
  tie: number
  lose: number
}

function fractions(c: EquityCounts, total: number): EquityResult {
  return { win: c.win / total, tie: c.tie / total, lose: c.lose / total }
}

/** Exact: enumerate every combination of `need` cards from `deck` for the board. */
function enumerateBoard(
  hole: readonly Card[],
  board: readonly Card[],
  opps: readonly (readonly Card[])[],
  deck: readonly Card[],
  need: number,
): EquityResult {
  const counts: EquityCounts = { win: 0, tie: 0, lose: 0 }
  let total = 0
  const chosen: Card[] = []

  const score = (): void => {
    const full = board.concat(chosen)
    const heroScore = evaluate7([hole[0], hole[1], ...full])
    let maxOpp = -1
    for (const o of opps) {
      const s = evaluate7([o[0], o[1], ...full])
      if (s > maxOpp) maxOpp = s
    }
    tally(heroScore, maxOpp, counts)
    total++
  }

  const recurse = (start: number, remaining: number): void => {
    if (remaining === 0) {
      score()
      return
    }
    for (let i = start; i <= deck.length - remaining; i++) {
      chosen.push(deck[i])
      recurse(i + 1, remaining - 1)
      chosen.pop()
    }
  }

  recurse(0, need)
  return fractions(counts, total)
}

/** Seeded Monte-Carlo: sample unknown board + random-opponent cards. */
function monteCarlo(
  hole: readonly Card[],
  board: readonly Card[],
  oppsFixed: readonly (readonly Card[])[] | null,
  numOpponents: number,
  deck: readonly Card[],
  unknownBoard: number,
  iterations: number,
  rng: () => number,
): EquityResult {
  const counts: EquityCounts = { win: 0, tie: 0, lose: 0 }
  const needed = unknownBoard + (oppsFixed ? 0 : numOpponents * 2)
  const pool = deck.slice()
  const n = pool.length
  if (needed > n) throw new Error('not enough cards left to deal this scenario')

  for (let it = 0; it < iterations; it++) {
    // Partial Fisher-Yates: shuffle the first `needed` slots, drawing uniformly
    // from the whole pool each time (pool stays a permutation of the deck).
    for (let i = 0; i < needed; i++) {
      const j = i + Math.floor(rng() * (n - i))
      const tmp = pool[i]
      pool[i] = pool[j]
      pool[j] = tmp
    }
    let idx = 0
    const full = board.slice()
    for (let b = 0; b < unknownBoard; b++) full.push(pool[idx++])

    const heroScore = evaluate7([hole[0], hole[1], ...full])
    let maxOpp = -1
    if (oppsFixed) {
      for (const o of oppsFixed) {
        const s = evaluate7([o[0], o[1], ...full])
        if (s > maxOpp) maxOpp = s
      }
    } else {
      for (let o = 0; o < numOpponents; o++) {
        const s = evaluate7([pool[idx++], pool[idx++], ...full])
        if (s > maxOpp) maxOpp = s
      }
    }
    tally(heroScore, maxOpp, counts)
  }
  return fractions(counts, iterations)
}

/**
 * Estimate hero's equity. Pure — deterministic for a given RNG. Uses exact
 * enumeration when opponents are fixed and few board cards are unknown,
 * otherwise a seeded Monte-Carlo.
 */
export function estimateEquity(input: EquityInput): EquityResult {
  const hole = input.hole
  const board = input.board ?? []
  if (hole.length !== 2) throw new Error('hole must be exactly 2 cards')
  if (board.length > 5) throw new Error('board cannot exceed 5 cards')

  const oppsFixed =
    typeof input.opponents === 'number' ? null : input.opponents.map((h) => [...h])
  const numOpponents = typeof input.opponents === 'number' ? input.opponents : input.opponents.length
  if (numOpponents < 1) throw new Error('need at least one opponent')

  // Collect known cards and reject duplicates.
  const known = new Set<Card>()
  const addKnown = (c: Card): void => {
    if (known.has(c)) throw new Error(`duplicate card: ${formatCard(c)}`)
    known.add(c)
  }
  hole.forEach(addKnown)
  board.forEach(addKnown)
  if (oppsFixed) {
    for (const h of oppsFixed) {
      if (h.length !== 2) throw new Error('each opponent hand must be 2 cards')
      h.forEach(addKnown)
    }
  }

  const deck: Card[] = []
  for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c)

  const unknownBoard = 5 - board.length

  if (oppsFixed && unknownBoard <= MAX_ENUM_BOARD) {
    return enumerateBoard(hole, board, oppsFixed, deck, unknownBoard)
  }

  const iterations = input.iterations ?? DEFAULT_ITERATIONS
  const rng = input.rng ?? mulberry32(0x9e3779b9)
  return monteCarlo(hole, board, oppsFixed, numOpponents, deck, unknownBoard, iterations, rng)
}
