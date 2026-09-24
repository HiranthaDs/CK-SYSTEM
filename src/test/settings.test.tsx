import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/Toast'
import { api } from '../lib/api'
import { PURGE_CONFIRMATION, SettingsPage } from '../pages/SettingsPage'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
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
