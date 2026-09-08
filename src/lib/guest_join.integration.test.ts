import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// ---------------------------------------------------------------------------
// mig 0035 — guest self-join, integration against the local Supabase stack.
// guest_join is ANON-callable: a newcomer with the fecha link signs up as a
// guest (is_guest = true, confirmed entry) — only on a fecha the admin opened
// to guests. A member email gets 'member' (nothing created). promote_guest is
// admin-gated. Same isolation idiom as the other DB suites: throwaway archived
// season (year 2097) tagged per RUN; serial file execution; service-role for
// fixtures, real anon / signed-in clients for the calls under test.
// ---------------------------------------------------------------------------
const url = import.meta.env.VITE_SUPABASE_URL
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const canRun = Boolean(url && serviceKey && anonKey)

describe.skipIf(!canRun)('guest_join / promote_guest (0035, local integration)', () => {
  const admin: SupabaseClient<Database> = createClient<Database>(url, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const anon: SupabaseClient<Database> = createClient<Database>(url, anonKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const RUN = crypto.randomUUID().slice(0, 8)
  const guestEmail = `guest-${RUN}@example.com`
  const memberEmail = `member-${RUN}@example.com`
  let seasonId: string
  let openId: string
  let closedId: string
  let memberId: string

  beforeAll(async () => {
    const s = await admin
      .from('season')
      .insert({ name: `GUEST ${RUN}`, year: 2097, status: 'archived' })
      .select('id')
      .single()
    if (s.error) throw s.error
    seasonId = s.data.id
    const mk = async (guestsOpen: boolean) => {
      const { data, error } = await admin
        .from('tournament')
        .insert({
          season_id: seasonId,
          name: `GUEST ${RUN} ${guestsOpen ? 'open' : 'closed'}`,
          scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
          status: 'scheduled',
          guests_open: guestsOpen,
        })
        .select('id')
        .single()
      if (error) throw error
      return data.id as string
    }
    openId = await mk(true)
    closedId = await mk(false)
    const m = await admin
      .from('player')
      .insert({ name: `Member ${RUN}`, email: memberEmail })
      .select('id')
      .single()
    if (m.error) throw m.error
    memberId = m.data.id
  })

  afterAll(async () => {
    await admin.from('player').delete().in('email', [guestEmail, memberEmail])
    await admin.from('tournament').delete().in('id', [openId, closedId])
    await admin.from('season').delete().eq('id', seasonId)
  })

  it('anon: joins an open fecha → guest player (is_guest) + confirmed entry; repeat is idempotent', async () => {
    const first = await anon.rpc('guest_join', {
      p_email: guestEmail.toUpperCase(),
      p_name: '  Primo Pepe ',
      p_tournament_id: openId,
    })
    expect(first.error).toBeNull()
    expect(first.data).toBe('guest')

    const p = await admin
      .from('player')
      .select('id, name, email, is_guest')
      .eq('email', guestEmail)
      .single()
    expect(p.error).toBeNull()
    expect(p.data).toMatchObject({ name: 'Primo Pepe', email: guestEmail, is_guest: true })

    const e = await admin
      .from('entry')
      .select('status')
      .eq('tournament_id', openId)
      .eq('player_id', p.data!.id)
    expect(e.data).toEqual([{ status: 'confirmed' }])

    const again = await anon.rpc('guest_join', {
      p_email: guestEmail,
      p_name: 'Primo Pepe',
      p_tournament_id: openId,
    })
    expect(again.data).toBe('guest')
    const players = await admin.from('player').select('id').eq('email', guestEmail)
    expect(players.data).toHaveLength(1)
  })

  it('anon: a known member email returns member and creates nothing', async () => {
    const r = await anon.rpc('guest_join', {
      p_email: memberEmail,
      p_name: 'Whatever',
      p_tournament_id: openId,
    })
    expect(r.error).toBeNull()
    expect(r.data).toBe('member')
    const e = await admin.from('entry').select('id').eq('player_id', memberId)
    expect(e.data).toHaveLength(0)
  })

  it('anon: a fecha closed to guests, a bad email or an empty name are rejected', async () => {
    const closed = await anon.rpc('guest_join', {
      p_email: `other-${RUN}@example.com`,
      p_name: 'X',
      p_tournament_id: closedId,
    })
    expect(closed.error?.message).toMatch(/no acepta invitados/)
    const badEmail = await anon.rpc('guest_join', {
      p_email: 'not-an-email',
      p_name: 'X',
      p_tournament_id: openId,
    })
    expect(badEmail.error?.message).toMatch(/correo inválido/)
    const noName = await anon.rpc('guest_join', {
      p_email: `other-${RUN}@example.com`,
      p_name: '   ',
      p_tournament_id: openId,
    })
    expect(noName.error?.message).toMatch(/nombre/)
  })

  it('fecha_preview exposes guests_open (true only for an open, live/scheduled fecha)', async () => {
    const open = await anon.rpc('fecha_preview', { p_id: openId })
    expect((open.data as Array<{ guests_open: boolean }>)[0]?.guests_open).toBe(true)
    const closed = await anon.rpc('fecha_preview', { p_id: closedId })
    expect((closed.data as Array<{ guests_open: boolean }>)[0]?.guests_open).toBe(false)
  })

  it('promote_guest: anon is rejected; service role flips the guest into a member', async () => {
    const p = await admin.from('player').select('id').eq('email', guestEmail).single()
    const denied = await anon.rpc('promote_guest', { p_player_id: p.data!.id })
    expect(denied.error).not.toBeNull()

    const ok = await admin.rpc('promote_guest', { p_player_id: p.data!.id })
    expect(ok.error).toBeNull()
    const after = await admin.from('player').select('is_guest').eq('id', p.data!.id).single()
    expect(after.data?.is_guest).toBe(false)

    // Not a guest any more → a second promotion is an error, not a silent no-op.
    const twice = await admin.rpc('promote_guest', { p_player_id: p.data!.id })
    expect(twice.error?.message).toMatch(/no es un invitado/)
  })
})
