import { useCallback, useState, type ChangeEvent } from 'react'
import { requestPosition } from '@/lib/checkin'
import PrizeDistributionEditor, {
  isValidDist,
  type PctRow,
} from '@/components/PrizeDistributionEditor'
import { formatMiles } from '@/lib/format'
import { toDatetimeLocal } from '@/lib/fechas'

// ---------------------------------------------------------------------------
// FechaForm — the ONE fecha form, shared by Admin · Nueva fecha (create) and
// /fechas/:id/editar (edit). It owns the field state and the "Guardar ajustes"
// defaults; the parent seeds it via `initial`, owns the async I/O (structures,
// season template, the tournament row) and receives the values back on submit.
// The parent must not render the form until `initial` is fully resolved — the
// state is initialised ONCE from it (no re-seeding on prop change).
// ---------------------------------------------------------------------------

export type Structure = { id: string; name: string }

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
export const FECHA_DEFAULTS_KEY = 'pf-fecha-defaults'

export type FechaDefaults = {
  buyIn: number
  rebuyAmount: number
  startingStack: number
  bonusStack: number
  rebuyUntil: number | null
  // Max re-entries a single player may buy in a fecha. COUNT of rebuys — distinct
  // from rebuyUntil (the level the rebuy window stays open). No DB column yet, so
  // this is a saved form default only (not persisted onto the tournament row).
  maxRebuys: number
  // Venue geofence, kept as the raw input strings (lat/lng blank until captured;
  // radius as typed). Persisted so the venue — usually the same house — carries
  // across fechas instead of being re-entered each time. Written onto the
  // tournament at create via venue_lat / venue_lng / geofence_radius_m (submit).
  lat: string
  lng: string
  radius: string
}

export const HARDCODED_FECHA_DEFAULTS: FechaDefaults = {
  buyIn: 10000,
  rebuyAmount: 10000,
  startingStack: 20000,
  bonusStack: 5000,
  rebuyUntil: 8,
  maxRebuys: 8,
  lat: '',
  lng: '',
  radius: '100',
}

export function loadFechaDefaults(): FechaDefaults {
  try {
    const raw = localStorage.getItem(FECHA_DEFAULTS_KEY)
    if (!raw) return { ...HARDCODED_FECHA_DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<FechaDefaults>
    const num = (v: unknown, fallback: number) =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback
    const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback)
    return {
      buyIn: num(parsed.buyIn, HARDCODED_FECHA_DEFAULTS.buyIn),
      rebuyAmount: num(parsed.rebuyAmount, HARDCODED_FECHA_DEFAULTS.rebuyAmount),
      startingStack: num(parsed.startingStack, HARDCODED_FECHA_DEFAULTS.startingStack),
      bonusStack: num(parsed.bonusStack, HARDCODED_FECHA_DEFAULTS.bonusStack),
      rebuyUntil: parsed.rebuyUntil === null ? null : num(parsed.rebuyUntil, 8),
      maxRebuys: num(parsed.maxRebuys, HARDCODED_FECHA_DEFAULTS.maxRebuys),
      lat: str(parsed.lat, HARDCODED_FECHA_DEFAULTS.lat),
      lng: str(parsed.lng, HARDCODED_FECHA_DEFAULTS.lng),
      radius: str(parsed.radius, HARDCODED_FECHA_DEFAULTS.radius),
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

/** Strip every non-digit and return the raw integer (empty → 0). */
export const parseMoney = (s: string): number => {
  const digits = s.replace(/\D/g, '')
  return digits === '' ? 0 : Number(digits)
}

/** Everything the form edits. Money/stack values are raw integers; the venue
 *  fields are the raw input strings (blank = not set); date/time are the native
 *  input values (YYYY-MM-DD / HH:mm, local time). */
export type FechaFormValues = {
  name: string
  date: string
  time: string
  lat: string
  lng: string
  radius: string
  buyIn: number
  rebuyAmount: number
  startingStack: number
  bonusStack: number
  rebuyUntil: number | null
  maxRebuys: number
  structureId: string
  anteEnabled: boolean
  countsForLeague: boolean
  oddsEnabled: boolean
  /** Guests may sign themselves up with the shared link (mig 0035). */
  guestsOpen: boolean
  distRows: PctRow[]
}

/** Seed for a NEW fecha: saved defaults + the given structure / payout split. */
export function createInitialValues(
  d: FechaDefaults,
  structureId: string,
  distRows: PctRow[],
): FechaFormValues {
  return {
    name: '',
    date: '',
    time: '19:00',
    lat: d.lat,
    lng: d.lng,
    radius: d.radius,
    buyIn: d.buyIn,
    rebuyAmount: d.rebuyAmount,
    startingStack: d.startingStack,
    bonusStack: d.bonusStack,
    rebuyUntil: d.rebuyUntil,
    maxRebuys: d.maxRebuys,
    structureId,
    anteEnabled: false,
    // Standalone-fecha toggle (Phase-2 step 7). ON by default: the fecha counts
    // toward the season standings. OFF → it runs fully but adds 0 to totals.
    countsForLeague: true,
    // Odds-calculator toggle (Phase-2 step 7). ON by default → the Calculadora is
    // available while THIS fecha is live (the admin can also flip it mid-game).
    oddsEnabled: true,
    // OFF by default: only fechas the admin opts in accept guests via the link.
    guestsOpen: false,
    distRows,
  }
}

/** A stored `scheduled_at` → the form's {date, time} in local time. */
export function splitDatetime(iso: string): { date: string; time: string } {
  const [date = '', time = ''] = toDatetimeLocal(iso).split('T')
  return { date, time }
}

/** The form's {date, time} → ISO timestamp, or null when incomplete/invalid.
 *  `YYYY-MM-DDTHH:mm` (no zone) parses as LOCAL time, matching the inputs. */
export function joinDatetime(date: string, time: string): string | null {
  if (!date || !time) return null
  const d = new Date(`${date}T${time}`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export type VenueColumns = {
  venue_lat: number | null
  venue_lng: number | null
  geofence_radius_m: number
}

/** Validate the venue inputs into tournament columns. Both coordinates blank →
 *  no geofence (check-in then needs the admin override); exactly one blank, a
 *  non-numeric coordinate, or a non-positive radius → a user-facing error. */
export function parseVenue(
  lat: string,
  lng: string,
  radius: string,
): { ok: true; venue: VenueColumns } | { ok: false; message: string } {
  const latS = lat.trim()
  const lngS = lng.trim()
  const radS = radius.trim()
  if ((latS === '') !== (lngS === '')) {
    return { ok: false, message: 'Sede incompleta: ingresar latitud y longitud, o dejar ambas vacías.' }
  }
  const latN = latS === '' ? null : Number(latS)
  const lngN = lngS === '' ? null : Number(lngS)
  if (
    (latN != null && (!Number.isFinite(latN) || Math.abs(latN) > 90)) ||
    (lngN != null && (!Number.isFinite(lngN) || Math.abs(lngN) > 180))
  ) {
    return { ok: false, message: 'Coordenadas de la sede inválidas.' }
  }
  const radN = radS === '' ? 100 : Number(radS)
  if (!Number.isInteger(radN) || radN <= 0) {
    return { ok: false, message: 'El radio de check-in debe ser un número entero de metros mayor a 0.' }
  }
  return { ok: true, venue: { venue_lat: latN, venue_lng: lngN, geofence_radius_m: radN } }
}

type Props = {
  initial: FechaFormValues
  structures: Structure[]
  /** Primary button copy, idle / in-flight ("Crear fecha" / "Creando…"). */
  submitLabel: string
  busyLabel: string
  busy: boolean
  error: string | null
  onSubmit: (values: FechaFormValues) => void
}

export default function FechaForm({
  initial,
  structures,
  submitLabel,
  busyLabel,
  busy,
  error,
  onSubmit,
}: Props) {
  const [name, setName] = useState(initial.name)
  const [date, setDate] = useState(initial.date)
  const [time, setTime] = useState(initial.time)
  const [lat, setLat] = useState(initial.lat)
  const [lng, setLng] = useState(initial.lng)
  const [radius, setRadius] = useState(initial.radius)
  const [buyIn, setBuyIn] = useState(initial.buyIn)
  const [rebuyAmount, setRebuyAmount] = useState(initial.rebuyAmount)
  const [startingStack, setStartingStack] = useState(initial.startingStack)
  const [bonusStack, setBonusStack] = useState(initial.bonusStack)
  const [rebuyUntil, setRebuyUntil] = useState<number | null>(initial.rebuyUntil)
  const [maxRebuys, setMaxRebuys] = useState(initial.maxRebuys)
  const [structureId, setStructureId] = useState(initial.structureId)
  const [anteEnabled, setAnteEnabled] = useState(initial.anteEnabled)
  const [countsForLeague, setCountsForLeague] = useState(initial.countsForLeague)
  const [oddsEnabled, setOddsEnabled] = useState(initial.oddsEnabled)
  const [guestsOpen, setGuestsOpen] = useState(initial.guestsOpen)
  const [distRows, setDistRows] = useState<PctRow[]>(initial.distRows)
  const [savedDefaults, setSavedDefaults] = useState(false)
  const [locating, setLocating] = useState(false)
  const [locError, setLocError] = useState<string | null>(null)

  // An existing fecha may carry a rebuy cutoff outside the preset list (e.g. a
  // level typed by hand in an earlier version); surface it so the select never
  // silently shows a different value than what is stored.
  const rebuyOptions =
    rebuyUntil != null && !REBUY_OPTIONS.some((o) => o.value === rebuyUntil)
      ? [{ label: `Nivel ${rebuyUntil}`, value: rebuyUntil }, ...REBUY_OPTIONS]
      : REBUY_OPTIONS

  const useMyLocation = useCallback(async () => {
    setLocating(true)
    setLocError(null)
    try {
      const pos = await requestPosition()
      setLat(pos.lat.toFixed(6))
      setLng(pos.lng.toFixed(6))
      // The venue just changed → the saved-defaults note no longer describes it.
      setSavedDefaults(false)
    } catch {
      setLocError('No se pudo obtener la ubicación. Ingresar la sede manualmente.')
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

  // Venue (lat/lng/radius) change handler: store the raw string + invalidate the
  // "guardado" note, mirroring onMoney so an edited venue never shows as saved.
  const onVenue = useCallback(
    (setter: (s: string) => void) => (e: ChangeEvent<HTMLInputElement>) => {
      setter(e.target.value)
      setSavedDefaults(false)
    },
    [],
  )

  // Persist the current money/rebuy values + the venue geofence as the defaults
  // for future fechas (the venue is usually the same house week to week).
  const guardarAjustes = useCallback(() => {
    saveFechaDefaults({
      buyIn,
      rebuyAmount,
      startingStack,
      bonusStack,
      rebuyUntil,
      maxRebuys,
      lat,
      lng,
      radius,
    })
    setSavedDefaults(true)
  }, [buyIn, rebuyAmount, startingStack, bonusStack, rebuyUntil, maxRebuys, lat, lng, radius])

  const submit = useCallback(() => {
    onSubmit({
      name,
      date,
      time,
      lat,
      lng,
      radius,
      buyIn,
      rebuyAmount,
      startingStack,
      bonusStack,
      rebuyUntil,
      maxRebuys,
      structureId,
      anteEnabled,
      countsForLeague,
      oddsEnabled,
      guestsOpen,
      distRows,
    })
  }, [
    onSubmit,
    name,
    date,
    time,
    lat,
    lng,
    radius,
    buyIn,
    rebuyAmount,
    startingStack,
    bonusStack,
    rebuyUntil,
    maxRebuys,
    structureId,
    anteEnabled,
    countsForLeague,
    oddsEnabled,
    guestsOpen,
    distRows,
  ])

  const shownError = error ?? locError

  return (
    <div data-testid="fecha-form">
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
          <input
            id="cf-time"
            type="time"
            aria-label="Hora"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
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
            onChange={onVenue(setLat)}
          />
          <input
            id="cf-lng"
            inputMode="decimal"
            placeholder="Longitud"
            value={lng}
            onChange={onVenue(setLng)}
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
          onChange={onVenue(setRadius)}
        />
      </div>

      <div className="field">
        <label htmlFor="cf-buyin">Buy-in / Recompra (₡)</label>
        <div className="two">
          <span className="money-input" data-symbol="₡">
            <input
              id="cf-buyin"
              inputMode="numeric"
              value={formatMiles(buyIn)}
              onChange={onMoney(setBuyIn)}
            />
          </span>
          <span className="money-input" data-symbol="₡">
            <input
              id="cf-rebuy"
              inputMode="numeric"
              aria-label="Recompra"
              value={formatMiles(rebuyAmount)}
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
            value={formatMiles(startingStack)}
            onChange={onMoney(setStartingStack)}
          />
          <input
            id="cf-bonus"
            inputMode="numeric"
            aria-label="Bonus stack"
            value={formatMiles(bonusStack)}
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
          {rebuyOptions.map((o) => (
            <option key={o.label} value={o.value === null ? 'none' : String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="cf-max-rebuys">Máx recompras por jugador</label>
        <input
          id="cf-max-rebuys"
          inputMode="numeric"
          value={String(maxRebuys)}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '')
            setMaxRebuys(digits === '' ? 0 : Number(digits))
            setSavedDefaults(false)
          }}
        />
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
          <div className="ts">Si se apaga, la fecha se juega igual pero no suma a la tabla</div>
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

      <div className="toggle-row">
        <div>
          <div className="tl">Permitir calculadora de probabilidades</div>
          <div className="ts">Si se apaga, la calculadora queda deshabilitada mientras la fecha esté en vivo</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={oddsEnabled}
          aria-label="Permitir calculadora de probabilidades"
          className={`switch${oddsEnabled ? ' on' : ''}`}
          onClick={() => setOddsEnabled((v) => !v)}
        />
      </div>

      <div className="toggle-row">
        <div>
          <div className="tl">Invitados pueden unirse con el enlace</div>
          <div className="ts">
            Quien reciba el enlace puede anotarse como invitado: juega, pero no suma a la tabla
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={guestsOpen}
          aria-label="Invitados pueden unirse con el enlace"
          className={`switch${guestsOpen ? ' on' : ''}`}
          onClick={() => setGuestsOpen((v) => !v)}
        />
      </div>

      {shownError && (
        <div className="fd-note" role="alert" style={{ color: 'var(--oxblood)' }}>
          {shownError}
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
          onClick={submit}
        >
          {busy ? busyLabel : submitLabel}
        </button>
      </div>
    </div>
  )
}
