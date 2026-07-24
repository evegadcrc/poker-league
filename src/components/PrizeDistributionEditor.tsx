import { ordinal, type DistSlice } from '@/lib/live'

// ---------------------------------------------------------------------------
// PrizeDistributionEditor (Phase-2 step 5) — a reusable, controlled editor for
// a fecha's payout split. Reused by Create-Fecha and the live admin console.
//
// The stored jsonb (`tournament.payout_distribution`) is `[{place, pct}]` with
// `pct` a FRACTION (0.60). The admin edits whole PERCENTAGES (60), so the row
// model here carries a raw percentage STRING (ergonomic input: clearing a field
// doesn't snap to 0). The parent converts on save via rowsToDist; the sum must
// land on ~100% before it can be persisted (see isValidDist).
// ---------------------------------------------------------------------------

/** One editable place. `pct` is a raw percentage string (e.g. "60", "28.5"). */
export type PctRow = { pct: string }

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

function fmtSum(total: number): string {
  return Number.isInteger(total) ? String(total) : total.toFixed(1)
}

type Props = {
  rows: PctRow[]
  onChange: (rows: PctRow[]) => void
  disabled?: boolean
}

export default function PrizeDistributionEditor({ rows, onChange, disabled = false }: Props) {
  const total = sumPct(rows)
  const valid = isValidDist(rows)

  const setPct = (i: number, value: string) =>
    onChange(rows.map((r, idx) => (idx === i ? { pct: value } : r)))
  const addRow = () => onChange([...rows, { pct: '' }])
  const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i))

  return (
    <div className="field" data-testid="prize-dist-editor">
      <label>Reparto de premios</label>

      <div>
        {rows.map((r, i) => (
          <div
            key={i}
            style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}
          >
            <span
              style={{
                fontFamily: "'Bricolage Grotesque'",
                fontWeight: 800,
                fontSize: 16,
                width: 34,
                color: 'var(--oxblood)',
                flex: 'none',
              }}
            >
              {ordinal(i + 1)}
            </span>
            <input
              aria-label={`Porcentaje ${ordinal(i + 1)} lugar`}
              inputMode="decimal"
              value={r.pct}
              disabled={disabled}
              onChange={(e) => setPct(i, e.target.value)}
              style={{ flex: 1 }}
            />
            <span style={{ font: "700 14px 'Archivo'", color: 'var(--ink-2)', flex: 'none' }}>%</span>
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

      <div className="hintline" data-testid="dist-sum">
        Suma: {fmtSum(total)}%
        {!valid && (
          <span data-testid="dist-warning" style={{ color: 'var(--oxblood)', fontWeight: 700 }}>
            {' '}
            · Debe sumar 100%
          </span>
        )}
      </div>
    </div>
  )
}
