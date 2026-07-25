import { supabase } from './supabase'

/** One point of the cumulative points series (from `player_profile`). */
export type HistoryPoint = { scheduled_at: string; points: number; cumulative: number }

/** A player's season profile, normalized from the `player_profile` RPC row. */
export type PlayerProfile = {
  total_points: number
  games_played: number
  wins: number
  podiums: number
  points_history: HistoryPoint[]
  form: string[]
}

/** Discriminated fetch state shared by the Perfil screen and the Tabla popup. */
export type ProfileState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; profile: PlayerProfile }

export const EMPTY_PROFILE: PlayerProfile = {
  total_points: 0,
  games_played: 0,
  wins: 0,
  podiums: 0,
  points_history: [],
  form: [],
}

/**
 * Fetches ANY player's season profile via the `player_profile` RPC (granted to
 * authenticated; takes any player_id). Missing rows resolve to an empty profile
 * (a rostered player with no games) so callers never special-case a null row.
 */
export async function fetchProfile(playerId: string): Promise<ProfileState> {
  const { data, error } = await supabase.rpc('player_profile', { p_player_id: playerId })
  if (error) return { status: 'error' }
  const row = data?.[0]
  if (!row) return { status: 'ready', profile: EMPTY_PROFILE }
  return {
    status: 'ready',
    profile: {
      total_points: row.total_points ?? 0,
      games_played: row.games_played ?? 0,
      wins: row.wins ?? 0,
      podiums: row.podiums ?? 0,
      points_history: (row.points_history as unknown as HistoryPoint[]) ?? [],
      form: row.form ?? [],
    },
  }
}
