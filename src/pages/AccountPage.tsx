import { zodResolver } from '@hookform/resolvers/zod'
import { KeyRound, MailCheck, ShieldCheck, UserRound } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { useAuth } from '../auth/AuthProvider'
import { useToast } from '../components/Toast'
import { Button, Card, Field, FormActions, InlineNotice, Input, PageHeader, SectionTitle } from '../components/UI'
import { useAppContext } from '../layout/AppShell'

const passwordSchema = z.object({
  otp: z.string().regex(/^\d{6,10}$/, 'Enter the 6–10 digit code from your email.'),
  password: z.string()
    .min(10, 'Use at least 10 characters.')
    .regex(/[a-z]/, 'Include a lowercase letter.')
    .regex(/[A-Z]/, 'Include an uppercase letter.')
    .regex(/[0-9]/, 'Include a number.')
    .regex(/[^A-Za-z0-9]/, 'Include a symbol.'),
  confirm: z.string(),
}).superRefine((values, context) => {
  if (values.password !== values.confirm) {
    context.addIssue({ code: 'custom', message: 'Passwords do not match.', path: ['confirm'] })
  }
})

type PasswordValues = z.infer<typeof passwordSchema>

export function AccountPage() {
  const auth = useAuth()
  const toast = useToast()
  const { me } = useAppContext()
  const [otpSent, setOtpSent] = useState(false)
  const [sendingOtp, setSendingOtp] = useState(false)
  const form = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { otp: '', password: '', confirm: '' },
  })
  const identity = me.display_name || me.email || 'Signed-in user'

  const sendOtp = async () => {
    setSendingOtp(true)
    try {
      await auth.requestPasswordChangeOtp()
      setOtpSent(true)
      toast.success(
        'Verification code sent',
        `Enter the verification code sent to ${me.email ?? 'your verified email address'}.`,
      )
    } catch (error) {
      toast.error(
        'Code could not be sent',
        error instanceof Error ? error.message : 'Wait a moment and try again.',
      )
    } finally {
      setSendingOtp(false)
    }
  }

  const changePassword = form.handleSubmit(async (values) => {
    try {
      await auth.updatePassword(values.password, values.otp)
      form.reset()
      setOtpSent(false)
      toast.success('Password changed', 'Sign in again with your new password.')
    } catch (error) {
      toast.error(
        'Password was not changed',
        error instanceof Error ? error.message : 'Confirm your current password and try again.',
      )
    }
  })

  return (
    <div className="page-stack account-page">
      <PageHeader
        eyebrow="Personal account"
        title="Account & security"
        description="Manage the password for your individual CK SYS sign-in. This page is available to every signed-in user."
      />

      <div className="account-grid">
        <Card className="account-identity-card">
          <div className="settings-overview__icon"><UserRound size={24} aria-hidden="true" /></div>
          <div>
            <span className="eyebrow">Signed in as</span>
            <h2>{identity}</h2>
            <p>{me.email ?? 'No email address is available for this profile.'}</p>
            <span className="account-company">Current company: {me.active_company_name}</span>
          </div>
        </Card>

        <Card className="account-security-card">
          <SectionTitle
            title="Change password"
            description="Verify this change with a one-time code sent to your account email."
          />
          <InlineNotice tone="success" title="Verified password update">
            Supabase Auth sends the email code and processes the password update. CK SYS never stores your code or password.
          </InlineNotice>
          {!otpSent ? (
            <div className="form-stack account-password-form">
              <div className="account-security-note account-otp-destination">
                <MailCheck size={21} aria-hidden="true" />
                <div>
                  <strong>Send a code to {me.email ?? 'your verified email'}</strong>
                  <span>The code expires according to your Supabase Auth security settings.</span>
                </div>
              </div>
              <FormActions>
                <Button type="button" icon={MailCheck} loading={sendingOtp} onClick={() => void sendOtp()}>
                  Send email code
                </Button>
              </FormActions>
            </div>
          ) : (
            <form className="form-stack account-password-form" onSubmit={(event) => void changePassword(event)}>
              <Field label="Email verification code" required error={form.formState.errors.otp?.message}>
                <Input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={10}
                  aria-label="Email verification code"
                  {...form.register('otp')}
                />
              </Field>
              <div className="form-grid form-grid--two">
                <Field label="New password" required error={form.formState.errors.password?.message}>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    aria-label="New password"
                    {...form.register('password')}
                  />
                </Field>
                <Field label="Confirm new password" required error={form.formState.errors.confirm?.message}>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    aria-label="Confirm new password"
                    {...form.register('confirm')}
                  />
                </Field>
              </div>
              <FormActions>
                <Button type="button" variant="secondary" loading={sendingOtp} onClick={() => void sendOtp()}>
                  Resend code
                </Button>
                <Button type="submit" icon={KeyRound} loading={form.formState.isSubmitting}>Change password</Button>
              </FormActions>
            </form>
          )}
        </Card>
      </div>

      <Card className="account-security-note">
        <ShieldCheck size={21} aria-hidden="true" />
        <div><strong>One secure identity, assigned access</strong><span>The same Supabase Authentication email and password works in each company portal assigned to you; pages and actions follow your capability roles.</span></div>
      </Card>
    </div>
  )
}
