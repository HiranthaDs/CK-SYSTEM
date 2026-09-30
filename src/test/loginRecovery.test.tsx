import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/Toast'

const mocks = vi.hoisted(() => ({ updatePassword: vi.fn() }))

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    session: { access_token: 'recovery-token' },
    loading: false,
    recovery: true,
    updatePassword: mocks.updatePassword,
    signIn: vi.fn(),
    requestPasswordReset: vi.fn(),
  }),
}))

import { LoginPage } from '../auth/LoginPage'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('password recovery page', () => {
  it('lets a recovery session set and confirm a new password', async () => {
    mocks.updatePassword.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/ck/reset-password']}>
        <ToastProvider><LoginPage /></ToastProvider>
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: 'Set a new password' })).toBeInTheDocument()
    const passwordFields = screen.getAllByLabelText(/password/i)
    await user.type(passwordFields[0]!, 'Recovered-password-1!')
    await user.type(passwordFields[1]!, 'Recovered-password-1!')
    await user.click(screen.getByRole('button', { name: 'Update password' }))

    await waitFor(() => expect(mocks.updatePassword).toHaveBeenCalledWith('Recovered-password-1!'))
    expect(await screen.findByText('Your new password was verified and you are signed in securely.')).toBeInTheDocument()
  })

  it('does not submit when the password confirmation differs', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/ck/reset-password']}>
        <ToastProvider><LoginPage /></ToastProvider>
      </MemoryRouter>,
    )

    const passwordFields = screen.getAllByLabelText(/password/i)
    await user.type(passwordFields[0]!, 'Recovered-password-1!')
    await user.type(passwordFields[1]!, 'Different-password-2!')
    await user.click(screen.getByRole('button', { name: 'Update password' }))

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument()
    expect(mocks.updatePassword).not.toHaveBeenCalled()
  })
})
