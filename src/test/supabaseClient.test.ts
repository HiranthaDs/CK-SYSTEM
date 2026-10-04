import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn((...args: [string, string, unknown?]) => {
    void args
    return { auth: {} }
  }),
}))

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }))

describe('Supabase browser client', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.createClient.mockClear()
  })

  it('persists and restores an independent session on each device', async () => {
    await import('../lib/supabase')

    expect(mocks.createClient).toHaveBeenCalledTimes(1)
    expect(mocks.createClient.mock.calls[0]?.[2]).toMatchObject({
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
        storageKey: 'ck-sys-v3-auth',
      },
    })
  })
})
