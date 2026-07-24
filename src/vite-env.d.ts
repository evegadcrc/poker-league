/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project API URL, e.g. http://127.0.0.1:55321 (from `supabase status`). */
  readonly VITE_SUPABASE_URL: string
  /** Supabase anon / publishable key (from `supabase status`). */
  readonly VITE_SUPABASE_ANON_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
