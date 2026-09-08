// ---------------------------------------------------------------------------
// PWA install helpers shared by the install banner (InstallPrompt), the
// step-by-step tour (InstallTour) and Perfil. Pure functions over the browser
// environment, parameterised for tests.
// ---------------------------------------------------------------------------

/**
 * The `beforeinstallprompt` event (Chromium/Android). Not in lib.dom, so declare
 * the shape we use: capture it, `preventDefault()`, and later call `.prompt()`.
 */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

/** iOS Safari exposes the legacy standalone flag on navigator. */
type IosNavigator = Navigator & { standalone?: boolean }

/** Running as an installed PWA (Android/desktop display-mode, or iOS standalone). */
export function isStandalone(): boolean {
  try {
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches
    ) {
      return true
    }
    return (navigator as IosNavigator).standalone === true
  } catch {
    return false
  }
}

export type InstallPlatform = 'ios-safari' | 'ios-other' | 'android' | 'desktop'

/** Which install story applies. iPadOS Safari reports a desktop UA but has touch. */
export function installPlatform(
  ua: string = navigator.userAgent,
  nav: { platform?: string; maxTouchPoints?: number } = navigator,
): InstallPlatform {
  const ios =
    /iphone|ipad|ipod/i.test(ua) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1)
  if (ios) {
    // Chrome (CriOS), Firefox (FxiOS), Edge (EdgiOS) etc. on iOS also match
    // "Safari" in their UA but can't add to the home screen — only Safari can.
    const safari = /safari/i.test(ua) && !/crios|fxios|edgios|opios|mercury/i.test(ua)
    return safari ? 'ios-safari' : 'ios-other'
  }
  if (/android/i.test(ua)) return 'android'
  return 'desktop'
}

export function isMobilePlatform(p: InstallPlatform): boolean {
  return p !== 'desktop'
}

// --- tour bookkeeping -------------------------------------------------------
// 'seen' → auto-opened once; 'done' → the user tapped "Listo" (never auto-open
// again; the banner also goes away).
export const TOUR_KEY = 'pf-install-tour'
export type TourStatus = 'none' | 'seen' | 'done'

export function tourStatus(): TourStatus {
  try {
    const v = localStorage.getItem(TOUR_KEY)
    return v === 'seen' || v === 'done' ? v : 'none'
  } catch {
    return 'none'
  }
}

export function markTour(status: Exclude<TourStatus, 'none'>): void {
  try {
    localStorage.setItem(TOUR_KEY, status)
  } catch {
    // storage unavailable — the tour may show again next load; harmless.
  }
}
