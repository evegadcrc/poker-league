import { colonesCompact } from '@/lib/fechas'
import { ordinal, pctLabel, type Prize } from '@/lib/live'

/**
 * The shared **Premios** block — the prize-distribution list rendered on both the
 * En Vivo screen (proposed / live split from the pot) and the completed-fecha view
 * (final materialized amounts, chop-adjusted). One source so the markup + 3-theme
 * tokens (the `.premios` classes in App.css) stay identical across both surfaces.
 *
 * `formatAmount` lets each caller pick its money style: En Vivo keeps the compact
 * `colonesCompact` ("₡124K"); the completed fecha passes the full "₡124.000" form.
 */
export default function PrizeList({
  prizes,
  proposed = false,
  formatAmount = colonesCompact,
}: {
  prizes: Prize[]
  proposed?: boolean
  formatAmount?: (amount: number) => string
}) {
  return (
    <div className="premios" data-testid="premios">
      <div className="ph">
        <span className="t">Premios</span>
        <span className="s">{proposed ? 'reparto propuesto' : 'según el pozo'}</span>
      </div>
      {prizes.length === 0 ? (
        <div className="prow-prize">
          <span className="nm">Los premios se definen según el pozo final.</span>
        </div>
      ) : (
        prizes.map((p) => (
          <div className="prow-prize" key={p.position}>
            <span className="pl">{ordinal(p.position)}</span>
            <span className="nm" />
            <span className="pct">{pctLabel(p.pct)}</span>
            <span className="amt">{formatAmount(p.amount)}</span>
          </div>
        ))
      )}
    </div>
  )
}
