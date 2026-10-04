import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

export const configurationError =
  !supabaseUrl || !publishableKey
    ? 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.'
    : null

const noStoreFetch: typeof fetch = (input, init) => fetch(input, {
  ...init,
  cache: 'no-store',
})

export const supabase = createClient(
  supabaseUrl || 'https://invalid.localhost',
  publishableKey || 'missing-publishable-key',
  {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // A browser-local session survives refreshes and mobile tab suspension. Each
      // device receives its own refresh token and can be signed out independently.
      persistSession: true,
      storageKey: 'ck-sys-v3-auth',
    },
    global: { fetch: noStoreFetch },
  },
)
