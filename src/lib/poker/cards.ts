// Card model for the Texas Hold'em equity engine (Phase 2, plan step 9).
//
// A Card is encoded as a single integer 0..51 for speed in the Monte-Carlo hot
// loop:  card = rankIndex * 4 + suitIndex
//   rankIndex 0..12  →  rank 2..14 (11=J, 12=Q, 13=K, 14=A)
//   suitIndex 0..3   →  's' | 'h' | 'd' | 'c'
// Rank/suit are recovered with rankOf / suitOf. All engine files agree on this
// encoding; do not hand-pack card integers elsewhere — use makeCard / parseCard.

export type Suit = 's' | 'h' | 'd' | 'c'
/** Integer 0..51 (see module header for the encoding). */
export type Card = number

/** Rank glyphs indexed by rankIndex (0 → '2' … 12 → 'A'). */
const RANK_CHARS = '23456789TJQKA'
/** Suit glyphs indexed by suitIndex. */
const SUIT_CHARS = 'shdc'

export const RANKS: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
export const SUITS: readonly Suit[] = ['s', 'h', 'd', 'c']

/** Build a card from a rank (2..14) and suit. */
export function makeCard(rank: number, suit: Suit): Card {
  const si = SUIT_CHARS.indexOf(suit)
  if (rank < 2 || rank > 14 || si < 0) throw new Error(`invalid card: ${rank}${suit}`)
  return (rank - 2) * 4 + si
}

/** Rank value 2..14 of a card. */
export function rankOf(card: Card): number {
  return (card >> 2) + 2
}

/** Suit glyph of a card. */
export function suitOf(card: Card): Suit {
  return SUIT_CHARS[card & 3] as Suit
}

/** Suit index 0..3 of a card (used by the evaluator hot path). */
export function suitIndexOf(card: Card): number {
  return card & 3
}

/** Parse a two-character card like "As", "Kh", "Td". Case-insensitive. */
export function parseCard(str: string): Card {
  if (str.length !== 2) throw new Error(`invalid card: "${str}"`)
  const ri = RANK_CHARS.indexOf(str[0].toUpperCase())
  const si = SUIT_CHARS.indexOf(str[1].toLowerCase())
  if (ri < 0 || si < 0) throw new Error(`invalid card: "${str}"`)
  return ri * 4 + si
}

/** Format a card back to its two-character string, e.g. 51 → "Ac". */
export function formatCard(card: Card): string {
  return RANK_CHARS[card >> 2] + SUIT_CHARS[card & 3]
}

/** Parse a run of cards, e.g. "As Kh" / "AsKh" / "As,Kh". */
export function parseCards(input: string): Card[] {
  const cleaned = input.replace(/[\s,]+/g, '')
  const out: Card[] = []
  for (let i = 0; i < cleaned.length; i += 2) out.push(parseCard(cleaned.slice(i, i + 2)))
  return out
}

/** A fresh, ordered 52-card deck. */
export function makeDeck(): Card[] {
  const deck: Card[] = []
  for (let c = 0; c < 52; c++) deck.push(c)
  return deck
}
