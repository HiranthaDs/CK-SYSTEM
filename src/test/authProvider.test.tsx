import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
  getUser: vi.fn().mockResolvedValue({
    data: { user: { id: 'user-1', email: 'User@Example.com' } },
    error: null,
  }),
  onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
  signInWithPassword: vi.fn().mockResolvedValue({
    data: { session: { access_token: 'fresh-token' }, user: { id: 'user-1' } },
    error: null,
  }),
  signOut: vi.fn().mockResolvedValue({ error: null }),
  resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
  reauthenticate: vi.fn().mockResolvedValue({ error: null }),
  updateUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1', email: 'User@Example.com' } }, error: null }),
}))

vi.mock('../lib/supabase', () => ({
  supabase: { auth: authMocks },
}))

import { AuthProvider, useAuth } from '../auth/AuthProvider'

function AuthActions() {
  const auth = useAuth()
  return (
    <>
      <button onClick={() => void auth.requestPasswordReset(' User@Example.com ', '/ck/reset-password')}>Request reset</button>
      <button onClick={() => void auth.requestPasswordChangeOtp()}>Request change code</button>
      <button onClick={() => void auth.updatePassword('new-password-123', '123456')}>Change password</button>
    </>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Supabase password flows', () => {
  it('uses the public reset route and proves the updated password with a fresh session', async () => {
    const user = userEvent.setup()
    render(<AuthProvider><AuthActions /></AuthProvider>)

    await user.click(screen.getByRole('button', { name: 'Request reset' }))
    await user.click(screen.getByRole('button', { name: 'Request change code' }))
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    await waitFor(() => expect(authMocks.resetPasswordForEmail).toHaveBeenCalledWith('user@example.com', {
      redirectTo: `${window.location.origin}/ck/reset-password`,
    }))
    expect(authMocks.reauthenticate).toHaveBeenCalledTimes(1)
    expect(authMocks.updateUser).toHaveBeenCalledWith({
      password: 'new-password-123',
      nonce: '123456',
    })
    await waitFor(() => expect(authMocks.signInWithPassword).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'new-password-123',
    }))
    expect(authMocks.signOut).not.toHaveBeenCalled()
  })
})
