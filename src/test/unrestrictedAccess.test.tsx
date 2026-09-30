import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/Toast'
import { AppShell } from '../layout/AppShell'
import { api, getActiveCompanyId, setActiveCompanyId } from '../lib/api'

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    session: { user: { id: 'authenticated-user' } },
    signOut: vi.fn(),
  }),
}))

afterEach(() => {
  cleanup()
  setActiveCompanyId(null)
  vi.restoreAllMocks()
})

describe('permission-scoped workspace access', () => {
  it('shows only pages granted by the selected company permissions', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      user_id: 'authenticated-user',
      email: 'viewer@example.com',
      display_name: 'Authenticated User',
      is_active: true,
      active_company_id: '00000000-0000-4000-8000-000000000001',
      active_company_code: 'CK',
      active_company_name: 'CK Plastics',
      is_super_admin: false,
      role_codes: ['operations'],
      permission_codes: ['dashboard.read', 'production.read', 'production.write', 'inventory.read', 'inventory.write'],
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/ck/dashboard']}>
          <ToastProvider>
            <Routes>
              <Route path="/:companyCode" element={<AppShell />}>
                <Route path="dashboard" element={<div>Dashboard content</div>} />
              </Route>
            </Routes>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Dashboard content')).toBeInTheDocument()
    for (const label of ['Overview', 'Production', 'Inventory', 'Account & security']) {
      expect(screen.getAllByRole('link', { name: label }).length).toBeGreaterThan(0)
    }
    for (const label of ['Sales', 'Staff & payroll', 'Accounting', 'Settings']) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument()
    }
    expect(screen.getByText('operations')).toBeInTheDocument()
    await waitFor(() => expect(getActiveCompanyId()).toBe('00000000-0000-4000-8000-000000000001'))
    expect(api.get).toHaveBeenCalledWith('/me', undefined, expect.any(AbortSignal))
  })
})
