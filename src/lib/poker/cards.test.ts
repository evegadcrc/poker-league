import { describe, expect, it } from 'vitest'
import {
  formatCard,
  makeCard,
  makeDeck,
  parseCard,
  parseCards,
  rankOf,
  suitOf,
} from './cards'

describe('cards — model + parse/format', () => {
  it('parses and formats a card round-trip', () => {
    for (const s of ['As', 'Kh', 'Td', '2c', '9h', 'Qs']) {
      expect(formatCard(parseCard(s))).toBe(s)
    }
  })

  it('is case-insensitive on parse', () => {
    expect(parseCard('as')).toBe(parseCard('As'))
    expect(parseCard('KH')).toBe(parseCard('Kh'))
  })

  it('exposes rank (2..14) and suit', () => {
    expect(rankOf(parseCard('As'))).toBe(14)
    expect(rankOf(parseCard('2c'))).toBe(2)
    expect(rankOf(parseCard('Td'))).toBe(10)
    expect(suitOf(parseCard('Kh'))).toBe('h')
    expect(suitOf(parseCard('Kc'))).toBe('c')
  })

  it('makeCard mirrors parseCard', () => {
    expect(makeCard(14, 's')).toBe(parseCard('As'))
    expect(makeCard(2, 'c')).toBe(parseCard('2c'))
  })

  it('rejects malformed cards', () => {
    expect(() => parseCard('Xx')).toThrow()
    expect(() => parseCard('A')).toThrow()
    expect(() => makeCard(15, 's')).toThrow()
  })

  it('parseCards splits runs with or without separators', () => {
    expect(parseCards('AsKh')).toEqual(parseCards('As Kh'))
    expect(parseCards('As,Kh')).toEqual(parseCards('As Kh'))
    expect(parseCards('ThJh2h7c4s')).toHaveLength(5)
  })

  it('makeDeck yields 52 unique cards', () => {
    const deck = makeDeck()
    expect(deck).toHaveLength(52)
    expect(new Set(deck).size).toBe(52)
    expect(Math.min(...deck)).toBe(0)
    expect(Math.max(...deck)).toBe(51)
  })
})
