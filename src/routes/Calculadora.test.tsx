import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// Controllable fake worker: postMessage synchronously (next microtask) delivers
// a fixed EquityResult back through the component-assigned onmessage handler, so
// the test never spins a real Worker (jsdom has none) yet still exercises the
// full request → reply → DOM plumbing.
const wh = vi.hoisted(() => ({
  result: { win: 0.82, tie: 0.02, lose: 0.16 } as { win: number; tie: number; lose: number },
  lastReq: null as unknown,
}))

vi.mock('@/lib/equityWorker', () => {
  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null
    postMessage(req: unknown) {
      wh.lastReq = req
      queueMicrotask(() => this.onmessage?.({ data: wh.result }))
    }
    terminate() {}
  }
  return { createEquityWorker: () => new FakeWorker() }
})

// AppLayout needs a role.
vi.mock('@/lib/auth', () => ({ useRole: () => ({ isAdmin: false }) }))

// The calc gate queries a LIVE fecha with odds_enabled=false on mount. Hoisted
// state lets a test pick the response: a row → the calculator is disabled; null
// (default) → it renders normally.
const sb = vi.hoisted(() => ({
  gate: { data: null as unknown, error: null as unknown },
}))
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        limit: () => b,
        maybeSingle: () => Promise.resolve(sb.gate),
      }
      return b
    },
  },
}))

import Calculadora from './Calculadora'
import AppLayout from '@/components/AppLayout'
import { ThemeProvider } from '@/lib/theme'

beforeEach(() => {
  wh.result = { win: 0.82, tie: 0.02, lose: 0.16 }
  wh.lastReq = null
  sb.gate = { data: null, error: null }
})

describe('Calculadora', () => {
  it('computes and plumbs the (mocked) worker win/tie/lose into the DOM', async () => {
    const u = userEvent.setup()
    render(<Calculadora />)

    // Fill 2 hole cards + a flop (3), leaving the default 1 rival.
    await u.click(screen.getByRole('button', { name: 'A de picas' }))
    await u.click(screen.getByRole('button', { name: 'K de picas' }))
    await u.click(screen.getByRole('button', { name: 'Q de corazones' }))
    await u.click(screen.getByRole('button', { name: 'J de corazones' }))
    await u.click(screen.getByRole('button', { name: '10 de corazones' }))

    expect(await screen.findByTestId('win-pct')).toHaveTextContent('82%')
    expect(screen.getByTestId('tie-pct')).toHaveTextContent('2%')
    expect(screen.getByTestId('lose-pct')).toHaveTextContent('16%')

    // The request the UI sent the worker carries the picked cards + rival count.
    expect(wh.lastReq).toMatchObject({
      hole: ['As', 'Ks'],
      board: ['Qh', 'Jh', 'Th'],
      opponents: 1,
    })
  })

  it('disables a used card, frees it when cleared, and tracks cartas restantes', async () => {
    const u = userEvent.setup()
    render(<Calculadora />)

    expect(screen.getByTestId('restantes')).toHaveTextContent('52')

    await u.click(screen.getByRole('button', { name: 'A de picas' }))
    // The picker cell for that exact card is now disabled (no duplicates).
    expect(screen.getByRole('button', { name: 'A de picas' })).toBeDisabled()
    expect(screen.getByTestId('restantes')).toHaveTextContent('51')

    // Clearing the slot it filled (first empty = hole card 1) frees the card.
    await u.click(screen.getByTestId('slot-hole-0'))
    expect(screen.getByRole('button', { name: 'A de picas' })).not.toBeDisabled()
    expect(screen.getByTestId('restantes')).toHaveTextContent('52')
  })

  it('renders under AppLayout and is reachable from the header nav entry', async () => {
    const u = userEvent.setup()
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/perfil']}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/perfil" element={<div data-testid="perfil-stub">perfil</div>} />
              <Route path="/calculadora" element={<Calculadora />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    )

    expect(screen.getByTestId('perfil-stub')).toBeInTheDocument()
    await u.click(screen.getByRole('link', { name: 'Calculadora de probabilidades' }))
    expect(await screen.findByTestId('calc-root')).toBeInTheDocument()
  })

  it('lets the rivals stepper climb to 10 and clamps there', async () => {
    const u = userEvent.setup()
    render(<Calculadora />)

    const mas = screen.getByRole('button', { name: 'Más rivales' })
    const menos = screen.getByRole('button', { name: 'Menos rivales' })

    // Default is 1 → "Menos" disabled at the floor.
    expect(screen.getByTestId('rivals-n')).toHaveTextContent('1')
    expect(menos).toBeDisabled()

    // Click up to the ceiling (11 clicks would overshoot; 9 lands on 10).
    for (let i = 0; i < 9; i++) await u.click(mas)
    expect(screen.getByTestId('rivals-n')).toHaveTextContent('10')

    // At the ceiling "Más" is disabled and a further click can't exceed 10.
    expect(mas).toBeDisabled()
    await u.click(mas)
    expect(screen.getByTestId('rivals-n')).toHaveTextContent('10')
  })

  it('shows the hand-rankings reference behind a "Ranking de manos" toggle', async () => {
    const u = userEvent.setup()
    render(<Calculadora />)

    const toggle = screen.getByTestId('rankings-toggle')
    // Collapsed by default: the ranking rows are not rendered yet.
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryAllByTestId('hr-row')).toHaveLength(0)

    await u.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByTestId('hr-row')).toHaveLength(10)
    expect(screen.getByText('Escalera Real')).toBeInTheDocument()
  })

  it('renders the calculator when no live fecha disables it', async () => {
    render(<Calculadora />)
    // The gate check resolves to "enabled" (no disabling live fecha) → the full
    // calculator (with the Limpiar action + card picker) stays, no disabled note.
    await waitFor(() => expect(screen.getByTestId('calc-reset')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'A de picas' })).toBeInTheDocument()
    expect(screen.queryByTestId('calc-disabled')).not.toBeInTheDocument()
  })

  it('shows the disabled message when a live fecha has odds_enabled=false', async () => {
    sb.gate = { data: { id: 't-live' }, error: null }
    render(<Calculadora />)
    expect(await screen.findByTestId('calc-disabled')).toHaveTextContent(
      'La calculadora está deshabilitada durante la fecha en curso.',
    )
    // The interactive calculator (Limpiar / card picker) is gone …
    expect(screen.queryByTestId('calc-reset')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'A de picas' })).not.toBeInTheDocument()
    // … but the hand-rankings reference stays available.
    expect(screen.getByTestId('rankings-toggle')).toBeInTheDocument()
  })
})
