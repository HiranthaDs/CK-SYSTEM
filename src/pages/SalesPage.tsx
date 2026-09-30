import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFieldArray, useForm } from 'react-hook-form'
import { useEffect, useState } from 'react'
import { Banknote, FileBarChart, MessageCircle, Pencil, Plus, Printer, ReceiptText, RotateCcw, ShoppingCart, Trash2, WalletCards } from 'lucide-react'
import { z } from 'zod'
import { api } from '../lib/api'
import { localIsoDate, money, numberValue, quantity, shortDate, titleCase } from '../lib/format'
import { invoiceWhatsAppMessage, normalizeWhatsAppPhone, saleLineName, suggestedUnitPrice } from '../lib/salesInvoice'
import type { InventoryPosition, MutationReceipt, Page, Payment, Sale } from '../types/api'
import { useAppContext } from '../layout/AppShell'
import { useToast } from '../components/Toast'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { RemoteSelect } from '../components/RemoteSelect'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  InlineNotice,
  Input,
  LoadingState,
  PageHeader,
  Pagination,
  SearchBox,
  SectionTitle,
  Select,
  StatCard,
  TableWrap,
  Tabs,
  Textarea,
} from '../components/UI'

type SalesTab = 'invoices' | 'outstanding' | 'report'

const paymentMethods = ['cash', 'bank_transfer', 'cheque', 'credit', 'accounts_receivable', 'other'] as const
const lineSchema = z.object({
  item_id: z.string().uuid('Select a finished item.'),
  quantity: z.coerce.number().positive('Quantity must be greater than zero.'),
  unit_price: z.coerce.number().positive('Price must be greater than zero.'),
  discount: z.coerce.number().min(0, 'Discount cannot be negative.'),
}).refine((line) => line.discount < line.quantity * line.unit_price, { message: 'Discount must be less than line gross.', path: ['discount'] })

const saleSchema = z.object({
  invoice_no: z.string().min(1, 'Invoice number is required.').max(80).regex(/^[A-Za-z0-9._/-]+$/, 'Use letters, numbers, dots, slashes, underscores, or hyphens.'),
  sale_date: z.string().min(1, 'Select a sale date.'),
  customer_name: z.string().min(1, 'Customer name is required.').max(160),
  customer_phone: z.string().max(40),
  payment_method: z.enum(paymentMethods),
  amount_paid: z.coerce.number().min(0),
  items: z.array(lineSchema).min(1, 'Add at least one invoice item.').max(500),
}).refine((sale) => sale.amount_paid <= sale.items.reduce((sum, line) => sum + line.quantity * line.unit_price - line.discount, 0), {
  message: 'Initial payment cannot exceed the invoice total.',
  path: ['amount_paid'],
})

const paymentSchema = z.object({
  payment_date: z.string().min(1, 'Select a payment date.'),
  amount: z.coerce.number().positive('Amount must be greater than zero.'),
  method: z.enum(paymentMethods),
  notes: z.string().max(1000),
})

type SaleValues = z.infer<typeof saleSchema>
type PaymentValues = z.infer<typeof paymentSchema>
const pageSize = 30

function saleLines(sale: Sale) {
  return sale.sale_items ?? []
}

function salePayments(sale: Sale) {
  return sale.sale_payments ?? []
}

function statusTone(status: string | null | undefined) {
  if (status === 'paid' || status === 'posted') return 'success' as const
  if (status === 'partial') return 'warning' as const
  if (status === 'reversed') return 'danger' as const
  return 'neutral' as const
}

export function SalesPage() {
  const { year } = useAppContext()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<SalesTab>('invoices')
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [saleOpen, setSaleOpen] = useState(false)
  const [editingSale, setEditingSale] = useState<Sale | null>(null)
  const [invoiceActionId, setInvoiceActionId] = useState<string | null>(null)
  const [paymentSale, setPaymentSale] = useState<Sale | null>(null)
  const [reverseSale, setReverseSale] = useState<Sale | null>(null)
  const [reversePayment, setReversePayment] = useState<{ sale: Sale; payment: Payment } | null>(null)

  const dateQuery = { from_date: `${year}-01-01`, to_date: `${year}-12-31` }
  const salesQuery = useQuery({
    queryKey: ['sales', year, page, search],
    queryFn: ({ signal }) => api.list<Sale>('/sales', { ...dateQuery, page, page_size: pageSize, q: search }, signal),
    enabled: tab === 'invoices',
  })
  const outstandingQuery = useQuery({
    queryKey: ['sales-outstanding', year, page, search],
    queryFn: ({ signal }) => api.list<Sale>('/sales-outstanding', { ...dateQuery, page, page_size: pageSize, q: search }, signal),
    enabled: tab === 'outstanding',
  })
  const reportQuery = useQuery({
    queryKey: ['report', 'sales', year, page, search],
    queryFn: ({ signal }) => api.list<Sale>('/reports/sales', { ...dateQuery, page, page_size: pageSize, q: search }, signal),
    enabled: tab === 'report',
  })

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['sales'] }),
      queryClient.invalidateQueries({ queryKey: ['sales-outstanding'] }),
      queryClient.invalidateQueries({ queryKey: ['report', 'sales'] }),
      queryClient.invalidateQueries({ queryKey: ['inventory'] }),
      queryClient.invalidateQueries({ queryKey: ['lookup'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      queryClient.invalidateQueries({ queryKey: ['ledger'] }),
    ])
  }

  const editSaleMutation = useMutation({
    mutationFn: (saleId: string) => api.get<Sale>(`/sales/${saleId}`),
    onSuccess: (sale) => {
      setEditingSale(sale)
      setSaleOpen(true)
    },
    onError: (error) => toast.error('Invoice could not be opened', error instanceof Error ? error.message : 'Try again.'),
  })

  const saleMutation = useMutation({
    mutationFn: ({ id, body }: { id?: string | undefined; body: SaleValues }) => id
      ? api.patch<MutationReceipt, SaleValues>(`/sales/${id}`, body)
      : api.post<MutationReceipt, SaleValues>('/sales', body),
    onSuccess: async (receipt) => {
      setSaleOpen(false)
      setEditingSale(null)
      if (receipt.id) setInvoiceActionId(receipt.id)
      await invalidate()
      toast.success('Invoice saved', 'Review the invoice, print it, or send it to the customer on WhatsApp.')
    },
    onError: (error) => toast.error('Invoice was not saved', error instanceof Error ? error.message : 'Try again.'),
  })
  const paymentMutation = useMutation({
    mutationFn: ({ saleId, body }: { saleId: string; body: PaymentValues }) => api.post<MutationReceipt, PaymentValues>(`/sales/${saleId}/payments`, body),
    onSuccess: async () => {
      setPaymentSale(null)
      await invalidate()
      toast.success('Receipt posted', 'The invoice balance and accounting ledger are current.')
    },
    onError: (error) => toast.error('Receipt was not posted', error instanceof Error ? error.message : 'Try again.'),
  })
  const reverseSaleMutation = useMutation({
    mutationFn: (sale: Sale) => api.delete<MutationReceipt, { reason: string }>(`/sales/${sale.id}`, { reason: 'Reversed from sales workspace' }),
    onSuccess: async () => { setReverseSale(null); await invalidate(); toast.success('Invoice reversed', 'All stock and accounting effects were offset.') },
    onError: (error) => toast.error('Unable to reverse invoice', error instanceof Error ? error.message : 'Try again.'),
  })
  const reversePaymentMutation = useMutation({
    mutationFn: ({ sale, payment }: { sale: Sale; payment: Payment }) => api.delete<MutationReceipt, { reason: string }>(`/sales/${sale.id}/payments/${payment.id}`, { reason: 'Receipt reversed from sales workspace' }),
    onSuccess: async () => { setReversePayment(null); setPaymentSale(null); await invalidate(); toast.success('Receipt reversed', 'The invoice balance was restored.') },
    onError: (error) => toast.error('Unable to reverse receipt', error instanceof Error ? error.message : 'Try again.'),
  })

  const pageData = tab === 'outstanding' ? outstandingQuery.data : tab === 'report' ? reportQuery.data : salesQuery.data
  const visibleRows = pageData?.items ?? []
  const visibleRevenue = visibleRows.reduce((sum, sale) => sum + numberValue(sale.total_amount), 0)
  const visiblePaid = visibleRows.reduce((sum, sale) => sum + numberValue(sale.paid_amount), 0)
  const visibleDue = visibleRows.reduce((sum, sale) => sum + numberValue(sale.balance_due), 0)
  const changeTab = (value: SalesTab) => { setTab(value); setPage(1); setSearch('') }

  return (
    <div className="page-stack">
      <PageHeader eyebrow={`${year} sales`} title="Sales & receivables" description="Create invoices, settle balances, and inspect server-calculated customer receivables." actions={<Button icon={Plus} onClick={() => { setEditingSale(null); setSaleOpen(true) }}>New invoice</Button>} />
      <div className="stats-grid stats-grid--four">
        <StatCard label="Visible invoices" value={pageData?.total ?? 0} icon={ReceiptText} tone="blue" />
        <StatCard label="Visible sales" value={money(visibleRevenue)} icon={ShoppingCart} tone="green" />
        <StatCard label="Visible receipts" value={money(visiblePaid)} icon={Banknote} tone="purple" />
        <StatCard label="Visible balance" value={money(visibleDue)} icon={WalletCards} tone="amber" />
      </div>
      <Tabs value={tab} onChange={changeTab} ariaLabel="Sales sections" items={[
        { value: 'invoices', label: 'Invoices', icon: ReceiptText },
        { value: 'outstanding', label: 'Outstanding', icon: WalletCards },
        { value: 'report', label: 'Sales report', icon: FileBarChart },
      ]} />

      <Card className={tab === 'report' ? 'print-area' : undefined}>
        <SectionTitle
          title={tab === 'outstanding' ? 'Outstanding invoices' : tab === 'report' ? 'Sales report' : 'Posted invoices'}
          description="Search is executed by the API and results remain server-paginated."
          actions={tab === 'report' ? <Button variant="secondary" onClick={() => window.print()}>Print / save PDF</Button> : <Button icon={Plus} onClick={() => { setEditingSale(null); setSaleOpen(true) }}>New invoice</Button>}
        />
        <div className="toolbar no-print"><SearchBox value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="Search invoice number" /></div>
        <SalesTable
          query={tab === 'outstanding' ? outstandingQuery : tab === 'report' ? reportQuery : salesQuery}
          page={page}
          setPage={setPage}
          editingSaleId={editSaleMutation.isPending ? editSaleMutation.variables : undefined}
          onInvoice={(sale) => setInvoiceActionId(sale.id)}
          onEdit={(sale) => editSaleMutation.mutate(sale.id)}
          onPayment={setPaymentSale}
          onReverse={setReverseSale}
        />
      </Card>

      <SaleDialog open={saleOpen} record={editingSale} mutation={saleMutation} onClose={() => { setSaleOpen(false); setEditingSale(null) }} />
      <InvoiceActionsDialog saleId={invoiceActionId} onClose={() => setInvoiceActionId(null)} />
      <PaymentDialog sale={paymentSale} mutation={paymentMutation} onReverse={(payment) => { if (paymentSale) setReversePayment({ sale: paymentSale, payment }) }} onClose={() => setPaymentSale(null)} />
      <ConfirmDialog open={Boolean(reverseSale)} title="Reverse this invoice?" message={`${reverseSale?.invoice_no ?? 'This invoice'} will remain in the audit trail. Stock, revenue, COGS, and receipts will be offset atomically.`} destructive confirmLabel="Post reversal" busy={reverseSaleMutation.isPending} onCancel={() => setReverseSale(null)} onConfirm={() => { if (reverseSale) reverseSaleMutation.mutate(reverseSale) }} />
      <ConfirmDialog open={Boolean(reversePayment)} title="Reverse this receipt?" message={`${reversePayment?.payment.reference_no ?? 'This receipt'} will remain visible and its accounting effect will be offset.`} destructive confirmLabel="Reverse receipt" busy={reversePaymentMutation.isPending} onCancel={() => setReversePayment(null)} onConfirm={() => { if (reversePayment) reversePaymentMutation.mutate(reversePayment) }} />
    </div>
  )
}

function SalesTable({ query, page, setPage, editingSaleId, onInvoice, onEdit, onPayment, onReverse }: {
  query: ReturnType<typeof useQuery<Page<Sale>>>
  page: number
  setPage: (page: number) => void
  editingSaleId?: string | undefined
  onInvoice: (sale: Sale) => void
  onEdit: (sale: Sale) => void
  onPayment: (sale: Sale) => void
  onReverse: (sale: Sale) => void
}) {
  const rows = query.data?.items ?? []
  if (query.isLoading) return <LoadingState />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  if (!rows.length) return <EmptyState message="No invoices match the selected period and search." />
  return (
    <><TableWrap><table><thead><tr><th>Date / invoice</th><th>Customer</th><th className="numeric">Lines</th><th className="numeric">Total</th><th className="numeric">Paid</th><th className="numeric">Due</th><th>Status</th><th className="no-print"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{rows.map((sale) => <tr key={sale.id}>
        <td><strong className="mono">{sale.invoice_no}</strong><span className="table-subtext">{shortDate(sale.sale_date)} · {sale.reference_no}</span></td>
        <td><strong>{sale.customer_name}</strong><span className="table-subtext">{sale.customer_phone || 'No phone'}</span></td>
        <td className="numeric">{saleLines(sale).length}</td><td className="numeric">{money(sale.total_amount)}</td><td className="numeric">{money(sale.paid_amount)}</td><td className="numeric"><strong>{money(sale.balance_due)}</strong></td>
        <td><Badge tone={statusTone(sale.status === 'reversed' ? 'reversed' : sale.payment_status)}>{titleCase(sale.status === 'reversed' ? sale.status : sale.payment_status ?? 'unpaid')}</Badge></td>
        <td className="no-print"><div className="row-actions"><Button size="small" variant="ghost" icon={ReceiptText} onClick={() => onInvoice(sale)}>Invoice</Button><Button size="small" variant="ghost" icon={Banknote} disabled={sale.status === 'reversed'} onClick={() => onPayment(sale)}>Receipts</Button><Button size="small" variant="ghost" icon={Pencil} loading={editingSaleId === sale.id} disabled={sale.status === 'reversed' || Boolean(editingSaleId && editingSaleId !== sale.id)} onClick={() => onEdit(sale)}>Correct</Button><Button size="small" variant="ghost" icon={RotateCcw} disabled={sale.status === 'reversed'} onClick={() => onReverse(sale)}>Reverse</Button></div></td>
      </tr>)}</tbody></table></TableWrap><Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} /></>
  )
}

function SaleDialog({ open, record, mutation, onClose }: {
  open: boolean
  record: Sale | null
  mutation: ReturnType<typeof useMutation<MutationReceipt, Error, { id?: string | undefined; body: SaleValues }>>
  onClose: () => void
}) {
  const [selectedItems, setSelectedItems] = useState<Record<string, InventoryPosition>>({})
  const form = useForm<SaleValues>({
    resolver: zodResolver(saleSchema),
    values: {
      invoice_no: record?.invoice_no ?? '',
      sale_date: record?.sale_date ?? localIsoDate(),
      customer_name: record?.customer_name ?? '',
      customer_phone: record?.customer_phone ?? '',
      payment_method: 'accounts_receivable',
      amount_paid: record ? 0 : 0,
      items: (record ? saleLines(record) : []).map((line) => ({ item_id: line.item_id, quantity: numberValue(line.quantity), unit_price: numberValue(line.unit_price), discount: numberValue(line.discount) })).concat(record ? [] : [{ item_id: '', quantity: 1, unit_price: 0, discount: 0 }]),
    },
  })
  const fields = useFieldArray({ control: form.control, name: 'items' })
  const items = form.watch('items')
  const total = items.reduce((sum, line) => sum + numberValue(line.quantity) * numberValue(line.unit_price) - numberValue(line.discount), 0)
  const submit = form.handleSubmit((body) => mutation.mutate({ id: record?.id, body }))

  useEffect(() => {
    setSelectedItems({})
  }, [open, record?.id])

  return (
    <Dialog open={open} title={record ? 'Correct invoice' : 'Post sales invoice'} description="Availability, weighted COGS, and all journal lines are recalculated by the server." size="wide" onClose={onClose} closeDisabled={mutation.isPending} footer={<><Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button><Button icon={ShoppingCart} loading={mutation.isPending} onClick={() => void submit()}>Save invoice</Button></>}>
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <div className="form-grid form-grid--three">
          <Field label="Invoice number" required error={form.formState.errors.invoice_no?.message}><Input {...form.register('invoice_no')} /></Field>
          <Field label="Sale date" required error={form.formState.errors.sale_date?.message}><Input type="date" {...form.register('sale_date')} /></Field>
          <Field label="Customer name" required error={form.formState.errors.customer_name?.message}><Input {...form.register('customer_name')} /></Field>
          <Field label="Customer phone" error={form.formState.errors.customer_phone?.message}><Input type="tel" {...form.register('customer_phone')} /></Field>
          <Field label="Initial payment method" required><Select {...form.register('payment_method')}>{paymentMethods.map((method) => <option value={method} key={method}>{titleCase(method)}</option>)}</Select></Field>
          <Field label="Initial amount paid" error={form.formState.errors.amount_paid?.message}><Input type="number" min="0" step="0.01" {...form.register('amount_paid')} /></Field>
        </div>
        <SectionTitle title="Invoice items" description="Selecting a finished product loads its saved selling price (or a 50% cost fallback for older products). Quantity, offer discount, and price remain editable." actions={<Button type="button" size="small" variant="secondary" icon={Plus} onClick={() => fields.append({ item_id: '', quantity: 1, unit_price: 0, discount: 0 })}>Add line</Button>} />
        <div className="line-card-list">
          {fields.fields.map((field, index) => {
            const line = items[index]
            const selectedItem = selectedItems[field.id]
            const currentRecordLine = record ? saleLines(record)[index] : undefined
            const originalLine = record ? saleLines(record).find((item) => item.item_id === line?.item_id) : undefined
            const available = selectedItem
              ? numberValue(selectedItem.quantity_on_hand) + numberValue(originalLine?.quantity)
              : null
            const lineTotal = numberValue(line?.quantity) * numberValue(line?.unit_price) - numberValue(line?.discount)
            return <Card className="line-card line-card--sale" key={field.id}>
              <RemoteSelect<InventoryPosition>
                label={`Item ${index + 1}`}
                endpoint="/inventory/finished"
                queryKey="sale-finished-item-position"
                value={line?.item_id ?? ''}
                onChange={(value) => form.setValue(`items.${index}.item_id`, value, { shouldValidate: true })}
                onSelectItem={(item) => {
                  setSelectedItems((current) => {
                    if (!item) {
                      const next = { ...current }
                      delete next[field.id]
                      return next
                    }
                    return { ...current, [field.id]: item }
                  })
                  form.setValue(`items.${index}.quantity`, item ? 1 : 0, { shouldValidate: true })
                  form.setValue(`items.${index}.unit_price`, item ? suggestedUnitPrice(item) : 0, { shouldValidate: true })
                  form.setValue(`items.${index}.discount`, 0, { shouldValidate: true })
                }}
                optionValue={(item) => item.item_id}
                optionLabel={(item) => `${item.item_name} · ${item.sku || 'No SKU'} · ${quantity(item.quantity_on_hand, 3)} ${item.unit} available`}
                required
                error={form.formState.errors.items?.[index]?.item_id?.message}
                selectedLabel={currentRecordLine ? `${saleLineName(currentRecordLine)} · current invoice item` : undefined}
              />
              <div className="calculated-field calculated-field--stock" aria-live="polite">
                <span>Available stock</span>
                <strong>{available === null ? 'Select item' : `${quantity(available, 3)} ${selectedItem?.unit ?? ''}`}</strong>
                <small>{selectedItem ? `Saved price ${money(selectedItem.selling_price)} · weighted cost ${money(selectedItem.average_unit_cost)}` : 'Loaded from live finished-goods stock'}</small>
              </div>
              <Field label="Quantity" required error={form.formState.errors.items?.[index]?.quantity?.message}><Input type="number" min="0.000001" step="0.001" {...form.register(`items.${index}.quantity`)} /></Field>
              <Field label="Unit price" required hint="Auto-filled; you can change it." error={form.formState.errors.items?.[index]?.unit_price?.message}><Input type="number" min="0.01" step="0.01" {...form.register(`items.${index}.unit_price`)} /></Field>
              <Field label="Discount" error={form.formState.errors.items?.[index]?.discount?.message}><Input type="number" min="0" step="0.01" {...form.register(`items.${index}.discount`)} /></Field>
              <div className="calculated-field"><span>Line total</span><strong>{money(lineTotal)}</strong></div>
              <button type="button" className="icon-button icon-button--danger" disabled={fields.fields.length <= 1} onClick={() => fields.remove(index)} aria-label={`Remove invoice line ${index + 1}`}><Trash2 size={17} /></button>
            </Card>
          })}
        </div>
        <div className="form-total"><span>Invoice total</span><strong>{money(total)}</strong></div>
      </form>
    </Dialog>
  )
}

function escapeInvoiceHtml(value: unknown) {
  const text = typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
      ? `${value}`
      : ''
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function printInvoice(sale: Sale) {
  const popup = window.open('', '_blank')
  if (!popup) return false
  popup.opener = null
  const rows = saleLines(sale).map((line) => {
    const lineTotal = numberValue(line.line_total) || (
      numberValue(line.quantity) * numberValue(line.unit_price) - numberValue(line.discount)
    )
    return `<tr>
      <td>${escapeInvoiceHtml(saleLineName(line))}</td>
      <td class="number">${escapeInvoiceHtml(quantity(line.quantity, 3))}</td>
      <td class="number">${escapeInvoiceHtml(money(line.unit_price))}</td>
      <td class="number">${escapeInvoiceHtml(money(line.discount))}</td>
      <td class="number"><strong>${escapeInvoiceHtml(money(lineTotal))}</strong></td>
    </tr>`
  }).join('')
  popup.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice ${escapeInvoiceHtml(sale.invoice_no)}</title><style>
    *{box-sizing:border-box}body{margin:0;padding:36px;color:#172033;font:14px Arial,sans-serif}.sheet{max-width:900px;margin:0 auto}.head{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid #2457d6;padding-bottom:20px}.brand{font-size:25px;font-weight:800;color:#173e9b}.meta{text-align:right}.meta h1{margin:0 0 8px;font-size:24px}.meta p,.customer p{margin:4px 0;color:#566278}.customer{display:flex;justify-content:space-between;gap:24px;padding:24px 0}.customer strong{display:block;margin-bottom:6px;font-size:16px}table{width:100%;border-collapse:collapse}th,td{padding:11px 10px;border-bottom:1px solid #dde3ec;text-align:left}th{background:#f3f6fb;color:#566278;font-size:11px;text-transform:uppercase}.number{text-align:right}.totals{width:min(100%,360px);margin:22px 0 0 auto}.total-row{display:flex;justify-content:space-between;padding:7px 0}.total-row.grand{margin-top:5px;padding-top:12px;border-top:2px solid #172033;font-size:18px}.footer{margin-top:54px;padding-top:16px;border-top:1px solid #dde3ec;color:#69758a;font-size:12px}@media print{body{padding:0}@page{size:A4;margin:16mm}}
  </style></head><body><main class="sheet"><header class="head"><div><div class="brand">CK SYS</div><p>Sales invoice</p></div><div class="meta"><h1>INVOICE</h1><p><strong>${escapeInvoiceHtml(sale.invoice_no)}</strong></p><p>${escapeInvoiceHtml(shortDate(sale.sale_date))}</p><p>${escapeInvoiceHtml(sale.reference_no)}</p></div></header><section class="customer"><div><strong>Bill to</strong><p>${escapeInvoiceHtml(sale.customer_name)}</p><p>${escapeInvoiceHtml(sale.customer_phone || 'No phone number')}</p></div><div class="meta"><strong>Status</strong><p>${escapeInvoiceHtml(titleCase(sale.payment_status ?? 'unpaid'))}</p></div></section><table><thead><tr><th>Item</th><th class="number">Quantity</th><th class="number">Unit price</th><th class="number">Discount</th><th class="number">Amount</th></tr></thead><tbody>${rows}</tbody></table><section class="totals"><div class="total-row"><span>Paid</span><strong>${escapeInvoiceHtml(money(sale.paid_amount))}</strong></div><div class="total-row"><span>Balance due</span><strong>${escapeInvoiceHtml(money(sale.balance_due))}</strong></div><div class="total-row grand"><span>Total</span><strong>${escapeInvoiceHtml(money(sale.total_amount))}</strong></div></section><footer class="footer">Thank you for your business.</footer></main></body></html>`)
  popup.document.close()
  popup.focus()
  window.setTimeout(() => popup.print(), 150)
  return true
}

function InvoiceActionsDialog({ saleId, onClose }: { saleId: string | null; onClose: () => void }) {
  const toast = useToast()
  const invoiceQuery = useQuery({
    queryKey: ['sales', 'invoice', saleId],
    queryFn: ({ signal }) => api.get<Sale>(`/sales/${saleId}`, undefined, signal),
    enabled: Boolean(saleId),
  })
  const sale = invoiceQuery.data
  const whatsappPhone = normalizeWhatsAppPhone(sale?.customer_phone)
  const sendWhatsApp = () => {
    if (!sale || !whatsappPhone) return
    const popup = window.open(`https://wa.me/${whatsappPhone}?text=${encodeURIComponent(invoiceWhatsAppMessage(sale))}`, '_blank', 'noopener,noreferrer')
    if (!popup) toast.error('WhatsApp did not open', 'Allow pop-ups for this site and try again.')
  }
  const print = () => {
    if (sale && !printInvoice(sale)) toast.error('Print preview did not open', 'Allow pop-ups for this site and try again.')
  }

  return (
    <Dialog
      open={Boolean(saleId)}
      title={sale ? `Invoice ${sale.invoice_no}` : 'Saved invoice'}
      description="The invoice is saved. Print it now or send the payment summary to the customer."
      size="large"
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button variant="secondary" icon={MessageCircle} disabled={!sale || !whatsappPhone} onClick={sendWhatsApp}>Send WhatsApp</Button><Button icon={Printer} disabled={!sale} onClick={print}>Print invoice</Button></>}
    >
      {invoiceQuery.isLoading ? <LoadingState label="Preparing invoice…" /> : invoiceQuery.isError ? <ErrorState error={invoiceQuery.error} onRetry={() => void invoiceQuery.refetch()} /> : sale ? (
        <div className="invoice-preview">
          <div className="invoice-preview__header"><div><span className="eyebrow">Sales invoice</span><h3>{sale.customer_name}</h3><p>{sale.customer_phone || 'No customer phone number saved'}</p></div><div><strong className="mono">{sale.invoice_no}</strong><span>{shortDate(sale.sale_date)}</span><Badge tone={statusTone(sale.payment_status)}>{titleCase(sale.payment_status ?? 'unpaid')}</Badge></div></div>
          <TableWrap><table><thead><tr><th>Item</th><th className="numeric">Qty</th><th className="numeric">Unit price</th><th className="numeric">Discount</th><th className="numeric">Amount</th></tr></thead><tbody>{saleLines(sale).map((line) => <tr key={line.id}><td><strong>{saleLineName(line)}</strong><span className="table-subtext">{line.item?.sku || line.item_id.slice(0, 8)}</span></td><td className="numeric">{quantity(line.quantity, 3)}</td><td className="numeric">{money(line.unit_price)}</td><td className="numeric">{money(line.discount)}</td><td className="numeric"><strong>{money(line.line_total)}</strong></td></tr>)}</tbody></table></TableWrap>
          <div className="invoice-preview__totals"><span>Paid <strong>{money(sale.paid_amount)}</strong></span><span>Balance <strong>{money(sale.balance_due)}</strong></span><span>Total <strong>{money(sale.total_amount)}</strong></span></div>
          {!whatsappPhone ? <InlineNotice tone="warning" title="WhatsApp needs a phone number">Add a valid customer phone number to this invoice to enable WhatsApp.</InlineNotice> : null}
        </div>
      ) : null}
    </Dialog>
  )
}

function PaymentDialog({ sale, mutation, onReverse, onClose }: {
  sale: Sale | null
  mutation: ReturnType<typeof useMutation<MutationReceipt, Error, { saleId: string; body: PaymentValues }>>
  onReverse: (payment: Payment) => void
  onClose: () => void
}) {
  const form = useForm<PaymentValues>({ resolver: zodResolver(paymentSchema), values: { payment_date: localIsoDate(), amount: numberValue(sale?.balance_due), method: 'cash', notes: '' } })
  const submit = form.handleSubmit((body) => { if (sale) mutation.mutate({ saleId: sale.id, body }) })
  return (
    <Dialog open={Boolean(sale)} title={`Receipts · ${sale?.invoice_no ?? ''}`} description={`Current balance: ${money(sale?.balance_due)}`} size="large" onClose={onClose} closeDisabled={mutation.isPending} footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button icon={Banknote} loading={mutation.isPending} disabled={!sale || numberValue(sale.balance_due) <= 0} onClick={() => void submit()}>Post receipt</Button></>}>
      <form className="form-grid form-grid--two" onSubmit={(event) => void submit(event)}>
        <Field label="Payment date" required error={form.formState.errors.payment_date?.message}><Input type="date" {...form.register('payment_date')} /></Field>
        <Field label="Amount" required error={form.formState.errors.amount?.message}><Input type="number" min="0.01" max={numberValue(sale?.balance_due) || undefined} step="0.01" {...form.register('amount')} /></Field>
        <Field label="Method" required><Select {...form.register('method')}>{paymentMethods.filter((method) => method !== 'credit' && method !== 'accounts_receivable').map((method) => <option value={method} key={method}>{titleCase(method)}</option>)}</Select></Field>
        <Field label="Notes"><Textarea rows={2} {...form.register('notes')} /></Field>
      </form>
      <SectionTitle title="Receipt history" />
      {sale && salePayments(sale).length ? <TableWrap><table><thead><tr><th>Date / reference</th><th>Method</th><th className="numeric">Amount</th><th>Status</th><th /></tr></thead><tbody>{salePayments(sale).map((payment) => <tr key={payment.id}><td><strong className="mono">{payment.reference_no}</strong><span className="table-subtext">{shortDate(payment.payment_date)}</span></td><td>{titleCase(payment.method)}</td><td className="numeric">{money(payment.amount)}</td><td><Badge tone={statusTone(payment.status)}>{titleCase(payment.status ?? 'posted')}</Badge></td><td><Button size="small" variant="ghost" icon={RotateCcw} disabled={payment.status === 'reversed'} onClick={() => onReverse(payment)}>Reverse</Button></td></tr>)}</tbody></table></TableWrap> : <EmptyState message="No receipts have been posted for this invoice." />}
    </Dialog>
  )
}
