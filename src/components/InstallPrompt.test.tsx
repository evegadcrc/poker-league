import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
// Inject App.css so the .install-prompt layout is computable in jsdom.
import '@/App.css'
import InstallPrompt from './InstallPrompt'

const DISMISS_KEY = 'pf-install-dismissed'

// Real device UAs: Chrome on Android (installable via beforeinstallprompt) and
// Safari on iPhone (add-to-home-screen only, no programmatic install).
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const IOS_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

function setStandalone(standalone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('standalone') ? standalone : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ua })
}

/** A stand-in for the browser's beforeinstallprompt event with a spied prompt(). */
function makeBeforeInstallPromptEvent() {
  const event = new Event('beforeinstallprompt') as Event & {
    prompt: ReturnType<typeof vi.fn>
    userChoice: Promise<{ outcome: string; platform: string }>
  }
  event.prompt = vi.fn().mockResolvedValue(undefined)
  event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' })
  return event
}

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: undefined })
  setStandalone(false)
  setUserAgent(ANDROID_UA)
})

describe('InstallPrompt', () => {
  it('renders nothing when the app is running standalone (already installed)', () => {
    setStandalone(true)
    const { container } = render(<InstallPrompt />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the Instalar button on Android after beforeinstallprompt and prompts on click', async () => {
    setUserAgent(ANDROID_UA)
    render(<InstallPrompt />)
    // Nothing surfaced until the browser fires the installability event.
    expect(screen.queryByRole('button', { name: 'Instalar' })).toBeNull()

    const event = makeBeforeInstallPromptEvent()
    act(() => {
      window.dispatchEvent(event)
    })

    const button = await screen.findByRole('button', { name: 'Instalar' })
    expect(button).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(button)
    })
    expect(event.prompt).toHaveBeenCalledTimes(1)
  })

  it('shows add-to-home instructions on iOS Safari and no Instalar button', () => {
    setUserAgent(IOS_SAFARI_UA)
    render(<InstallPrompt />)
    const banner = screen.getByRole('dialog', { name: 'Instalar Poker Friends' })
    expect(within(banner).getByText(/Compartir/i)).toBeInTheDocument()
    expect(within(banner).getByText(/Añadir a pantalla de inicio/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Instalar' })).toBeNull()
    expect(within(banner).getByRole('button', { name: 'Cómo instalar' })).toBeInTheDocument()
  })

  it('dismiss (✕) hides the prompt and remembers it in localStorage', async () => {
    setUserAgent(IOS_SAFARI_UA)
    const { container } = render(<InstallPrompt />)
    const close = screen.getByRole('button', { name: 'Cerrar' })

    await act(async () => {
      fireEvent.click(close)
    })

    expect(container).toBeEmptyDOMElement()
    expect(localStorage.getItem(DISMISS_KEY)).toBe('1')
  })

  it('renders nothing on a later mount when previously dismissed', () => {
    localStorage.setItem(DISMISS_KEY, '1')
    setUserAgent(IOS_SAFARI_UA)
    const { container } = render(<InstallPrompt />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('InstallPrompt — install tour', () => {
  it('auto-opens the tour once on a phone that is not installed, and remembers it', () => {
    setUserAgent(IOS_SAFARI_UA)
    const first = render(<InstallPrompt />)
    expect(screen.getByTestId('install-tour')).toHaveAttribute('data-platform', 'ios-safari')
    expect(localStorage.getItem('pf-install-tour')).toBe('seen')
    first.unmount()

    render(<InstallPrompt />)
    expect(screen.queryByTestId('install-tour')).toBeNull()
  })

  it('does not auto-open on desktop', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/120 Safari/537.36')
    render(<InstallPrompt />)
    expect(screen.queryByTestId('install-tour')).toBeNull()
  })

  it('"Listo" marks the tour done; "Cómo instalar" reopens it', async () => {
    setUserAgent(IOS_SAFARI_UA)
    render(<InstallPrompt />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Listo' }))
    })
    expect(screen.queryByTestId('install-tour')).toBeNull()
    expect(localStorage.getItem('pf-install-tour')).toBe('done')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cómo instalar' }))
    })
    expect(screen.getByTestId('install-tour')).toBeInTheDocument()
  })

  it('dismissing the banner (✕) also closes the tour', async () => {
    setUserAgent(IOS_SAFARI_UA)
    const { container } = render(<InstallPrompt />)
    expect(screen.getByTestId('install-tour')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    })
    expect(container).toBeEmptyDOMElement()
  })
})
