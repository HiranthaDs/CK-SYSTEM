import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Boxes, ClipboardList, PackageSearch, Pencil, Plus, RotateCcw, Scale } from 'lucide-react'
import { z } from 'zod'
import { api } from '../lib/api'
import { localIsoDate, money, numberValue, quantity, shortDate, titleCase } from '../lib/format'
import type { InventoryAdjustment, InventoryItem, InventoryPosition, InventorySummary, MutationReceipt, Page } from '../types/api'
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

type InventoryTab = 'bulk' | 'chip' | 'finished' | 'adjustments' | 'report'
type Stage = 'bulk' | 'chip' | 'finished'

const adjustmentSchema = z.object({
  adjustment_date: z.string().min(1, 'Select a date.'),
  item_id: z.string().uuid('Select an inventory item.'),
  direction: z.enum(['positive', 'negative']),
  quantity: z.coerce.number().positive('Quantity must be greater than zero.'),
  value: z.coerce.number().positive('Value must be greater than zero.'),
  notes: z.string().min(3, 'Explain why this adjustment is required.').max(2000),
})

type AdjustmentValues = z.infer<typeof adjustmentSchema>
const pageSize = 30

function stagePath(stage: Stage) {
  return stage === 'chip' ? '/inventory/chips' : `/inventory/${stage}`
}

function PositionTable({ rows }: { rows: InventoryPosition[] }) {
  if (!rows.length) return <EmptyState message="No inventory items match this view." />
  return (
    <TableWrap>
      <table>
        <thead><tr><th>SKU</th><th>Item</th><th>Stage</th><th>Availability</th><th className="numeric">On hand</th><th className="numeric">Average cost</th><th className="numeric">Value</th><th>Last movement</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.item_id}>
            <td className="mono">{row.sku || '—'}</td>
            <td><strong>{row.item_name}</strong><span className="table-subtext">Unit: {row.unit}</span></td>
            <td><Badge tone="info">{titleCase(row.stage)}</Badge></td>
            <td><Badge tone={numberValue(row.quantity_on_hand) > 0 ? 'success' : 'danger'}>{numberValue(row.quantity_on_hand) > 0 ? 'Available' : 'Out of stock'}</Badge></td>
            <td className="numeric">{quantity(row.quantity_on_hand, 3)}</td>
            <td className="numeric">{money(row.average_unit_cost)}</td>
            <td className="numeric"><strong>{money(row.inventory_value)}</strong></td>
            <td>{shortDate(row.last_movement_at)}</td>
          </tr>
        ))}</tbody>
      </table>
    </TableWrap>
  )
}

export function InventoryPage() {
  const { can } = useAppContext()
  const canWrite = can('inventory.write')
  const canReport = can('reports.read')
  const toast = useToast()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<InventoryTab>('finished')
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<InventoryAdjustment | null>(null)
  const [reverseTarget, setReverseTarget] = useState<InventoryAdjustment | null>(null)

  const summaryQuery = useQuery({
    queryKey: ['inventory', 'summary'],
    queryFn: ({ signal }) => api.get<InventorySummary>('/inventory/summary', undefined, signal),
  })

  const stage = tab === 'bulk' || tab === 'chip' || tab === 'finished' ? tab : null
  const positionQuery = useQuery({
    queryKey: ['inventory', 'position', stage, page, search],
    queryFn: ({ signal }) => api.list<InventoryPosition>(stagePath(stage ?? 'bulk'), {
      page,
      page_size: pageSize,
      q: search,
      descending: false,
    }, signal),
    enabled: stage !== null,
  })

  const adjustmentQuery = useQuery({
    queryKey: ['adjustments', page, search],
    queryFn: ({ signal }) => api.list<InventoryAdjustment>('/adjustments', {
      page,
      page_size: pageSize,
      q: search,
    }, signal),
    enabled: tab === 'adjustments',
  })

  const reportQuery = useQuery({
    queryKey: ['report', 'inventory', page, search],
    queryFn: ({ signal }) => api.list<InventoryPosition>('/reports/inventory', {
      page,
      page_size: pageSize,
      q: search,
    }, signal),
    enabled: tab === 'report' && canReport,
  })

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['inventory'] }),
      queryClient.invalidateQueries({ queryKey: ['adjustments'] }),
      queryClient.invalidateQueries({ queryKey: ['report', 'inventory'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    ])
  }

  const saveMutation = useMutation({
    mutationFn: ({ id, body }: { id?: string | undefined; body: AdjustmentValues }) => id
      ? api.patch<MutationReceipt, AdjustmentValues>(`/adjustments/${id}`, body)
      : api.post<MutationReceipt, AdjustmentValues>('/adjustments', body),
    onSuccess: async () => {
      setDialogOpen(false)
      setEditing(null)
      await invalidate()
      toast.success('Adjustment posted', 'Inventory and accounting were updated atomically.')
    },
    onError: (error) => toast.error('Adjustment was not saved', error instanceof Error ? error.message : 'Try again.'),
  })

  const reverseMutation = useMutation({
    mutationFn: (row: InventoryAdjustment) => api.delete<MutationReceipt, { reason: string }>(`/adjustments/${row.id}`, { reason: 'Reversed from inventory workspace' }),
    onSuccess: async () => {
      setReverseTarget(null)
      await invalidate()
      toast.success('Adjustment reversed', 'The offsetting stock and journal entries are posted.')
    },
    onError: (error) => toast.error('Unable to reverse adjustment', error instanceof Error ? error.message : 'Try again.'),
  })

  const summary = summaryQuery.data
  const stageCount = (value: Stage) => value === 'chip' ? summary?.chips.item_count : summary?.[value].item_count
  const changeTab = (value: InventoryTab) => {
    setTab(value)
    setPage(1)
    setSearch('')
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Stock control"
        title="Inventory position"
        description="Finished products are shown first, with live available quantities and weighted costs from posted stock movements."
        actions={<Button icon={Plus} disabled={!canWrite} onClick={() => { setEditing(null); setDialogOpen(true) }}>New adjustment</Button>}
      />
      {!canWrite ? <InlineNotice title="Read-only access">Your permissions allow inventory review but not stock adjustments.</InlineNotice> : null}

      {summaryQuery.isLoading ? <LoadingState label="Valuing current inventory…" /> : summaryQuery.isError ? <ErrorState error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} /> : summary ? (
        <div className="stats-grid stats-grid--four">
          <StatCard label="Finished goods value" value={money(summary.finished.total_value)} hint={`${quantity(summary.finished.total_quantity, 3)} ready-for-sale units`} icon={Boxes} tone="green" />
          <StatCard label="Finished products" value={summary.finished.item_count} hint="Active finished-product lines" icon={ClipboardList} tone="blue" />
          <StatCard label="Total inventory" value={money(summary.total_value)} hint={`${quantity(summary.total_quantity, 3)} units across all stages`} icon={PackageSearch} tone="slate" />
          <StatCard label="Work in process" value={money(numberValue(summary.bulk.total_value) + numberValue(summary.chips.total_value))} hint={`${summary.bulk.item_count + summary.chips.item_count} bulk and chip items`} icon={Scale} tone="amber" />
        </div>
      ) : null}

      <Tabs value={tab} onChange={changeTab} ariaLabel="Inventory sections" items={[
        { value: 'finished', label: 'Finished products', icon: Boxes, count: stageCount('finished') },
        { value: 'bulk', label: 'Bulk', icon: PackageSearch, count: stageCount('bulk') },
        { value: 'chip', label: 'Chips', icon: Scale, count: stageCount('chip') },
        { value: 'adjustments', label: 'Adjustments', icon: ClipboardList },
        ...(canReport ? [{ value: 'report' as const, label: 'Report', icon: ClipboardList }] : []),
      ]} />

      {stage ? (
        <Card>
          <SectionTitle title={stage === 'finished' ? 'Finished-product availability' : `${titleCase(stage)} inventory`} description={stage === 'finished' ? 'Sale-ready products with current stock, weighted unit cost, inventory value, and latest movement.' : 'Use server-side search and pagination for large stock catalogues.'} />
          <div className="toolbar"><SearchBox value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="Search item name" /></div>
          {positionQuery.isLoading ? <LoadingState /> : positionQuery.isError ? <ErrorState error={positionQuery.error} onRetry={() => void positionQuery.refetch()} /> : (
            <><PositionTable rows={positionQuery.data?.items ?? []} /><Pagination page={positionQuery.data?.page ?? page} pages={positionQuery.data?.pages ?? 0} total={positionQuery.data?.total ?? 0} onChange={setPage} /></>
          )}
        </Card>
      ) : null}

      {tab === 'adjustments' ? (
        <AdjustmentList
          query={adjustmentQuery}
          page={page}
          setPage={setPage}
          search={search}
          setSearch={(value) => { setSearch(value); setPage(1) }}
          canWrite={canWrite}
          onAdd={() => { setEditing(null); setDialogOpen(true) }}
          onEdit={(row) => { setEditing(row); setDialogOpen(true) }}
          onReverse={setReverseTarget}
        />
      ) : null}

      {tab === 'report' ? (
        <Card className="print-area">
          <SectionTitle title="Inventory report" description="Server-filtered live inventory; use the browser print command to save a PDF." actions={<Button variant="secondary" onClick={() => window.print()}>Print / save PDF</Button>} />
          <div className="toolbar no-print"><SearchBox value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="Search item name" /></div>
          {reportQuery.isLoading ? <LoadingState /> : reportQuery.isError ? <ErrorState error={reportQuery.error} onRetry={() => void reportQuery.refetch()} /> : <><PositionTable rows={reportQuery.data?.items ?? []} /><Pagination page={reportQuery.data?.page ?? page} pages={reportQuery.data?.pages ?? 0} total={reportQuery.data?.total ?? 0} onChange={setPage} /></>}
        </Card>
      ) : null}

      <AdjustmentDialog open={dialogOpen} record={editing} mutation={saveMutation} onClose={() => { setDialogOpen(false); setEditing(null) }} />
      <ConfirmDialog
        open={Boolean(reverseTarget)}
        title="Reverse this adjustment?"
        message={`${reverseTarget?.reference_no ?? 'This adjustment'} will remain in the audit trail and receive offsetting entries.`}
        confirmLabel="Post reversal"
        destructive
        busy={reverseMutation.isPending}
        onCancel={() => setReverseTarget(null)}
        onConfirm={() => { if (reverseTarget) reverseMutation.mutate(reverseTarget) }}
      />
    </div>
  )
}

function AdjustmentList({ query, page, setPage, search, setSearch, canWrite, onAdd, onEdit, onReverse }: {
  query: ReturnType<typeof useQuery<Page<InventoryAdjustment>>>
  page: number
  setPage: (page: number) => void
  search: string
  setSearch: (value: string) => void
  canWrite: boolean
  onAdd: () => void
  onEdit: (row: InventoryAdjustment) => void
  onReverse: (row: InventoryAdjustment) => void
}) {
  const rows = query.data?.items ?? []
  return (
    <Card>
      <SectionTitle title="Stock adjustments" description="Posted corrections remain traceable and are never silently deleted." actions={<Button icon={Plus} disabled={!canWrite} onClick={onAdd}>New adjustment</Button>} />
      <div className="toolbar"><SearchBox value={search} onChange={setSearch} placeholder="Search reference" /></div>
      {query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : rows.length ? (
        <><TableWrap><table><thead><tr><th>Date / reference</th><th>Item</th><th>Direction</th><th className="numeric">Quantity</th><th className="numeric">Value</th><th>Notes</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}>
            <td><strong className="mono">{row.reference_no}</strong><span className="table-subtext">{shortDate(row.adjustment_date)}</span></td>
            <td className="mono">{row.item_id.slice(0, 8)}…</td>
            <td><Badge tone={row.direction === 'positive' ? 'success' : 'warning'}>{titleCase(row.direction)}</Badge></td>
            <td className="numeric">{quantity(row.quantity, 3)}</td><td className="numeric">{money(row.value)}</td><td>{row.notes || '—'}</td>
            <td><Badge tone={row.status === 'reversed' ? 'danger' : 'success'}>{titleCase(row.status)}</Badge></td>
            <td><div className="row-actions"><Button size="small" variant="ghost" icon={Pencil} disabled={!canWrite || row.status === 'reversed'} onClick={() => onEdit(row)}>Correct</Button><Button size="small" variant="ghost" icon={RotateCcw} disabled={!canWrite || row.status === 'reversed'} onClick={() => onReverse(row)}>Reverse</Button></div></td>
          </tr>)}</tbody></table></TableWrap><Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} /></>
      ) : <EmptyState message="No stock adjustments match the current search." action={<Button icon={Plus} disabled={!canWrite} onClick={onAdd}>Post first adjustment</Button>} />}
    </Card>
  )
}

function AdjustmentDialog({ open, record, mutation, onClose }: {
  open: boolean
  record: InventoryAdjustment | null
  mutation: ReturnType<typeof useMutation<MutationReceipt, Error, { id?: string | undefined; body: AdjustmentValues }>>
  onClose: () => void
}) {
  const form = useForm<AdjustmentValues>({
    resolver: zodResolver(adjustmentSchema),
    values: {
      adjustment_date: record?.adjustment_date ?? localIsoDate(),
      item_id: record?.item_id ?? '',
      direction: record?.direction === 'negative' ? 'negative' : 'positive',
      quantity: Number(record?.quantity ?? 0),
      value: Number(record?.value ?? 0),
      notes: record?.notes ?? '',
    },
  })
  const submit = form.handleSubmit((body) => mutation.mutate({ id: record?.id, body }))
  return (
    <Dialog open={open} title={record ? 'Correct stock adjustment' : 'Post stock adjustment'} description="The Python API revalidates stock and posts the balanced journal in one transaction." onClose={onClose} closeDisabled={mutation.isPending} footer={<><Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button><Button loading={mutation.isPending} onClick={() => void submit()}>Save adjustment</Button></>}>
      <form className="form-grid form-grid--two" onSubmit={(event) => void submit(event)}>
        <Field label="Adjustment date" required error={form.formState.errors.adjustment_date?.message}><Input type="date" {...form.register('adjustment_date')} /></Field>
        <Field label="Direction" required error={form.formState.errors.direction?.message}><Select {...form.register('direction')}><option value="positive">Positive / add stock</option><option value="negative">Negative / remove stock</option></Select></Field>
        <RemoteSelect<InventoryItem> label="Inventory item" endpoint="/inventory/items" queryKey="adjustment-item" value={form.watch('item_id')} onChange={(value) => form.setValue('item_id', value, { shouldValidate: true })} optionValue={(item) => item.id} optionLabel={(item) => `${item.name} · ${titleCase(item.stage)} · ${item.sku}`} required error={form.formState.errors.item_id?.message} selectedLabel={record ? `Current item · ${record.item_id.slice(0, 8)}…` : undefined} />
        <Field label="Quantity" required error={form.formState.errors.quantity?.message}><Input type="number" min="0.000001" step="0.001" {...form.register('quantity')} /></Field>
        <Field label="Total value" required error={form.formState.errors.value?.message}><Input type="number" min="0.01" step="0.01" {...form.register('value')} /></Field>
        <Field label="Reason / notes" required error={form.formState.errors.notes?.message} className="field--span-2"><Textarea rows={3} {...form.register('notes')} /></Field>
      </form>
    </Dialog>
  )
}
