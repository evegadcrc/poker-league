import {
  useCallback,
  useEffect,
  useState,
  type DependencyList,
  type Dispatch,
  type SetStateAction,
} from 'react'

/**
 * Reloadable async-data mechanic shared by the route screens. The caller owns
 * the discriminated `state` union; its loading variant is passed as `loading`
 * and `load()` resolves to one of the non-loading variants. Before each run the
 * hook flips `state` back to `loading`; an abort guard drops a resolution whose
 * effect has since been torn down. `reload()` re-runs the fetch, and any change
 * in `deps` re-runs it too. `enabled = false` holds at `loading` without
 * fetching (for when a required id isn't ready yet). `setState` is exposed so a
 * screen can apply an optimistic local patch that the next reload reconciles.
 */
export function useLoadable<T>(
  loading: T,
  load: () => Promise<T>,
  deps: DependencyList = [],
  enabled = true,
): { state: T; setState: Dispatch<SetStateAction<T>>; reload: () => void } {
  const [state, setState] = useState<T>(loading)
  const [attempt, setAttempt] = useState(0)
  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    if (!enabled) return
    let active = true
    setState(loading)
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
