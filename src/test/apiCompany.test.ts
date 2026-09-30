import { afterEach, describe, expect, it, vi } from 'vitest'

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn().mockResolvedValue({
    data: { session: { access_token: 'test-access-token' } },
    error: null,
  }),
  refreshSession: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  supabase: { auth: authMocks },
}))

import { api, getActiveCompanyId, setActiveCompanyId } from '../lib/api'

afterEach(() => {
  setActiveCompanyId(null)
  vi.restoreAllMocks()
})

describe('company-aware API requests', () => {
  it('adds the selected company header to authenticated requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))

    setActiveCompanyId('22222222-2222-4222-8222-222222222222')
    await api.get<{ ok: boolean }>('/me')

    const request = fetchMock.mock.calls[0]
    const headers = new Headers(request?.[1]?.headers)
    expect(getActiveCompanyId()).toBe('22222222-2222-4222-8222-222222222222')
    expect(headers.get('X-Company-ID')).toBe('22222222-2222-4222-8222-222222222222')
    expect(headers.get('Authorization')).toBe('Bearer test-access-token')
  })

  it('omits the company header until a company context is known', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))

    await api.get<{ ok: boolean }>('/me')

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.has('X-Company-ID')).toBe(false)
  })
})
