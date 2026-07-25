import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// AppLayout needs a role; the Aprende screen itself has no auth/supabase deps.
vi.mock('@/lib/auth', () => ({ useRole: () => ({ isAdmin: false }) }))

import Aprende from './Aprende'
import AppLayout from '@/components/AppLayout'
import { ThemeProvider } from '@/lib/theme'

describe('Aprende', () => {
  it('renders the how-to content plus the reused hand-rankings reference', () => {
    render(<Aprende />)

    expect(screen.getByTestId('aprende-root')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Cómo jugar' })).toBeInTheDocument()
    // Texas Hold'em basics: the four betting rounds, in order.
    const rounds = screen.getByTestId('learn-rounds')
    expect(rounds.textContent).toMatch(/Preflop[\s\S]*Flop[\s\S]*Turn[\s\S]*River/)
    // The hand-rankings component is reused here (all 10 hands).
    expect(screen.getAllByTestId('hr-row')).toHaveLength(10)
    expect(screen.getByText('Escalera Real')).toBeInTheDocument()
    expect(screen.getByText('Carta Alta')).toBeInTheDocument()
  })

  it('renders under AppLayout and is reachable from the header nav entry', async () => {
    const u = userEvent.setup()
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/perfil']}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/perfil" element={<div data-testid="perfil-stub">perfil</div>} />
              <Route path="/aprende" element={<Aprende />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    )

    expect(screen.getByTestId('perfil-stub')).toBeInTheDocument()
    await u.click(screen.getByRole('link', { name: 'Aprende a jugar' }))
    expect(await screen.findByTestId('aprende-root')).toBeInTheDocument()
    expect(screen.getAllByTestId('hr-row')).toHaveLength(10)
  })
})
