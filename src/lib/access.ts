import { supabase } from '@/lib/supabase'

// ---------------------------------------------------------------------------
// Access-request + admin-approval flow (migration 0022). Thin wrappers over the
// signup_request RPCs so the Login / Admin screens stay declarative and the same
// supabase mock the routes' tests install intercepts every call.
//
//   • request_access  — ANON-callable membership gate for first-time logins.
//   • fetchPendingRequests / approveRequest / rejectRequest — the admin queue.
//   • sendApprovalLink — dispatches the magic link AFTER an approval (the RPC
//     returns the email; email is never sent from SQL).
// ---------------------------------------------------------------------------

/** request_access outcome: a known member, a queued request, or a rejected email. */
export type AccessResult = 'member' | 'pending' | 'rejected'

/** A pending row in the admin "Solicitudes" queue. */
export type SignupRequest = {
  id: string
  email: string
  name: string | null
  created_at: string
}

/**
 * Gate a first-time login. 'member' → the caller sends the magic link as today;
 * 'pending'/'rejected' → the caller shows the matching message and sends NO link.
 */
export async function requestAccess(
  email: string,
): Promise<{ result: AccessResult | null; error: string | null }> {
  const { data, error } = await supabase.rpc('request_access', { p_email: email })
  if (error) return { result: null, error: error.message }
  return { result: (data as AccessResult) ?? null, error: null }
}

/** The pending access requests, oldest first (admin-only via RLS). */
export async function fetchPendingRequests(): Promise<{
  data: SignupRequest[]
  error: string | null
}> {
  const { data, error } = await supabase
    .from('signup_request')
    .select('id, email, name, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as SignupRequest[], error: null }
}

/**
 * Approve a request → creates the player server-side and returns the approved
 * email so the caller can dispatch the magic link with sendApprovalLink.
 */
export async function approveRequest(
  id: string,
): Promise<{ email: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc('approve_request', { p_id: id })
  if (error) return { email: null, error: error.message }
  return { email: (data as string) ?? null, error: null }
}

/** Reject a request (no player created). */
export async function rejectRequest(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('reject_request', { p_id: id })
  return { error: error?.message ?? null }
}

/** Send the magic link to a freshly-approved member (post-approval). */
export async function sendApprovalLink(email: string): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${window.location.origin}/` },
  })
  return { error: error?.message ?? null }
}

/**
 * Read the active season's auto-approve-signups flag (drives the admin
 * Solicitudes switch). Reads season directly — the "read season" RLS lets an
 * authenticated user SELECT it; only the write goes through set_auto_approve.
 */
export async function fetchAutoApprove(): Promise<{ on: boolean; error: string | null }> {
  const { data, error } = await supabase
    .from('season')
    .select('auto_approve_signups')
    .eq('status', 'active')
    .order('year', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { on: false, error: error.message }
  return {
    on: Boolean((data as { auto_approve_signups?: boolean } | null)?.auto_approve_signups),
    error: null,
  }
}

/** Flip auto-approve on the active season (admin-only via set_auto_approve). */
export async function setAutoApprove(on: boolean): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('set_auto_approve', { p_on: on })
  return { error: error?.message ?? null }
}

// ---------------------------------------------------------------------------
// Guest self-join (mig 0035). The login screen offers "Ingresar como invitado" when
// the visitor arrived through a fecha link whose admin opened it to guests.
// ---------------------------------------------------------------------------
export type GuestJoinResult = 'guest' | 'member'

/** The linked fecha, if it currently accepts guests (anon-callable preview). */
export async function fetchGuestFecha(
  tournamentId: string,
): Promise<{ id: string; name: string } | null> {
  const { data, error } = await supabase.rpc('fecha_preview', { p_id: tournamentId })
  if (error) return null
  const row = (data as Array<{ name: string; guests_open: boolean }> | null)?.[0]
  return row && row.guests_open ? { id: tournamentId, name: row.name } : null
}

/** Sign up as a guest for a fecha (creates the guest player + confirmed entry);
 *  'member' means the email already belongs to a league member. The magic link
 *  is sent by the client afterwards, never from SQL. */
export async function guestJoin(
  email: string,
  name: string,
  tournamentId: string,
): Promise<{ result: GuestJoinResult | null; error: string | null }> {
  const { data, error } = await supabase.rpc('guest_join', {
    p_email: email,
    p_name: name,
    p_tournament_id: tournamentId,
  })
  if (error) return { result: null, error: error.message.replace(/^invitado:\s*/i, '') }
  return { result: (data as GuestJoinResult) ?? null, error: null }
}
