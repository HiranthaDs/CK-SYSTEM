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
      // The session intentionally lives in memory only. Reloading the page requires
      // a new sign-in, but no refresh token is written to browser storage.
      persistSession: false,
    },
    global: { fetch: noStoreFetch },
  },
)
