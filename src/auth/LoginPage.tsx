import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Navigate, useLocation } from 'react-router-dom'
import { Boxes, KeyRound, LockKeyhole, Mail, ShieldCheck } from 'lucide-react'
import { z } from 'zod'
import { useAuth } from './AuthProvider'
import { Button, Field, Input } from '../components/UI'
import { useToast } from '../components/Toast'

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(8, 'Password must contain at least 8 characters.'),
})

const resetSchema = z.object({ email: z.string().email('Enter a valid email address.') })
const passwordSchema = z.object({
  password: z.string().min(10, 'Use at least 10 characters.'),
  confirm: z.string(),
}).refine((value) => value.password === value.confirm, { message: 'Passwords do not match.', path: ['confirm'] })

type LoginValues = z.infer<typeof loginSchema>
type ResetValues = z.infer<typeof resetSchema>
type PasswordValues = z.infer<typeof passwordSchema>

export function LoginPage() {
  const auth = useAuth()
  const toast = useToast()
  const location = useLocation()
  const [mode, setMode] = useState<'login' | 'reset'>(auth.recovery ? 'reset' : 'login')
  const destination = ((location.state as { from?: string } | null)?.from) ?? '/dashboard'

  const loginForm = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } })
  const resetForm = useForm<ResetValues>({ resolver: zodResolver(resetSchema), defaultValues: { email: '' } })
  const passwordForm = useForm<PasswordValues>({ resolver: zodResolver(passwordSchema), defaultValues: { password: '', confirm: '' } })

  if (auth.session && !auth.recovery) return <Navigate to={destination} replace />

  const login = loginForm.handleSubmit(async (values) => {
    try {
      await auth.signIn(values.email, values.password)
      toast.success('Welcome back', 'Your secure session is ready.')
    } catch (error) {
      toast.error('Sign-in failed', error instanceof Error ? error.message : 'Check your credentials and try again.')
    }
  })

  const requestReset = resetForm.handleSubmit(async (values) => {
    try {
      await auth.requestPasswordReset(values.email)
      toast.success('Check your inbox', 'A secure password recovery link has been sent if that account exists.')
      setMode('login')
    } catch (error) {
      toast.error('Unable to send recovery email', error instanceof Error ? error.message : 'Try again shortly.')
    }
  })

  const updatePassword = passwordForm.handleSubmit(async (values) => {
    try {
      await auth.updatePassword(values.password)
      toast.success('Password updated', 'You can continue to CK SYS.')
    } catch (error) {
      toast.error('Unable to update password', error instanceof Error ? error.message : 'Try again shortly.')
    }
  })

  return (
    <main className="auth-page">
      <section className="auth-brand" aria-label="CK SYS product overview">
        <div className="brand-mark brand-mark--large"><Boxes /></div>
        <span className="eyebrow">AR Plastic · Operations platform</span>
        <h1>Every operational number, connected.</h1>
        <p>Production, inventory, sales, payroll, and accounting run from one secure source of truth.</p>
        <ul className="auth-benefits">
          <li><ShieldCheck /> Supabase identity with server-verified access</li>
          <li><LockKeyhole /> Transaction-safe financial and stock workflows</li>
          <li><KeyRound /> No shared passwords or browser-stored business data</li>
        </ul>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-card__brand"><span className="brand-mark"><Boxes /></span><strong>CK SYS <em>V3</em></strong></div>
          {auth.recovery ? (
            <>
              <div className="auth-card__heading"><h2>Set a new password</h2><p>Choose a strong password for your account.</p></div>
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
          ) : mode === 'login' ? (
            <>
              <div className="auth-card__heading"><h2>Sign in</h2><p>Use your individual staff account.</p></div>
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
          ) : (
            <>
              <div className="auth-card__heading"><h2>Recover access</h2><p>We will email a one-time recovery link.</p></div>
              <form onSubmit={(event) => void requestReset(event)} className="form-stack">
                <Field label="Email address" required error={resetForm.formState.errors.email?.message}>
                  <Input type="email" autoComplete="email" {...resetForm.register('email')} />
                </Field>
                <Button type="submit" loading={resetForm.formState.isSubmitting}>Send recovery link</Button>
              </form>
              <button className="text-button" onClick={() => setMode('login')}>Back to sign in</button>
            </>
          )}
        </div>
      </section>
    </main>
  )
}
