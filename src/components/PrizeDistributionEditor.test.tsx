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

// ---------------------------------------------------------------------------
// ₡ mode — amounts in, percentages out (the stored split never changes shape).
// ---------------------------------------------------------------------------
function PotHarness({ initial, pot }: { initial: PctRow[]; pot?: number }) {
  const [rows, setRows] = useState<PctRow[]>(initial)
  return (
    <>
      <PrizeDistributionEditor rows={rows} onChange={setRows} pot={pot} />
      <output data-testid="rows-out">{rows.map((r) => r.pct || '∅').join('|')}</output>
    </>
  )
}

describe('PrizeDistributionEditor — Monto ₡ mode', () => {
  it('typing amounts derives the percentages from each share of the total', async () => {
    const user = userEvent.setup()
    render(<PotHarness initial={[{ pct: '60' }, { pct: '28' }, { pct: '12' }]} />)
    const editor = screen.getByTestId('prize-dist-editor')
    await user.click(within(editor).getByRole('tab', { name: 'Monto ₡' }))

    // Unknown pot → blank amounts, "Ingresar los montos".
    expect(within(editor).getByTestId('dist-warning')).toHaveTextContent('Ingresar los montos')
    await user.type(within(editor).getByLabelText('Monto 1º lugar'), '60000')
    await user.type(within(editor).getByLabelText('Monto 2º lugar'), '30000')
    await user.type(within(editor).getByLabelText('Monto 3º lugar'), '10000')

    expect(within(editor).getByLabelText('Monto 1º lugar')).toHaveValue('60.000')
    expect(within(editor).getByTestId('dist-sum')).toHaveTextContent('Total: ₡100.000')
    expect(within(editor).getByTestId('dist-pct-derived-1')).toHaveTextContent('60%')
    expect(within(editor).getByTestId('dist-pct-derived-2')).toHaveTextContent('30%')
    expect(within(editor).getByTestId('dist-pct-derived-3')).toHaveTextContent('10%')
    expect(screen.getByTestId('rows-out')).toHaveTextContent('60|30|10')
    expect(within(editor).queryByTestId('dist-warning')).toBeNull()

    // Back to % keeps the derived split as the editable percentages.
    await user.click(within(editor).getByRole('tab', { name: 'Porcentaje' }))
    expect(within(editor).getByLabelText('Porcentaje 1º lugar')).toHaveValue('60')
    expect(within(editor).getByTestId('dist-sum')).toHaveTextContent('Suma: 100%')
  })

  it('uneven amounts still yield a valid ~100% split (one-decimal percentages)', async () => {
    const user = userEvent.setup()
    render(<PotHarness initial={[{ pct: '50' }, { pct: '50' }]} />)
    const editor = screen.getByTestId('prize-dist-editor')
    await user.click(within(editor).getByRole('tab', { name: 'Monto ₡' }))
    await user.type(within(editor).getByLabelText('Monto 1º lugar'), '70000')
    await user.type(within(editor).getByLabelText('Monto 2º lugar'), '35000')
    // 70/105 = 66.7%, 35/105 = 33.3% → sums to 100.0 within tolerance.
    expect(screen.getByTestId('rows-out')).toHaveTextContent('66.7|33.3')
    expect(isValidDist([{ pct: '66.7' }, { pct: '33.3' }])).toBe(true)
  })

  it('with a known pot: ₡ hints in % mode, and switching to ₡ seeds the amounts from the split', async () => {
    const user = userEvent.setup()
    render(<PotHarness initial={[{ pct: '60' }, { pct: '40' }]} pot={100_000} />)
    const editor = screen.getByTestId('prize-dist-editor')
    expect(within(editor).getByTestId('dist-amount-hint-1')).toHaveTextContent('₡60.000')
    expect(within(editor).getByTestId('dist-sum')).toHaveTextContent('Pozo ₡100.000')

    await user.click(within(editor).getByRole('tab', { name: 'Monto ₡' }))
    expect(within(editor).getByLabelText('Monto 1º lugar')).toHaveValue('60.000')
    expect(within(editor).getByLabelText('Monto 2º lugar')).toHaveValue('40.000')
    expect(within(editor).getByTestId('dist-sum')).toHaveTextContent('Total: ₡100.000')
  })

  it('adding / removing places works in ₡ mode and re-derives the split', async () => {
    const user = userEvent.setup()
    render(<PotHarness initial={[{ pct: '100' }]} />)
    const editor = screen.getByTestId('prize-dist-editor')
    await user.click(within(editor).getByRole('tab', { name: 'Monto ₡' }))
    await user.type(within(editor).getByLabelText('Monto 1º lugar'), '50000')
    await user.click(within(editor).getByRole('button', { name: '+ Agregar lugar' }))
    await user.type(within(editor).getByLabelText('Monto 2º lugar'), '50000')
    expect(screen.getByTestId('rows-out')).toHaveTextContent('50|50')
    await user.click(within(editor).getByRole('button', { name: /Quitar 2º lugar/ }))
    expect(screen.getByTestId('rows-out')).toHaveTextContent('100')
  })
})
