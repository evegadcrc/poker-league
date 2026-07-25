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
