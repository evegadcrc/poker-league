import { beforeEach, describe, expect, it } from 'vitest'
import { NEXT_KEY, clearNext, isSafeNext, peekNext, saveNext, takeNext } from './next'

beforeEach(() => {
  localStorage.clear()
})

describe('isSafeNext', () => {
  it('accepts same-origin in-app paths (with query / hash)', () => {
    expect(isSafeNext('/fechas/abc')).toBe(true)
    expect(isSafeNext('/vivo?x=1#top')).toBe(true)
  })

  it('rejects home, login, protocol-relative, absolute and junk values', () => {
    expect(isSafeNext('/')).toBe(false)
    expect(isSafeNext('/?a=1')).toBe(false)
    expect(isSafeNext('/login')).toBe(false)
    expect(isSafeNext('//evil.example/x')).toBe(false)
    expect(isSafeNext('https://evil.example/x')).toBe(false)
    expect(isSafeNext('/fechas/a b')).toBe(false)
    expect(isSafeNext('')).toBe(false)
    expect(isSafeNext(null)).toBe(false)
    expect(isSafeNext('/' + 'x'.repeat(3000))).toBe(false)
  })
})

describe('saveNext / takeNext', () => {
  it('round-trips a deep link and clears it on take', () => {
    saveNext('/fechas/t-1', 1000)
    expect(localStorage.getItem(NEXT_KEY)).toContain('/fechas/t-1')
    expect(takeNext(2000)).toBe('/fechas/t-1')
    expect(takeNext(2000)).toBeNull()
    expect(localStorage.getItem(NEXT_KEY)).toBeNull()
  })

  it('never stores the home or login paths', () => {
    saveNext('/', 1000)
    saveNext('/login', 1000)
    expect(localStorage.getItem(NEXT_KEY)).toBeNull()
  })

  it('expires after 24h', () => {
    saveNext('/fechas/t-1', 0)
    expect(takeNext(24 * 60 * 60 * 1000 + 1)).toBeNull()
  })

  it('ignores malformed or unsafe stored values (and clears them)', () => {
    localStorage.setItem(NEXT_KEY, 'not json')
    expect(takeNext()).toBeNull()
    expect(localStorage.getItem(NEXT_KEY)).toBeNull()
    localStorage.setItem(NEXT_KEY, JSON.stringify({ path: '//evil.example', ts: Date.now() }))
    expect(takeNext()).toBeNull()
  })
})

describe('peekNext / clearNext (render-safe split)', () => {
  it('peek reads without clearing; clear removes', () => {
    saveNext('/fechas/t-1', 1000)
    expect(peekNext(2000)).toBe('/fechas/t-1')
    expect(peekNext(2000)).toBe('/fechas/t-1')
    clearNext()
    expect(peekNext(2000)).toBeNull()
  })

  it('peek applies the TTL and safety checks', () => {
    saveNext('/fechas/t-1', 0)
    expect(peekNext(24 * 60 * 60 * 1000 + 1)).toBeNull()
    localStorage.setItem(NEXT_KEY, JSON.stringify({ path: '/login', ts: Date.now() }))
    expect(peekNext()).toBeNull()
  })
})
