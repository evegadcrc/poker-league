import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'Missing Supabase env vars. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY ' +
      '(copy .env.example to .env and fill from `supabase status`).',
  )
}

/**
 * Typed Supabase browser client. Reads the local/hosted project URL + anon
 * (publishable) key from Vite env. The `Database` generic wires the generated
 * schema types into every `.from()` / `.rpc()` call.
 */
export const supabase = createClient<Database>(url, anonKey)
