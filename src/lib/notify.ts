import { useCallback, useEffect, useRef, useState } from 'react'
import { playCue, resumeAudio, type SoundCue } from '@/lib/sound'

/**
 * Event cues + in-app toasts + optional LOCAL notifications, fired off STATE
 * TRANSITIONS (plan step 13). This is deliberately NOT tick-driven: the hook
 * compares the previously-observed discrete state (live fecha id, current level,
 * the set of players who are OUT) against the latest observation and only fires
 * when one of those actually changed. The one clock-derived cue — the
 * final-seconds warning — fires exactly once per level, on the downward crossing
 * of the threshold, so a per-second re-render can never re-fire it.
 *
 * Both `Live` and the admin `Consola` refetch their whole state on every
 * realtime event, so "observe a transition" == "diff this render's signal
 * against the last one". Non-admin observers get everything through Live's
 * realtime subscription; they never perform the action.
 *
 * Web push / service-worker notifications are Phase 3 — out of scope. Here the
 * Notification API is used only for LOCAL, permission-gated notifications so a
 * player with the screen off still gets the high-value alerts.
 */

/** Fire the warning this many seconds before a level ends. */
const WARNING_THRESHOLD_SECONDS = 10

/** How long an in-app event toast stays up before auto-dismissing. */
const TOAST_TTL_MS = 6000

export type LiveEventSignal = {
  /**
   * True once the observed phase is SETTLED (a fecha is live, or we know none
   * is). While loading/error we hold `false` so the initial data arriving is
   * never mistaken for a transition (opening the app onto an already-live fecha
   * must not chime).
   */
  settled: boolean
  /** The observed live fecha, or null when none is live. */
  tournament: {
    id: string
    name: string
    currentLevel: number
    smallBlind: number
    bigBlind: number
    /** Remaining seconds on the current level — the state-based clock value. */
    remaining: number
  } | null
  /** Players who busted (status 'eliminated'): entryId → display name. Winners /
   *  co-champions are excluded — a champion reaching a final position is not a
   *  "quedó fuera" event. New keys across observations => new eliminations. */
  out: Record<string, string>
}

export type LiveToast = { id: number; message: string }

export type NotifyPermission = 'default' | 'granted' | 'denied' | 'unsupported'

type PrevState = {
  liveId: string | null
  level: number | null
  outIds: Set<string>
}

function getPermission(): NotifyPermission {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

/** Emit a LOCAL notification, but only when the user has granted permission.
 *  Wrapped in try/catch: the constructor throws in some browser / PWA states
 *  (and is absent under jsdom), and a cue must never blow up an event handler. */
function emitLocalNotification(title: string, body: string): void {
  try {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    // eslint-disable-next-line no-new
    new Notification(title, { body })
  } catch {
    /* notifications unavailable / blocked — the in-app toast already covers it */
  }
}

export type UseLiveEventCues = {
  /** The current in-app toast to render (null when none). */
  toast: LiveToast | null
  dismissToast: () => void
  /** Notification permission — drives whether to show the "activar" affordance. */
  permission: NotifyPermission
  /** Request Notification permission (also unlocks audio via the user gesture). */
  requestNotifications: () => Promise<void>
}

export function useLiveEventCues(signal: LiveEventSignal): UseLiveEventCues {
  const [toast, setToast] = useState<LiveToast | null>(null)
  const [permission, setPermission] = useState<NotifyPermission>(() => getPermission())

  const seq = useRef(0)
  const prev = useRef<PrevState | null>(null)
  // The level a warning has already fired for → blocks re-firing that level.
  const warnedLevel = useRef<number | null>(null)
  // Last observed remaining (per level) → detect a genuine downward crossing.
  const prevRemaining = useRef<{ level: number; remaining: number } | null>(null)

  const pushToast = useCallback((message: string) => {
    seq.current += 1
    setToast({ id: seq.current, message })
  }, [])

  const fire = useCallback(
    (cue: SoundCue, message: string, notify?: { title: string; body: string }) => {
      playCue(cue)
      pushToast(message)
      if (notify) emitLocalNotification(notify.title, notify.body)
    },
    [pushToast],
  )

  // Auto-dismiss the toast (only if it's still the same one).
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(
      () => setToast((cur) => (cur && cur.id === toast.id ? null : cur)),
      TOAST_TTL_MS,
    )
    return () => clearTimeout(id)
  }, [toast])

  useEffect(() => {
    // Ignore unsettled phases entirely — no seeding, no firing.
    if (!signal.settled) return
    const { tournament, out } = signal
    const outIds = new Set(Object.keys(out))

    // First SETTLED observation → seed refs and fire nothing (this is the
    // baseline snapshot, not a transition).
    if (prev.current === null) {
      prev.current = {
        liveId: tournament?.id ?? null,
        level: tournament?.currentLevel ?? null,
        outIds,
      }
      prevRemaining.current = tournament
        ? { level: tournament.currentLevel, remaining: tournament.remaining }
        : null
      return
    }

    const p = prev.current

    if (tournament) {
      if (p.liveId !== tournament.id) {
        // A fecha just went live (none before, or a different one) → opened.
        fire('tournamentStart', '¡Fecha abierta! Ya podés hacer check-in.', {
          title: tournament.name,
          body: '¡Fecha abierta! Ya podés hacer check-in.',
        })
        warnedLevel.current = null
      } else {
        // Same fecha: level advanced (current_level strictly increased).
        if (p.level != null && tournament.currentLevel > p.level) {
          const msg = `Nivel ${tournament.currentLevel} — ciegas ${tournament.smallBlind}/${tournament.bigBlind}`
          fire('levelChange', msg, { title: 'Subieron las ciegas', body: msg })
        }

        // Elimination(s): entry ids newly present in the OUT set.
        const newlyOut = [...outIds].filter((id) => !p.outIds.has(id))
        if (newlyOut.length > 0) {
          const names = newlyOut.map((id) => out[id] ?? 'Jugador')
          const msg =
            names.length === 1
              ? `${names[0]} quedó fuera`
              : `${names.length} jugadores quedaron fuera`
          fire('elimination', msg)
        }

        // Final-seconds warning: fire ONCE per level on the downward crossing of
        // the threshold. Derived from the state-based clock, never a tick loop.
        const pr = prevRemaining.current
        const crossed =
          pr != null &&
          pr.level === tournament.currentLevel &&
          pr.remaining > WARNING_THRESHOLD_SECONDS &&
          tournament.remaining <= WARNING_THRESHOLD_SECONDS
        if (crossed && tournament.remaining > 0 && warnedLevel.current !== tournament.currentLevel) {
          playCue('levelWarning')
          warnedLevel.current = tournament.currentLevel
        }
      }

      prevRemaining.current = { level: tournament.currentLevel, remaining: tournament.remaining }
    } else {
      prevRemaining.current = null
    }

    prev.current = {
      liveId: tournament?.id ?? null,
      level: tournament?.currentLevel ?? null,
      outIds,
    }
  }, [signal, fire])

  const requestNotifications = useCallback(async () => {
    // The tap is a user gesture — unlock audio while we have it.
    resumeAudio()
    if (typeof Notification === 'undefined') {
      setPermission('unsupported')
      return
    }
    try {
      const result = await Notification.requestPermission()
      setPermission(result)
    } catch {
      setPermission(getPermission())
    }
  }, [])

  const dismissToast = useCallback(() => setToast(null), [])

  return { toast, dismissToast, permission, requestNotifications }
}
