import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { auditRowsToCsv } from '../lib/auditExport'
import { ActivityPage } from '../pages/ActivityPage'

vi.mock('../layout/AppShell', () => ({
  useAppContext: () => ({
    me: {
      active_company_id: 'company-ck',
      active_company_code: 'CK',
      active_company_name: 'CK Plastics',
      permission_codes: ['audit.read'],
    },
  }),
}))

const event = {
  id: 42,
  occurred_at: '2026-10-05T08:30:00+05:30',
  actor_user_id: 'admin',
  actor_display_name: 'Hirantha Dias',
  actor_email: 'admin@example.com',
  operation: 'sale.upsert',
  entity_table: 'sale',
  entity_id: 'sale-42',
  action: 'execute' as const,
  before_data: null,
  after_data: { ok: true, reference_no: 'INV-42' },
  request_id: 'request-42',
  company_id: 'company-ck',
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('activity and audit report', () => {
  it('filters who did what and opens the full immutable event', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const list = vi.spyOn(api, 'list').mockResolvedValue({
      items: [event], total: 1, page: 1, page_size: 50, pages: 1,
    })

    render(<QueryClientProvider client={queryClient}><ActivityPage /></QueryClientProvider>)

    expect(await screen.findByText('Hirantha Dias')).toBeInTheDocument()
    expect(screen.getByText('Sale › Upsert')).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: 'User' }), 'Hirantha')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Action' }), 'execute')
    await waitFor(() => expect(list).toHaveBeenLastCalledWith('/reports/audit-log', expect.objectContaining({
      actor: 'Hirantha',
      action: 'execute',
      page_size: 50,
    }), expect.any(AbortSignal)))

    await user.click(screen.getByRole('button', { name: 'View' }))
    const dialog = screen.getByRole('dialog', { name: 'Audit event details' })
    expect(within(dialog).getByText('request-42')).toBeInTheDocument()
    expect(within(dialog).getByText(/INV-42/)).toBeInTheDocument()
    expect(within(dialog).getByText('admin@example.com')).toBeInTheDocument()
  })

  it('exports quoted event details as CSV', () => {
    const csv = auditRowsToCsv([{ ...event, actor_display_name: 'Dias, Hirantha' }])
    expect(csv).toContain('"Dias, Hirantha"')
    expect(csv).toContain('"sale.upsert"')
    expect(csv).toContain('"{""ok"":true,""reference_no"":""INV-42""}"')
  })
})
