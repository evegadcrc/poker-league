import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { defaultRows, distToRows, isValidDist, rowsToDist } from '@/components/PrizeDistributionEditor'
import type { Database, Json } from '@/lib/database.types'
import type { DistSlice } from '@/lib/live'
import FechaForm, {
  joinDatetime,
  loadFechaDefaults,
  parseVenue,
  splitDatetime,
  type FechaFormValues,
  type Structure,
} from '@/routes/admin/FechaForm'

// ---------------------------------------------------------------------------
// /fechas/:id/editar — admin edits a SCHEDULED fecha (name, date/time, venue
// geofence, money, stacks, rebuys, blinds, payout split, toggles) with the same
// FechaForm used to create it. Writes go through the admin-only tournament
// UPDATE policy (mig 0017), like the other admin fields on the fecha view.
//
// Only a scheduled, uncancelled fecha is editable: once open (live) the clock,
// entries and check-ins depend on these values, and a completed fecha holds
// results. The gate is applied on load (a locked note) AND on save (the UPDATE
// is filtered by status/cancelled_at and reports "0 rows" as a friendly error),
// so a fecha opened from another device between load and save is not rewritten.
// ---------------------------------------------------------------------------

type TournamentRow = Database['public']['Tables']['tournament']['Row']
type Row = Pick<
  TournamentRow,
  | 'id'
  | 'name'
  | 'scheduled_at'
  | 'status'
  | 'cancelled_at'
  | 'venue_lat'
  | 'venue_lng'
  | 'geofence_radius_m'
  | 'buy_in'
  | 'rebuy_amount'
  | 'rebuy_until_level'
  | 'starting_stack'
  | 'ante_enabled'
  | 'blind_structure_id'
  | 'payout_distribution'
  | 'counts_for_league'
  | 'odds_enabled'
  | 'guests_open'
>

const SELECT =
  'id, name, scheduled_at, status, cancelled_at, venue_lat, venue_lng, geofence_radius_m, buy_in, rebuy_amount, rebuy_until_level, starting_stack, ante_enabled, blind_structure_id, payout_distribution, counts_for_league, odds_enabled, guests_open'

type State =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'not-found' }
  | { phase: 'locked'; row: Row }
  | { phase: 'ready'; row: Row; structures: Structure[]; initial: FechaFormValues }

/** jsonb [{place, pct}] → editor rows; anything malformed falls back to the default split. */
function payoutRows(raw: unknown) {
  if (!Array.isArray(raw)) return defaultRows()
  const slices = raw.filter(
    (s): s is DistSlice =>
      typeof s === 'object' &&
      s !== null &&
      Number.isFinite((s as DistSlice).place) &&
      Number.isFinite((s as DistSlice).pct),
  )
  return slices.length > 0 ? distToRows(slices) : defaultRows()
}

/** Seed the form from the stored row. Bonus stack + máx recompras have no DB
 *  column (form defaults only), so they come from the saved defaults. */
function rowToValues(row: Row, structures: Structure[]): FechaFormValues {
  const d = loadFechaDefaults()
  const { date, time } = splitDatetime(row.scheduled_at)
  return {
    name: row.name,
    date,
    time,
    lat: row.venue_lat == null ? '' : String(row.venue_lat),
    lng: row.venue_lng == null ? '' : String(row.venue_lng),
    radius: String(row.geofence_radius_m ?? 100),
    buyIn: Number(row.buy_in ?? 0),
    rebuyAmount: Number(row.rebuy_amount ?? 0),
    startingStack: row.starting_stack ?? 0,
    bonusStack: d.bonusStack,
    // null/0 both mean "sin recompras" (mig 0001).
    rebuyUntil: row.rebuy_until_level || null,
    maxRebuys: d.maxRebuys,
    structureId: row.blind_structure_id ?? structures[0]?.id ?? '',
    anteEnabled: row.ante_enabled,
    countsForLeague: row.counts_for_league ?? true,
    oddsEnabled: row.odds_enabled ?? true,
    guestsOpen: row.guests_open ?? false,
    distRows: payoutRows(row.payout_distribution),
  }
}

function lockedReason(row: Row): string {
  if (row.cancelled_at != null) return 'fue cancelada'
  if (row.status === 'live') return 'está en vivo'
  return 'ya se jugó'
}

export default function EditFecha() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setState({ phase: 'loading' })
    void (async () => {
      const [tRes, sRes] = await Promise.all([
        supabase.from('tournament').select(SELECT).eq('id', id).maybeSingle(),
        supabase.from('blind_structure').select('id, name').order('name'),
      ])
      if (!alive) return
      if (tRes.error) {
        setState({ phase: 'error' })
        return
      }
      if (!tRes.data) {
        setState({ phase: 'not-found' })
        return
      }
      const row = tRes.data as Row
      if (row.status !== 'scheduled' || row.cancelled_at != null) {
        setState({ phase: 'locked', row })
        return
      }
      const structures = (sRes.data ?? []) as Structure[]
      setState({ phase: 'ready', row, structures, initial: rowToValues(row, structures) })
    })()
    return () => {
      alive = false
    }
  }, [id])

  const save = useCallback(
    async (v: FechaFormValues) => {
      if (state.phase !== 'ready') return
      const scheduledAt = joinDatetime(v.date, v.time)
      if (!scheduledAt) {
        setError('Fecha y hora inválidas.')
        return
      }
      const venue = parseVenue(v.lat, v.lng, v.radius)
      if (!venue.ok) {
        setError(venue.message)
        return
      }
      const update: Database['public']['Tables']['tournament']['Update'] = {
        name: v.name.trim() || state.row.name,
        scheduled_at: scheduledAt,
        ...venue.venue,
        buy_in: v.buyIn,
        rebuy_amount: v.rebuyAmount === 0 ? null : v.rebuyAmount,
        rebuy_until_level: v.rebuyUntil,
        starting_stack: v.startingStack === 0 ? null : v.startingStack,
        ante_enabled: v.anteEnabled,
        blind_structure_id: v.structureId || null,
        counts_for_league: v.countsForLeague,
        odds_enabled: v.oddsEnabled,
        guests_open: v.guestsOpen,
      }
      if (isValidDist(v.distRows)) {
        update.payout_distribution = rowsToDist(v.distRows) as unknown as Json
      }
      setBusy(true)
      setError(null)
      const { data, error: err } = await supabase
        .from('tournament')
        .update(update)
        .eq('id', id)
        .eq('status', 'scheduled')
        .is('cancelled_at', null)
        .select('id')
      setBusy(false)
      if (err) {
        setError('No se pudieron guardar los cambios. Intentar de nuevo.')
        return
      }
      if (((data ?? []) as unknown[]).length === 0) {
        setError('La fecha ya no está programada (se abrió o se canceló), no se puede editar.')
        return
      }
      navigate(`/fechas/${id}`)
    },
    [state, id, navigate],
  )

  const back = (
    <button type="button" className="back" onClick={() => navigate(`/fechas/${id}`)}>
      ← Fecha
    </button>
  )

  if (state.phase === 'loading') {
    return (
      <>
        {back}
        <div className="fd-note">Cargando…</div>
      </>
    )
  }
  if (state.phase === 'error') {
    return (
      <>
        {back}
        <div className="fd-note" role="alert">
          No se pudo cargar la fecha.
        </div>
      </>
    )
  }
  if (state.phase === 'not-found') {
    return (
      <>
        {back}
        <div className="fd-note">Esta fecha no existe.</div>
      </>
    )
  }

  return (
    <>
      {back}
      <div className="section-head" style={{ paddingTop: 10 }}>
        <div>
          <span className="overline">Editar fecha</span>
          <h1>{state.row.name}</h1>
        </div>
      </div>
      {state.phase === 'locked' ? (
        <div className="fd-note" role="status" data-testid="edit-fecha-locked">
          <p>Solo se puede editar una fecha programada. Esta fecha {lockedReason(state.row)}.</p>
        </div>
      ) : (
        <div data-testid="edit-fecha">
          <FechaForm
            initial={state.initial}
            structures={state.structures}
            submitLabel="Guardar cambios"
            busyLabel="Guardando…"
            busy={busy}
            error={error}
            onSubmit={(v) => void save(v)}
          />
        </div>
      )}
    </>
  )
}
