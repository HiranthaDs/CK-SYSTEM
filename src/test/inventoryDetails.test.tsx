import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { InventoryPage } from '../pages/InventoryPage'

vi.mock('../layout/AppShell', () => ({
  useAppContext: () => ({
    me: {
      active_company_code: 'CK',
      active_company_name: 'CK Plastics',
    },
  }),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('inventory summary drill-downs', () => {
  it('opens finished-product details with quantities, values, costs, and selling prices', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.spyOn(api, 'get').mockResolvedValue({
      bulk: { item_count: 1, total_quantity: 10, shared_total_quantity: 15, total_value: 1000 },
      chips: { item_count: 1, total_quantity: 20, shared_total_quantity: 25, total_value: 2000 },
      finished: { item_count: 1, total_quantity: 30, shared_total_quantity: 40, total_value: 3000 },
      total_quantity: 60,
      shared_total_quantity: 80,
      total_value: 6000,
    })
    const list = vi.spyOn(api, 'list').mockResolvedValue({
      items: [{
        item_id: 'finished-1',
        sku: 'FP-001',
        item_name: 'Blue crate',
        stage: 'finished',
        unit: 'unit',
        quantity_on_hand: 30,
        shared_quantity_on_hand: 40,
        selling_price: 250,
        average_unit_cost: 100,
        inventory_value: 3000,
        is_active: true,
      }],
      total: 1,
      page: 1,
      page_size: 25,
      pages: 1,
    })

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><InventoryPage /></MemoryRouter>
      </QueryClientProvider>,
    )

    await user.click(await screen.findByRole('button', { name: 'View Finished products details' }))
    const dialog = screen.getByRole('dialog', { name: 'Finished products details' })
    expect(within(dialog).getByText('Blue crate')).toBeInTheDocument()
    expect(within(dialog).getByText(/LKR\s*250\.00/)).toBeInTheDocument()
    expect(within(dialog).getByText(/LKR\s*100\.00/)).toBeInTheDocument()
    expect(within(dialog).getAllByText('30')).not.toHaveLength(0)
    expect(within(dialog).getAllByText('40')).not.toHaveLength(0)
    await waitFor(() => expect(list).toHaveBeenCalledWith('/inventory/position', {
      page: 1,
      page_size: 25,
      descending: false,
      stage: 'finished',
    }, expect.any(AbortSignal)))
  })
})
