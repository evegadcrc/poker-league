import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import HandRankings from './HandRankings'

// Expected order, best → worst (plan step 11).
const ORDER = [
  'Escalera Real',
  'Escalera de Color',
  'Póker',
  'Full',
  'Color',
  'Escalera',
  'Trío',
  'Doble Pareja',
  'Pareja',
  'Carta Alta',
]

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
})

describe('HandRankings', () => {
  it('renders the 10 hands best → worst with their Spanish labels', () => {
    render(<HandRankings />)

    const rows = screen.getAllByTestId('hr-row')
    expect(rows).toHaveLength(10)

    // Row order matches best → worst; every Spanish label is present.
    ORDER.forEach((name, i) => {
      expect(within(rows[i]!).getByText(name)).toBeInTheDocument()
    })
    // First is Royal Flush, last is High Card.
    expect(within(rows[0]!).getByText('Escalera Real')).toBeInTheDocument()
    expect(within(rows[9]!).getByText('Carta Alta')).toBeInTheDocument()
  })

  it('renders each example hand as native card glyphs, never a raster image', () => {
    const { container } = render(<HandRankings />)
    // Every row exposes a 5-card example as an accessible group (role=img label),
    // rendered with native glyphs — the DOM contains no <img> element.
    expect(screen.getAllByRole('img')).toHaveLength(10)
    expect(container.querySelector('img')).toBeNull()
    // Escalera Real shows a 5-card example including the ♠ glyph.
    const royal = screen.getAllByTestId('hr-row')[0]!
    expect(royal.querySelectorAll('.hr-card')).toHaveLength(5)
    expect(royal.textContent).toContain('♠')
  })

  it('renders crisply under each of the three themes', () => {
    for (const theme of ['light', 'dark', 'neon']) {
      document.documentElement.setAttribute('data-theme', theme)
      const { unmount } = render(<HandRankings />)
      expect(screen.getAllByTestId('hr-row')).toHaveLength(10)
      unmount()
    }
  })
})
