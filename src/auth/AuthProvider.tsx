import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { setActiveCompanyId } from '../lib/api'
import { PasswordUpdatedSignInError } from './errors'

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
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    })
    if (error) throw error
    if (!data.session) throw new Error('Sign-in succeeded without creating a session. Please try again.')
    setRecovery(false)
  }, [])

  const signOut = useCallback(async () => {
    // Do not use Supabase's default global scope here: it revokes the user's
    // refresh tokens on every browser and device.
    const { error } = await supabase.auth.signOut({ scope: 'local' })
    if (error) throw error
  }, [])

  const requestPasswordReset = useCallback(async (email: string, redirectPath = '/login') => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
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
    // Validate the recovery/change-password session with Auth before changing
    // credentials, and retain the canonical email for the verification login.
    const { data: identityData, error: identityError } = await supabase.auth.getUser()
    if (identityError) throw identityError
    const identity = identityData.user
    const email = identity?.email?.trim().toLowerCase()
    if (!identity || !email) throw new Error('A verified email account is required to change this password.')

    const attributes = otp
      ? { password, nonce: otp.trim() }
      : { password }
    const { data, error } = await supabase.auth.updateUser(attributes)
    if (error) throw error
    if (!data.user || data.user.id !== identity.id) {
      throw new Error('Supabase did not confirm the password update for this account.')
    }

    // Prove that the saved password can immediately create a fresh, ordinary
    // sign-in session. This also replaces the temporary recovery session.
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    if (signInError || !signInData.session) {
      // The password has already changed. End the temporary recovery session
      // so the user gets a clean manual sign-in screen with accurate guidance.
      const { error: cleanupError } = await supabase.auth.signOut({ scope: 'local' })
      setRecovery(false)
      throw new PasswordUpdatedSignInError(email, signInError ?? cleanupError)
    }
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
