import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type Theme = 'light' | 'dark' | 'neon'

/** Cycle order matches the approved prototype: light → dark → neon → light. */
export const THEMES: readonly Theme[] = ['light', 'dark', 'neon'] as const
const STORAGE_KEY = 'pf-theme'

/** Spanish labels + glyphs, ported from the prototype's theme switcher. */
export const THEME_LABELS: Record<Theme, string> = {
  light: 'Almanaque claro',
  dark: 'Almanaque oscuro',
  neon: 'Neón',
}
export const THEME_ICONS: Record<Theme, string> = {
  light: '☀',
  dark: '☾',
  neon: '⚡',
}

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'neon'
}

function getInitialTheme(): Theme {
  // The inline script in index.html has already resolved + applied the theme
  // pre-paint; prefer that so React hydrates to the same value.
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme')
    if (isTheme(attr)) return attr
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isTheme(stored)) return stored
  } catch {
    /* localStorage may be unavailable */
  }
  if (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)')?.matches
  ) {
    return 'dark'
  }
  return 'light'
}

type ThemeContextValue = {
  theme: Theme
  setTheme: (theme: Theme) => void
  cycleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      /* localStorage may be unavailable */
    }
  }, [theme])

  const setTheme = useCallback((next: Theme) => setThemeState(next), [])
  const cycleTheme = useCallback(() => {
    setThemeState((prev) => THEMES[(THEMES.indexOf(prev) + 1) % THEMES.length])
  }, [])

  const value = useMemo(
    () => ({ theme, setTheme, cycleTheme }),
    [theme, setTheme, cycleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}
