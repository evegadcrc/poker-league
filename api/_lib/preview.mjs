// @ts-check
// ---------------------------------------------------------------------------
// Link-preview (Open Graph) content for a shared /fechas/:id — PURE helpers
// used by the Vercel function api/preview.mjs. Plain ESM on purpose: Vercel
// runs .mjs functions directly (no TypeScript compile / import-resolution step
// to go wrong), and `_lib/` is not treated as a function. Dates render in
// Costa Rica time explicitly instead of relying on the server's zone.
// Tested by api/_lib/preview.test.ts.
// ---------------------------------------------------------------------------

/**
 * @typedef {{ name: string, scheduled_at: string, status: 'scheduled'|'live'|'completed',
 *             cancelled: boolean, confirmed: number, cover_url?: string | null }} FechaPreviewRow
 * @typedef {{ title: string, description: string, url: string, image: string,
 *             imageIsCard: boolean, redirect: string }} PreviewMeta
 */

export const DEFAULT_TITLE = 'Poker Friends'
export const DEFAULT_DESCRIPTION = 'Liga de póker — tabla, fechas, check-in y torneo en vivo.'

const TZ = 'America/Costa_Rica'

/** "Sáb 20 sep · 19:00" in Costa Rica time; "" for an unparseable input.
 *  @param {string} iso @returns {string} */
export function formatWhenCR(iso) {
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

/** @param {number} n */
function confirmados(n) {
  return `${n} ${n === 1 ? 'confirmado' : 'confirmados'}`
}

/**
 * Title + description for the card. `row` null → the generic app card. When the
 * fecha has a portada (cover_url, https) it becomes the preview image;
 * `imageIsCard` tells previewHtml whether the fixed 1200×630 PNG dimensions of
 * the branded card apply.
 * @param {FechaPreviewRow | null} row
 * @param {string} url
 * @param {string} image   the default branded card (absolute URL)
 * @param {string} [redirect]
 * @returns {PreviewMeta}
 */
export function previewMeta(row, url, image, redirect = url) {
  if (!row) {
    return {
      title: DEFAULT_TITLE,
      description: DEFAULT_DESCRIPTION,
      url,
      image,
      imageIsCard: true,
      redirect,
    }
  }
  const cover =
    typeof row.cover_url === 'string' && /^https:\/\//.test(row.cover_url) ? row.cover_url : null
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
    image: cover ?? image,
    imageIsCard: cover == null,
    redirect,
  }
}

/** @param {string} s */
export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Minimal HTML document carrying the OG/Twitter tags (crawlers never run JS).
 *  A human who somehow lands here is sent on to the app.
 *  @param {PreviewMeta} meta */
export function previewHtml(meta) {
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
    ...(meta.imageIsCard
      ? [
          '<meta property="og:image:width" content="1200">',
          '<meta property="og:image:height" content="630">',
          '<meta property="og:image:type" content="image/png">',
        ]
      : []),
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
