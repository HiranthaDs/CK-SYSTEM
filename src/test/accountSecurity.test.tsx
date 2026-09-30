import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/Toast'

const mocks = vi.hoisted(() => ({
  requestPasswordChangeOtp: vi.fn(),
  updatePassword: vi.fn(),
}))

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    requestPasswordChangeOtp: mocks.requestPasswordChangeOtp,
    updatePassword: mocks.updatePassword,
  }),
}))

vi.mock('../layout/AppShell', () => ({
  useAppContext: () => ({
    me: {
      user_id: 'user-1',
      email: 'manager@example.com',
      display_name: 'Company Manager',
      active_company_name: 'CK Plastics',
    },
  }),
}))

import { AccountPage } from '../pages/AccountPage'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('account security', () => {
  it('requests an email OTP and submits it with the confirmed new password', async () => {
    mocks.requestPasswordChangeOtp.mockResolvedValue(undefined)
    mocks.updatePassword.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<ToastProvider><AccountPage /></ToastProvider>)

    await user.click(screen.getByRole('button', { name: 'Send email code' }))
    await waitFor(() => expect(mocks.requestPasswordChangeOtp).toHaveBeenCalledTimes(1))

    await user.type(screen.getByLabelText('Email verification code'), '123456')
    await user.type(screen.getByLabelText('New password'), 'New-password-123!')
    await user.type(screen.getByLabelText('Confirm new password'), 'New-password-123!')
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    await waitFor(() => expect(mocks.updatePassword).toHaveBeenCalledWith('New-password-123!', '123456'))
    expect(await screen.findByText('Sign in again with your new password.')).toBeInTheDocument()
  })

  it('does not submit an incomplete email code', async () => {
    mocks.requestPasswordChangeOtp.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<ToastProvider><AccountPage /></ToastProvider>)

    await user.click(screen.getByRole('button', { name: 'Send email code' }))
    await user.type(await screen.findByLabelText('Email verification code'), '123')
    await user.type(screen.getByLabelText('New password'), 'New-password-123!')
    await user.type(screen.getByLabelText('Confirm new password'), 'New-password-123!')
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    expect(await screen.findByText('Enter the 6–10 digit code from your email.')).toBeInTheDocument()
    expect(mocks.updatePassword).not.toHaveBeenCalled()
  })
})
