import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { requestPosition } from '@/lib/checkin'
import PrizeDistributionEditor, {
  defaultRows,
  isValidDist,
  rowsToDist,
  type PctRow,
} from '@/components/PrizeDistributionEditor'
import type { Database, Json } from '@/lib/database.types'

type Structure = { id: string; name: string }

// Rebuy-period options → the numeric level (null = sin recompras).
const REBUY_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'Nivel 6', value: 6 },
  { label: 'Nivel 4', value: 4 },
  { label: 'Nivel 8', value: 8 },
  { label: 'Sin recompras', value: null },
]

// ---------------------------------------------------------------------------
// Fecha money/rebuy defaults. The league/season config does NOT store these
// (buy_in / rebuy_amount / starting_stack are tournament-level; bonus-stack and
// a re-entry cap have no DB column at all), so "Guardar ajustes" persists them
// client-side under `pf-fecha-defaults`. CreateFecha seeds the form from that
// key on mount, falling back to the hardcoded template below. No schema change.
// ---------------------------------------------------------------------------
const FECHA_DEFAULTS_KEY = 'pf-fecha-defaults'

type FechaDefaults = {
  buyIn: number
  rebuyAmount: number
  startingStack: number
  bonusStack: number
  rebuyUntil: number | null
}

const HARDCODED_FECHA_DEFAULTS: FechaDefaults = {
  buyIn: 10000,
  rebuyAmount: 10000,
  startingStack: 20000,
  bonusStack: 5000,
  rebuyUntil: 8,
}

function loadFechaDefaults(): FechaDefaults {
  try {
    const raw = localStorage.getItem(FECHA_DEFAULTS_KEY)
    if (!raw) return { ...HARDCODED_FECHA_DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<FechaDefaults>
    const num = (v: unknown, fallback: number) =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback
    return {
      buyIn: num(parsed.buyIn, HARDCODED_FECHA_DEFAULTS.buyIn),
      rebuyAmount: num(parsed.rebuyAmount, HARDCODED_FECHA_DEFAULTS.rebuyAmount),
      startingStack: num(parsed.startingStack, HARDCODED_FECHA_DEFAULTS.startingStack),
      bonusStack: num(parsed.bonusStack, HARDCODED_FECHA_DEFAULTS.bonusStack),
      rebuyUntil: parsed.rebuyUntil === null ? null : num(parsed.rebuyUntil, 8),
    }
  } catch {
    return { ...HARDCODED_FECHA_DEFAULTS }
  }
}

function saveFechaDefaults(d: FechaDefaults): void {
  try {
    localStorage.setItem(FECHA_DEFAULTS_KEY, JSON.stringify(d))
  } catch {
    // localStorage unavailable (private mode / quota) — non-fatal.
  }
}

/**
 * Display a whole-colón integer with "." thousands separators (10000 → "10.000").
 * Grouping is done explicitly rather than via toLocaleString('es-CR') because the
 * es-CR grouping separator varies by ICU/CLDR version (some emit a space); money
 * here is always whole colones, so a deterministic "." group is correct.
 */
const fmtMoney = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
/** Strip every non-digit and return the raw integer (empty → 0). */
const parseMoney = (s: string): number => {
  const digits = s.replace(/\D/g, '')
  return digits === '' ? 0 : Number(digits)
}

// ---------------------------------------------------------------------------
// Admin · Nueva fecha (slice 13). Creates a scheduled fecha in the active
// season via create_tournament. Venue is captured by geolocation ("usar mi
// ubicación") or entered manually. Money inputs display es-CR thousands
// separators; their defaults + the rebuy cutoff seed from pf-fecha-defaults
// (see loadFechaDefaults) and are saved back via "Guardar ajustes".
// ---------------------------------------------------------------------------
export default function CreateFecha() {
  const navigate = useNavigate()
  const [structures, setStructures] = useState<Structure[]>([])
  // Payout split for this fecha — seeded from the season default template, then
  // fully editable. Persisted to tournament.payout_distribution after create.
  const [distRows, setDistRows] = useState<PctRow[]>(defaultRows)

  // Money/rebuy defaults, seeded once from localStorage (falls back hardcoded).
  const seeded = useMemo(loadFechaDefaults, [])

  const [name, setName] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('19:00')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [radius, setRadius] = useState('100')
  const [buyIn, setBuyIn] = useState(seeded.buyIn)
  const [rebuyAmount, setRebuyAmount] = useState(seeded.rebuyAmount)
  const [startingStack, setStartingStack] = useState(seeded.startingStack)
  const [bonusStack, setBonusStack] = useState(seeded.bonusStack)
  const [rebuyUntil, setRebuyUntil] = useState<number | null>(seeded.rebuyUntil)
  const [savedDefaults, setSavedDefaults] = useState(false)
  const [structureId, setStructureId] = useState('')
  const [anteEnabled, setAnteEnabled] = useState(false)
  // Standalone-fecha toggle (Phase-2 step 7). ON by default: the fecha counts
  // toward the season standings. OFF → it runs fully (clock / eliminations /
  // prizes) but adds 0 to every player's season total.
  const [countsForLeague, setCountsForLeague] = useState(true)

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
          .select('payout_template')
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
        payout_template: unknown
      } | null
      if (season) {
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

  // Controlled formatted-money change handler: store the raw integer, invalidate
  // the "guardado" note so it never lingers over edited values.
  const onMoney = useCallback(
    (setter: (n: number) => void) => (e: ChangeEvent<HTMLInputElement>) => {
      setter(parseMoney(e.target.value))
      setSavedDefaults(false)
    },
    [],
  )

  // Persist the current money/rebuy values as the defaults for future fechas.
  const guardarAjustes = useCallback(() => {
    saveFechaDefaults({ buyIn, rebuyAmount, startingStack, bonusStack, rebuyUntil })
    setSavedDefaults(true)
  }, [buyIn, rebuyAmount, startingStack, bonusStack, rebuyUntil])

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
      buy_in: buyIn,
      rebuy_amount: rebuyAmount === 0 ? null : rebuyAmount,
      rebuy_until_level: rebuyUntil,
      starting_stack: startingStack === 0 ? null : startingStack,
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
    // Persist the fecha's payout split + the standalone flag. create_tournament
    // seeds a turnout-scaled default distribution; the admin's edited version is
    // authoritative, so overwrite it. counts_for_league is always written (the
    // column defaults true; a standalone fecha needs the explicit false).
    // Non-blocking: a create succeeds regardless — both can be fixed live.
    if (id) {
      const update: Database['public']['Tables']['tournament']['Update'] = {
        counts_for_league: countsForLeague,
      }
      if (isValidDist(distRows)) {
        update.payout_distribution = rowsToDist(distRows) as unknown as Json
      }
      await supabase.from('tournament').update(update).eq('id', id)
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
    countsForLeague,
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
          <span className="money-input" data-symbol="₡">
            <input
              id="cf-buyin"
              inputMode="numeric"
              value={fmtMoney(buyIn)}
              onChange={onMoney(setBuyIn)}
            />
          </span>
          <span className="money-input" data-symbol="₡">
            <input
              id="cf-rebuy"
              inputMode="numeric"
              aria-label="Recompra"
              value={fmtMoney(rebuyAmount)}
              onChange={onMoney(setRebuyAmount)}
            />
          </span>
        </div>
      </div>

      <div className="field">
        <label htmlFor="cf-stack">Stack inicial / Bonus stack</label>
        <div className="two">
          <input
            id="cf-stack"
            inputMode="numeric"
            value={fmtMoney(startingStack)}
            onChange={onMoney(setStartingStack)}
          />
          <input
            id="cf-bonus"
            inputMode="numeric"
            aria-label="Bonus stack"
            value={fmtMoney(bonusStack)}
            onChange={onMoney(setBonusStack)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="cf-rebuy-until">Recompra permitida hasta</label>
        <select
          id="cf-rebuy-until"
          value={rebuyUntil === null ? 'none' : String(rebuyUntil)}
          onChange={(e) => {
            setRebuyUntil(e.target.value === 'none' ? null : Number(e.target.value))
            setSavedDefaults(false)
          }}
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

      <div className="toggle-row">
        <div>
          <div className="tl">Cuenta para la liga</div>
          <div className="ts">Si lo apagás, la fecha se juega igual pero no suma a la tabla</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={countsForLeague}
          aria-label="Cuenta para la liga"
          className={`switch${countsForLeague ? ' on' : ''}`}
          onClick={() => setCountsForLeague((v) => !v)}
        />
      </div>

      {error && (
        <div className="fd-note" role="alert" style={{ color: 'var(--oxblood)' }}>
          {error}
        </div>
      )}
      {savedDefaults && (
        <div className="fd-note" role="status">
          ✓ Guardado como predeterminado
        </div>
      )}

      <div className="btn-row" style={{ padding: '4px 18px 0' }}>
        <button type="button" className="btn ghost full" onClick={guardarAjustes}>
          Guardar ajustes
        </button>
      </div>

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
