import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { defaultRows, isValidDist, rowsToDist } from '@/components/PrizeDistributionEditor'
import type { Database, Json } from '@/lib/database.types'
import FechaForm, {
  createInitialValues,
  joinDatetime,
  loadFechaDefaults,
  type FechaFormValues,
  type Structure,
} from '@/routes/admin/FechaForm'

// ---------------------------------------------------------------------------
// Admin · Nueva fecha (slice 13). Creates a scheduled fecha in the active
// season via create_tournament. The form itself (venue by geolocation or by
// hand, es-CR money inputs, "Guardar ajustes" defaults) is the shared
// FechaForm; this page loads the blind structures + the season payout template,
// seeds the form from pf-fecha-defaults, and turns the submitted values into
// the RPC payload.
// ---------------------------------------------------------------------------
export default function CreateFecha() {
  const navigate = useNavigate()
  const [structures, setStructures] = useState<Structure[]>([])
  // Resolved once the async seeds (structures + season template) are in; the
  // form initialises its state from this exactly once, so it is not rendered
  // before then.
  const [initial, setInitial] = useState<FechaFormValues | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [structRes, seasonRes] = await Promise.all([
        supabase.from('blind_structure').select('id, name').order('name'),
        supabase
          .from('season')
          .select('payout_template')
          .eq('status', 'active')
          .order('year', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
      if (!alive) return
      const list = (structRes.data ?? []) as Structure[]
      const season = seasonRes.data as {
        payout_template: unknown
      } | null
      // Seed the payout editor from the season's default template (raw fraction
      // array, e.g. [0.60, 0.28, 0.12] → 60 / 28 / 12); fall back to the top-3
      // default when there is no season or an empty template.
      const tmpl = season && Array.isArray(season.payout_template) ? season.payout_template : []
      const rows = tmpl
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v))
        .map((v) => ({ pct: String(Math.round(v * 1000) / 10) }))
      setStructures(list)
      setInitial(
        createInitialValues(
          loadFechaDefaults(),
          list[0]?.id ?? '',
          rows.length > 0 ? rows : defaultRows(),
        ),
      )
    })()
    return () => {
      alive = false
    }
  }, [])

  const submit = useCallback(
    async (v: FechaFormValues) => {
      setBusy(true)
      setError(null)
      const payload: Record<string, Json | undefined> = {
        name: v.name.trim() || 'Nueva fecha',
        // Missing date/time → undefined → create_tournament defaults to now().
        scheduled_at: joinDatetime(v.date, v.time) ?? undefined,
        venue_lat: v.lat === '' ? null : Number(v.lat),
        venue_lng: v.lng === '' ? null : Number(v.lng),
        geofence_radius_m: v.radius === '' ? 100 : Number(v.radius),
        buy_in: v.buyIn,
        rebuy_amount: v.rebuyAmount === 0 ? null : v.rebuyAmount,
        rebuy_until_level: v.rebuyUntil,
        starting_stack: v.startingStack === 0 ? null : v.startingStack,
        ante_enabled: v.anteEnabled,
        blind_structure_id: v.structureId || null,
      }
      const { data, error: rpcErr } = await supabase.rpc('create_tournament', {
        p_payload: payload as Json,
      })
      setBusy(false)
      if (rpcErr) {
        setError(rpcErr.message)
        return
      }
      const rows = (data ?? []) as { id: string }[]
      const id = rows[0]?.id
      // Persist the fecha's payout split + the standalone flag. create_tournament
      // seeds a turnout-scaled default distribution; the admin's edited version is
      // authoritative, so overwrite it. counts_for_league is always written (the
      // column defaults true; a standalone fecha needs the explicit false).
      // Non-blocking: a create succeeds regardless — both can be fixed live.
      if (id) {
        const update: Database['public']['Tables']['tournament']['Update'] = {
          counts_for_league: v.countsForLeague,
          odds_enabled: v.oddsEnabled,
        }
        if (isValidDist(v.distRows)) {
          update.payout_distribution = rowsToDist(v.distRows) as unknown as Json
        }
        await supabase.from('tournament').update(update).eq('id', id)
      }
      navigate(id ? `/fechas/${id}` : '/fechas')
    },
    [navigate],
  )

  if (!initial) return <div className="fd-note">Cargando…</div>

  return (
    <div data-testid="create-fecha">
      <FechaForm
        initial={initial}
        structures={structures}
        submitLabel="Crear fecha"
        busyLabel="Creando…"
        busy={busy}
        error={error}
        onSubmit={(v) => void submit(v)}
      />
    </div>
  )
}
