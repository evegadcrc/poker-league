import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import FormPills from './FormPills'

// The RPC returns `form` MOST-RECENT-FIRST (index 0 = latest game) with
// `form_positions` aligned 1:1. FormPills renders newest-on-the-RIGHT, showing
// the finishing NUMBER inside each pill in its tier color (mig 0018).

function pills(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.pill'))
}

describe('FormPills', () => {
  it('renders the finishing number inside each pill, newest-on-the-RIGHT', () => {
    // latest→oldest tiers + positions (aligned): champion@1, podium@3, out@8
    const { container } = render(
      <FormPills form={['champion', 'podium', 'out']} positions={[1, 3, 8]} />,
    )
    const p = pills(container)
    expect(p).toHaveLength(3)
    // Rendered left→right = oldest→newest → reversed: out@8, podium@3, champion@1
    expect(p.map((el) => el.textContent)).toEqual(['8', '3', '1'])
    // Rightmost pill is the newest game (RPC index 0 = champion@1).
    expect(p[p.length - 1]!.textContent).toBe('1')
    expect(p[p.length - 1]!.classList.contains('champ')).toBe(true)
    expect(p[0]!.classList.contains('out')).toBe(true)
  })

  it('applies the tier color class to each numbered pill', () => {
    const { container } = render(
      <FormPills form={['champion', 'podium', 'final', 'out']} positions={[1, 2, 5, 9]} />,
    )
    // form reversed → left→right: out(9), final(5), podio(2), champ(1)
    const klasses = pills(container).map(
      (el) => Array.from(el.classList).find((c) => c !== 'pill') ?? '',
    )
    expect(klasses).toEqual(['out', 'final', 'podio', 'champ'])
  })

  it('falls back to empty pills (color only) when positions are missing', () => {
    const { container } = render(<FormPills form={['champion', 'out']} />)
    const p = pills(container)
    expect(p).toHaveLength(2)
    expect(p.every((el) => el.textContent === '')).toBe(true)
    // Tier classes are still applied without numbers.
    expect(p[p.length - 1]!.classList.contains('champ')).toBe(true)
  })

  it('renders nothing when form is empty', () => {
    const { container } = render(<FormPills form={[]} positions={[]} />)
    expect(pills(container)).toHaveLength(0)
    expect(container.querySelector('.form')).toBeNull()
  })

  it('uses the .big-form strip for the full variant', () => {
    const { container } = render(
      <FormPills form={['champion']} positions={[1]} variant="full" />,
    )
    expect(container.querySelector('.big-form')).not.toBeNull()
    expect(container.querySelector('.pill')?.textContent).toBe('1')
  })
})
