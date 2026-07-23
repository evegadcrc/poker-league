import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import logo from '@/assets/poker-friends.jpg'
import { useAuth } from '@/lib/auth'
import { THEME_ICONS, THEME_LABELS, useTheme } from '@/lib/theme'

type Status = 'idle' | 'sending' | 'sent' | 'error'

/**
 * Reproduces the prototype's #screen-login: emblem hero, POKER FRIENDS mark,
 * email input, "Enviar enlace" (magic link) → signInWithOtp. Also the terminal
 * state for an authenticated-but-unbound session (email not pre-created).
 */
export default function Login() {
  const { session, player, loading, bindError, signInWithOtp, signOut } = useAuth()
  const { theme, cycleTheme } = useTheme()
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)

  // Already signed in AND bound → nothing to do here; go home.
  if (session && player) return <Navigate to="/" replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setStatus('sending')
    setError(null)
    const { error: err } = await signInWithOtp(email.trim())
    if (err) {
      setError(err)
      setStatus('error')
    } else {
      setStatus('sent')
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
              ? 'Tu correo no está en la liga todavía. Pedile al admin que te agregue.'
              : 'No pudimos cargar tu perfil. Intentá de nuevo en un momento.'}
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
            disabled={status === 'sending' || status === 'sent'}
          />
          <button
            type="submit"
            className="btn blood full"
            style={{ marginTop: 14 }}
            disabled={status === 'sending' || status === 'sent' || !email.trim()}
          >
            {status === 'sending' ? 'Enviando…' : 'Enviar enlace'}
          </button>

          {status === 'sent' && (
            <p className="login-note ok">
              ✉ Enlace enviado a {email}. Revisá tu correo para entrar.
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
