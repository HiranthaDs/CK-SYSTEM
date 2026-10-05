import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Boxes, ClipboardList, PackageSearch, Scale, Warehouse } from 'lucide-react'
import { Dialog } from '../components/Dialog'
import { api } from '../lib/api'
import { money, numberValue, quantity, shortDate, titleCase } from '../lib/format'
import type { InventoryPosition, InventorySummary } from '../types/api'
import { useAppContext } from '../layout/AppShell'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
  PageHeader,
  Pagination,
  SearchBox,
  SectionTitle,
  StatCard,
  TableWrap,
  Tabs,
} from '../components/UI'

type InventoryTab = 'bulk' | 'chip' | 'finished' | 'report'
type Stage = 'bulk' | 'chip' | 'finished'

const pageSize = 30

function stagePath(stage: Stage) {
  return stage === 'chip' ? '/inventory/chips' : `/inventory/${stage}`
}

function PositionTable({ rows, companyName }: { rows: InventoryPosition[]; companyName: string }) {
  if (!rows.length) return <EmptyState message="No inventory items match this view." />
  return (
    <TableWrap>
      <table>
        <thead><tr><th>SKU</th><th>Item</th><th>Stage</th><th>Availability</th><th className="numeric">{companyName} stock</th><th className="numeric">Shared warehouse</th><th className="numeric">Selling price</th><th className="numeric">Company average cost</th><th className="numeric">Company value</th><th>Last company movement</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.item_id}>
            <td className="mono">{row.sku || '—'}</td>
            <td><strong>{row.item_name}</strong><span className="table-subtext">Unit: {row.unit}</span></td>
            <td><Badge tone="info">{titleCase(row.stage)}</Badge></td>
            <td><Badge tone={numberValue(row.shared_quantity_on_hand) > 0 ? 'success' : 'danger'}>{numberValue(row.shared_quantity_on_hand) > 0 ? 'Available' : 'Out of stock'}</Badge></td>
            <td className="numeric"><strong>{quantity(row.quantity_on_hand, 3)}</strong></td>
            <td className="numeric">{quantity(row.shared_quantity_on_hand, 3)}</td>
            <td className="numeric">{row.stage === 'finished' && numberValue(row.selling_price) > 0 ? <strong>{money(row.selling_price)}</strong> : '—'}</td>
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
  const { me } = useAppContext()
  const [tab, setTab] = useState<InventoryTab>('finished')
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [detailView, setDetailView] = useState<'finished' | 'shared' | null>(null)
  const [detailPage, setDetailPage] = useState(1)

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

  const reportQuery = useQuery({
    queryKey: ['report', 'inventory', page, search],
    queryFn: ({ signal }) => api.list<InventoryPosition>('/reports/inventory', {
      page,
      page_size: pageSize,
      q: search,
    }, signal),
    enabled: tab === 'report',
  })

  const detailQuery = useQuery({
    queryKey: ['inventory', 'detail', detailView, detailPage],
    queryFn: ({ signal }) => api.list<InventoryPosition>('/inventory/position', {
      page: detailPage,
      page_size: 25,
      descending: false,
      ...(detailView === 'finished' ? { stage: 'finished' } : {}),
    }, signal),
    enabled: detailView !== null,
  })

  const summary = summaryQuery.data
  const stageCount = (value: Stage) => value === 'chip' ? summary?.chips.item_count : summary?.[value].item_count
  const changeTab = (value: InventoryTab) => {
    setTab(value)
    setPage(1)
    setSearch('')
  }
  const openDetail = (view: 'finished' | 'shared') => {
    setDetailPage(1)
    setDetailView(view)
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={`${me.active_company_code} stock visibility`}
        title={`${me.active_company_name} inventory position`}
        description={`This read-only view separates ${me.active_company_name} stock ownership from the shared physical warehouse quantity.`}
      />
      <InlineNotice title="Read-only shared inventory">
        Direct stock changes are disabled here. Quantities change only through authorized purchasing, conversion, production, and sales workflows.
      </InlineNotice>

      {summaryQuery.isLoading ? <LoadingState label="Valuing current inventory..." /> : summaryQuery.isError ? <ErrorState error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} /> : summary ? (
        <div className="stats-grid stats-grid--four">
          <StatCard label={`${me.active_company_code} finished goods value`} value={money(summary.finished.total_value)} hint={`${quantity(summary.finished.total_quantity, 3)} company-owned units`} icon={Boxes} tone="green" />
          <StatCard label="Finished products" value={summary.finished.item_count} hint="Click to view quantities and prices" icon={ClipboardList} tone="blue" onClick={() => openDetail('finished')} />
          <StatCard label="Shared warehouse stock" value={quantity(summary.shared_total_quantity, 3)} hint="Click to view all warehouse amounts and prices" icon={Warehouse} tone="slate" onClick={() => openDetail('shared')} />
          <StatCard label={`${me.active_company_code} work in process`} value={money(numberValue(summary.bulk.total_value) + numberValue(summary.chips.total_value))} hint={`${summary.bulk.item_count + summary.chips.item_count} bulk and chip items`} icon={Scale} tone="amber" />
        </div>
      ) : null}

      <Tabs value={tab} onChange={changeTab} ariaLabel="Inventory sections" items={[
        { value: 'finished', label: 'Finished products', icon: Boxes, count: stageCount('finished') },
        { value: 'bulk', label: 'Bulk', icon: PackageSearch, count: stageCount('bulk') },
        { value: 'chip', label: 'Chips', icon: Scale, count: stageCount('chip') },
        { value: 'report', label: 'Read-only report', icon: ClipboardList },
      ]} />

      {stage ? (
        <Card>
          <SectionTitle title={stage === 'finished' ? 'Finished-product availability' : `${titleCase(stage)} inventory`} description={`Company stock is allocated to ${me.active_company_name}; shared warehouse stock shows total physical availability across both companies.`} />
          <div className="toolbar"><SearchBox value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="Search item name" /></div>
          {positionQuery.isLoading ? <LoadingState /> : positionQuery.isError ? <ErrorState error={positionQuery.error} onRetry={() => void positionQuery.refetch()} /> : (
            <><PositionTable rows={positionQuery.data?.items ?? []} companyName={me.active_company_name} /><Pagination page={positionQuery.data?.page ?? page} pages={positionQuery.data?.pages ?? 0} total={positionQuery.data?.total ?? 0} onChange={setPage} /></>
          )}
        </Card>
      ) : null}

      {tab === 'report' ? (
        <Card className="print-area">
          <SectionTitle title={`${me.active_company_name} inventory report`} description="Company-owned stock and shared physical availability. This report cannot change inventory." actions={<Button variant="secondary" onClick={() => window.print()}>Print / save PDF</Button>} />
          <div className="toolbar no-print"><SearchBox value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="Search item name" /></div>
          {reportQuery.isLoading ? <LoadingState /> : reportQuery.isError ? <ErrorState error={reportQuery.error} onRetry={() => void reportQuery.refetch()} /> : <><PositionTable rows={reportQuery.data?.items ?? []} companyName={me.active_company_name} /><Pagination page={reportQuery.data?.page ?? page} pages={reportQuery.data?.pages ?? 0} total={reportQuery.data?.total ?? 0} onChange={setPage} /></>}
        </Card>
      ) : null}

      <Dialog
        open={detailView !== null}
        title={detailView === 'finished' ? 'Finished products details' : 'Shared warehouse stock details'}
        description={detailView === 'finished'
          ? `Finished-product quantities, valuation, and selling prices for ${me.active_company_name}.`
          : `Physical warehouse amounts across CK Plastics and AR Plastics, with ${me.active_company_name} ownership and valuation.`}
        size="wide"
        onClose={() => setDetailView(null)}
        footer={<Button onClick={() => setDetailView(null)}>Close</Button>}
      >
        {summary && detailView ? (
          <div className="inventory-detail-summary">
            <div><span>Lines</span><strong>{detailView === 'finished' ? summary.finished.item_count : summary.bulk.item_count + summary.chips.item_count + summary.finished.item_count}</strong></div>
            <div><span>{me.active_company_code} quantity</span><strong>{quantity(detailView === 'finished' ? summary.finished.total_quantity : summary.total_quantity, 3)}</strong></div>
            <div><span>Shared quantity</span><strong>{quantity(detailView === 'finished' ? summary.finished.shared_total_quantity : summary.shared_total_quantity, 3)}</strong></div>
            <div><span>{me.active_company_code} value</span><strong>{money(detailView === 'finished' ? summary.finished.total_value : summary.total_value)}</strong></div>
          </div>
        ) : null}
        {detailQuery.isLoading ? <LoadingState label="Loading inventory details..." /> : detailQuery.isError ? <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} /> : (
          <>
            <PositionTable rows={detailQuery.data?.items ?? []} companyName={me.active_company_name} />
            <Pagination page={detailQuery.data?.page ?? detailPage} pages={detailQuery.data?.pages ?? 0} total={detailQuery.data?.total ?? 0} onChange={setDetailPage} />
          </>
        )}
      </Dialog>
    </div>
  )
}
