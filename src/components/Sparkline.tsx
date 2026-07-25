import type { HistoryPoint } from '@/lib/profile'

/**
 * Inline SVG sparkline of the cumulative points series (oxblood line + gradient
 * area), ported from the prototype's #spark. Y is scaled across [min(0,series),
 * max]; a single point renders as a flat baseline with one node. Reused by the
 * Perfil-style stat blocks (currently the Tabla's player-stats popup).
 */
export default function Sparkline({ history }: { history: HistoryPoint[] }) {
  const w = 340
  const h = 88
  const values = history.map((p) => p.cumulative)
  const max = Math.max(...values)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const n = values.length
  const x = (i: number) => (n <= 1 ? w / 2 : (i * w) / (n - 1))
  const y = (v: number) => h - ((v - min) / range) * h

  const nodes = values.map((v, i) => ({ cx: x(i), cy: y(v) }))
  // A single game has no line span → draw a flat baseline across the full width.
  const linePts =
    n === 1 ? [`0,${y(values[0]!)}`, `${w},${y(values[0]!)}`] : nodes.map((p) => `${p.cx},${p.cy}`)

  return (
    <div className="spark" data-testid="spark">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Historial de puntos"
      >
        <defs>
          <linearGradient id="pf-spark" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--oxblood)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--oxblood)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`M 0,${h} L ${linePts.join(' L ')} L ${w},${h} Z`} fill="url(#pf-spark)" />
        <path
          d={`M ${linePts.join(' L ')}`}
          fill="none"
          stroke="var(--oxblood)"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {nodes.map((p, i) => (
          <circle
            key={i}
            cx={p.cx}
            cy={p.cy}
            r="3.2"
            fill="var(--paper)"
            stroke="var(--oxblood)"
            strokeWidth="2"
          />
        ))}
      </svg>
    </div>
  )
}
