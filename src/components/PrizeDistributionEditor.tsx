import { useState } from 'react'
import { formatMiles, parseMoney } from '@/lib/format'
import { ordinal, type DistSlice } from '@/lib/live'

// ---------------------------------------------------------------------------
// PrizeDistributionEditor (Phase-2 step 5) — a reusable, controlled editor for
// a fecha's payout split. Reused by Create/Edit-Fecha and the live admin console.
//
// The stored jsonb (`tournament.payout_distribution`) is `[{place, pct}]` with
// `pct` a FRACTION (0.60). The admin edits whole PERCENTAGES (60), so the row
// model here carries a raw percentage STRING (ergonomic input: clearing a field
// doesn't snap to 0). The parent converts on save via rowsToDist; the sum must
// land on ~100% before it can be persisted (see isValidDist).
//
// Two input modes, same output: "Porcentaje" (type 60 / 28 / 12) or "Monto ₡"
// (type ₡60.000 / ₡28.000 / ₡12.000 — the percentages are DERIVED from each
// amount's share of the total). Amounts are an input convenience only: what is
// stored is still the percentage split, and the real payouts are computed from
// it against the actual pot when the fecha opens (set_prizes). When the pot is
// already known (live console) the editor shows the ₡ each percentage yields.
// ---------------------------------------------------------------------------

/** One editable place. `pct` is a raw percentage string (e.g. "60", "28.5"). */
export type PctRow = { pct: string }

export type DistMode = 'pct' | 'amount'

/** Tolerance (percentage points) for the "sums to 100%" check. */
const SUM_TOLERANCE = 0.5

/** jsonb [{place, pct(fraction)}] → editor rows (percentages, place-ordered). */
export function distToRows(dist: readonly DistSlice[]): PctRow[] {
  const rows = [...dist]
    .sort((a, b) => a.place - b.place)
    // 0.6 → "60", 0.285 → "28.5" (drop trailing zeros).
    .map((d) => ({ pct: String(Math.round(d.pct * 1000) / 10) }))
  return rows.length > 0 ? rows : defaultRows()
}

/** editor rows → jsonb [{place, pct(fraction)}] (place = row index + 1). */
export function rowsToDist(rows: readonly PctRow[]): DistSlice[] {
  return rows.map((r, i) => {
    const n = r.pct.trim() === '' ? 0 : Number(r.pct)
    const pct = Number.isFinite(n) ? Math.round((n / 100) * 10000) / 10000 : 0
    return { place: i + 1, pct }
  })
}

/** Sum of the rows' percentages (invalid entries count as 0). */
export function sumPct(rows: readonly PctRow[]): number {
  return rows.reduce((s, r) => {
    const n = r.pct.trim() === '' ? 0 : Number(r.pct)
    return s + (Number.isFinite(n) ? n : 0)
  }, 0)
}

/** A distribution is valid when it has ≥1 place and sums to ~100%. */
export function isValidDist(rows: readonly PctRow[]): boolean {
  return rows.length > 0 && Math.abs(sumPct(rows) - 100) <= SUM_TOLERANCE
}

/** Sensible starting split (top-3, 60/28/12) when there is nothing to seed from. */
export function defaultRows(): PctRow[] {
  return [{ pct: '60' }, { pct: '28' }, { pct: '12' }]
}

/** ₡ amounts (raw integers) → percentage rows, each its share of the total (0.1%
 *  precision). A zero total yields blank rows, which the parent treats as invalid. */
export function amountsToRows(amounts: readonly number[]): PctRow[] {
  const sum = amounts.reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0)
  return amounts.map((n) => ({
    pct: sum > 0 ? String(Math.round((n / sum) * 1000) / 10) : '',
  }))
}

/** Percentage rows × pot → whole-colón amounts (for seeding the ₡ mode / hints). */
export function rowsToAmounts(rows: readonly PctRow[], pot: number): number[] {
  return rows.map((r) => {
    const n = r.pct.trim() === '' ? 0 : Number(r.pct)
    return Number.isFinite(n) ? Math.round((n / 100) * pot) : 0
  })
}

function fmtSum(total: number): string {
  return Number.isInteger(total) ? String(total) : total.toFixed(1)
}

type Props = {
  rows: PctRow[]
  onChange: (rows: PctRow[]) => void
  disabled?: boolean
  /** The pot when already known (live console): seeds ₡ mode and shows ₡ hints. */
  pot?: number | null
  initialMode?: DistMode
}

export default function PrizeDistributionEditor({
  rows,
  onChange,
  disabled = false,
  pot = null,
  initialMode = 'pct',
}: Props) {
  const [mode, setMode] = useState<DistMode>(initialMode)
  // ₡ mode keeps the raw typed amounts (as strings, blank allowed) per place; the
  // rows handed to the parent are always the derived percentages.
  const [amounts, setAmounts] = useState<string[]>(() =>
    initialMode === 'amount' && pot != null && pot > 0
      ? rowsToAmounts(rows, pot).map(String)
      : rows.map(() => ''),
  )
  const potKnown = pot != null && pot > 0
  const total = sumPct(rows)
  const valid = isValidDist(rows)
  const amountTotal = amounts.reduce((s, a) => s + parseMoney(a), 0)

  const switchMode = (next: DistMode) => {
    if (next === mode) return
    if (next === 'amount') {
      // Seed from the current split: pct × pot when the pot is known, else blank.
      setAmounts(potKnown ? rowsToAmounts(rows, pot).map(String) : rows.map(() => ''))
    }
    setMode(next)
  }

  const emitAmounts = (next: string[]) => {
    setAmounts(next)
    onChange(amountsToRows(next.map(parseMoney)))
  }

  const setPct = (i: number, value: string) =>
    onChange(rows.map((r, idx) => (idx === i ? { pct: value } : r)))
  const setAmount = (i: number, value: string) =>
    emitAmounts(amounts.map((a, idx) => (idx === i ? value : a)))
  const addRow = () =>
    mode === 'amount' ? emitAmounts([...amounts, '']) : onChange([...rows, { pct: '' }])
  const removeRow = (i: number) =>
    mode === 'amount'
      ? emitAmounts(amounts.filter((_, idx) => idx !== i))
      : onChange(rows.filter((_, idx) => idx !== i))

  const placeStyle = {
    fontFamily: "'Bricolage Grotesque'",
    fontWeight: 800,
    fontSize: 16,
    width: 34,
    color: 'var(--oxblood)',
    flex: 'none',
  } as const
  const sideStyle = { font: "700 13px 'Archivo'", color: 'var(--ink-2)', flex: 'none' } as const

  return (
    <div className="field" data-testid="prize-dist-editor">
      <label>Reparto de premios</label>

      <div className="subnav" role="tablist" aria-label="Modo de reparto" style={{ padding: '0 0 8px' }}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'pct'}
          className={mode === 'pct' ? 'on' : ''}
          disabled={disabled}
          onClick={() => switchMode('pct')}
        >
          Porcentaje
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'amount'}
          className={mode === 'amount' ? 'on' : ''}
          disabled={disabled}
          onClick={() => switchMode('amount')}
        >
          Monto ₡
        </button>
      </div>

      <div>
        {rows.map((r, i) => (
          <div
            key={i}
            style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}
          >
            <span style={placeStyle}>{ordinal(i + 1)}</span>
            {mode === 'pct' ? (
              <>
                <input
                  aria-label={`Porcentaje ${ordinal(i + 1)} lugar`}
                  inputMode="decimal"
                  value={r.pct}
                  disabled={disabled}
                  onChange={(e) => setPct(i, e.target.value)}
                  style={{ flex: 1 }}
                />
                <span style={sideStyle}>
                  %
                  {potKnown && (
                    <span data-testid={`dist-amount-hint-${i + 1}`}>
                      {' '}
                      · ₡{formatMiles(rowsToAmounts([r], pot)[0] ?? 0)}
                    </span>
                  )}
                </span>
              </>
            ) : (
              <>
                <span className="money-input" data-symbol="₡" style={{ flex: 1 }}>
                  <input
                    aria-label={`Monto ${ordinal(i + 1)} lugar`}
                    inputMode="numeric"
                    value={(amounts[i] ?? '') === '' ? '' : formatMiles(parseMoney(amounts[i] ?? ''))}
                    disabled={disabled}
                    onChange={(e) => setAmount(i, e.target.value)}
                  />
                </span>
                <span style={sideStyle} data-testid={`dist-pct-derived-${i + 1}`}>
                  {(amounts[i] ?? '').trim() === '' || r.pct === '' ? '—' : `${r.pct}%`}
                </span>
              </>
            )}
            <button
              type="button"
              className="btn ghost sm"
              aria-label={`Quitar ${ordinal(i + 1)} lugar`}
              disabled={disabled || rows.length <= 1}
              onClick={() => removeRow(i)}
              style={{ flex: 'none' }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="btn-row" style={{ padding: 0, marginTop: 2 }}>
        <button
          type="button"
          className="btn ghost sm"
          disabled={disabled}
          onClick={addRow}
        >
          + Agregar lugar
        </button>
      </div>

      {mode === 'pct' ? (
        <div className="hintline" data-testid="dist-sum">
          Suma: {fmtSum(total)}%
          {potKnown && ` · Pozo ₡${formatMiles(pot)}`}
          {!valid && (
            <span data-testid="dist-warning" style={{ color: 'var(--oxblood)', fontWeight: 700 }}>
              {' '}
              · Debe sumar 100%
            </span>
          )}
        </div>
      ) : (
        <div className="hintline" data-testid="dist-sum">
          Total: ₡{formatMiles(amountTotal)}
          {amountTotal === 0 && (
            <span data-testid="dist-warning" style={{ color: 'var(--oxblood)', fontWeight: 700 }}>
              {' '}
              · Ingresar los montos
            </span>
          )}
          <br />
          Los montos definen el porcentaje de cada lugar; los premios se calculan sobre el pozo
          {potKnown ? ' actual' : ' real al abrir la fecha'}.
        </div>
      )}
    </div>
  )
}
