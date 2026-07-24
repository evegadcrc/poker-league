import { describe, expect, it } from 'vitest'
import { colonesFull } from './fechas'
import {
  fechaSummaryText,
  seasonSummaryText,
  type FechaSummaryEntry,
  type SeasonStandingRow,
} from './summary'

const ENTRIES: FechaSummaryEntry[] = [
  { name: 'Mauricio A.', status: 'winner', final_position: 1, rebuys_count: 0 },
  { name: 'Andrés R.', status: 'eliminated', final_position: 2, rebuys_count: 1 },
  { name: 'Edwin V.', status: 'eliminated', final_position: 3, rebuys_count: 1 },
  { name: 'Sofía M.', status: 'eliminated', final_position: 4, rebuys_count: 0 },
  { name: 'No-show', status: 'no_show', final_position: null, rebuys_count: 0 },
  { name: 'Declinó', status: 'declined', final_position: null, rebuys_count: 0 },
]

describe('fechaSummaryText', () => {
  it('formats the podium, pot and counts with the POKER FRIENDS header', () => {
    const out = fechaSummaryText({ fechaName: 'Fecha 8 — El Sótano', entries: ENTRIES, pot: 140_000 })
    expect(out).toBe(
      [
        '🃏 POKER FRIENDS · Fecha 8 — El Sótano',
        '',
        '🏆 Campeón: Mauricio A.',
        '🥈 2º: Andrés R.',
        '🥉 3º: Edwin V.',
        '',
        `💰 Pozo: ${colonesFull(140_000)}`,
        '👥 4 jugadores · 2 recompras',
        '',
        '📊 Tabla general → poker-friends.app',
      ].join('\n'),
    )
  })

  it('lists co-champions on one line when the top is chopped', () => {
    const chopped: FechaSummaryEntry[] = [
      { name: 'Ana', status: 'winner', final_position: 1, rebuys_count: 0 },
      { name: 'Beto', status: 'winner', final_position: 1, rebuys_count: 0 },
    ]
    const out = fechaSummaryText({ fechaName: 'Fecha 9', entries: chopped, pot: 100_000 })
    expect(out).toContain('🏆 Campeón: Ana, Beto')
    expect(out).toContain('👥 2 jugadores · 0 recompras')
  })

  it('is defensive mid-game when nobody has a final position yet', () => {
    const live: FechaSummaryEntry[] = [
      { name: 'Ana', status: 'playing', final_position: null, rebuys_count: 0 },
      { name: 'Beto', status: 'playing', final_position: null, rebuys_count: 0 },
    ]
    const out = fechaSummaryText({ fechaName: 'Fecha 9', entries: live, pot: 40_000 })
    expect(out).toContain('🎲 Resultados en juego…')
  })

  it('uses singular for one player / one rebuy', () => {
    const one: FechaSummaryEntry[] = [
      { name: 'Ana', status: 'winner', final_position: 1, rebuys_count: 1 },
    ]
    expect(fechaSummaryText({ fechaName: 'F', entries: one, pot: 0 })).toContain(
      '👥 1 jugador · 1 recompra',
    )
  })
})

describe('seasonSummaryText', () => {
  const ROWS: SeasonStandingRow[] = [
    { player_name: 'Mauricio A.', total_points: 320 },
    { player_name: 'Andrés R.', total_points: 295 },
    { player_name: 'Edwin V.', total_points: 270 },
    { player_name: 'Sofía M.', total_points: 240 },
    { player_name: 'Diego C.', total_points: 210 },
    { player_name: 'Extra', total_points: 100 },
  ]

  it('formats the top 5 with medals + ranks and the header', () => {
    const out = seasonSummaryText({ seasonName: 'Liga 2026', rows: ROWS })
    expect(out).toBe(
      [
        '🃏 POKER FRIENDS · Liga 2026 — Tabla general',
        '',
        '🥇 1º Mauricio A. — 320 pts',
        '🥈 2º Andrés R. — 295 pts',
        '🥉 3º Edwin V. — 270 pts',
        '4º Sofía M. — 240 pts',
        '5º Diego C. — 210 pts',
        '',
        '📊 Mirá la tabla completa → poker-friends.app',
      ].join('\n'),
    )
    // topN defaults to 5 → "Extra" is not included.
    expect(out).not.toContain('Extra')
  })

  it('handles an empty leaderboard', () => {
    const out = seasonSummaryText({ seasonName: 'Liga 2027', rows: [] })
    expect(out).toContain('Aún no hay puntos en la tabla.')
  })
})
