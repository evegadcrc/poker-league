import { useEffect, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import logo from '@/assets/poker-friends.jpg'
import { fetchGuestFecha, guestJoin } from '@/lib/access'
import { useAuth } from '@/lib/auth'
import { peekNext } from '@/lib/next'
import { THEME_ICONS, THEME_LABELS, useTheme } from '@/lib/theme'

type Status = 'idle' | 'sending' | 'sent' | 'error' | 'pending' | 'rejected'

/**
 * Reproduces the prototype's #screen-login: emblem hero, POKER FRIENDS mark,
 * email input, "Enviar enlace" (magic link) → signInWithOtp. Also the terminal
 * state for an authenticated-but-unbound session (email not pre-created).
 *
 * First-login gate (migration 0022): submit calls request_access FIRST. A KNOWN
 * member email sends the link as before; an UNKNOWN email is queued as a pending
 * admin request ('pending') and no link is sent; a previously rejected email
 * gets a neutral message ('rejected').
 */
export default function Login() {
  const { session, player, loading, bindError, requestAccess, signInWithOtp, signOut } = useAuth()
  const { theme, cycleTheme } = useTheme()
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)

  // Guest self-join (mig 0035): when the visitor came through a fecha link and
  // that fecha accepts guests, offer "Ingresar como invitado … Entrar aquí" (email + name → a guest
  // player, confirmed for that fecha, then the same magic link).
  const [guestFecha, setGuestFecha] = useState<{ id: string; name: string } | null>(null)
  const [guestMode, setGuestMode] = useState(false)
  const [guestName, setGuestName] = useState('')
  useEffect(() => {
    const m = /^\/fechas\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(peekNext() ?? '')
    if (!m) return
    let alive = true
    void fetchGuestFecha(m[1]!).then((f) => {
      if (alive) setGuestFecha(f)
    })
    return () => {
      alive = false
    }
  }, [])

  // Already signed in AND bound → nothing to do here; go home.
  if (session && player) return <Navigate to="/" replace />

  // Send the magic link (member path + the resend affordance).
  async function sendLink(target: string) {
    setStatus('sending')
    setError(null)
    const { error: err } = await signInWithOtp(target)
    if (err) {
      setError(err)
      setStatus('error')
    } else {
      setStatus('sent')
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const target = email.trim()
    if (!target) return
    if (guestMode && guestFecha) {
      const gname = guestName.trim()
      if (!gname) return
      setStatus('sending')
      setError(null)
      // Creates the guest player + confirmed entry (or recognises a member),
      // then the usual magic link — the deep link brings them back to the fecha.
      const { result, error: gErr } = await guestJoin(target, gname, guestFecha.id)
      if (gErr || !result) {
        setError(gErr ?? 'No se pudo anotar como invitado.')
        setStatus('error')
        return
      }
      await sendLink(target)
      return
    }
    setStatus('sending')
    setError(null)
    // Gate on membership before sending any link.
    const { result, error: reqErr } = await requestAccess(target)
    if (reqErr) {
      setError(reqErr)
      setStatus('error')
      return
    }
    if (result === 'member') {
      await sendLink(target)
    } else if (result === 'rejected') {
      setStatus('rejected')
    } else {
      // 'pending' (new or already queued) — no link is sent.
      setStatus('pending')
    }
  }

  // Signed in, but the email matched no pre-created player (or an RPC error).
  const showUnbound = Boolean(session && !player && !loading && bindError)

  return (
    <div className="login-screen">
      <button
        type="button"
        className="icon-btn login-theme"
        onClick={cycleTheme}
        title={THEME_LABELS[theme]}
        aria-label={`Tema: ${THEME_LABELS[theme]}`}
      >
        {THEME_ICONS[theme]}
      </button>

      <div
        className="logo-emblem login-logo"
        style={{ width: 120, height: 120, backgroundImage: `url(${logo})` }}
        role="img"
        aria-label="Poker Friends"
      />
      <h1 className="login-mark">
        POKER<br />FRIENDS
      </h1>
      <p className="login-sub">Liga de póker · Temporada 2026</p>

      {showUnbound ? (
        <div className="login-form">
          <p className="login-note err">
            {bindError === 'no-player'
              ? 'Este correo no está en la liga todavía. Solicitar al admin que lo agregue.'
              : 'No se pudo cargar el perfil. Intentar de nuevo en un momento.'}
          </p>
          <button
            type="button"
            className="btn ghost full"
            style={{ marginTop: 14 }}
            onClick={() => signOut()}
          >
            Cerrar sesión
          </button>
        </div>
      ) : (
        <form className="login-form" onSubmit={onSubmit}>
          <input
            className="login-in"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="tu@correo.com"
            aria-label="Correo electrónico"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={status === 'sending' || status === 'sent' || status === 'pending'}
          />
          {guestMode && guestFecha && (
            <input
              className="login-in"
              style={{ marginTop: 10 }}
              type="text"
              autoComplete="name"
              maxLength={40}
              placeholder="Tu nombre"
              aria-label="Tu nombre"
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              disabled={status === 'sending' || status === 'sent'}
              data-testid="guest-name"
            />
          )}
          <button
            type="submit"
            className="btn blood full"
            style={{ marginTop: 14 }}
            disabled={
              status === 'sending' ||
              status === 'sent' ||
              status === 'pending' ||
              !email.trim() ||
              (guestMode && !guestName.trim())
            }
          >
            {status === 'sending'
              ? 'Enviando…'
              : guestMode && guestFecha
                ? 'Anotarme como invitado'
                : 'Enviar enlace'}
          </button>

          {status === 'idle' && guestFecha && !guestMode && (
            <p className="login-hint" data-testid="guest-offer">
              Ingresar como invitado a <b>{guestFecha.name}</b>:{' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => setGuestMode(true)}
                data-testid="guest-mode"
              >
                Entrar aquí
              </button>
            </p>
          )}
          {status === 'idle' && guestFecha && guestMode && (
            <p className="login-hint" data-testid="guest-explainer">
              Como invitado en <b>{guestFecha.name}</b> jugás esa fecha con todo (check-in,
              avisos), pero no sumás puntos en la tabla.{' '}
              <button type="button" className="link-btn" onClick={() => setGuestMode(false)}>
                Soy miembro
              </button>
            </p>
          )}
          {status === 'idle' && !(guestFecha && guestMode) && (
            <p className="login-hint">
              ¿Primera vez? Si el correo todavía no está en la liga, la solicitud le llega al
              admin. Cuando la apruebe, se envía el enlace de acceso por correo.
            </p>
          )}

          {status === 'pending' && (
            <p className="login-note ok" role="status">
              📨 Solicitud anotada en la lista. <b>El admin tiene que aprobarla primero</b> —
              apenas lo haga, llega el enlace de acceso a <b>este correo</b>. (Revisar también spam.)
            </p>
          )}
          {status === 'rejected' && (
            <p className="login-note err" role="status">
              No se pudo procesar la solicitud. Hablar con el admin.{' '}
              <button type="button" className="link-btn" onClick={() => setStatus('idle')}>
                Reintentar
              </button>
            </p>
          )}

          {status === 'sent' && (
            <p className="login-note ok">
              {guestMode && guestFecha ? (
                <>
                  🙋 Quedaste anotado en <b>{guestFecha.name}</b>.{' '}
                </>
              ) : null}
              ✉ Enlace enviado a {email}. Revisar el correo para entrar.{' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => void sendLink(email.trim())}
              >
                Reenviar enlace
              </button>
            </p>
          )}
          {status === 'error' && (
            <p className="login-note err">
              {error ?? 'No se pudo enviar el enlace.'}{' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => setStatus('idle')}
              >
                Reintentar
              </button>
            </p>
          )}
        </form>
      )}
    </div>
  )
}
