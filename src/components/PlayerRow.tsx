import { cn } from '@/lib/utils'
import type { Database } from '@/lib/database.types'
import Avatar from './Avatar'
import FormPills from './FormPills'

export type LeaderboardRow =
  Database['public']['Functions']['leaderboard']['Returns'][number]

type PlayerRowProps = {
  row: LeaderboardRow
  /** Table position (1-based); the RPC already returns rows in ranked order. */
  rank: number
  /** True when this row is the signed-in player → highlighted + "· tú" suffix. */
  isCurrent: boolean
}

/**
 * One leaderboard row (`.lb-row`): big rank numeral, avatar, name + form pills,
 * and the PJ / Tít / Pts stat columns. The current player's row gets the `.you`
 * highlight (oxblood left rail + tinted background) and a "· tú" suffix.
 */
export default function PlayerRow({ row, rank, isCurrent }: PlayerRowProps) {
  return (
    <div
      className={cn('lb-row', isCurrent && 'you')}
      data-testid="lb-row"
      aria-current={isCurrent ? 'true' : undefined}
    >
      <div className={cn('rank', rank === 1 && 'top1')}>{rank}</div>
      <div className="who">
        <Avatar name={row.player_name} url={row.avatar_url} size={40} />
        <div className="name">
          <b>
            {row.player_name}
            {isCurrent ? ' · tú' : ''}
          </b>
          <FormPills form={row.form} />
        </div>
      </div>
      <div className="lb-stats">
        <div className="stat">
          <span className="v">{row.games_played}</span>
          <span className="k">PJ</span>
        </div>
        <div className="stat">
          <span className="v">{row.wins}</span>
          <span className="k">Tít</span>
        </div>
        <div className="stat pts">
          <span className="v">{row.total_points}</span>
          <span className="k">Pts</span>
        </div>
      </div>
    </div>
  )
}
