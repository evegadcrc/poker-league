import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { requestPosition } from '@/lib/checkin'
import PrizeDistributionEditor, {
  defaultRows,
  isValidDist,
  rowsToDist,
  type PctRow,
} from '@/components/PrizeDistributionEditor'
import type { Json } from '@/lib/database.types'

type Structure = { id: string; name: string }

// Rebuy-period options → the numeric level (null = sin recompras).
const REBUY_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'Nivel 6', value: 6 },
  { label: 'Nivel 4', value: 4 },
  { label: 'Nivel 8', value: 8 },
  { label: 'Sin recompras', value: null },
]

// ---------------------------------------------------------------------------
// Admin · Nueva fecha (slice 13). Creates a scheduled fecha in the active
// season via create_tournament. Venue is captured by geolocation ("usar mi
// ubicación") or entered manually; early-bird bonus is a season setting shown
// read-only here (edited in Liga · temporada).
// ---------------------------------------------------------------------------
export default function CreateFecha() {
  const navigate = useNavigate()
  const [structures, setStructures] = useState<Structure[]>([])
  const [earlyBirdChips, setEarlyBirdChips] = useState<number | null>(null)
  // Payout split for this fecha — seeded from the season default template, then
  // fully editable. Persisted to tournament.payout_distribution after create.
  const [distRows, setDistRows] = useState<PctRow[]>(defaultRows)

  const [name, setName] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('19:00')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [radius, setRadius] = useState('100')
  const [buyIn, setBuyIn] = useState('20000')
  const [rebuyAmount, setRebuyAmount] = useState('20000')
  const [startingStack, setStartingStack] = useState('10000')
  const [rebuyUntil, setRebuyUntil] = useState<number | null>(6)
  const [structureId, setStructureId] = useState('')
  const [anteEnabled, setAnteEnabled] = useState(false)

  const [locating, setLocating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [structRes, seasonRes] = await Promise.all([
        supabase.from('blind_structure').select('id, name').order('name'),
        supabase
          .from('season')
          .select('early_bird_bonus_chips, payout_template')
          .eq('status', 'active')
          .order('year', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
      if (!alive) return
      const list = (structRes.data ?? []) as Structure[]
      setStructures(list)
      if (list.length > 0 && !structureId) setStructureId(list[0]!.id)
      const season = seasonRes.data as {
        early_bird_bonus_chips: number
        payout_template: unknown
      } | null
      if (season) {
        setEarlyBirdChips(season.early_bird_bonus_chips)
        // Seed the editor from the season's default template (raw fraction array,
        // e.g. [0.60, 0.28, 0.12] → 60 / 28 / 12); fall back to the top-3 default.
        const tmpl = Array.isArray(season.payout_template) ? season.payout_template : []
        const rows = tmpl
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v))
          .map((v) => ({ pct: String(Math.round(v * 1000) / 10) }))
        setDistRows(rows.length > 0 ? rows : defaultRows())
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const useMyLocation = useCallback(async () => {
    setLocating(true)
    setError(null)
    try {
      const pos = await requestPosition()
      setLat(pos.lat.toFixed(6))
      setLng(pos.lng.toFixed(6))
    } catch {
      setError('No se pudo obtener tu ubicación. Ingresá la sede manualmente.')
    } finally {
      setLocating(false)
    }
  }, [])

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    const scheduledAt = date && time ? new Date(`${date}T${time}`).toISOString() : undefined
    const payload: Record<string, Json | undefined> = {
      name: name.trim() || 'Nueva fecha',
      scheduled_at: scheduledAt,
      venue_lat: lat === '' ? null : Number(lat),
      venue_lng: lng === '' ? null : Number(lng),
      geofence_radius_m: radius === '' ? 100 : Number(radius),
      buy_in: buyIn === '' ? 0 : Number(buyIn),
      rebuy_amount: rebuyAmount === '' ? null : Number(rebuyAmount),
      rebuy_until_level: rebuyUntil,
      starting_stack: startingStack === '' ? null : Number(startingStack),
      ante_enabled: anteEnabled,
      blind_structure_id: structureId || null,
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
    // Persist the fecha's payout split. create_tournament seeds a turnout-scaled
    // default; the admin's edited distribution is authoritative, so overwrite it.
    // Non-blocking: a create succeeds regardless — the split can be fixed live.
    if (id && isValidDist(distRows)) {
      await supabase
        .from('tournament')
        .update({ payout_distribution: rowsToDist(distRows) as unknown as Json })
        .eq('id', id)
    }
    navigate(id ? `/fechas/${id}` : '/fechas')
  }, [
    name,
    date,
    time,
    lat,
    lng,
    radius,
    buyIn,
    rebuyAmount,
    rebuyUntil,
    startingStack,
    anteEnabled,
    structureId,
    distRows,
    navigate,
  ])

  return (
    <div data-testid="create-fecha">
      <div className="field">
        <label htmlFor="cf-name">Nombre de la fecha</label>
        <input
          id="cf-name"
          value={name}
          placeholder="Fecha 10 — Casa de José"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="cf-date">Fecha y hora</label>
        <div className="two">
          <input id="cf-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <input id="cf-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label htmlFor="cf-lat">Sede (geocerca)</label>
        <div className="two">
          <input
            id="cf-lat"
            inputMode="decimal"
            placeholder="Latitud"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
          />
          <input
            id="cf-lng"
            inputMode="decimal"
            placeholder="Longitud"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="hintline"
          style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0 }}
          onClick={() => void useMyLocation()}
          disabled={locating}
        >
          📍 {locating ? 'Obteniendo ubicación…' : 'Usar mi ubicación actual'}
        </button>
      </div>

      <div className="field">
        <label htmlFor="cf-radius">Radio de check-in (m)</label>
        <input
          id="cf-radius"
          inputMode="numeric"
          value={radius}
          onChange={(e) => setRadius(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="cf-buyin">Buy-in / Recompra (₡)</label>
        <div className="two">
          <input
            id="cf-buyin"
            inputMode="numeric"
            value={buyIn}
            onChange={(e) => setBuyIn(e.target.value)}
          />
          <input
            id="cf-rebuy"
            inputMode="numeric"
            aria-label="Recompra"
            value={rebuyAmount}
            onChange={(e) => setRebuyAmount(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="cf-stack">Stack inicial / Bonus llegada temprana</label>
        <div className="two">
          <input
            id="cf-stack"
            inputMode="numeric"
            value={startingStack}
            onChange={(e) => setStartingStack(e.target.value)}
          />
          <input
            aria-label="Bonus llegada temprana"
            value={earlyBirdChips != null ? `+${earlyBirdChips.toLocaleString('es-CR')}` : '—'}
            disabled
            readOnly
          />
        </div>
        <div className="hintline">El bonus de llegada temprana se ajusta en Liga · temporada.</div>
      </div>

      <div className="field">
        <label htmlFor="cf-rebuy-until">Recompra permitida hasta</label>
        <select
          id="cf-rebuy-until"
          value={rebuyUntil === null ? 'none' : String(rebuyUntil)}
          onChange={(e) => setRebuyUntil(e.target.value === 'none' ? null : Number(e.target.value))}
        >
          {REBUY_OPTIONS.map((o) => (
            <option key={o.label} value={o.value === null ? 'none' : String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="cf-structure">Estructura de blinds</label>
        <select
          id="cf-structure"
          value={structureId}
          onChange={(e) => setStructureId(e.target.value)}
        >
          {structures.length === 0 && <option value="">Sin estructuras</option>}
          {structures.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <PrizeDistributionEditor rows={distRows} onChange={setDistRows} disabled={busy} />

      <div className="toggle-row">
        <div>
          <div className="tl">Usar ante</div>
          <div className="ts">Normalmente sin ante</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={anteEnabled}
          aria-label="Usar ante"
          className={`switch${anteEnabled ? ' on' : ''}`}
          onClick={() => setAnteEnabled((v) => !v)}
        />
      </div>

      {error && (
        <div className="fd-note" role="alert" style={{ color: 'var(--oxblood)' }}>
          {error}
        </div>
      )}

      <div className="btn-row" style={{ padding: '4px 18px 0' }}>
        <button
          type="button"
          className="btn blood full"
          disabled={busy || !isValidDist(distRows)}
          onClick={() => void submit()}
        >
          {busy ? 'Creando…' : 'Crear fecha'}
        </button>
      </div>
    </div>
  )
}
