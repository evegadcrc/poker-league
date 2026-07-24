import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
// Inject App.css so the .legend class layout is computable in jsdom.
import '@/App.css'
import Legend from './Legend'

describe('Legend', () => {
  it('renders the four form-guide tiers', () => {
    render(<Legend />)
    for (const label of ['Campeón', 'Podio', 'Mesa final', 'Fuera']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('centers the legend row horizontally', () => {
    const { container } = render(<Legend />)
    const legend = container.querySelector('.legend') as HTMLElement
    expect(legend).not.toBeNull()
    expect(getComputedStyle(legend).justifyContent).toBe('center')
  })
})
