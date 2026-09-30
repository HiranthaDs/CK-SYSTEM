import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { setActiveCompanyId } from '../lib/api'

interface AuthContextValue {
  session: Session | null
  loading: boolean
  recovery: boolean
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  requestPasswordReset: (email: string, redirectPath?: string) => Promise<void>
  verifyPasswordResetOtp: (email: string, otp: string) => Promise<void>
  requestPasswordChangeOtp: () => Promise<void>
  updatePassword: (password: string, otp?: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function isPasswordRecoveryUrl() {
  if (typeof window === 'undefined') return false
  const searchType = new URLSearchParams(window.location.search).get('type')
  const hashType = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('type')
  return searchType === 'recovery' || hashType === 'recovery'
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [recovery, setRecovery] = useState(isPasswordRecoveryUrl)

  useEffect(() => {
    let active = true
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return
      if (!error) setSession(data.session)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true)
      if (event === 'SIGNED_OUT') {
        setRecovery(false)
        setActiveCompanyId(null)
      }
      setSession(nextSession)
      setLoading(false)
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    setActiveCompanyId(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }, [])

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
  }, [])

  const requestPasswordReset = useCallback(async (email: string, redirectPath = '/login') => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}${redirectPath}`,
    })
    if (error) throw error
  }, [])

  const verifyPasswordResetOtp = useCallback(async (email: string, otp: string) => {
    const { data, error } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: otp.trim(),
      type: 'recovery',
    })
    if (error) throw error
    if (!data.session) throw new Error('The recovery code did not create a secure session.')
    setRecovery(true)
  }, [])

  const requestPasswordChangeOtp = useCallback(async () => {
    const { error } = await supabase.auth.reauthenticate()
    if (error) throw error
  }, [])

  const updatePassword = useCallback(async (password: string, otp?: string) => {
    const attributes = otp
      ? { password, nonce: otp }
      : { password }
    const { error } = await supabase.auth.updateUser(attributes)
    if (error) throw error
    // End the local session after changing credentials. The next sign-in must
    // prove the newly saved password and cannot rely on a stale browser token.
    const signOutResult = await supabase.auth.signOut({ scope: 'local' })
    if (signOutResult?.error) throw signOutResult.error
    setRecovery(false)
  }, [])

  const value = useMemo(
    () => ({
      session,
      loading,
      recovery,
      signIn,
      signOut,
      requestPasswordReset,
      verifyPasswordResetOtp,
      requestPasswordChangeOtp,
      updatePassword,
    }),
    [
      session,
      loading,
      recovery,
      signIn,
      signOut,
      requestPasswordReset,
      verifyPasswordResetOtp,
      requestPasswordChangeOtp,
      updatePassword,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
