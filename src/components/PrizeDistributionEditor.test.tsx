import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import PrizeDistributionEditor, {
  distToRows,
  isValidDist,
  rowsToDist,
  sumPct,
  type PctRow,
} from './PrizeDistributionEditor'

// A tiny controlled harness so the tests drive the editor exactly as the
// Create-Fecha / live-admin parents do (they own the rows state).
function Harness({ initial }: { initial: PctRow[] }) {
  const [rows, setRows] = useState<PctRow[]>(initial)
  return <PrizeDistributionEditor rows={rows} onChange={setRows} />
}

describe('PrizeDistributionEditor — pure helpers', () => {
  it('rowsToDist emits [{place, pct}] with pct as a FRACTION, place = index+1', () => {
    expect(rowsToDist([{ pct: '60' }, { pct: '28' }, { pct: '12' }])).toEqual([
      { place: 1, pct: 0.6 },
      { place: 2, pct: 0.28 },
      { place: 3, pct: 0.12 },
    ])
  })

  it('distToRows round-trips a fraction distribution to percentage strings, place-ordered', () => {
    expect(
      distToRows([
        { place: 2, pct: 0.28 },
        { place: 1, pct: 0.6 },
      ]),
    ).toEqual([{ pct: '60' }, { pct: '28' }])
  })

  it('sumPct / isValidDist accept ~100% and reject otherwise', () => {
    expect(sumPct([{ pct: '60' }, { pct: '28' }, { pct: '12' }])).toBe(100)
    expect(isValidDist([{ pct: '60' }, { pct: '28' }, { pct: '12' }])).toBe(true)
    expect(isValidDist([{ pct: '60' }, { pct: '28' }])).toBe(false) // sums to 88
    expect(isValidDist([])).toBe(false) // no places
  })
})

describe('PrizeDistributionEditor — interactions', () => {
  it('renders one row per place seeded from the initial distribution', () => {
    render(<Harness initial={[{ pct: '60' }, { pct: '28' }, { pct: '12' }]} />)
    const editor = screen.getByTestId('prize-dist-editor')
    const inputs = within(editor).getAllByRole('textbox')
    expect(inputs).toHaveLength(3)
    expect(within(editor).getByTestId('dist-sum')).toHaveTextContent('Suma: 100%')
    expect(within(editor).queryByTestId('dist-warning')).not.toBeInTheDocument()
  })

  it('adds a place with "Agregar lugar" and removes one with the row ✕', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ pct: '60' }, { pct: '40' }]} />)
    const editor = screen.getByTestId('prize-dist-editor')

    await user.click(within(editor).getByRole('button', { name: '+ Agregar lugar' }))
    expect(within(editor).getAllByRole('textbox')).toHaveLength(3)

    await user.click(within(editor).getByRole('button', { name: /Quitar 3º lugar/ }))
    expect(within(editor).getAllByRole('textbox')).toHaveLength(2)
  })

  it('warns "Debe sumar 100%" when the percentages do not sum to ~100', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ pct: '60' }, { pct: '28' }, { pct: '12' }]} />)
    const editor = screen.getByTestId('prize-dist-editor')

    // Drop 3rd place from 12 → 5 so the total is 93%.
    const third = within(editor).getByLabelText('Porcentaje 3º lugar')
    await user.clear(third)
    await user.type(third, '5')

    expect(within(editor).getByTestId('dist-sum')).toHaveTextContent('Suma: 93%')
    expect(within(editor).getByTestId('dist-warning')).toHaveTextContent('Debe sumar 100%')
  })
})
