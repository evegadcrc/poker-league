import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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

// AppLayout needs a role; the calc screen itself has no auth/supabase deps.
vi.mock('@/lib/auth', () => ({ useRole: () => ({ isAdmin: false }) }))

import Calculadora from './Calculadora'
import AppLayout from '@/components/AppLayout'
import { ThemeProvider } from '@/lib/theme'

beforeEach(() => {
  wh.result = { win: 0.82, tie: 0.02, lose: 0.16 }
  wh.lastReq = null
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
})
