import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertOctagon, Database, Pencil, Plus, RefreshCw, ShieldCheck, Tags, Trash2, Wrench, type LucideIcon } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Dialog } from '../components/Dialog'
import { ConversionTypeDialog, PieceworkRateDialog } from '../components/ConversionSetupDialogs'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, EmptyState, Field, InlineNotice, Input, LoadingState, PageHeader, SectionTitle, TableWrap } from '../components/UI'
import { api, ApiError } from '../lib/api'
import { money, shortDate, titleCase } from '../lib/format'
import type { ConversionType, MutationReceipt, PieceworkRate } from '../types/api'

export const PURGE_CONFIRMATION = 'DELETE ALL BUSINESS DATA'

interface PurgePayload {
  confirmation: typeof PURGE_CONFIRMATION
  acknowledge_irreversible: true
}

const deletedGroups = [
  'Employee profiles, bank/pay details, compensation history, and piecework rates',
  'Daily work, conversion labor, production, purchasing, and inventory records',
  'Sales, receipts, payrolls, payments, journals, stock movements, and audit history',
]

const preservedGroups = [
  'Sign-in accounts, user profiles, roles, and permissions',
  'Chart of accounts, database schema, and application configuration',
  'One system audit event and the retry receipt for this purge',
]

const externalGroups = [
  'Supabase backups and point-in-time recovery history',
  'PDFs already downloaded, printed, emailed, or stored on another device or service',
  'Any third-party exports or copies outside this live ERP database',
]

export function SettingsPage() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [typeDialogOpen, setTypeDialogOpen] = useState(false)
  const [rateDialogOpen, setRateDialogOpen] = useState(false)
  const [editingType, setEditingType] = useState<ConversionType | null>(null)
  const [editingRate, setEditingRate] = useState<PieceworkRate | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const toast = useToast()

  const typesQuery = useQuery({
    queryKey: ['conversion-types', 'settings'],
    queryFn: ({ signal }) => api.list<ConversionType>('/conversion-types', { page: 1, page_size: 100, descending: false }, signal),
  })
  const ratesQuery = useQuery({
    queryKey: ['piecework-rates', 'settings'],
    queryFn: ({ signal }) => api.list<PieceworkRate>('/piecework-rates', { page: 1, page_size: 100, descending: false }, signal),
  })

  const purgeMutation = useMutation({
    mutationFn: () => api.post<MutationReceipt, PurgePayload>('/admin/purge-business-data', {
      confirmation: PURGE_CONFIRMATION,
      acknowledge_irreversible: true,
    }),
    onSuccess: async () => {
      setDialogOpen(false)
      setConfirmation('')
      setAcknowledged(false)
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'me',
      })
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      toast.success(
        'Business data deleted',
        'The live ERP is empty. Authentication, access roles, and the chart of accounts were preserved.',
      )
      void navigate('/dashboard', { replace: true })
    },
    onError: (error) => {
      toast.error(
        'Nothing was deleted',
        error instanceof Error ? error.message : 'The purge could not be completed.',
      )
    },
  })

  const closeDialog = () => {
    if (purgeMutation.isPending) return
    setDialogOpen(false)
    setConfirmation('')
    setAcknowledged(false)
  }

  const confirmationMatches = confirmation === PURGE_CONFIRMATION
  const canPurge = confirmationMatches && acknowledged && !purgeMutation.isPending
  const conversionTypes = typesQuery.data?.items ?? []
  const rates = ratesQuery.data?.items ?? []
  const typeNames = new Map(conversionTypes.map((item) => [item.id, item.name]))
  const closeTypeDialog = () => { setTypeDialogOpen(false); setEditingType(null) }
  const closeRateDialog = () => { setRateDialogOpen(false); setEditingRate(null) }

  return (
    <div className="page-stack settings-page">
      <PageHeader
        eyebrow="Administrator controls"
        title="System settings"
        description="Manage high-risk system operations. Access to this workspace requires full system administration permission."
      />

      <Card className="settings-overview">
        <div className="settings-overview__icon"><ShieldCheck size={24} aria-hidden="true" /></div>
        <div>
          <h2>Protected administration</h2>
          <p>
            Every destructive request is authorized again by the API and database, recorded with
            the acting administrator, and completed as one transaction.
          </p>
        </div>
      </Card>

      <Card className="conversion-settings">
        <SectionTitle
          title="Conversion types & rates"
          description="Create the dropdown values used by Production & conversion. Manual entry remains available for one-off work."
          actions={<div className="row-actions"><Button variant="secondary" icon={Tags} onClick={() => setTypeDialogOpen(true)}>Add type</Button><Button icon={Wrench} onClick={() => setRateDialogOpen(true)}>Add rate</Button></div>}
        />
        <InlineNotice tone="success" title="One setup, used throughout conversion entry">
          Saved types can prefill the chip stock name. Saved rates fill each worker task and rate, then the posted amount becomes that employee's open payroll earning.
        </InlineNotice>
        <div className="settings-master-grid">
          <section className="settings-master-panel">
            <div className="settings-master-panel__heading"><div><Tags size={18} /><strong>Conversion types</strong></div><span>{conversionTypes.length} saved</span></div>
            {typesQuery.isLoading ? <LoadingState label="Loading conversion types…" /> : typesQuery.isError ? <ConversionSetupError kind="types" error={typesQuery.error} onRetry={() => void typesQuery.refetch()} /> : conversionTypes.length ? <TableWrap><table><thead><tr><th>Type</th><th>Default chip</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{conversionTypes.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><span className="table-subtext">{item.notes ?? ''}</span></td><td>{item.default_chip_name ?? 'Manual on entry'}</td><td><Badge tone={item.status === 'active' ? 'success' : 'neutral'}>{titleCase(item.status)}</Badge></td><td><Button variant="ghost" size="small" icon={Pencil} onClick={() => { setEditingType(item); setTypeDialogOpen(true) }}>Edit</Button></td></tr>)}</tbody></table></TableWrap> : <EmptyState message="No conversion types have been saved." action={<Button size="small" icon={Plus} onClick={() => setTypeDialogOpen(true)}>Add first type</Button>} />}
          </section>
          <section className="settings-master-panel">
            <div className="settings-master-panel__heading"><div><Wrench size={18} /><strong>Conversion rates</strong></div><span>{rates.length} saved</span></div>
            {ratesQuery.isLoading ? <LoadingState label="Loading conversion rates…" /> : ratesQuery.isError ? <ConversionSetupError kind="rates" error={ratesQuery.error} onRetry={() => void ratesQuery.refetch()} /> : rates.length ? <TableWrap><table><thead><tr><th>Type / work</th><th className="numeric">Rate / kg</th><th>Effective</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rates.map((rate) => <tr key={rate.id}><td><strong>{rate.conversion_type_id ? typeNames.get(rate.conversion_type_id) ?? rate.work_type : rate.work_type}</strong><span className="table-subtext">{rate.conversion_type_id ? rate.work_type : 'Manual work type'}</span></td><td className="numeric">{money(rate.rate_per_kg)}</td><td>{shortDate(rate.effective_from)}<span className="table-subtext">to {rate.effective_to ? shortDate(rate.effective_to) : 'Open ended'}</span></td><td><Badge tone={rate.status === 'active' ? 'success' : 'neutral'}>{titleCase(rate.status)}</Badge></td><td><Button variant="ghost" size="small" icon={Pencil} onClick={() => { setEditingRate(rate); setRateDialogOpen(true) }}>Edit</Button></td></tr>)}</tbody></table></TableWrap> : <EmptyState message="No conversion rates have been saved." action={<Button size="small" icon={Plus} onClick={() => setRateDialogOpen(true)}>Add first rate</Button>} />}
          </section>
        </div>
      </Card>

      <Card className="danger-zone">
        <SectionTitle
          title="Danger zone"
          description="Use this only to permanently reset the live company records. It is not a routine cleanup action."
        />
        <InlineNotice tone="danger" title="Permanent live-data deletion">
          Confirm your legal, tax, payroll, and backup retention obligations before continuing.
          This operation cannot be undone from CK SYS.
        </InlineNotice>
        <div className="danger-zone__action">
          <div>
            <strong>Delete all business data</strong>
            <span>Keep authentication and system configuration, but remove live operational records.</span>
          </div>
          <Button variant="danger" icon={Trash2} onClick={() => setDialogOpen(true)}>
            Delete all data
          </Button>
        </div>
      </Card>

      <Dialog
        open={dialogOpen}
        title="Permanently delete all business data?"
        description="This is an irreversible reset of the live ERP database."
        size="large"
        onClose={closeDialog}
        closeDisabled={purgeMutation.isPending}
        footer={(
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={purgeMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={purgeMutation.isPending}
              disabled={!canPurge}
              onClick={() => purgeMutation.mutate()}
            >
              Permanently delete data
            </Button>
          </>
        )}
      >
        <div className="purge-confirmation">
          <InlineNotice tone="danger" title="There is no in-app recovery">
            Records are removed in one atomic database transaction. If any part fails, nothing is deleted.
          </InlineNotice>

          <ScopeList icon={Database} title="Deleted from the live ERP" items={deletedGroups} />
          <ScopeList icon={ShieldCheck} title="Preserved" items={preservedGroups} />
          <ScopeList icon={AlertOctagon} title="Not erased by this control" items={externalGroups} />

          <Field
            label={`Type ${PURGE_CONFIRMATION} exactly`}
            required
            error={confirmation.length > 0 && !confirmationMatches ? 'The confirmation phrase does not match.' : undefined}
          >
            <Input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={purgeMutation.isPending}
              placeholder={PURGE_CONFIRMATION}
            />
          </Field>

          <label className="check-field purge-confirmation__acknowledgement">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              disabled={purgeMutation.isPending}
            />
            <span>I understand this permanently deletes the listed live business records.</span>
          </label>
        </div>
      </Dialog>
      <ConversionTypeDialog open={typeDialogOpen} record={editingType} onClose={closeTypeDialog} />
      <PieceworkRateDialog open={rateDialogOpen} record={editingRate} onClose={closeRateDialog} />
    </div>
  )
}

function ScopeList({
  icon: Icon,
  title,
  items,
}: {
  icon: LucideIcon
  title: string
  items: string[]
}) {
  return (
    <section className="purge-scope">
      <div className="purge-scope__title"><Icon size={18} aria-hidden="true" /><strong>{title}</strong></div>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </section>
  )
}

function ConversionSetupError({ kind, error, onRetry }: { kind: 'types' | 'rates'; error: unknown; onRetry: () => void }) {
  const schemaPending = error instanceof ApiError && error.code === 'supabase_schema_unavailable'
  const detail = schemaPending
    ? 'The conversion setup database update has not reached this environment yet. Manual conversion entry remains available in Production.'
    : (error instanceof Error ? error.message : 'The saved setup could not be loaded.')
  return (
    <div className="settings-master-error" role="alert">
      <Database size={22} aria-hidden="true" />
      <div>
        <strong>Conversion {kind} are temporarily unavailable</strong>
        <span>{detail}</span>
      </div>
      <Button size="small" variant="secondary" icon={RefreshCw} onClick={onRetry}>Retry</Button>
    </div>
  )
}
