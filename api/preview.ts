// ---------------------------------------------------------------------------
// GET /api/preview?id=<fecha uuid> — Open Graph HTML for chat-app crawlers.
//
// vercel.json rewrites /fechas/:id here ONLY when the User-Agent looks like a
// link-preview bot (WhatsApp, Facebook, Telegram, iMessage…); real visitors keep
// getting the SPA. Data comes from the anon-callable `fecha_preview` RPC
// (mig 0033) using the same publishable key the app ships with — no
// service-role key on Vercel. Anything unexpected falls back to the generic
// Poker Friends card so a preview always renders.
// ---------------------------------------------------------------------------
import { previewHtml, previewMeta, type FechaPreviewRow } from '../src/lib/preview'

type Req = {
  query?: Record<string, string | string[] | undefined>
  headers: Record<string, string | string[] | undefined>
}
type Res = {
  setHeader(name: string, value: string): void
  status(code: number): Res
  send(body: string): void
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FALLBACK_ORIGIN = 'https://poker-friends-xi.vercel.app'

async function fetchRow(id: string): Promise<FechaPreviewRow | null> {
  const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY
  if (!url || !key) return null
  try {
    const r = await fetch(`${url}/rest/v1/rpc/fecha_preview`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_id: id }),
      signal: AbortSignal.timeout(4000),
    })
    if (!r.ok) return null
    const rows = (await r.json()) as FechaPreviewRow[]
    return rows[0] ?? null
  } catch {
    return null
  }
}

export default async function handler(req: Req, res: Res): Promise<void> {
  const raw = req.query?.id
  const id = (Array.isArray(raw) ? raw[0] : raw) ?? ''
  const host = req.headers['x-forwarded-host'] ?? req.headers.host
  const origin = typeof host === 'string' && host ? `https://${host}` : FALLBACK_ORIGIN
  const row = UUID_RE.test(id) ? await fetchRow(id) : null
  const pageUrl = UUID_RE.test(id) ? `${origin}/fechas/${id}` : `${origin}/`
  const meta = previewMeta(row, pageUrl, `${origin}/og/fecha-card.png`)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  // Short cache: the confirmed count changes as people RSVP.
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120')
  res.status(200).send(previewHtml(meta))
}
