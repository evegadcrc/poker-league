import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import Sheet from '@/components/Sheet'
import { bandLabel, parseBands, type Band } from '@/lib/fechas'
import type { Json } from '@/lib/database.types'

type Season = {
  id: string
  name: string
  year: number
  points_multiplier: number
  bonus_final_table: number
  bonus_top3: number
  bonus_attendance: number
  no_show_penalty: number
  early_bird_bonus_chips: number
  final_table_size_override: number | null
  payout_template: Json
  cancel_bands: Json
}

const SEASON_COLUMNS =
  'id, name, year, points_multiplier, bonus_final_table, bonus_top3, bonus_attendance, no_show_penalty, early_bird_bonus_chips, final_table_size_override, payout_template, cancel_bands'

/** payout_template is stored as decimals ([0.60,0.28,0.12]); the UI edits percentages. */
function templateToPercents(raw: Json): string {
  if (!Array.isArray(raw)) return ''
  return raw.map((v) => Math.round(Number(v) * 100)).join(', ')
}
function percentsToTemplate(text: string): number[] {
  return text
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.round((n / 100) * 100) / 100)
}

// ---------------------------------------------------------------------------
// Admin · Liga · temporada (slice 13). Edits the active season's config via
// update_season_config, shows the graduated cancel-bands, and gates the
// irreversible season rollover (close_season) behind a confirm modal.
// ---------------------------------------------------------------------------
export default function LeagueSettings() {
  const navigate = useNavigate()
  const [season, setSeason] = useState<Season | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')

  const [name, setName] = useState('')
  const [mult, setMult] = useState('')
  const [bmf, setBmf] = useState('')
  const [btop3, setBtop3] = useState('')
  const [batt, setBatt] = useState('')
  const [ftSize, setFtSize] = useState('')
  const [noShow, setNoShow] = useState('')
  const [payout, setPayout] = useState('')

  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)

  const hydrate = useCallback((s: Season) => {
    setSeason(s)
    setName(s.name)
    setMult(String(s.points_multiplier))
    setBmf(String(s.bonus_final_table))
    setBtop3(String(s.bonus_top3))
    setBatt(String(s.bonus_attendance))
    setFtSize(s.final_table_size_override != null ? String(s.final_table_size_override) : '')
    setNoShow(String(s.no_show_penalty))
    setPayout(templateToPercents(s.payout_template))
  }, [])

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('season')
      .select(SEASON_COLUMNS)
      .eq('status', 'active')
      .order('year', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (err || !data) {
      setPhase('error')
      return
    }
    hydrate(data as Season)
    setPhase('ready')
  }, [hydrate])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    const payload: Record<string, Json> = {
      name: name.trim(),
      points_multiplier: mult === '' ? 10 : Number(mult),
      bonus_final_table: bmf === '' ? 0 : Number(bmf),
      bonus_top3: btop3 === '' ? 0 : Number(btop3),
      bonus_attendance: batt === '' ? 0 : Number(batt),
      no_show_penalty: noShow === '' ? 0 : Number(noShow),
      // Early-bird bonus is a fecha-level setting now (removed from this view);
      // preserve the season's stored value so the save doesn't reset it.
      early_bird_bonus_chips: season?.early_bird_bonus_chips ?? 0,
      final_table_size_override: ftSize === '' ? '' : Number(ftSize),
      payout_template: percentsToTemplate(payout),
    }
    const { data, error: err } = await supabase.rpc('update_season_config', {
      p_payload: payload as Json,
    })
    setBusy(false)
    if (err) {
      setError(err.message)
      return
    }
    const rows = (data ?? []) as Season[]
    if (rows[0]) hydrate(rows[0])
    setSaved(true)
  }, [name, mult, bmf, btop3, batt, noShow, season, ftSize, payout, hydrate])

  const doClose = useCallback(async () => {
    setBusy(true)
    setError(null)
    const { data, error: err } = await supabase.rpc('close_season')
    setBusy(false)
    setConfirmClose(false)
    if (err) {
      setError(err.message)
      return
    }
    // close_season returns the NEW active season row — land on its Tabla so the
    // admin sees the fresh (roster-at-0) standings instead of a blank screen.
    const rows = (data ?? []) as Season[]
    const next = rows[0]
    if (next) navigate(`/temporadas/${next.id}`)
  }, [navigate])

  if (phase === 'loading') return <div className="fd-note">Cargando ajustes…</div>
  if (phase === 'error' || !season)
    return (
      <div className="fd-note" role="alert">
        <p>No se pudieron cargar los ajustes de la liga.</p>
        <button type="button" className="btn ghost sm" onClick={() => void load()}>
          Reintentar
        </button>
      </div>
    )

  const bands: Band[] = parseBands(season.cancel_bands)

  return (
    <div data-testid="league-settings">
      <div className="field">
        <label htmlFor="ls-name">Temporada activa</label>
        <input id="ls-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="ls-mult">Multiplicador de puntos</label>
        <input
          id="ls-mult"
          inputMode="numeric"
          value={mult}
          onChange={(e) => setMult(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="ls-bmf">Bonus Mesa Final / Top 3 / Asistencia</label>
        <div className="two">
          <input
            id="ls-bmf"
            aria-label="Bonus Mesa Final"
            inputMode="numeric"
            value={bmf}
            onChange={(e) => setBmf(e.target.value)}
          />
          <input
            aria-label="Bonus Top 3"
            inputMode="numeric"
            value={btop3}
            onChange={(e) => setBtop3(e.target.value)}
          />
        </div>
        <input
          style={{ marginTop: 8 }}
          aria-label="Bonus Asistencia"
          inputMode="numeric"
          value={batt}
          onChange={(e) => setBatt(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="ls-ftsize">Tamaño de mesa final (vacío = automático 5/10)</label>
        <input
          id="ls-ftsize"
          inputMode="numeric"
          placeholder="Automático"
          value={ftSize}
          onChange={(e) => setFtSize(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="ls-noshow">Castigo no-show (confirmó y no llegó)</label>
        <input
          id="ls-noshow"
          inputMode="numeric"
          value={noShow}
          onChange={(e) => setNoShow(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="ls-payout">Reparto de premios (% top 3)</label>
        <input
          id="ls-payout"
          placeholder="60, 28, 12"
          value={payout}
          onChange={(e) => setPayout(e.target.value)}
        />
      </div>

      <div className="field" style={{ paddingBottom: 2 }}>
        <label>Castigo por cancelar (según antelación)</label>
      </div>
      <div className="bands" data-testid="cancel-bands">
        {bands.map((b, i) => (
          <div className="br" key={`${b.hours_before}-${i}`}>
            <span>{bandLabel(b, bands)}</span>
            <b>{b.penalty}</b>
          </div>
        ))}
      </div>

      {error && (
        <div className="fd-note" role="alert" style={{ color: 'var(--oxblood)' }}>
          {error}
        </div>
      )}
      {saved && (
        <div className="fd-note" role="status">
          ✓ Ajustes guardados
        </div>
      )}

      <div className="btn-row" style={{ padding: '4px 18px 0' }}>
        <button type="button" className="btn primary full" disabled={busy} onClick={() => void save()}>
          {busy ? 'Guardando…' : 'Guardar ajustes'}
        </button>
      </div>

      <div className="rule faint" style={{ margin: '14px 0' }} />

      <div className="field" style={{ paddingTop: 2 }}>
        <label>Fin de temporada</label>
        <div className="hintline">
          Cerrar {season.name} (queda como historial) y abrir {season.year + 1} — el roster se
          mantiene, los puntos vuelven a cero.
        </div>
      </div>
      <div className="btn-row" style={{ padding: '4px 18px 0' }}>
        <button
          type="button"
          className="btn ghost full"
          disabled={busy}
          onClick={() => setConfirmClose(true)}
        >
          Cerrar liga actual
        </button>
      </div>

      <Sheet open={confirmClose} onClose={() => setConfirmClose(false)} title="Cerrar liga actual">
        <p>
          La <b>{season.name}</b> pasa a historial (solo lectura) y se abre una nueva liga. Los
          jugadores se mantienen; los puntos vuelven a cero. Esta acción no se puede deshacer.
        </p>
        <div className="btn-row">
          <button
            type="button"
            className="btn ghost"
            style={{ flex: 1 }}
            onClick={() => setConfirmClose(false)}
          >
            Volver
          </button>
          <button
            type="button"
            className="btn blood"
            style={{ flex: 1 }}
            disabled={busy}
            onClick={() => void doClose()}
          >
            Cerrar liga
          </button>
        </div>
      </Sheet>
    </div>
  )
}
