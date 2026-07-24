import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DependencyList,
  type Dispatch,
  type SetStateAction,
} from 'react'

/** Options for `reload()`. `silent` refetches without flipping to `loading`. */
export type ReloadOptions = { silent?: boolean }

/**
 * Reloadable async-data mechanic shared by the route screens. The caller owns
 * the discriminated `state` union; its loading variant is passed as `loading`
 * and `load()` resolves to one of the non-loading variants. On first mount and
 * on a real `deps` change the hook flips `state` back to `loading`; an abort
 * guard drops a resolution whose effect has since been torn down. `reload()`
 * re-runs the fetch — loud by default (shows `loading`), or `reload({ silent:
 * true })` to refetch in place WITHOUT a skeleton flash, so an optimistic patch
 * applied via `setState` reconciles without flicker. Any change in `deps`
 * re-runs it too (always loud). `enabled = false` holds at `loading` without
 * fetching (for when a required id isn't ready yet).
 */
export function useLoadable<T>(
  loading: T,
  load: () => Promise<T>,
  deps: DependencyList = [],
  enabled = true,
): { state: T; setState: Dispatch<SetStateAction<T>>; reload: (opts?: ReloadOptions) => void } {
  const [state, setState] = useState<T>(loading)
  const [attempt, setAttempt] = useState(0)
  // A silent reload sets this before bumping `attempt`; the effect reads and
  // clears it so only the very next run skips the `loading` flip.
  const silentNext = useRef(false)
  const reload = useCallback((opts?: ReloadOptions) => {
    if (opts?.silent) silentNext.current = true
    setAttempt((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!enabled) return
    let active = true
    const silent = silentNext.current
    silentNext.current = false
    if (!silent) setState(loading)
    void load().then((next) => {
      if (active) setState(next)
    })
    return () => {
      active = false
    }
    // `load`/`loading` are fresh each render by design; re-running is driven by
    // `deps` + `reload`, mirroring the hand-rolled effects this replaces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt, enabled])

  return { state, setState, reload }
}
