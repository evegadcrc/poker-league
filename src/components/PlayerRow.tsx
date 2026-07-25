import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { Database } from '@/lib/database.types'
import Avatar from './Avatar'
import FormPills from './FormPills'
import AvatarLightbox from './AvatarLightbox'
import PlayerStatsSheet from './PlayerStatsSheet'

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
 *
 * Two tap targets: the avatar opens a full-screen photo lightbox, the rest of
 * the row opens a season-stats popup. The avatar is a nested `<button>` whose
 * click/keydown `stopPropagation` so it never also triggers the row's popup;
 * the row itself is a `role="button"` (Enter/Space) for keyboard parity.
 */
export default function PlayerRow({ row, rank, isCurrent }: PlayerRowProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)

  return (
    <>
      <div
        className={cn('lb-row', isCurrent && 'you')}
        data-testid="lb-row"
        aria-current={isCurrent ? 'true' : undefined}
        role="button"
        tabIndex={0}
        aria-label={`Ver perfil de ${row.player_name}`}
        onClick={() => setStatsOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setStatsOpen(true)
          }
        }}
      >
        <div className={cn('rank', rank === 1 && 'top1')}>{rank}</div>
        <div className="who">
          <button
            type="button"
            className="avatar-btn"
            aria-label={`Ver foto de ${row.player_name}`}
            onClick={(e) => {
              // Keep the row's stats popup from also firing.
              e.stopPropagation()
              setLightboxOpen(true)
            }}
            onKeyDown={(e) => {
              // The button activates on Enter/Space natively; stop the keydown so
              // the row's Enter/Space handler doesn't ALSO open the stats popup.
              if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
            }}
          >
            <Avatar name={row.player_name} url={row.avatar_url} size={40} />
          </button>
          <div className="name">
            <b>
              {row.player_name}
              {isCurrent ? ' · tú' : ''}
            </b>
            <FormPills form={row.form} positions={row.form_positions} />
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

      {lightboxOpen && (
        <AvatarLightbox
          name={row.player_name}
          url={row.avatar_url}
          onClose={() => setLightboxOpen(false)}
        />
      )}

      {statsOpen && (
        <PlayerStatsSheet
          playerId={row.player_id}
          playerName={row.player_name}
          form={row.form}
          formPositions={row.form_positions}
          onClose={() => setStatsOpen(false)}
        />
      )}
    </>
  )
}
