/**
 * Player avatar — renders the uploaded photo (`avatar_url`) when present, else
 * falls back to initials over the paper-3 chip (ported from the prototype's
 * `av()` helper). Font size scales with the requested diameter.
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase()
}

type AvatarProps = {
  name: string
  url?: string | null
  size?: number
}

export default function Avatar({ name, url, size = 40 }: AvatarProps) {
  const dimension = { width: size, height: size, fontSize: Math.round(size * 0.36) }
  if (url) {
    return (
      <div
        className="avatar"
        style={{ ...dimension, backgroundImage: `url(${url})` }}
        role="img"
        aria-label={name}
      />
    )
  }
  return (
    <div className="avatar" style={dimension} aria-hidden="true">
      {initials(name)}
    </div>
  )
}
