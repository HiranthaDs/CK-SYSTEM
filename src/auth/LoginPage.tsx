import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Building2, Boxes, KeyRound, LockKeyhole, Mail, ShieldCheck } from 'lucide-react'
import { z } from 'zod'
import { useAuth } from './AuthProvider'
import { PasswordUpdatedSignInError } from './errors'
import { Button, Field, Input, LoadingState } from '../components/UI'
import { useToast } from '../components/Toast'
import { companyPath, getCompanyPortal } from '../lib/companyPortal'

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(8, 'Password must contain at least 8 characters.'),
})

const resetSchema = z.object({ email: z.string().email('Enter a valid email address.') })
const otpSchema = z.object({ otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit PIN from your email.') })
const passwordSchema = z.object({
  password: z.string()
    .min(10, 'Use at least 10 characters.')
    .regex(/[a-z]/, 'Include a lowercase letter.')
    .regex(/[A-Z]/, 'Include an uppercase letter.')
    .regex(/[0-9]/, 'Include a number.')
    .regex(/[^A-Za-z0-9]/, 'Include a symbol.'),
  confirm: z.string(),
}).refine((value) => value.password === value.confirm, { message: 'Passwords do not match.', path: ['confirm'] })

type LoginValues = z.infer<typeof loginSchema>
type ResetValues = z.infer<typeof resetSchema>
type OtpValues = z.infer<typeof otpSchema>
type PasswordValues = z.infer<typeof passwordSchema>

export function LoginPage() {
  const auth = useAuth()
  const toast = useToast()
  const location = useLocation()
  const navigate = useNavigate()
  const routeCompanyCode = useParams().companyCode ?? location.pathname.split('/')[1]
  const portal = getCompanyPortal(routeCompanyCode)
  const [mode, setMode] = useState<'login' | 'reset' | 'otp'>(auth.recovery ? 'reset' : 'login')
  const [recoveryEmail, setRecoveryEmail] = useState('')
  const isRecoveryRoute = location.pathname.endsWith('/reset-password')
  const requestedDestination = (location.state as { from?: string } | null)?.from
  const destination = portal && requestedDestination?.startsWith(`/${portal.routeCode}/`)
    ? requestedDestination
    : portal ? companyPath(portal.routeCode, 'dashboard') : '/login'
  const suggestedEmail = (location.state as { email?: string } | null)?.email ?? ''

  const loginForm = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: { email: suggestedEmail, password: '' } })
  const resetForm = useForm<ResetValues>({ resolver: zodResolver(resetSchema), defaultValues: { email: '' } })
  const otpForm = useForm<OtpValues>({ resolver: zodResolver(otpSchema), defaultValues: { otp: '' } })
  const passwordForm = useForm<PasswordValues>({ resolver: zodResolver(passwordSchema), defaultValues: { password: '', confirm: '' } })

  if (!portal && !isRecoveryRoute) {
    return (
      <main className="auth-page">
        <section className="auth-brand" aria-label="CK SYS company portal selection">
          <div className="brand-mark brand-mark--large"><Boxes /></div>
          <span className="eyebrow">CK SYS V3</span>
          <h1>Choose your company portal.</h1>
          <p>CK Plastics and AR Plastics keep separate company data and accounting records. Sign-in succeeds only for a portal assigned by a super administrator.</p>
          <ul className="auth-benefits">
            <li><ShieldCheck /> Company and capability access enforced end to end</li>
            <li><LockKeyhole /> One identity can be assigned to CK, AR, or both</li>
            <li><KeyRound /> Shared stock visibility without direct inventory editing</li>
          </ul>
        </section>
        <section className="auth-panel">
          <div className="auth-card">
            <div className="auth-card__brand"><span className="brand-mark"><Boxes /></span><strong>CK SYS <em>V3</em></strong></div>
            <div className="auth-card__heading"><h2>Select a company</h2><p>You will be sent to that company&apos;s own login URL.</p></div>
            <div className="form-stack">
              <Link className="button button--primary button--medium" to="/ck/login"><Building2 size={18} /> CK Plastics login</Link>
              <Link className="button button--secondary button--medium" to="/ar/login"><Building2 size={18} /> AR Plastics login</Link>
            </div>
          </div>
        </section>
      </main>
    )
  }

  if (!portal) return <Navigate to="/login" replace />
  if (auth.session && !auth.recovery) return <Navigate to={destination} replace />

  const login = loginForm.handleSubmit(async (values) => {
    try {
      await auth.signIn(values.email, values.password)
      toast.success('Welcome back', `Your ${portal.name} session is ready.`)
    } catch (error) {
      toast.error('Sign-in failed', error instanceof Error ? error.message : 'Check your credentials and try again.')
    }
  })

  const requestReset = resetForm.handleSubmit(async (values) => {
    try {
      await auth.requestPasswordReset(values.email, companyPath(portal.routeCode, 'reset-password'))
      setRecoveryEmail(values.email.trim().toLowerCase())
      setMode('otp')
      toast.success('Check your inbox', 'Enter the 6-digit PIN, or open the secure recovery link if your mail provider sends a link.')
    } catch (error) {
      toast.error('Unable to send recovery email', error instanceof Error ? error.message : 'Try again shortly.')
    }
  })

  const verifyOtp = otpForm.handleSubmit(async (values) => {
    try {
      await auth.verifyPasswordResetOtp(recoveryEmail, values.otp)
      toast.success('PIN verified', 'Create your new password now.')
    } catch (error) {
      toast.error('PIN verification failed', error instanceof Error ? error.message : 'Request a new PIN and try again.')
    }
  })

  const updatePassword = passwordForm.handleSubmit(async (values) => {
    try {
      await auth.updatePassword(values.password)
      passwordForm.reset()
      toast.success('Password updated', 'Your new password was verified and you are signed in securely.')
      void navigate(destination, { replace: true })
    } catch (error) {
      if (error instanceof PasswordUpdatedSignInError) {
        passwordForm.reset()
        toast.error('Password updated — sign in required', error.message)
        void navigate(companyPath(portal.routeCode, 'login'), {
          replace: true,
          state: { email: error.email },
        })
        return
      }
      toast.error('Unable to update password', error instanceof Error ? error.message : 'Try again shortly.')
    }
  })

  return (
    <main className="auth-page">
      <section className="auth-brand" aria-label={`${portal.name} product overview`}>
        <div className="brand-mark brand-mark--large"><Boxes /></div>
        <span className="eyebrow">{portal.name} · Secure company portal</span>
        <h1>{portal.name} operations, kept separate.</h1>
        <p>Use your Supabase Authentication email and password. Your account must have active access to {portal.name}.</p>
        <ul className="auth-benefits">
          <li><ShieldCheck /> Supabase Authentication sign-in</li>
          <li><LockKeyhole /> Company-specific accounting and operations</li>
          <li><KeyRound /> Working password recovery for this portal</li>
        </ul>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-card__brand"><span className="brand-mark"><Boxes /></span><strong>{portal.companyCode} SYS <em>V3</em></strong></div>
          {isRecoveryRoute && auth.loading ? (
            <LoadingState label="Validating your recovery link..." />
          ) : auth.recovery && auth.session ? (
            <>
              <div className="auth-card__heading"><h2>Set a new password</h2><p>Choose a strong password. We will verify it by creating a fresh secure session before continuing.</p></div>
              <form onSubmit={(event) => void updatePassword(event)} className="form-stack">
                <Field label="New password" required error={passwordForm.formState.errors.password?.message}>
                  <Input type="password" autoComplete="new-password" {...passwordForm.register('password')} />
                </Field>
                <Field label="Confirm password" required error={passwordForm.formState.errors.confirm?.message}>
                  <Input type="password" autoComplete="new-password" {...passwordForm.register('confirm')} />
                </Field>
                <Button type="submit" loading={passwordForm.formState.isSubmitting}>Update password</Button>
              </form>
            </>
          ) : isRecoveryRoute ? (
            <>
              <div className="auth-card__heading"><h2>Recovery link unavailable</h2><p>This recovery link is invalid or has expired. Request a new link from the sign-in page.</p></div>
              <Link className="button button--primary button--medium" to={companyPath(portal.routeCode, 'login')}>Return to {portal.name} sign in</Link>
            </>
          ) : mode === 'login' ? (
            <>
              <div className="auth-card__heading"><h2>{portal.name} sign in</h2><p>Use your individual {portal.companyCode} staff account.</p></div>
              <form onSubmit={(event) => void login(event)} className="form-stack">
                <Field label="Email address" required error={loginForm.formState.errors.email?.message}>
                  <div className="input-with-icon"><Mail size={17} /><Input type="email" autoComplete="username" {...loginForm.register('email')} /></div>
                </Field>
                <Field label="Password" required error={loginForm.formState.errors.password?.message}>
                  <div className="input-with-icon"><LockKeyhole size={17} /><Input type="password" autoComplete="current-password" {...loginForm.register('password')} /></div>
                </Field>
                <Button type="submit" loading={loginForm.formState.isSubmitting}>Sign in securely</Button>
              </form>
              <button className="text-button" onClick={() => setMode('reset')}>Forgot your password?</button>
            </>
          ) : mode === 'reset' ? (
            <>
              <div className="auth-card__heading"><h2>Recover access</h2><p>We will request a 6-digit one-time PIN for your {portal.name} account. If the hosted mail provider sends a secure recovery link instead, open that link to continue.</p></div>
              <form onSubmit={(event) => void requestReset(event)} className="form-stack">
                <Field label="Email address" required error={resetForm.formState.errors.email?.message}>
                  <Input type="email" autoComplete="email" {...resetForm.register('email')} />
                </Field>
                <Button type="submit" loading={resetForm.formState.isSubmitting}>Send OTP PIN</Button>
              </form>
              <button className="text-button" onClick={() => setMode('login')}>Back to sign in</button>
            </>
          ) : (
            <>
              <div className="auth-card__heading"><h2>Enter your OTP PIN</h2><p>Use the 6-digit code sent to {recoveryEmail}, or open the secure recovery link in that email.</p></div>
              <form onSubmit={(event) => void verifyOtp(event)} className="form-stack">
                <Field label="6-digit OTP PIN" required error={otpForm.formState.errors.otp?.message}>
                  <Input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} {...otpForm.register('otp')} />
                </Field>
                <Button type="submit" loading={otpForm.formState.isSubmitting}>Verify PIN</Button>
              </form>
              <button className="text-button" onClick={() => setMode('reset')}>Request a new PIN</button>
              <button className="text-button" onClick={() => setMode('login')}>Back to sign in</button>
            </>
          )}
          {!auth.recovery ? <Link className="text-button" to="/login">Choose another company</Link> : null}
        </div>
      </section>
    </main>
  )
}
