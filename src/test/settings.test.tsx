import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/Toast'
import { api, ApiError } from '../lib/api'
import { PURGE_CONFIRMATION, SettingsPage } from '../pages/SettingsPage'

vi.mock('../layout/AppShell', () => ({
  useAppContext: () => ({
    me: {
      user_id: 'admin',
      is_active: true,
      active_company_id: 'company-ck',
      active_company_code: 'CK',
      active_company_name: 'CK Plastics',
      is_super_admin: true,
      role_codes: ['admin'],
      permission_codes: ['system.admin'],
    },
    basePath: '/ck',
    year: 2026,
    setYear: vi.fn(),
  }),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('bilingual system workflow guide', () => {
  it('opens a complete English and Sinhala guide and returns focus to its button', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    vi.spyOn(api, 'list').mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100, pages: 0 })

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/settings']}>
          <ToastProvider><SettingsPage /></ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const openGuide = screen.getByRole('button', { name: 'Open user guide / මාර්ගෝපදේශය' })
    await user.click(openGuide)

    const dialog = screen.getByRole('dialog', { name: /System workflow guide/ })
    const englishGuide = within(dialog).getByRole('region', { name: 'English guide' })
    const sinhalaGuide = within(dialog).getByRole('region', { name: 'සිංහල මාර්ගෝපදේශය' })

    expect(within(englishGuide).getAllByRole('listitem')).toHaveLength(8)
    expect(within(sinhalaGuide).getAllByRole('listitem')).toHaveLength(8)
    expect(within(englishGuide).getByText('Confirm the company and year')).toBeInTheDocument()
    expect(within(englishGuide).getByText('Review accounting and finish safely')).toBeInTheDocument()
    expect(within(sinhalaGuide).getByText('සමාගම සහ වර්ෂය තහවුරු කරන්න')).toBeInTheDocument()
    expect(within(sinhalaGuide).getByText('ගිණුම් පරීක්ෂා කර ආරක්ෂිතව අවසන් කරන්න')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Done / අවසන්' }))
    expect(screen.queryByRole('dialog', { name: /System workflow guide/ })).not.toBeInTheDocument()
    expect(openGuide).toHaveFocus()
  })
})

describe('administrator business-data purge', () => {
  it('requires the exact phrase and acknowledgement before calling the API', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    queryClient.setQueryData(['me'], { user_id: 'admin' })
    queryClient.setQueryData(['dashboard', 2026], { year: 2026 })
    vi.spyOn(api, 'list').mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100, pages: 0 })
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      ok: true,
      operation: 'system.purge_business_data',
      id: null,
      idempotent: false,
    })

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/settings']}>
          <ToastProvider><SettingsPage /></ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Delete all data' }))
    const destructiveButton = screen.getByRole('button', { name: 'Permanently delete data' })
    const confirmation = screen.getByRole('textbox', { name: `Type ${PURGE_CONFIRMATION} exactly` })
    const acknowledgement = screen.getByRole('checkbox', {
      name: 'I understand this permanently deletes the listed live business records.',
    })

    expect(destructiveButton).toBeDisabled()
    await user.type(confirmation, 'delete all business data')
    await user.click(acknowledgement)
    expect(destructiveButton).toBeDisabled()

    await user.clear(confirmation)
    await user.type(confirmation, PURGE_CONFIRMATION)
    expect(destructiveButton).toBeEnabled()
    await user.click(destructiveButton)

    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/purge-business-data', {
      confirmation: PURGE_CONFIRMATION,
      acknowledge_irreversible: true,
      company_code: 'CK',
    }))
    await waitFor(() => expect(queryClient.getQueryData(['dashboard', 2026])).toBeUndefined())
    expect(queryClient.getQueryData(['me'])).toEqual({ user_id: 'admin' })
  })
})

describe('conversion setup', () => {
  it('saves reusable conversion types from System settings', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    vi.spyOn(api, 'list').mockImplementation((path) => Promise.resolve({
      items: path === '/conversion-types' ? [{
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Existing cut',
        default_chip_name: 'Existing chip',
        status: 'active',
      }] : [],
      total: path === '/conversion-types' ? 1 : 0,
      page: 1,
      page_size: 100,
      pages: 1,
    }))
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      ok: true,
      operation: 'conversion_type.upsert',
      id: '22222222-2222-4222-8222-222222222222',
      idempotent: false,
    })

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/settings']}>
          <ToastProvider><SettingsPage /></ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Existing cut')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add type' }))
    await user.type(screen.getByRole('textbox', { name: 'Conversion type' }), 'Fine chip conversion')
    await user.type(screen.getByRole('textbox', { name: /Default chip stock name/ }), 'Fine chip stock')
    await user.click(screen.getByRole('button', { name: 'Save type' }))

    await waitFor(() => expect(post).toHaveBeenCalledWith('/conversion-types', {
      name: 'Fine chip conversion',
      default_chip_name: 'Fine chip stock',
      status: 'active',
      notes: null,
    }))
  })
})

describe('super-admin settings', () => {
  it('loads and displays controlled account management', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const list = vi.spyOn(api, 'list').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 100,
      pages: 0,
    })

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/settings']}>
          <ToastProvider><SettingsPage /></ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('System settings')).toBeInTheDocument()
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(list.mock.calls.some(([path]) => path === '/admin/users')).toBe(true)
    expect(screen.getByText('Login accounts & access')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument()
  })

  it('validates account details and keeps actionable server errors in the dialog', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    vi.spyOn(api, 'list').mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100, pages: 0 })
    const post = vi.spyOn(api, 'post').mockRejectedValue(new ApiError(
      'Account creation is not configured on the API server. Add a rotated SUPABASE_SECRET_KEY (sb_secret_...) to the backend environment and restart the API.',
      503,
      { code: 'auth_admin_not_configured' },
    ))

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/settings']}>
          <ToastProvider><SettingsPage /></ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await user.click(await screen.findByRole('button', { name: 'Create account' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a login account' })
    const submit = within(dialog).getByRole('button', { name: 'Create account' })

    await user.click(submit)
    expect(within(dialog).getByText('Enter the user’s full name.')).toBeInTheDocument()
    expect(within(dialog).getByText('Enter a valid email address.')).toBeInTheDocument()
    expect(within(dialog).getByText('Use at least 10 characters.')).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()

    await user.type(within(dialog).getByLabelText(/Full name/), '  New User  ')
    await user.type(within(dialog).getByLabelText(/Email address/), ' New.User@Example.com ')
    await user.type(within(dialog).getByLabelText(/Temporary password/), 'Strong-password-1!')
    await user.click(submit)

    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/users', {
      display_name: 'New User',
      email: 'new.user@example.com',
      temporary_password: 'Strong-password-1!',
      company_access: 'BOTH',
      role_codes: ['viewer'],
      is_super_admin: false,
    }))
    expect(await within(dialog).findByText(/SUPABASE_SECRET_KEY/)).toBeInTheDocument()
  })

  it('changes account status with a switch and requires the removal PIN', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const accountRows = [{
      company_id: 'company-ck',
      company_code: 'CK',
      company_name: 'CK Plastics',
      user_id: 'staff-user',
      display_name: 'Accounts User',
      email: 'accounts@example.com',
      profile_active: true,
      is_super_admin: false,
      membership_active: true,
      is_primary: true,
      role_codes: ['accountant'],
    }, {
      company_id: 'company-ar',
      company_code: 'AR',
      company_name: 'AR Plastics',
      user_id: 'staff-user',
      display_name: 'Accounts User',
      email: 'accounts@example.com',
      profile_active: true,
      is_super_admin: false,
      membership_active: true,
      is_primary: false,
      role_codes: ['viewer'],
    }]
    vi.spyOn(api, 'list').mockImplementation((path) => Promise.resolve({
      items: path === '/admin/users' ? accountRows : [],
      total: path === '/admin/users' ? accountRows.length : 0,
      page: 1,
      page_size: 100,
      pages: path === '/admin/users' ? 1 : 0,
    }))
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ ok: true, operation: 'admin.user.status', id: 'staff-user', idempotent: false })
    const remove = vi.spyOn(api, 'delete').mockResolvedValue({ ok: true, operation: 'admin.user.remove', id: 'staff-user', idempotent: false })

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/settings']}>
          <ToastProvider><SettingsPage /></ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Accounts User')).toBeInTheDocument()
    expect(screen.getByText('CK + AR')).toBeInTheDocument()
    const statusSwitch = screen.getByRole('switch', { name: 'Account status for Accounts User' })
    expect(statusSwitch).toHaveAttribute('aria-checked', 'true')
    await user.click(statusSwitch)
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/admin/users/staff-user/status', { is_active: false }))

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    const removeButton = screen.getByRole('button', { name: 'Remove account' })
    expect(removeButton).toBeDisabled()
    expect(screen.queryByText(/2113/)).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Account-removal PIN'), '2113')
    expect(removeButton).toBeEnabled()
    await user.click(removeButton)
    await waitFor(() => expect(remove).toHaveBeenCalledWith('/admin/users/staff-user', { confirmation_pin: '2113' }))
  })
})
