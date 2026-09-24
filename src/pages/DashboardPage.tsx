import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  Banknote,
  Boxes,
  Factory,
  PackageCheck,
  ReceiptText,
  Scale,
  ShoppingCart,
  TrendingDown,
  TrendingUp,
  Users,
  WalletCards,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../layout/AppShell'
import { api } from '../lib/api'
import { money, numberValue, quantity, shortDate } from '../lib/format'
import type { DashboardSummary, JsonRecord } from '../types/api'
import { Card, ErrorState, LoadingState, PageHeader, SectionTitle, StatCard } from '../components/UI'

function inventoryValue(rows: JsonRecord[]) {
  return rows.reduce((total, row) => total + numberValue(row.inventory_value), 0)
}

function inventoryQuantity(rows: JsonRecord[]) {
  return rows.reduce((total, row) => total + numberValue(row.quantity_on_hand), 0)
}

function inventoryItemCount(rows: JsonRecord[]) {
  const aggregates = rows.filter((row) => row.item_count !== undefined)
  return aggregates.length
    ? aggregates.reduce((total, row) => total + numberValue(row.item_count), 0)
    : rows.length
}

export function DashboardPage() {
  const { year, me, hasAnyPermission } = useAppContext()
  const query = useQuery({
    queryKey: ['dashboard', year],
    queryFn: ({ signal }) => api.get<DashboardSummary>('/dashboard', { year }, signal),
  })

  if (query.isLoading) return <LoadingState label="Building the live operations overview…" />
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />

  const data = query.data
  const finance = data.finance
  const workforce = data.workforce
  const operations = data.operations
  const bulk = data.inventory.bulk ?? []
  const chips = data.inventory.chip ?? []
  const finished = data.inventory.finished ?? []
  const netResult = numberValue(finance.revenue) - numberValue(finance.cogs) - numberValue(finance.expenses)
  const identity = me.display_name || me.email || 'there'
  const firstName = identity.split(/[\s@]/).filter(Boolean)[0] ?? 'there'
  const inventoryStages = [
    { label: 'Bulk material', rows: bulk, icon: Factory },
    { label: 'Converted chips', rows: chips, icon: PackageCheck },
    { label: 'Finished goods', rows: finished, icon: Boxes },
  ]
  const workspaces = [
    { to: '/production', icon: Factory, title: 'Manufacturing', description: 'Purchases, conversions, piecework, and production', permissions: ['production.read', 'inventory.read'] },
    { to: '/inventory', icon: PackageCheck, title: 'Inventory', description: 'Live position, valuation, and stock adjustments', permissions: ['inventory.read'] },
    { to: '/sales', icon: ShoppingCart, title: 'Sales', description: 'Invoices, receipts, and outstanding balances', permissions: ['sales.read'] },
    { to: '/employees', icon: Users, title: 'Staff & payroll', description: 'Employees, daily work, earnings, and settlements', permissions: ['employees.read', 'payroll.read'] },
    { to: '/accounting', icon: Scale, title: 'Accounting', description: 'Journals, account balances, ledger, and statements', permissions: ['finance.read'] },
  ].filter((item) => hasAnyPermission(...item.permissions))

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={`${data.year} command centre`}
        title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${firstName}`}
        description={`Live server-calculated position · refreshed ${shortDate(data.generated_at)}`}
      />

      <section className="stats-grid stats-grid--four" aria-label="Financial summary">
        <StatCard label="Revenue" value={money(finance.revenue)} hint={`Fiscal ${data.year}`} icon={TrendingUp} tone="green" />
        <StatCard label="Net result" value={money(netResult)} hint="Revenue less COGS and expenses" icon={netResult >= 0 ? TrendingUp : TrendingDown} tone={netResult >= 0 ? 'purple' : 'red'} />
        <StatCard label="Receivables" value={money(finance.receivables)} hint="Open customer balances" icon={WalletCards} tone="amber" />
        <StatCard label="Cash & bank" value={money(finance.cash_bank)} hint="Posted ledger balance" icon={Banknote} tone="blue" />
      </section>

      <div className="dashboard-grid">
        <Card>
          <SectionTitle title="Inventory pipeline" description="Current quantity and weighted value by production stage." />
          <div className="pipeline-grid">
            {inventoryStages.map(({ label, rows, icon: StageIcon }) => {
              const values = rows
              return (
                <div className="pipeline-item" key={label}>
                  <StageIcon size={20} aria-hidden="true" />
                  <div><span>{label}</span><strong>{quantity(inventoryQuantity(values))}</strong><small>{money(inventoryValue(values))} · {quantity(inventoryItemCount(values), 0)} items</small></div>
                </div>
              )
            })}
          </div>
        </Card>

        <Card>
          <SectionTitle title="Workforce obligations" description="Unclaimed work available for the next payroll." />
          <dl className="metric-list">
            <div><dt><Users size={16} /> Active employees</dt><dd>{workforce.active_employees}</dd></div>
            <div><dt><ReceiptText size={16} /> Open daily wages</dt><dd>{money(workforce.open_daily_wages)}</dd></div>
            <div><dt><Factory size={16} /> Open piecework</dt><dd>{money(workforce.open_piecework)}</dd></div>
            <div><dt><WalletCards size={16} /> Payables</dt><dd>{money(finance.payables)}</dd></div>
          </dl>
        </Card>
      </div>

      <Card>
        <SectionTitle title={`${data.year} posted activity`} description="Counts are calculated in the Python API from Supabase records." />
        <div className="operation-counts">
          {Object.entries(operations).map(([key, value]) => (
            <div key={key}><span>{key.replaceAll('_', ' ')}</span><strong>{quantity(value, 0)}</strong></div>
          ))}
        </div>
      </Card>

      <section>
        <SectionTitle title="Workspaces" description="Open a workspace allowed by your assigned permissions." />
        <div className="workspace-grid">
          {workspaces.map(({ to, icon: Icon, title, description }) => (
            <Link to={to} className="workspace-card" key={to}>
              <Icon size={22} aria-hidden="true" />
              <div><strong>{title}</strong><span>{description}</span></div>
              <ArrowRight size={18} aria-hidden="true" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
