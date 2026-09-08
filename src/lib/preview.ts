// ---------------------------------------------------------------------------
// Link-preview (Open Graph) content for a shared /fechas/:id — PURE helpers
// used by the Vercel function api/preview.ts. Runs on the server (Node), so
// no Vite / browser globals here; dates are rendered in Costa Rica time
// explicitly instead of relying on the machine's zone.
// ---------------------------------------------------------------------------

export type FechaPreviewRow = {
  name: string
  scheduled_at: string
  status: 'scheduled' | 'live' | 'completed'
  cancelled: boolean
  confirmed: number
}

export type PreviewMeta = {
  title: string
  description: string
  url: string
  image: string
  /** Where a human (not a crawler) should end up. */
  redirect: string
}

export const DEFAULT_TITLE = 'Poker Friends'
export const DEFAULT_DESCRIPTION = 'Liga de póker — tabla, fechas, check-in y torneo en vivo.'

const TZ = 'America/Costa_Rica'

/** "Sáb 20 sep · 19:00" in Costa Rica time; "" for an unparseable input. */
export function formatWhenCR(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = new Intl.DateTimeFormat('es-CR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: TZ,
  }).format(d)
  const time = new Intl.DateTimeFormat('es-CR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TZ,
  }).format(d)
  const pretty = day.replace(',', '').replace(/\.$/, '')
  return `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)} · ${time}`
}

function confirmados(n: number): string {
  return `${n} ${n === 1 ? 'confirmado' : 'confirmados'}`
}

/** Title + description for the card. `row` null → the generic app card. */
export function previewMeta(
  row: FechaPreviewRow | null,
  url: string,
  image: string,
  redirect: string = url,
): PreviewMeta {
  if (!row) {
    return { title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION, url, image, redirect }
  }
  const when = formatWhenCR(row.scheduled_at)
  let prefix = ''
  if (row.cancelled) prefix = 'Cancelada · '
  else if (row.status === 'live') prefix = '🔴 En vivo · '
  else if (row.status === 'completed') prefix = 'Jugada · '
  const parts = [when, confirmados(row.confirmed)].filter(Boolean)
  return {
    title: `${row.name} · Poker Friends`,
    description: `${prefix}${parts.join(' · ')}`,
    url,
    image,
    redirect,
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Minimal HTML document carrying the OG/Twitter tags (crawlers never run JS).
 *  A human who somehow lands here is sent on to the app. */
export function previewHtml(meta: PreviewMeta): string {
  const t = escapeHtml(meta.title)
  const d = escapeHtml(meta.description)
  const u = escapeHtml(meta.url)
  const img = escapeHtml(meta.image)
  const r = escapeHtml(meta.redirect)
  return [
    '<!doctype html>',
    '<html lang="es">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Poker Friends">',
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${u}">`,
    `<meta property="og:image" content="${img}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:type" content="image/png">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${img}">`,
    `<meta http-equiv="refresh" content="0; url=${r}">`,
    '</head>',
    `<body><p>${t}</p><p>${d}</p><p><a href="${r}">Abrir en Poker Friends</a></p></body>`,
    '</html>',
  ].join('\n')
}
