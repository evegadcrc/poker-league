import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { Database } from '@/lib/database.types'

export type PlayerRow = Database['public']['Tables']['player']['Row']

/**
 * Why the session may be authenticated yet have no bound player:
 * `claim_player()` (migration 0002) matches the verified email against a
 * pre-created `player` row. If the admin never added the member, binding
 * returns null → we surface `bindError='no-player'` so Login can tell them to
 * ask the admin. `'other'` covers an unexpected RPC failure.
 */
export type BindError = 'no-player' | 'other' | null

type AuthContextValue = {
  session: Session | null
  user: User | null
  /** Bound league member for the signed-in user (null until claimed / if unbound). */
  player: PlayerRow | null
  /** True while the initial session resolves or a bind RPC is in flight. */
  loading: boolean
  bindError: BindError
  signInWithOtp: (email: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  /**
   * Patch the bound player in context so a change made on one screen (e.g. the
   * new avatar uploaded on Perfil) is reflected app-wide immediately, without a
   * round-trip / reload. No-op when there is no bound player.
   */
  updatePlayer: (patch: Partial<PlayerRow>) => void
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [player, setPlayer] = useState<PlayerRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [bindError, setBindError] = useState<BindError>(null)

  // Track which auth user we've already bound so re-renders / StrictMode's
  // double-invoke don't fire claim_player repeatedly for the same session.
  const boundUserId = useRef<string | null>(null)

  useEffect(() => {
    let active = true

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session)
      if (!data.session) setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      if (!next) {
        // Signed out → clear everything and allow a fresh bind next time.
        boundUserId.current = null
        setPlayer(null)
        setBindError(null)
        setLoading(false)
      }
    })

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const userId = session?.user?.id ?? null

  // First authenticated session → bind (or re-load) the player row via the
  // SECURITY DEFINER claim_player RPC. Keyed on userId so it runs once per user.
  useEffect(() => {
    if (!userId) return
    if (boundUserId.current === userId) return
    boundUserId.current = userId

    let active = true
    setLoading(true)

    async function bind() {
      // claim_player returns SETOF player → array: [] = no pre-created member.
      const { data, error } = await supabase.rpc('claim_player')
      if (!active) return
      const row = data?.[0] ?? null
      if (error) {
        setPlayer(null)
        setBindError('other')
      } else if (!row) {
        setPlayer(null)
        setBindError('no-player')
      } else {
        setPlayer(row)
        setBindError(null)
      }
      setLoading(false)
    }
    void bind()

    return () => {
      active = false
    }
  }, [userId])

  const signInWithOtp = useCallback(async (email: string) => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/` },
    })
    return { error: error?.message ?? null }
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
  }, [])

  const updatePlayer = useCallback((patch: Partial<PlayerRow>) => {
    setPlayer((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      player,
      loading,
      bindError,
      signInWithOtp,
      signOut,
      updatePlayer,
    }),
    [session, player, loading, bindError, signInWithOtp, signOut, updatePlayer],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}

/** Role derived from the bound player row. Screen slices read `isAdmin` to gate admin UI. */
export function useRole(): { isAdmin: boolean } {
  const { player } = useAuth()
  return { isAdmin: player?.is_admin ?? false }
}
