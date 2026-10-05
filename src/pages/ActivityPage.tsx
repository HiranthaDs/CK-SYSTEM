import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  Clock3,
  Download,
  Eye,
  Printer,
  RotateCcw,
  ShieldCheck,
  UserRound,
} from 'lucide-react'
import { Dialog } from '../components/Dialog'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Pagination,
  SearchBox,
  SectionTitle,
  Select,
  StatCard,
  TableWrap,
} from '../components/UI'
import { api } from '../lib/api'
import { downloadAuditCsv } from '../lib/auditExport'
import { printElement, titleCase } from '../lib/format'
import { useAppContext } from '../layout/AppShell'
import type { AuditLogEntry } from '../types/api'

type AuditAction = '' | AuditLogEntry['action']
type AuditSort = 'occurred_at' | 'actor_display_name' | 'operation' | 'action'

interface AuditFilters {
  search: string
  actor: string
  action: AuditAction
  entity: string
  fromDate: string
  toDate: string
  sort: AuditSort
  descending: boolean
}

const emptyFilters: AuditFilters = {
  search: '',
  actor: '',
  action: '',
  entity: '',
  fromDate: '',
  toDate: '',
  sort: 'occurred_at',
  descending: true,
}

function actorLabel(entry: AuditLogEntry) {
  return entry.actor_display_name || entry.actor_email || entry.actor_user_id
}

function operationLabel(operation: string) {
  return operation.split('.').map(titleCase).join(' › ')
}

function actionTone(action: AuditLogEntry['action']): 'success' | 'warning' | 'danger' | 'info' | 'purple' {
  if (action === 'delete') return 'danger'
  if (action === 'reverse') return 'warning'
  if (action === 'insert') return 'success'
  if (action === 'update') return 'purple'
  return 'info'
}

export function ActivityPage() {
  const { me } = useAppContext()
  const reportRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState(1)
  const [filters, setFilters] = useState<AuditFilters>(emptyFilters)
  const [selected, setSelected] = useState<AuditLogEntry | null>(null)

  const updateFilter = <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }))
    setPage(1)
  }

  const query = useQuery({
    queryKey: ['audit-log', me.active_company_id, page, filters],
    queryFn: ({ signal }) => api.list<AuditLogEntry>('/reports/audit-log', {
      page,
      page_size: 50,
      q: filters.search.trim() || undefined,
      actor: filters.actor.trim() || undefined,
      action: filters.action || undefined,
      entity: filters.entity.trim() || undefined,
      from_date: filters.fromDate || undefined,
      to_date: filters.toDate || undefined,
      sort: filters.sort,
      descending: filters.descending,
    }, signal),
  })

  const entries = query.data?.items ?? []
  const actorCount = new Set(entries.map((entry) => entry.actor_user_id)).size
  const riskCount = entries.filter((entry) => entry.action === 'delete' || entry.action === 'reverse').length
  const newest = entries.reduce<AuditLogEntry | null>((latest, entry) => (
    !latest || new Date(entry.occurred_at) > new Date(latest.occurred_at) ? entry : latest
  ), null)
  const hasFilters = Object.entries(filters).some(([key, value]) => (
    key === 'sort' ? value !== emptyFilters.sort
      : key === 'descending' ? value !== emptyFilters.descending
        : Boolean(value)
  ))

  return (
    <div className="page-stack activity-page">
      <PageHeader
        eyebrow="Governance & traceability"
        title="Activity & audit report"
        description={`Permanent, company-scoped who-did-what history for ${me.active_company_name}. Business-data deletion preserves this report and adds its own purge receipt.`}
        actions={<div className="row-actions no-print">
          <Button
            variant="secondary"
            icon={Printer}
            disabled={!entries.length}
            onClick={() => { if (reportRef.current) printElement(`${me.active_company_code} activity audit report`, reportRef.current.innerHTML) }}
          >Print / save PDF</Button>
          <Button
            icon={Download}
            disabled={!entries.length}
            onClick={() => downloadAuditCsv(`${me.active_company_code}-audit-page-${page}.csv`, entries)}
          >Export page CSV</Button>
        </div>}
      />

      <div className="stats-grid stats-grid--four">
        <StatCard label="Matching events" value={query.data?.total ?? 0} hint="Across all result pages" icon={Activity} tone="blue" />
        <StatCard label="Actors on this page" value={actorCount} hint="Unique user identities" icon={UserRound} tone="purple" />
        <StatCard label="Delete / reversal events" value={riskCount} hint="On this result page" icon={AlertTriangle} tone="red" />
        <StatCard
          label="Latest visible event"
          value={newest ? new Date(newest.occurred_at).toLocaleDateString('en-LK') : '—'}
          hint={newest ? new Date(newest.occurred_at).toLocaleTimeString('en-LK') : 'No matching activity'}
          icon={Clock3}
          tone="slate"
        />
      </div>

      <Card className="audit-filter-card no-print">
        <SectionTitle
          title="Advanced filters"
          description="Narrow the immutable history by operation, user, action, record type, date, and sort order."
          actions={<Button
            size="small"
            variant="secondary"
            icon={RotateCcw}
            disabled={!hasFilters}
            onClick={() => { setFilters(emptyFilters); setPage(1) }}
          >Reset filters</Button>}
        />
        <div className="audit-filter-grid">
          <Field label="Operation"><SearchBox value={filters.search} onChange={(value) => updateFilter('search', value)} placeholder="Sale, payroll, production…" label="Search operation" /></Field>
          <Field label="User"><Input value={filters.actor} onChange={(event) => updateFilter('actor', event.target.value)} placeholder="Display name snapshot" /></Field>
          <Field label="Action"><Select value={filters.action} onChange={(event) => updateFilter('action', event.target.value as AuditAction)}>
            <option value="">All actions</option>
            <option value="execute">Execute</option>
            <option value="insert">Insert</option>
            <option value="update">Update</option>
            <option value="delete">Delete</option>
            <option value="reverse">Reverse</option>
          </Select></Field>
          <Field label="Record type"><Input value={filters.entity} onChange={(event) => updateFilter('entity', event.target.value)} placeholder="Sale, payroll, inventory…" /></Field>
          <Field label="From date"><Input type="date" value={filters.fromDate} max={filters.toDate || undefined} onChange={(event) => updateFilter('fromDate', event.target.value)} /></Field>
          <Field label="To date"><Input type="date" value={filters.toDate} min={filters.fromDate || undefined} onChange={(event) => updateFilter('toDate', event.target.value)} /></Field>
          <Field label="Sort by"><Select value={filters.sort} onChange={(event) => updateFilter('sort', event.target.value as AuditSort)}>
            <option value="occurred_at">Date & time</option>
            <option value="actor_display_name">User</option>
            <option value="operation">Operation</option>
            <option value="action">Action</option>
          </Select></Field>
          <Field label="Order"><Select value={filters.descending ? 'desc' : 'asc'} onChange={(event) => updateFilter('descending', event.target.value === 'desc')}>
            <option value="desc">Newest / Z–A first</option>
            <option value="asc">Oldest / A–Z first</option>
          </Select></Field>
        </div>
      </Card>

      <Card className="audit-report-card print-area" ref={reportRef}>
        <SectionTitle
          title="Audit events"
          description={`${query.data?.total ?? 0} matching immutable event${query.data?.total === 1 ? '' : 's'}. Select View for the full before/after payload and technical references.`}
        />
        {query.isLoading ? <LoadingState label="Loading audit history…" /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : entries.length ? <>
          <TableWrap><table><thead><tr><th>Date & time</th><th>User</th><th>What they did</th><th>Record</th><th>Action</th><th className="no-print"><span className="sr-only">Details</span></th></tr></thead><tbody>
            {entries.map((entry) => <tr key={entry.id}>
              <td><strong>{new Date(entry.occurred_at).toLocaleString('en-LK')}</strong><span className="table-subtext">Event #{entry.id}</span></td>
              <td><strong>{actorLabel(entry)}</strong>{entry.actor_email && entry.actor_email !== actorLabel(entry) ? <span className="table-subtext">{entry.actor_email}</span> : null}</td>
              <td><strong>{operationLabel(entry.operation)}</strong><span className="table-subtext mono">{entry.operation}</span></td>
              <td>{titleCase(entry.entity_table)}<span className="table-subtext mono">{entry.entity_id || '—'}</span></td>
              <td><Badge tone={actionTone(entry.action)}>{titleCase(entry.action)}</Badge></td>
              <td className="no-print"><Button size="small" variant="ghost" icon={Eye} onClick={() => setSelected(entry)}>View</Button></td>
            </tr>)}
          </tbody></table></TableWrap>
          <div className="no-print"><Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} /></div>
        </> : <EmptyState
          title="No matching audit activity"
          message={hasFilters ? 'No immutable events match these filters. Reset or widen the filters.' : 'No activity has been recorded for this company yet.'}
        />}
      </Card>

      <Card className="audit-integrity-note no-print">
        <ShieldCheck size={23} aria-hidden="true" />
        <div><strong>Audit history is protected</strong><span>Danger Zone deletion keeps every existing audit event, keeps actor identity snapshots even after account removal, and records the purge as a new event.</span></div>
      </Card>

      <Dialog
        open={selected !== null}
        title="Audit event details"
        description={selected ? `${operationLabel(selected.operation)} — ${new Date(selected.occurred_at).toLocaleString('en-LK')}` : undefined}
        size="large"
        onClose={() => setSelected(null)}
        footer={<Button onClick={() => setSelected(null)}>Close</Button>}
      >
        {selected ? <div className="audit-detail">
          <dl>
            <div><dt>Event ID</dt><dd>#{selected.id}</dd></div>
            <div><dt>Date & time</dt><dd>{new Date(selected.occurred_at).toLocaleString('en-LK')}</dd></div>
            <div><dt>User</dt><dd>{actorLabel(selected)}</dd></div>
            <div><dt>Email snapshot</dt><dd>{selected.actor_email || '—'}</dd></div>
            <div><dt>User ID</dt><dd className="mono">{selected.actor_user_id}</dd></div>
            <div><dt>Operation</dt><dd className="mono">{selected.operation}</dd></div>
            <div><dt>Action</dt><dd><Badge tone={actionTone(selected.action)}>{titleCase(selected.action)}</Badge></dd></div>
            <div><dt>Entity</dt><dd>{titleCase(selected.entity_table)} / <span className="mono">{selected.entity_id || '—'}</span></dd></div>
            <div><dt>Request ID</dt><dd className="mono">{selected.request_id || '—'}</dd></div>
            <div><dt>Idempotency key</dt><dd className="mono">{selected.idempotency_key || '—'}</dd></div>
          </dl>
          <div className="audit-payload-grid">
            <section><h3>Before</h3><pre>{JSON.stringify(selected.before_data ?? null, null, 2)}</pre></section>
            <section><h3>After / receipt</h3><pre>{JSON.stringify(selected.after_data ?? null, null, 2)}</pre></section>
          </div>
        </div> : null}
      </Dialog>
    </div>
  )
}
