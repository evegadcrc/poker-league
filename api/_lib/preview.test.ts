import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_TITLE,
  escapeHtml,
  formatWhenCR,
  previewHtml,
  previewMeta,
} from './preview.mjs'

const URL = 'https://poker-friends-xi.vercel.app/fechas/t-1'
const IMG = 'https://poker-friends-xi.vercel.app/og/fecha-card.png'
// 2026-09-20 19:00 Costa Rica (UTC-6) = 01:00Z next day.
const WHEN = '2026-09-21T01:00:00.000Z'

describe('formatWhenCR', () => {
  it('renders in Costa Rica time regardless of the server zone', () => {
    expect(formatWhenCR(WHEN)).toMatch(/^Dom 20 sept? · 19:00$/)
  })
  it('is empty for junk', () => {
    expect(formatWhenCR('nope')).toBe('')
  })
})

describe('previewMeta', () => {
  it('builds the fecha card for a scheduled fecha', () => {
    const m = previewMeta(
      { name: 'Fecha 10 — Casa de José', scheduled_at: WHEN, status: 'scheduled', cancelled: false, confirmed: 6 },
      URL,
      IMG,
    )
    expect(m.title).toBe('Fecha 10 — Casa de José · Poker Friends')
    expect(m.description).toMatch(/^Dom 20 sept? · 19:00 · 6 confirmados$/)
    expect(m.url).toBe(URL)
    expect(m.image).toBe(IMG)
    expect(m.redirect).toBe(URL)
  })

  it('prefixes live / completed / cancelled and pluralises one confirmado', () => {
    const base = { name: 'F', scheduled_at: WHEN, confirmed: 1 }
    expect(
      previewMeta({ ...base, status: 'live', cancelled: false }, URL, IMG).description,
    ).toMatch(/^🔴 En vivo · .* · 1 confirmado$/)
    expect(
      previewMeta({ ...base, status: 'completed', cancelled: false }, URL, IMG).description,
    ).toMatch(/^Jugada · /)
    expect(
      previewMeta({ ...base, status: 'scheduled', cancelled: true }, URL, IMG).description,
    ).toMatch(/^Cancelada · /)
  })

  it('falls back to the generic app card without a row', () => {
    const m = previewMeta(null, URL, IMG)
    expect(m.title).toBe(DEFAULT_TITLE)
    expect(m.description).toBe(DEFAULT_DESCRIPTION)
  })
})

describe('previewHtml', () => {
  it('emits the OG + Twitter tags with escaped values and a human redirect', () => {
    const html = previewHtml({
      title: 'Fecha <script> & "quotes"',
      description: "it's",
      url: URL,
      image: IMG,
      redirect: URL,
    })
    expect(html).toContain('<meta property="og:title" content="Fecha &lt;script&gt; &amp; &quot;quotes&quot;">')
    expect(html).toContain('<meta property="og:description" content="it&#39;s">')
    expect(html).toContain(`<meta property="og:image" content="${IMG}">`)
    expect(html).toContain(`<meta property="og:url" content="${URL}">`)
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(html).toContain(`<meta http-equiv="refresh" content="0; url=${URL}">`)
    expect(html).not.toContain('<script>')
  })

  it('escapeHtml covers the five specials', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  })
})
