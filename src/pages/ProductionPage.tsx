import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { useFieldArray, useForm } from 'react-hook-form'
import {
  AlertTriangle,
  Boxes,
  CalendarDays,
  ChevronDown,
  CircleHelp,
  Factory,
  Gauge,
  PackagePlus,
  Pencil,
  Plus,
  Recycle,
  RotateCcw,
  Scale,
  Settings2,
  Trash2,
} from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { z } from 'zod'
import { api } from '../lib/api'
import { localIsoDate, money, numberValue, quantity, recordValue, shortDate, titleCase } from '../lib/format'
import type { Conversion, ConversionType, Employee, InventoryPosition, MutationReceipt, Page, PieceworkRate, ProductionRun, ProductionSummary, RawMaterialPurchase } from '../types/api'
import { useToast } from '../components/Toast'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { RemoteSelect } from '../components/RemoteSelect'
import { ConversionTypeDialog, PieceworkRateDialog } from '../components/ConversionSetupDialogs'
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

type ProductionTab = 'dashboard' | 'purchases' | 'conversions' | 'rates' | 'runs'
type ReverseTarget = { type: 'rm-purchases' | 'conversions' | 'piecework-rates' | 'production'; id: string; reference: string }

const purchaseSchema = z.object({
  id: z.string().optional(),
  reference_no: z.string().optional(),
  purchase_date: z.string().min(1),
  material: z.string().min(2, 'Material is required.'),
  supplier_name: z.string().max(160).optional(),
  supplier_phone: z.string().max(40).optional(),
  quantity_kg: z.coerce.number().positive('Quantity must be greater than zero.'),
  total_cost: z.coerce.number().positive('Cost must be greater than zero.'),
  payment_method: z.enum(['cash', 'bank_transfer', 'cheque', 'credit']),
  notes: z.string().max(2000).optional(),
})

const workerSchema = z.object({
  employee_id: z.string().uuid('Select an employee.'),
  rate_id: z.string().optional(),
  task: z.string().min(2),
  quantity_kg: z.coerce.number().positive(),
  rate_per_kg: z.coerce.number().positive(),
})

const conversionSchema = z.object({
  conversion_date: z.string().min(1),
  conversion_type_id: z.string().optional(),
  source_item_id: z.string().uuid('Select bulk material.'),
  chip_name: z.string().min(2, 'Chip stock name is required.'),
  chip_type: z.string().max(100).optional(),
  input_kg: z.coerce.number().positive(),
  output_kg: z.coerce.number().positive(),
  overhead_cost: z.coerce.number().min(0),
  workers: z.array(workerSchema).min(1, 'Allocate at least one worker.'),
}).superRefine((value, context) => {
  if (value.output_kg > value.input_kg * 1.02) {
    context.addIssue({ code: 'custom', message: 'Output may not exceed input by more than 2%.', path: ['output_kg'] })
  }
  if (!value.conversion_type_id && (!value.chip_type || value.chip_type.trim().length < 2)) {
    context.addIssue({ code: 'custom', message: 'Enter a manual conversion type.', path: ['chip_type'] })
  }
})

const productionSchema = z.object({
  id: z.string().optional(),
  reference_no: z.string().optional(),
  production_date: z.string().min(1),
  shift: z.string().max(60).optional(),
  machine: z.string().max(100).optional(),
  operator_employee_id: z.string().uuid('Select an operator.'),
  chip_item_id: z.string().uuid('Select converted chip stock.'),
  finished_item_id: z.string().optional(),
  finished_item_name: z.string().min(2, 'Finished product name is required.'),
  selling_price: z.coerce.number().positive('Selling price must be greater than zero.'),
  input_kg: z.coerce.number().positive(),
  output_quantity: z.coerce.number().positive(),
  working_hours: z.coerce.number().min(0),
  overhead_cost: z.coerce.number().min(0),
  notes: z.string().max(2000).optional(),
})

type PurchaseValues = z.infer<typeof purchaseSchema>
type ConversionValues = z.infer<typeof conversionSchema>
type ProductionValues = z.infer<typeof productionSchema>

const pageSize = 30

export function ProductionPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<ProductionTab>('dashboard')
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [purchaseOpen, setPurchaseOpen] = useState(false)
  const [conversionOpen, setConversionOpen] = useState(false)
  const [conversionTypeOpen, setConversionTypeOpen] = useState(false)
  const [rateOpen, setRateOpen] = useState(false)
  const [runOpen, setRunOpen] = useState(false)
  const [editingPurchase, setEditingPurchase] = useState<RawMaterialPurchase | null>(null)
  const [editingRate, setEditingRate] = useState<PieceworkRate | null>(null)
  const [editingRun, setEditingRun] = useState<ProductionRun | null>(null)
  const [reverseTarget, setReverseTarget] = useState<ReverseTarget | null>(null)

  const summaryQuery = useQuery({
    queryKey: ['production', 'summary', localIsoDate()],
    queryFn: ({ signal }) => api.get<ProductionSummary>('/production/summary', { as_of: localIsoDate() }, signal),
    enabled: tab === 'dashboard',
  })
  const ratesQuery = useQuery({
    queryKey: ['piecework-rates', page, search],
    queryFn: ({ signal }) => api.list<PieceworkRate>('/piecework-rates', { page, page_size: pageSize, q: search, descending: false }, signal),
    enabled: tab === 'rates',
  })
  const purchasesQuery = useQuery({
    queryKey: ['rm-purchases', page, search],
    queryFn: ({ signal }) => api.list<RawMaterialPurchase>('/rm-purchases', { page, page_size: pageSize, q: search }, signal),
    enabled: tab === 'purchases',
  })
  const conversionsQuery = useQuery({
    queryKey: ['conversions', page, search],
    queryFn: ({ signal }) => api.list<Conversion>('/conversions', { page, page_size: pageSize, q: search }, signal),
    enabled: tab === 'conversions',
  })
  const runsQuery = useQuery({
    queryKey: ['production', page, search],
    queryFn: ({ signal }) => api.list<ProductionRun>('/production', { page, page_size: pageSize, q: search }, signal),
    enabled: tab === 'runs',
  })

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['rm-purchases'] }),
      queryClient.invalidateQueries({ queryKey: ['conversions'] }),
      queryClient.invalidateQueries({ queryKey: ['piecework-rates'] }),
      queryClient.invalidateQueries({ queryKey: ['production'] }),
      queryClient.invalidateQueries({ queryKey: ['inventory'] }),
      queryClient.invalidateQueries({ queryKey: ['lookup'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      queryClient.invalidateQueries({ queryKey: ['open-earnings'] }),
    ])
  }

  const purchaseMutation = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Record<string, unknown> }) => id
      ? api.patch<MutationReceipt, Record<string, unknown>>(`/rm-purchases/${id}`, body)
      : api.post<MutationReceipt, Record<string, unknown>>('/rm-purchases', body),
    onSuccess: async () => { setPurchaseOpen(false); setEditingPurchase(null); await invalidate(); toast.success('Purchase posted', 'Raw-material stock and accounting are updated.') },
    onError: (error) => toast.error('Purchase not saved', error.message),
  })
  const conversionMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<MutationReceipt, Record<string, unknown>>('/conversions', body),
    onSuccess: async () => { setConversionOpen(false); await invalidate(); toast.success('Conversion posted', 'Bulk stock, chip stock, and piecework accruals are updated.') },
    onError: (error) => toast.error('Conversion not saved', error.message),
  })
  const runMutation = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Record<string, unknown> }) => id
      ? api.patch<MutationReceipt, Record<string, unknown>>(`/production/${id}`, body)
      : api.post<MutationReceipt, Record<string, unknown>>('/production', body),
    onSuccess: async () => { setRunOpen(false); setEditingRun(null); await invalidate(); toast.success('Production posted', 'Chip consumption and finished-goods stock are updated.') },
    onError: (error) => toast.error('Production not saved', error.message),
  })
  const reverseMutation = useMutation({
    mutationFn: (target: ReverseTarget) => api.delete<MutationReceipt, { reason: string }>(`/${target.type}/${target.id}`, { reason: `Reversed from ${titleCase(target.type)} workspace` }),
    onSuccess: async () => { setReverseTarget(null); await invalidate(); toast.success('Record reversed', 'The original remains visible in the audit trail.') },
    onError: (error) => toast.error('Unable to reverse record', error.message),
  })

  const openPurchase = (record?: RawMaterialPurchase) => { setEditingPurchase(record ?? null); setPurchaseOpen(true) }
  const openRate = (record?: PieceworkRate) => { setEditingRate(record ?? null); setRateOpen(true) }
  const openRun = (record?: ProductionRun) => { setEditingRun(record ?? null); setRunOpen(true) }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Manufacturing operations" title="Production & conversion" description="Control material procurement, conversion labor, piecework rates, and finished-goods production." actions={<Button icon={Plus} onClick={() => openRun()}>Record production</Button>} />
      <Tabs value={tab} onChange={(value) => { setTab(value); setPage(1); setSearch('') }} ariaLabel="Production sections" items={[
        { value: 'dashboard', label: 'Dashboard', icon: Gauge },
        { value: 'purchases', label: 'Bulk RM', icon: PackagePlus },
        { value: 'conversions', label: 'Conversions', icon: Recycle },
        { value: 'rates', label: 'Rate master', icon: Settings2 },
        { value: 'runs', label: 'Production runs', icon: Factory },
      ]} />

      {tab === 'dashboard' ? summaryQuery.isLoading ? <LoadingState label="Calculating manufacturing position…" /> : summaryQuery.isError ? <ErrorState error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} /> : summaryQuery.data ? <ProductionDashboard summary={summaryQuery.data} /> : null : null}
      {tab === 'purchases' ? <PurchaseList query={purchasesQuery} search={search} setSearch={setSearch} page={page} setPage={setPage} onAdd={() => openPurchase()} onEdit={openPurchase} onReverse={(record) => setReverseTarget({ type: 'rm-purchases', id: record.id, reference: record.reference_no ?? record.id })} /> : null}
      {tab === 'conversions' ? <ConversionList query={conversionsQuery} search={search} setSearch={setSearch} page={page} setPage={setPage} onAdd={() => setConversionOpen(true)} onAddType={() => setConversionTypeOpen(true)} onAddRate={() => openRate()} onReverse={(record) => setReverseTarget({ type: 'conversions', id: record.id, reference: record.reference_no ?? record.id })} /> : null}
      {tab === 'rates' ? <RateList query={ratesQuery} search={search} setSearch={setSearch} page={page} setPage={setPage} onAdd={() => openRate()} onEdit={openRate} onReverse={(record) => setReverseTarget({ type: 'piecework-rates', id: record.id, reference: record.work_type ?? record.id })} /> : null}
      {tab === 'runs' ? <RunList query={runsQuery} search={search} setSearch={setSearch} page={page} setPage={setPage} onAdd={() => openRun()} onEdit={openRun} onReverse={(record) => setReverseTarget({ type: 'production', id: record.id, reference: record.reference_no ?? record.id })} /> : null}

      <PurchaseDialog open={purchaseOpen} record={editingPurchase} mutation={purchaseMutation} onClose={() => { setPurchaseOpen(false); setEditingPurchase(null) }} />
      <ConversionDialog open={conversionOpen} mutation={conversionMutation} onClose={() => setConversionOpen(false)} />
      <ConversionTypeDialog open={conversionTypeOpen} record={null} onClose={() => setConversionTypeOpen(false)} />
      <PieceworkRateDialog open={rateOpen} record={editingRate} onClose={() => { setRateOpen(false); setEditingRate(null) }} />
      <ProductionDialog open={runOpen} record={editingRun} mutation={runMutation} onClose={() => { setRunOpen(false); setEditingRun(null) }} />
      <ConfirmDialog open={Boolean(reverseTarget)} title="Reverse this posted record?" message={`${reverseTarget?.reference ?? 'This record'} will remain in the audit trail. Inventory and financial effects will be offset atomically.`} destructive confirmLabel="Post reversal" busy={reverseMutation.isPending} onCancel={() => setReverseTarget(null)} onConfirm={() => { if (reverseTarget) reverseMutation.mutate(reverseTarget) }} />
    </div>
  )
}

function ProductionDashboard({ summary }: { summary: ProductionSummary }) {
  const chart = summary.recent_daily.map((row) => ({
    date: row.production_date.slice(5),
    output: numberValue(row.output_quantity),
  }))
  return <div className="page-stack">
    <div className="stats-grid stats-grid--four">
      <StatCard label="Today's output" value={`${quantity(summary.today_output_quantity)} units`} hint={`${summary.today_runs} posted runs`} icon={Factory} tone="green" />
      <StatCard label="Today's chip input" value={`${quantity(summary.today_input_kg)} kg`} icon={Scale} tone="blue" />
      <StatCard label="Month production" value={`${quantity(summary.month_output_quantity)} units`} hint={`${summary.month_runs} posted runs`} icon={CalendarDays} tone="purple" />
      <StatCard label="Live material value" value={money(numberValue(summary.bulk_value) + numberValue(summary.chip_value))} icon={Boxes} tone="amber" />
    </div>
    <div className="dashboard-grid">
      <Card className="chart-card"><SectionTitle title="Recent production" description="Finished units by production date" />{chart.length ? <div className="chart-frame"><ResponsiveContainer width="100%" height="100%"><BarChart data={chart}><CartesianGrid vertical={false} strokeDasharray="3 3" /><XAxis dataKey="date" /><YAxis /><Tooltip /><Bar dataKey="output" name="Output" fill="#2563eb" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer></div> : <EmptyState message="Production trends appear after runs are posted." />}</Card>
      <Card><SectionTitle title="Current pipeline" description="Database-calculated totals across the complete catalogue" /><dl className="metric-list"><div><dt>Bulk materials</dt><dd>{summary.bulk_item_count}</dd></div><div><dt>Bulk value</dt><dd>{money(summary.bulk_value)}</dd></div><div><dt>Chip materials</dt><dd>{summary.chip_item_count}</dd></div><div><dt>Chip value</dt><dd>{money(summary.chip_value)}</dd></div></dl></Card>
    </div>
  </div>
}

function PurchaseList({ query, search, setSearch, page, setPage, onAdd, onEdit, onReverse }: { query: ReturnType<typeof useQuery<Page<RawMaterialPurchase>>>; search: string; setSearch: (value: string) => void; page: number; setPage: (value: number) => void; onAdd: () => void; onEdit: (record: RawMaterialPurchase) => void; onReverse: (record: RawMaterialPurchase) => void }) {
  const rows = query.data?.items ?? []
  return <Card><SectionTitle title="Raw-material procurement" description="Posted purchases add bulk stock and create the configured cash, bank, or payable accounting effect." actions={<Button icon={Plus} onClick={onAdd}>New purchase</Button>} /><div className="toolbar"><SearchBox value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="Search reference" /></div>{query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : rows.length ? <><TableWrap><table><thead><tr><th>Date / reference</th><th>Supplier</th><th>Material</th><th className="numeric">Quantity</th><th className="numeric">Cost</th><th>Method</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><strong className="mono">{row.reference_no ?? '—'}</strong><span className="table-subtext">{shortDate(row.purchase_date ?? row.date)}</span></td><td>{row.supplier_name ?? '—'}<span className="table-subtext">{row.supplier_phone ?? ''}</span></td><td><strong>{row.material_name ?? row.inventory_items?.name ?? recordValue<string>(row, 'item_name') ?? 'Material'}</strong></td><td className="numeric">{quantity(row.quantity_kg ?? row.qty)} kg</td><td className="numeric">{money(row.total_cost)}</td><td><Badge>{titleCase(row.payment_method)}</Badge></td><td><Badge tone={row.status === 'reversed' ? 'danger' : 'success'}>{titleCase(row.status ?? 'posted')}</Badge></td><td><div className="row-actions"><Button variant="ghost" size="small" icon={Pencil} disabled={row.status === 'reversed'} onClick={() => onEdit(row)}>Edit</Button><Button variant="ghost" size="small" icon={RotateCcw} disabled={row.status === 'reversed'} onClick={() => onReverse(row)}>Reverse</Button></div></td></tr>)}</tbody></table></TableWrap><Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} /></> : <EmptyState message="No material purchases match the current search." action={<Button icon={Plus} onClick={onAdd}>Post first purchase</Button>} />}</Card>
}

function ConversionList({ query, search, setSearch, page, setPage, onAdd, onAddType, onAddRate, onReverse }: { query: ReturnType<typeof useQuery<Page<Conversion>>>; search: string; setSearch: (value: string) => void; page: number; setPage: (value: number) => void; onAdd: () => void; onAddType: () => void; onAddRate: () => void; onReverse: (record: Conversion) => void }) {
  const rows = query.data?.items ?? []
  return <Card><SectionTitle title="Bulk-to-chip conversions" description="Each batch consumes bulk material, produces chip stock, and creates dated employee earnings for payroll." actions={<div className="row-actions"><Button variant="secondary" icon={Plus} onClick={onAddType}>Add type</Button><Button variant="secondary" icon={Plus} onClick={onAddRate}>Add rate</Button><Button icon={Plus} onClick={onAdd}>New conversion</Button></div>} /><InlineNotice tone="success" title="Worker allocations flow to payroll">Every posted worker amount appears in Staff & payroll → Open earnings for that employee and can be claimed in a daily or monthly payroll.</InlineNotice><div className="toolbar"><SearchBox value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="Material, chip, worker, or reference" /></div>{query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : rows.length ? <><TableWrap><table><thead><tr><th>Date / reference</th><th>Conversion</th><th className="numeric">Input</th><th className="numeric">Output</th><th className="numeric">Waste</th><th className="numeric">Labor earning</th><th>Workers</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map((row) => { const workers = row.conversion_workers ?? row.workers ?? []; const input = numberValue(row.input_kg ?? row.source_quantity_kg); const output = numberValue(row.output_kg ?? row.output_quantity_kg); return <tr key={row.id}><td><strong className="mono">{row.reference_no ?? '—'}</strong><span className="table-subtext">{shortDate(row.conversion_date ?? row.date)}</span></td><td><strong>{recordValue<string>(row, 'source_item_name', 'source_material_name') ?? 'Bulk material'} → {recordValue<string>(row, 'output_item_name', 'chip_name') ?? 'Chip'}</strong><span className="table-subtext">{row.conversion_type?.name ?? row.chip_type ?? ''}</span></td><td className="numeric">{quantity(input)} kg</td><td className="numeric">{quantity(output)} kg</td><td className="numeric">{quantity(row.waste_quantity_kg ?? input - output)} kg</td><td className="numeric">{money(row.labor_cost ?? workers.reduce((sum, worker) => sum + numberValue(worker.amount), 0))}</td><td><Badge tone="purple">{workers.length} earning{workers.length === 1 ? '' : 's'}</Badge></td><td><Badge tone={row.status === 'reversed' ? 'danger' : 'success'}>{titleCase(row.status ?? 'posted')}</Badge></td><td><Button variant="ghost" size="small" icon={RotateCcw} disabled={row.status === 'reversed'} onClick={() => onReverse(row)}>Reverse</Button></td></tr> })}</tbody></table></TableWrap><Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} /></> : <EmptyState message="No conversion batches match the current search." />}</Card>
}

function RateList({ query, search, setSearch, page, setPage, onAdd, onEdit, onReverse }: { query: ReturnType<typeof useQuery<Page<PieceworkRate>>>; search: string; setSearch: (value: string) => void; page: number; setPage: (value: number) => void; onAdd: () => void; onEdit: (record: PieceworkRate) => void; onReverse: (record: PieceworkRate) => void }) {
  const rates = query.data?.items ?? []
  return <Card><SectionTitle title="Conversion rate master" description="Rates are effective-dated; historical worker earnings retain their original rate snapshots." actions={<Button icon={Plus} onClick={onAdd}>Add type / rate</Button>} /><div className="toolbar"><SearchBox value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="Search conversion work type" /></div>{query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : rates.length ? <><TableWrap><table><thead><tr><th>Conversion / work type</th><th className="numeric">Rate / kg</th><th>Effective period</th><th>Status</th><th>Notes</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rates.map((rate) => <tr key={rate.id}><td><strong>{rate.work_type ?? rate.type}</strong></td><td className="numeric">{money(rate.rate_per_kg)}</td><td>{shortDate(rate.effective_from)}<span className="table-subtext">to {rate.effective_to ? shortDate(rate.effective_to) : 'Open ended'}</span></td><td><Badge tone={rate.status === 'active' ? 'success' : 'neutral'}>{titleCase(rate.status)}</Badge></td><td>{rate.notes ?? '—'}</td><td><div className="row-actions"><Button variant="ghost" size="small" icon={Pencil} onClick={() => onEdit(rate)}>Edit</Button><Button variant="ghost" size="small" icon={RotateCcw} disabled={rate.status === 'inactive'} onClick={() => onReverse(rate)}>Deactivate</Button></div></td></tr>)}</tbody></table></TableWrap><Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} /></> : <EmptyState message="No conversion rates are configured. Add a type and rate, or use Manual while posting a conversion." action={<Button icon={Plus} onClick={onAdd}>Add first rate</Button>} />}</Card>
}

function RunList({ query, search, setSearch, page, setPage, onAdd, onEdit, onReverse }: { query: ReturnType<typeof useQuery<Page<ProductionRun>>>; search: string; setSearch: (value: string) => void; page: number; setPage: (value: number) => void; onAdd: () => void; onEdit: (record: ProductionRun) => void; onReverse: (record: ProductionRun) => void }) {
  const rows = query.data?.items ?? []
  return <Card><SectionTitle title="Master production log" description="Posted chip consumption and finished-goods output with immutable costing snapshots." actions={<Button icon={Plus} onClick={onAdd}>Record production</Button>} /><div className="toolbar"><SearchBox value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="Product, machine, operator, or reference" /></div>{query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : rows.length ? <><TableWrap><table><thead><tr><th>Date / reference</th><th>Machine / operator</th><th>Output</th><th className="numeric">Quantity</th><th>Chip input</th><th className="numeric">Total cost</th><th className="numeric">Unit cost</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map((row) => { const output = numberValue(row.output_quantity ?? row.quantity ?? row.qty); const total = numberValue(row.total_cost); return <tr key={row.id}><td><strong className="mono">{row.reference_no ?? '—'}</strong><span className="table-subtext">{shortDate(row.production_date ?? row.date)}</span></td><td><strong>{row.machine ?? 'No machine'}</strong><span className="table-subtext">{row.operator_name ?? recordValue<string>(row, 'employee_name') ?? '—'} · {row.shift ?? 'No shift'}</span></td><td><strong>{row.finished_item_name ?? row.item_name ?? recordValue<string>(row, 'output_item_name') ?? 'Finished item'}</strong></td><td className="numeric">{quantity(output)}</td><td>{row.chip_name ?? row.raw_material_name ?? recordValue<string>(row, 'input_item_name') ?? 'Chip'}<span className="table-subtext">{quantity(row.input_kg ?? row.raw_material_quantity_kg)} kg</span></td><td className="numeric">{money(total)}</td><td className="numeric">{money(row.unit_cost ?? (output ? total / output : 0))}</td><td><Badge tone={row.status === 'reversed' ? 'danger' : 'success'}>{titleCase(row.status ?? 'posted')}</Badge></td><td><div className="row-actions"><Button variant="ghost" size="small" icon={Pencil} disabled={row.status === 'reversed'} onClick={() => onEdit(row)}>Edit</Button><Button variant="ghost" size="small" icon={RotateCcw} disabled={row.status === 'reversed'} onClick={() => onReverse(row)}>Reverse</Button></div></td></tr> })}</tbody></table></TableWrap><Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} /></> : <EmptyState message="No production runs match the current search." />}</Card>
}

function PurchaseDialog({ open, record, mutation, onClose }: { open: boolean; record: RawMaterialPurchase | null; mutation: ReturnType<typeof useMutation<MutationReceipt, Error, { id?: string; body: Record<string, unknown> }>>; onClose: () => void }) {
  const form = useForm<PurchaseValues>({ resolver: zodResolver(purchaseSchema), values: { id: record?.id, reference_no: record?.reference_no ?? '', purchase_date: record?.purchase_date ?? record?.date ?? localIsoDate(), material: record?.material_name ?? record?.inventory_items?.name ?? recordValue<string>(record ?? {}, 'item_name') ?? '', supplier_name: record?.supplier_name ?? '', supplier_phone: record?.supplier_phone ?? '', quantity_kg: numberValue(record?.quantity_kg ?? record?.qty), total_cost: numberValue(record?.total_cost), payment_method: (record?.payment_method as PurchaseValues['payment_method']) ?? 'credit', notes: record?.notes ?? '' } })
  const submit = form.handleSubmit((values) => mutation.mutate({ ...(values.id ? { id: values.id } : {}), body: { ...(values.reference_no ? { reference_no: values.reference_no } : {}), purchase_date: values.purchase_date, material_name: values.material, supplier_name: values.supplier_name || null, supplier_phone: values.supplier_phone || null, quantity_kg: values.quantity_kg, total_cost: values.total_cost, payment_method: values.payment_method, notes: values.notes || null } }))
  return <Dialog open={open} onClose={onClose} title={record ? 'Correct raw-material purchase' : 'Post raw-material purchase'} description="The server validates stock and posts the accounting entry in one transaction." closeDisabled={mutation.isPending} footer={<><Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button><Button icon={PackagePlus} loading={mutation.isPending} onClick={() => void submit()}>Save purchase</Button></>}><form className="form-grid form-grid--two" onSubmit={(event) => void submit(event)}><Field label="Purchase date" required error={form.formState.errors.purchase_date?.message}><Input type="date" {...form.register('purchase_date')} /></Field><Field label="Payment method" required><Select {...form.register('payment_method')}><option value="credit">Accounts payable</option><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="cheque">Cheque</option></Select></Field><Field label="Material" required error={form.formState.errors.material?.message}><Input {...form.register('material')} /></Field><Field label="Quantity (kg)" required error={form.formState.errors.quantity_kg?.message}><Input type="number" min="0.000001" step="0.001" {...form.register('quantity_kg')} /></Field><Field label="Supplier name"><Input {...form.register('supplier_name')} /></Field><Field label="Supplier phone"><Input type="tel" {...form.register('supplier_phone')} /></Field><Field label="Total cost" required error={form.formState.errors.total_cost?.message}><Input type="number" min="0.01" step="0.01" {...form.register('total_cost')} /></Field><Field label="Notes"><Textarea rows={2} {...form.register('notes')} /></Field></form></Dialog>
}

function ConversionDialog({ open, mutation, onClose }: { open: boolean; mutation: ReturnType<typeof useMutation<MutationReceipt, Error, Record<string, unknown>>>; onClose: () => void }) {
  const [selectedBulk, setSelectedBulk] = useState<InventoryPosition | undefined>()
  const defaultValues: ConversionValues = { conversion_date: localIsoDate(), conversion_type_id: '', source_item_id: '', chip_name: '', chip_type: '', input_kg: 0, output_kg: 0, overhead_cost: 0, workers: [{ employee_id: '', rate_id: '', task: '', quantity_kg: 0, rate_per_kg: 0 }] }
  const form = useForm<ConversionValues>({ resolver: zodResolver(conversionSchema), defaultValues })
  const fields = useFieldArray({ control: form.control, name: 'workers' })
  const typesQuery = useQuery({
    queryKey: ['conversion-types', 'conversion-entry'],
    queryFn: ({ signal }) => api.list<ConversionType>('/conversion-types', { page: 1, page_size: 100, status: 'active', descending: false }, signal),
    enabled: open,
    staleTime: 30_000,
  })
  const ratesQuery = useQuery({
    queryKey: ['piecework-rates', 'conversion-entry'],
    queryFn: ({ signal }) => api.list<PieceworkRate>('/piecework-rates', { page: 1, page_size: 100, status: 'active', descending: false }, signal),
    enabled: open,
    staleTime: 30_000,
  })
  useEffect(() => {
    if (open) {
      form.reset(defaultValues)
      setSelectedBulk(undefined)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const watched = form.watch()
  const types = typesQuery.data?.items ?? []
  const selectedTypeId = watched.conversion_type_id ?? ''
  const selectedType = types.find((item) => item.id === selectedTypeId)
  const effectiveRates = (ratesQuery.data?.items ?? []).filter((rate) => (
    rate.status === 'active'
    && rate.effective_from <= watched.conversion_date
    && (!rate.effective_to || rate.effective_to >= watched.conversion_date)
  ))
  const visibleRates = selectedTypeId
    ? effectiveRates.filter((rate) => rate.conversion_type_id === selectedTypeId || (!rate.conversion_type_id && rate.work_type === selectedType?.name))
    : effectiveRates
  const labor = watched.workers.reduce((sum, worker) => sum + numberValue(worker.quantity_kg) * numberValue(worker.rate_per_kg), 0)
  const waste = numberValue(watched.input_kg) - numberValue(watched.output_kg)
  const chooseRate = (index: number, rateId: string) => {
    if (rateId === '__manual__') {
      form.setValue(`workers.${index}.rate_id`, '', { shouldValidate: true })
      return
    }
    const rate = effectiveRates.find((item) => item.id === rateId)
    form.setValue(`workers.${index}.rate_id`, rateId, { shouldValidate: true })
    if (rate) {
      form.setValue(`workers.${index}.task`, rate.work_type ?? rate.type ?? '', { shouldValidate: true })
      form.setValue(`workers.${index}.rate_per_kg`, numberValue(rate.rate_per_kg), { shouldValidate: true })
    }
  }
  const chooseType = (value: string) => {
    if (value === '__manual__') {
      form.setValue('conversion_type_id', '')
      return
    }
    const type = types.find((item) => item.id === value)
    form.setValue('conversion_type_id', value, { shouldValidate: true })
    if (!type) return
    form.setValue('chip_type', type.name, { shouldValidate: true })
    form.setValue('chip_name', type.default_chip_name ?? '', { shouldValidate: true })
    const matchingRates = effectiveRates.filter((rate) => rate.conversion_type_id === value || (!rate.conversion_type_id && rate.work_type === type.name))
    const validIds = new Set(matchingRates.map((rate) => rate.id))
    watched.workers.forEach((worker, index) => {
      if (matchingRates.length === 1) {
        chooseRate(index, matchingRates[0]!.id)
      } else if (worker.rate_id && !validIds.has(worker.rate_id)) {
        form.setValue(`workers.${index}.rate_id`, '')
        form.setValue(`workers.${index}.task`, '')
        form.setValue(`workers.${index}.rate_per_kg`, 0)
      }
    })
  }
  const appendWorker = () => {
    const onlyRate = visibleRates.length === 1 ? visibleRates[0] : undefined
    fields.append({
      employee_id: '',
      rate_id: onlyRate?.id ?? '',
      task: onlyRate?.work_type ?? onlyRate?.type ?? selectedType?.name ?? '',
      quantity_kg: 0,
      rate_per_kg: numberValue(onlyRate?.rate_per_kg),
    })
  }
  const submit = form.handleSubmit((values) => mutation.mutate({ conversion_date: values.conversion_date, conversion_type_id: values.conversion_type_id || null, source_item_id: values.source_item_id, chip_name: values.chip_name, chip_type: selectedType?.name ?? (values.chip_type || null), input_kg: values.input_kg, output_kg: values.output_kg, overhead_cost: values.overhead_cost, workers: values.workers.map((worker) => ({ employee_id: worker.employee_id, rate_id: worker.rate_id || null, task: worker.task, quantity_kg: worker.quantity_kg, rate_per_kg: worker.rate_per_kg, amount: Math.round(worker.quantity_kg * worker.rate_per_kg * 100) / 100 })) }))
  return (
    <Dialog open={open} onClose={onClose} title="Post bulk-to-chip conversion" description="Choose saved setup values for fast entry, or select Manual to type one-off data." size="wide" closeDisabled={mutation.isPending} footer={<><Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button><Button icon={Recycle} loading={mutation.isPending} onClick={() => void submit()}>Post conversion & earnings</Button></>}>
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <div className="form-grid form-grid--three">
          <Field label="Conversion date" required><Input type="date" {...form.register('conversion_date')} /></Field>
          <Field label="Conversion type" required hint={typesQuery.isError ? 'Saved types could not be loaded. Choose Manual to continue.' : undefined}>
            <Select aria-label="Conversion type" value={selectedTypeId || '__manual__'} onChange={(event) => chooseType(event.target.value)}>
              <option value="__manual__">Manual — type your own</option>
              {typesQuery.isLoading ? <option value="" disabled>Loading saved types…</option> : null}
              {types.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
          </Field>
          <RemoteSelect<InventoryPosition>
            label="Bulk material"
            endpoint="/inventory/bulk"
            queryKey="conversion-bulk"
            value={form.watch('source_item_id')}
            onChange={(value) => form.setValue('source_item_id', value, { shouldValidate: true })}
            onSelectItem={(item) => {
              setSelectedBulk(item)
              if (item) form.setValue('input_kg', numberValue(item.quantity_on_hand), { shouldValidate: true })
            }}
            optionValue={(item) => item.item_id}
            optionLabel={(item) => `${item.item_name} · ${quantity(item.quantity_on_hand)} kg available`}
            required
            error={form.formState.errors.source_item_id?.message}
          />
          <Field label="Input kg" required error={form.formState.errors.input_kg?.message} hint={selectedBulk ? `${quantity(selectedBulk.quantity_on_hand)} kg currently available; adjust this batch quantity if needed.` : undefined}><Input type="number" min="0.000001" max={selectedBulk ? numberValue(selectedBulk.quantity_on_hand) : undefined} step="0.001" {...form.register('input_kg')} /></Field>
          <Field label="Chip stock name" required error={form.formState.errors.chip_name?.message}><Input {...form.register('chip_name')} /></Field>
          {!selectedTypeId ? <Field label="Manual conversion type" required error={form.formState.errors.chip_type?.message}><Input {...form.register('chip_type')} placeholder="Describe this conversion" /></Field> : null}
          <Field label="Output kg" required error={form.formState.errors.output_kg?.message}><Input type="number" min="0.000001" step="0.001" {...form.register('output_kg')} /></Field>
          <OverheadCostField inputId="conversion-overhead-cost"><Input id="conversion-overhead-cost" type="number" min="0" step="0.01" {...form.register('overhead_cost')} /></OverheadCostField>
          <div className="calculated-field"><span>Waste / gain</span><strong className={waste < 0 ? 'text-danger' : ''}>{quantity(waste)} kg</strong><small>Maximum output: {quantity(numberValue(watched.input_kg) * 1.02)} kg</small></div>
          <div className="calculated-field"><span>Labor allocation</span><strong>{money(labor)}</strong><small>Server recalculates every line</small></div>
        </div>
        <div className="setup-guidance-list">
          {(typesQuery.isError || ratesQuery.isError) ? <SetupGuidance tone="warning" title="Some saved setup values are unavailable">Manual type, task, and rate entry remains available. Saved selections will return after the database request succeeds.</SetupGuidance> : null}
          {!ratesQuery.isLoading && !ratesQuery.isError && !effectiveRates.length ? <SetupGuidance title="No effective conversion rates for this date">Choose Manual in Rate source and enter the task and rate. Use Add rate on the Conversions page to save it for future entries.</SetupGuidance> : null}
        </div>
        <SectionTitle title="Worker allocation & employee earnings" description="Each row creates a dated open earning on the selected employee profile." actions={<Button type="button" variant="secondary" size="small" icon={Plus} onClick={appendWorker}>Add worker</Button>} />
        <InlineNotice tone="success" title="Ready for daily or monthly payroll">After posting, every amount below is available in Staff & payroll → Open earnings and can be included when settling that employee.</InlineNotice>
        <TableWrap>
          <table className="entry-table">
            <thead><tr><th>Employee</th><th>Rate source</th><th>Task / earning</th><th className="numeric">Kg</th><th className="numeric">Rate / kg</th><th className="numeric">Income amount</th><th /></tr></thead>
            <tbody>{fields.fields.map((field, index) => {
              const row = watched.workers[index]
              const taskField = form.register(`workers.${index}.task`)
              const rateField = form.register(`workers.${index}.rate_per_kg`)
              const switchToManual = () => {
                if (row?.rate_id) form.setValue(`workers.${index}.rate_id`, '', { shouldValidate: true })
              }
              return <tr key={field.id}>
                <td><RemoteSelect<Employee> compact label={`Worker ${index + 1}`} endpoint="/employees" queryKey={`conversion-worker-${index}`} query={{ status: 'active' }} value={row?.employee_id ?? ''} onChange={(value) => form.setValue(`workers.${index}.employee_id`, value, { shouldValidate: true })} optionValue={(employee) => employee.id} optionLabel={(employee) => `${employee.name} · ${employee.employee_no ?? 'No ID'}`} placeholder="Select employee" /></td>
                <td><Select aria-label={`Rate source ${index + 1}`} value={row?.rate_id || '__manual__'} onChange={(event) => chooseRate(index, event.target.value)}><option value="__manual__">Manual — enter below</option>{ratesQuery.isLoading ? <option value="" disabled>Loading rates…</option> : null}{visibleRates.map((rate) => <option value={rate.id} key={rate.id}>{rate.work_type ?? rate.type ?? 'Rate'} · {money(rate.rate_per_kg)}</option>)}</Select></td>
                <td><Input aria-label={`Task ${index + 1}`} {...taskField} onChange={(event) => { void taskField.onChange(event); switchToManual() }} title={row?.rate_id ? 'Editing this saved value switches the rate source to Manual.' : undefined} /></td>
                <td><Input aria-label={`Worker quantity ${index + 1}`} type="number" min="0.000001" step="0.001" {...form.register(`workers.${index}.quantity_kg`)} /></td>
                <td><Input aria-label={`Worker rate ${index + 1}`} type="number" min="0.01" step="0.01" {...rateField} onChange={(event) => { void rateField.onChange(event); switchToManual() }} title={row?.rate_id ? 'Editing this saved value switches the rate source to Manual.' : undefined} /></td>
                <td className="numeric"><strong>{money(numberValue(row?.quantity_kg) * numberValue(row?.rate_per_kg))}</strong></td>
                <td><button type="button" className="icon-button icon-button--danger" disabled={fields.fields.length <= 1} onClick={() => fields.remove(index)} aria-label={`Remove worker ${index + 1}`}><Trash2 size={16} /></button></td>
              </tr>
            })}</tbody>
          </table>
        </TableWrap>
        {form.formState.errors.workers?.message ? <span className="field__error" role="alert">{form.formState.errors.workers.message}</span> : null}
      </form>
    </Dialog>
  )
}

function ProductionDialog({ open, record, mutation, onClose }: { open: boolean; record: ProductionRun | null; mutation: ReturnType<typeof useMutation<MutationReceipt, Error, { id?: string; body: Record<string, unknown> }>>; onClose: () => void }) {
  const [selectedChip, setSelectedChip] = useState<InventoryPosition | undefined>()
  const form = useForm<ProductionValues>({ resolver: zodResolver(productionSchema), values: { id: record?.id, reference_no: record?.reference_no ?? '', production_date: record?.production_date ?? record?.date ?? localIsoDate(), shift: record?.shift ?? '', machine: record?.machine ?? '', operator_employee_id: record?.operator_employee_id ?? '', chip_item_id: record?.chip_item_id ?? '', finished_item_id: record?.finished_item_id ?? '', finished_item_name: record?.finished_item_name ?? record?.finished_item?.name ?? record?.item_name ?? recordValue<string>(record ?? {}, 'output_item_name') ?? '', selling_price: numberValue(record?.finished_item?.selling_price), input_kg: numberValue(record?.input_kg ?? record?.raw_material_quantity_kg), output_quantity: numberValue(record?.output_quantity ?? record?.quantity ?? record?.qty), working_hours: numberValue(record?.working_hours), overhead_cost: numberValue(record?.overhead_cost), notes: record?.notes ?? '' } })
  const watched = form.watch()
  const reusingFinishedProduct = Boolean(watched.finished_item_id)
  const estimatedMaterial = selectedChip
    ? numberValue(watched.input_kg) * numberValue(selectedChip.average_unit_cost)
    : numberValue(record?.material_cost)
  const estimatedTotal = estimatedMaterial + numberValue(watched.overhead_cost)
  const submit = form.handleSubmit((values) => mutation.mutate({ ...(values.id ? { id: values.id } : {}), body: { ...(values.reference_no ? { reference_no: values.reference_no } : {}), production_date: values.production_date, shift: values.shift || null, machine: values.machine || null, operator_employee_id: values.operator_employee_id, chip_item_id: values.chip_item_id, ...(values.finished_item_id ? { finished_item_id: values.finished_item_id } : {}), finished_item_name: values.finished_item_name, selling_price: values.selling_price, input_kg: values.input_kg, output_quantity: values.output_quantity, working_hours: values.working_hours, overhead_cost: values.overhead_cost, notes: values.notes || null } }))
  return (
    <Dialog open={open} onClose={onClose} title={record ? 'Correct production run' : 'Record production run'} description="Existing effects are released and reposted atomically when correcting a run." size="large" closeDisabled={mutation.isPending} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={Factory} loading={mutation.isPending} onClick={() => void submit()}>Save production</Button></>}>
      <form className="form-grid form-grid--three" onSubmit={(event) => void submit(event)}>
        <Field label="Production date" required><Input type="date" {...form.register('production_date')} /></Field>
        <Field label="Shift"><Input {...form.register('shift')} placeholder="Day / Night" /></Field>
        <Field label="Machine"><Input {...form.register('machine')} /></Field>
        <RemoteSelect<Employee> label="Operator" endpoint="/employees" queryKey="production-operator" query={{ status: 'active' }} value={form.watch('operator_employee_id')} onChange={(value) => form.setValue('operator_employee_id', value, { shouldValidate: true })} optionValue={(employee) => employee.id} optionLabel={(employee) => `${employee.name} · ${employee.employee_no ?? 'No ID'}`} required error={form.formState.errors.operator_employee_id?.message} selectedLabel={record?.operator?.name} />
        <Field label="Working hours"><Input type="number" min="0" step="0.25" {...form.register('working_hours')} /></Field>
        <OverheadCostField inputId="production-overhead-cost"><Input id="production-overhead-cost" type="number" min="0" step="0.01" {...form.register('overhead_cost')} /></OverheadCostField>
        <RemoteSelect<InventoryPosition> label="Converted chip" endpoint="/inventory/chips" queryKey="production-chip" value={form.watch('chip_item_id')} onChange={(value) => form.setValue('chip_item_id', value, { shouldValidate: true })} onSelectItem={(item) => { setSelectedChip(item); if (item) form.setValue('input_kg', numberValue(item.quantity_on_hand), { shouldValidate: true }) }} optionValue={(item) => item.item_id} optionLabel={(item) => `${item.item_name} · ${quantity(item.quantity_on_hand)} kg available`} required error={form.formState.errors.chip_item_id?.message} selectedLabel={record?.chip_item?.name} />
        <Field label="Chip input (kg)" required error={form.formState.errors.input_kg?.message} hint={selectedChip ? `${quantity(selectedChip.quantity_on_hand)} kg currently available; adjust this run quantity if needed.` : undefined}><Input type="number" min="0.000001" max={selectedChip ? numberValue(selectedChip.quantity_on_hand) : undefined} step="0.001" {...form.register('input_kg')} /></Field>
        <RemoteSelect<InventoryPosition> label="Existing final product (optional)" endpoint="/inventory/finished" queryKey="production-finished-product" value={form.watch('finished_item_id') ?? ''} onChange={(value) => form.setValue('finished_item_id', value, { shouldValidate: true })} onSelectItem={(item) => { if (!item) return; form.setValue('finished_item_name', item.item_name, { shouldValidate: true }); const savedPrice = numberValue(item.selling_price); form.setValue('selling_price', savedPrice > 0 ? savedPrice : Math.round(numberValue(item.average_unit_cost) * 1.5 * 100) / 100, { shouldValidate: true }) }} optionValue={(item) => item.item_id} optionLabel={(item) => `${item.item_name} · ${item.sku || 'No SKU'} · ${money(item.selling_price)} selling price`} selectedLabel={record?.finished_item?.name} placeholder="Select to reuse, or enter a new product below" />
        <Field label="Final product name" required hint={reusingFinishedProduct ? 'The selected catalogue product will be reused; no duplicate is created.' : 'For example: 4-inch black photo frame arm.'} error={form.formState.errors.finished_item_name?.message}><Input {...form.register('finished_item_name')} readOnly={reusingFinishedProduct} /></Field>
        <Field label="Selling price" required hint="Saved on the product and auto-filled on invoices; offers and manual prices remain allowed." error={form.formState.errors.selling_price?.message}><Input type="number" min="0.01" step="0.01" {...form.register('selling_price')} /></Field>
        <Field label="Output quantity" required error={form.formState.errors.output_quantity?.message}><Input type="number" min="0.000001" step="0.001" {...form.register('output_quantity')} /></Field>
        <div className="calculated-field"><span>Estimated total cost</span><strong>{money(estimatedTotal)}</strong><small>Final weighted cost is server-calculated</small></div>
        <div className="calculated-field"><span>Estimated unit cost</span><strong>{money(numberValue(watched.output_quantity) ? estimatedTotal / numberValue(watched.output_quantity) : 0)}</strong><small>Material + overhead</small></div>
        <Field label="Notes" className="field--span-3"><Textarea rows={2} {...form.register('notes')} /></Field>
      </form>
    </Dialog>
  )
}

function SetupGuidance({ title, children, tone = 'info' }: { title: string; children: ReactNode; tone?: 'info' | 'warning' }) {
  return (
    <details className={`setup-guidance setup-guidance--${tone}`}>
      <summary>
        <span><AlertTriangle size={16} aria-hidden="true" /><strong>{title}</strong></span>
        <ChevronDown className="setup-guidance__chevron" size={16} aria-hidden="true" />
      </summary>
      <div className="setup-guidance__body">{children}</div>
    </details>
  )
}

function OverheadCostField({ inputId, children }: { inputId: string; children: ReactNode }) {
  return (
    <div className="field overhead-cost-field">
      <div className="field__label-row">
        <label className="field__label" htmlFor={inputId}>Overhead cost</label>
        <details className="field-info">
          <summary aria-label="What is overhead cost?" title="What is overhead cost?">
            <CircleHelp size={16} aria-hidden="true" />
            <span>Info</span>
          </summary>
          <div className="field-info__popover" role="dialog" aria-label="Overhead cost explanation">
            <section>
              <span className="field-info__language">English</span>
              <strong>What is overhead cost?</strong>
              <p>Indirect factory costs for this batch that are not already included as material or worker piece-rate costs.</p>
              <p>Examples: electricity, fuel, machine wear or maintenance, and shared production supplies. Enter only the amount attributable to this batch; it is added to total and unit cost.</p>
            </section>
            <section lang="si">
              <span className="field-info__language">සිංහල</span>
              <strong>පොදු නිෂ්පාදන පිරිවැය යනු කුමක්ද?</strong>
              <p>මෙම කාණ්ඩයට අදාළ, අමුද්‍රව්‍ය හෝ සේවක කැබලි-අනුපාත ගෙවීම්වලට දැනටමත් ඇතුළත් නොවන වක්‍ර කර්මාන්තශාලා වියදම් වේ.</p>
              <p>උදාහරණ: විදුලිය, ඉන්ධන, යන්ත්‍ර ක්ෂය හෝ නඩත්තුව සහ පොදු නිෂ්පාදන සැපයුම්. මෙම කාණ්ඩයට පමණක් අදාළ මුදල ඇතුළත් කරන්න; එය මුළු පිරිවැයට සහ ඒකක පිරිවැයට එකතු වේ.</p>
            </section>
          </div>
        </details>
      </div>
      {children}
    </div>
  )
}
