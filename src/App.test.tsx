import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { ThemeProvider } from './lib/theme'

function renderApp() {
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  )
}

describe('App shell', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('renders the POKER FRIENDS wordmark', () => {
    renderApp()
    // Exact, case-sensitive match hits only the header wordmark (the h1 is
    // "Poker Friends" and the logo carries an aria-label, not text content).
    expect(screen.getByText('POKER FRIENDS')).toBeInTheDocument()
  })

  it('cycles the theme light → dark → neon → light and persists it', async () => {
    const user = userEvent.setup()
    renderApp()

    // Default theme (no stored value, no matchMedia in jsdom) is light.
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    const button = screen.getByRole('button', { name: /tema/i })

    await user.click(button)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('pf-theme')).toBe('dark')

    await user.click(button)
    expect(document.documentElement.getAttribute('data-theme')).toBe('neon')

    await user.click(button)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem('pf-theme')).toBe('light')
  })
})
