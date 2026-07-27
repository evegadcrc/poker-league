import Sheet from '@/components/Sheet'
import { formatClock, nextLevel, type BlindLevel } from '@/lib/live'
import { formatMiles } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Read-only full blind structure, shown when the user taps the live clock
 * (Admin console + En Vivo). Lists every level — SB/BB (or "Descanso"), ante
 * (only when the structure uses antes) and duration — highlighting the current
 * level and marking the next one so players/admin can see what is coming.
 */
export default function BlindsTable({
  levels,
  currentLevel,
  onClose,
}: {
  levels: BlindLevel[]
  currentLevel: number
  onClose: () => void
}) {
  // Ante column only shows when at least one level actually carries an ante.
  const hasAnte = levels.some((l) => (l.ante ?? 0) > 0)
  // The upcoming level (smallest level_number strictly greater than current).
  const upcoming = nextLevel(levels, currentLevel)
  const nextNumber = upcoming?.level_number ?? null

  return (
    <Sheet open onClose={onClose} title="Estructura de blinds">
      {levels.length === 0 ? (
        <div className="fd-note">Esta fecha no tiene estructura de blinds.</div>
      ) : (
        <div className="blinds-table-wrap" data-testid="blinds-table">
          <table className="blinds-table">
            <thead>
              <tr>
                <th scope="col">Nivel</th>
                <th scope="col">SB / BB</th>
                {hasAnte && <th scope="col">Ante</th>}
                <th scope="col">Duración</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((l) => {
                const isCurrent = l.level_number === currentLevel
                const isNext = l.level_number === nextNumber
                return (
                  <tr
                    key={l.level_number}
                    className={cn(isCurrent && 'is-current', isNext && 'is-next')}
                    data-testid={isCurrent ? 'blinds-row-current' : undefined}
                    aria-current={isCurrent ? 'true' : undefined}
                  >
                    <th scope="row">
                      {l.level_number}
                      {isCurrent && <span className="bt-tag">Actual</span>}
                      {isNext && <span className="bt-tag next">Siguiente</span>}
                    </th>
                    <td>
                      {l.is_break
                        ? 'Descanso'
                        : `${formatMiles(l.small_blind)} / ${formatMiles(l.big_blind)}`}
                    </td>
                    {hasAnte && <td>{(l.ante ?? 0) > 0 ? formatMiles(l.ante ?? 0) : '—'}</td>}
                    <td>{formatClock(l.duration_seconds)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="btn-row">
        <button type="button" className="btn ghost full" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </Sheet>
  )
}
