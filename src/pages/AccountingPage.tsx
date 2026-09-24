import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useFieldArray, useForm } from 'react-hook-form'
import {
  BadgeDollarSign,
  BookOpenCheck,
  FileBarChart,
  FilePenLine,
  Landmark,
  ListPlus,
  Plus,
  ReceiptText,
  RotateCcw,
  Scale,
  Search,
  Trash2,
  TrendingDown,
  TrendingUp,
  WalletCards,
} from 'lucide-react'
import { z } from 'zod'
import { api, pageItems } from '../lib/api'
import { localIsoDate, money, numberValue, shortDate, titleCase } from '../lib/format'
import type { AccountBalance, Journal, JournalLine, JsonRecord, LedgerRow, MutationReceipt, Page, ReportPayload } from '../types/api'
import { useAppContext } from '../layout/AppShell'
import { useToast } from '../components/Toast'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  FormActions,
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
import { ReportView } from '../components/ReportView'
import { AccountingPdfStudio } from '../components/AccountingPdfStudio'

type AccountingTab = 'overview' | 'quick' | 'journal' | 'ledger' | 'reports' | 'studio'

const quickSchema = z.object({
  journal_date: z.string().min(1, 'Select a date.'),
  direction: z.enum(['in', 'out']),
  method: z.enum(['cash', 'bank_transfer', 'credit_card', 'cheque', 'accounts_receivable', 'accounts_payable', 'other']),
  category: z.string().min(1),
  account: z.string().min(2, 'Enter the primary account.'),
  offset_account: z.string().optional(),
  description: z.string().min(3, 'Describe the transaction.').max(500),
  base_amount: z.coerce.number().positive('Amount must be greater than zero.'),
  tax_percent: z.coerce.number().min(0).max(100),
})

const journalLineSchema = z.object({
  account_code: z.string().optional(),
  account: z.string().min(2, 'Account is required.'),
  description: z.string().max(500).optional(),
  debit: z.coerce.number().min(0),
  credit: z.coerce.number().min(0),
}).refine((line) => (line.debit > 0) !== (line.credit > 0), {
  message: 'Enter either a debit or a credit.',
  path: ['debit'],
})

const journalSchema = z.object({
  journal_date: z.string().min(1, 'Select a date.'),
  memo: z.string().min(3, 'Memo must contain at least 3 characters.').max(500),
  lines: z.array(journalLineSchema).min(2),
}).refine((value) => {
  const debit = value.lines.reduce((sum, line) => sum + line.debit, 0)
  const credit = value.lines.reduce((sum, line) => sum + line.credit, 0)
  return Math.abs(debit - credit) < 0.005
}, { message: 'Total debits and credits must match.', path: ['lines'] })

type QuickValues = z.infer<typeof quickSchema>
type JournalValues = z.infer<typeof journalSchema>

const accountCategories = ['asset', 'liability', 'equity', 'revenue', 'expense']

function defaultOffset(method: QuickValues['method'], direction: QuickValues['direction']) {
  if (method === 'bank_transfer' || method === 'credit_card' || method === 'cheque') return 'Bank Account'
  if (method === 'accounts_receivable') return 'Accounts Receivable'
  if (method === 'accounts_payable') return 'Accounts Payable'
  if (method === 'cash') return 'Cash on Hand'
  return direction === 'in' ? 'Cash on Hand' : 'Accounts Payable'
}

function balanceCategory(rows: AccountBalance[], category: string) {
  return rows.filter((row) => String(row.category ?? '').toLowerCase() === category).reduce((sum, row) => sum + numberValue(row.balance), 0)
}

function rowLines(journal: Journal): JournalLine[] {
  return journal.journal_lines ?? journal.lines ?? []
}

export function AccountingPage() {
  const { year, can } = useAppContext()
  const canWrite = can('finance.write')
  const canReport = can('reports.read')
  const toast = useToast()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<AccountingTab>('overview')
  const [ledgerPage, setLedgerPage] = useState(1)
  const [journalPage, setJournalPage] = useState(1)
  const [search, setSearch] = useState('')
  const [moduleFilter, setModuleFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [monthFilter, setMonthFilter] = useState('')
  const [reverseTarget, setReverseTarget] = useState<Journal | null>(null)
  const [studioDisclaimerOpen, setStudioDisclaimerOpen] = useState(false)
  const [studioAcknowledged, setStudioAcknowledged] = useState(false)
  const [studioPreparing, setStudioPreparing] = useState(false)
  const [studioSession, setStudioSession] = useState(0)

  const balancesQuery = useQuery({
    queryKey: ['account-balances', year],
    queryFn: ({ signal }) => api.list<AccountBalance>('/account-balances', { year, page: 1, page_size: 100 }, signal),
  })
  const ledgerQuery = useQuery({
    queryKey: ['ledger', year, ledgerPage, search, moduleFilter, categoryFilter, monthFilter],
    queryFn: ({ signal }) => api.list<LedgerRow>('/ledger', {
      year,
      page: ledgerPage,
      page_size: 50,
      q: search,
      source_type: moduleFilter,
      category: categoryFilter,
      month: monthFilter,
    }, signal),
    enabled: tab === 'ledger',
  })
  const journalsQuery = useQuery({
    queryKey: ['journals', year, journalPage],
    queryFn: ({ signal }) => api.list<Journal>('/journals', { from_date: `${year}-01-01`, to_date: `${year}-12-31`, page: journalPage, page_size: 25 }, signal),
    enabled: tab === 'journal',
  })
  const reportQuery = useQuery({
    queryKey: ['report', 'financial-summary', year],
    queryFn: ({ signal }) => api.get<ReportPayload>('/reports/financial-summary', { year }, signal),
    enabled: tab === 'reports' || (canReport && (tab === 'studio' || studioDisclaimerOpen)),
  })

  const changeTab = (nextTab: AccountingTab) => {
    if (nextTab !== 'studio') {
      setTab(nextTab)
      return
    }
    if (!canReport || tab === 'studio') return
    setStudioAcknowledged(false)
    setStudioDisclaimerOpen(true)
  }

  const enterStudio = async () => {
    if (!studioAcknowledged || studioPreparing) return
    setStudioPreparing(true)
    try {
      const [reportResult, balancesResult] = await Promise.all([
        reportQuery.refetch(),
        balancesQuery.refetch(),
      ])
      const loadError = reportResult.error ?? balancesResult.error
      if (loadError || !reportResult.data || !balancesResult.data) {
        toast.error('PDF Studio could not open', loadError instanceof Error ? loadError.message : 'The latest accounting snapshot is unavailable.')
        return
      }
      setStudioSession((current) => current + 1)
      setStudioDisclaimerOpen(false)
      setStudioAcknowledged(false)
      setTab('studio')
    } finally {
      setStudioPreparing(false)
    }
  }

  const invalidateAccounting = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['account-balances'] }),
      queryClient.invalidateQueries({ queryKey: ['ledger'] }),
      queryClient.invalidateQueries({ queryKey: ['journals'] }),
      queryClient.invalidateQueries({ queryKey: ['report'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    ])
  }

  const createJournal = useMutation({
    mutationFn: (body: JsonRecord) => api.post<MutationReceipt, JsonRecord>('/journals', body),
    onSuccess: async () => {
      await invalidateAccounting()
      toast.success('Journal posted', 'The balanced entry is now part of the master ledger.')
    },
    onError: (error) => toast.error('Journal was not posted', error instanceof Error ? error.message : 'Review the entry and try again.'),
  })

  const reverseJournal = useMutation({
    mutationFn: (journal: Journal) => api.delete<MutationReceipt, { reason: string }>(`/journals/${journal.id}`, { reason: 'Reversed from accounting workspace' }),
    onSuccess: async () => {
      setReverseTarget(null)
      await invalidateAccounting()
      toast.success('Journal reversed', 'A traceable reversal has been posted.')
    },
    onError: (error) => toast.error('Unable to reverse journal', error instanceof Error ? error.message : 'Try again.'),
  })

  const balances = pageItems(balancesQuery.data)
  const totals = useMemo(() => ({
    assets: balanceCategory(balances, 'asset'),
    liabilities: balanceCategory(balances, 'liability'),
    equity: balanceCategory(balances, 'equity'),
    revenue: balanceCategory(balances, 'revenue'),
    expenses: balanceCategory(balances, 'expense'),
    debit: balances.reduce((sum, row) => sum + numberValue(row.debit_total ?? row.debit), 0),
    credit: balances.reduce((sum, row) => sum + numberValue(row.credit_total ?? row.credit), 0),
  }), [balances])

  return (
    <div className="page-stack">
      <PageHeader eyebrow={`${year} fiscal ledger`} title="Accounting control centre" description="Post balanced journals, inspect the master ledger, and produce server-calculated statements." />
      {!canWrite ? <InlineNotice title="Read-only access">Your role can inspect records but cannot post or reverse accounting entries.</InlineNotice> : null}
      <Tabs value={tab} onChange={changeTab} ariaLabel="Accounting sections" items={[
        { value: 'overview', label: 'Overview', icon: Scale },
        { value: 'quick', label: 'Quick entry', icon: ReceiptText },
        { value: 'journal', label: 'Journals', icon: ListPlus },
        { value: 'ledger', label: 'Master ledger', icon: BookOpenCheck },
        { value: 'reports', label: 'Statements', icon: FileBarChart },
        ...(canReport ? [{ value: 'studio' as const, label: 'PDF Studio', icon: FilePenLine }] : []),
      ]} />

      {tab === 'overview' ? <AccountingOverview loading={balancesQuery.isLoading} error={balancesQuery.error} balances={balances} totals={totals} retry={() => void balancesQuery.refetch()} /> : null}
      {tab === 'quick' ? <QuickEntry disabled={!canWrite} accounts={balances} mutation={createJournal} /> : null}
      {tab === 'journal' ? (
        <JournalWorkspace
          disabled={!canWrite}
          accounts={balances}
          mutation={createJournal}
          query={journalsQuery}
          page={journalPage}
          setPage={setJournalPage}
          onReverse={setReverseTarget}
        />
      ) : null}
      {tab === 'ledger' ? (
        <LedgerView
          query={ledgerQuery}
          page={ledgerPage}
          setPage={setLedgerPage}
          search={search}
          setSearch={(value) => { setSearch(value); setLedgerPage(1) }}
          moduleFilter={moduleFilter}
          setModuleFilter={(value) => { setModuleFilter(value); setLedgerPage(1) }}
          categoryFilter={categoryFilter}
          setCategoryFilter={(value) => { setCategoryFilter(value); setLedgerPage(1) }}
          monthFilter={monthFilter}
          setMonthFilter={(value) => { setMonthFilter(value); setLedgerPage(1) }}
        />
      ) : null}
      {tab === 'reports' ? reportQuery.isLoading ? <LoadingState label="Preparing financial statements…" /> : reportQuery.isError ? <ErrorState error={reportQuery.error} onRetry={() => void reportQuery.refetch()} /> : <ReportView title="Financial statements" description={`Income statement and financial position for ${year}`} data={reportQuery.data} /> : null}
      {tab === 'studio' ? reportQuery.isLoading || studioPreparing ? <LoadingState label="Preparing the local PDF snapshot…" /> : reportQuery.isError || balancesQuery.isError ? <ErrorState error={reportQuery.error ?? balancesQuery.error} onRetry={() => void Promise.all([reportQuery.refetch(), balancesQuery.refetch()])} /> : reportQuery.data ? (
        <AccountingPdfStudio
          key={studioSession}
          summary={reportQuery.data}
          accountBalances={balances}
          year={year}
          onExit={() => setTab('reports')}
        />
      ) : <ErrorState error={new Error('The accounting snapshot is unavailable.')} onRetry={() => void reportQuery.refetch()} /> : null}

      <Dialog
        open={studioDisclaimerOpen}
        onClose={() => {
          if (studioPreparing) return
          setStudioDisclaimerOpen(false)
          setStudioAcknowledged(false)
        }}
        closeDisabled={studioPreparing}
        size="small"
        title="Acknowledge internal-use restrictions"
        description="You must accept these conditions every time PDF Studio is opened."
        footer={(
          <>
            <Button variant="secondary" disabled={studioPreparing} onClick={() => { setStudioDisclaimerOpen(false); setStudioAcknowledged(false) }}>Cancel</Button>
            <Button disabled={!studioAcknowledged} loading={studioPreparing} onClick={() => void enterStudio()}>I understand — open Studio</Button>
          </>
        )}
      >
        <div className="pdf-studio-disclaimer">
          <InlineNotice tone="danger" title="Internal, user-edited and unaudited">
            PDFs created in this Studio are internal working drafts only. They are not approved for government, tax, statutory, regulatory, banking, lending, audit, certification, or other official or critical use.
          </InlineNotice>
          <p>Values can be changed locally for the PDF. Those changes are not written to the ERP ledger or database and have not been independently verified.</p>
          <p><strong>Hich Web provides software only.</strong> Hich Web does not prepare, review, certify, audit, approve, or warrant these figures and does not provide accounting, tax, legal, audit, financial, banking, regulatory, or other professional advice.</p>
          <p>The company and the person generating the PDF remain responsible for verifying every value with appropriately qualified professionals and for controlling how the exported file is used or distributed.</p>
          <label className="pdf-studio-acknowledgement">
            <input type="checkbox" checked={studioAcknowledged} disabled={studioPreparing} onChange={(event) => setStudioAcknowledged(event.target.checked)} />
            <span>I have read and accept these restrictions, and I understand that this Studio creates a local, unaudited PDF draft only.</span>
          </label>
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(reverseTarget)}
        title="Reverse this journal?"
        message={`Journal ${reverseTarget?.reference_no ?? ''} will remain in the audit trail and receive an offsetting reversal. This cannot be silently undone.`}
        confirmLabel="Post reversal"
        destructive
        busy={reverseJournal.isPending}
        onCancel={() => setReverseTarget(null)}
        onConfirm={() => { if (reverseTarget) reverseJournal.mutate(reverseTarget) }}
      />
    </div>
  )
}

function AccountingOverview({ loading, error, balances, totals, retry }: {
  loading: boolean
  error: unknown
  balances: AccountBalance[]
  totals: { assets: number; liabilities: number; equity: number; revenue: number; expenses: number; debit: number; credit: number }
  retry: () => void
}) {
  if (loading) return <LoadingState label="Reconciling account balances…" />
  if (error) return <ErrorState error={error} onRetry={retry} />
  const difference = totals.debit - totals.credit
  return (
    <div className="page-stack">
      {Math.abs(difference) >= 0.005 ? <InlineNotice tone="danger" title="Trial balance mismatch">Debits and credits differ by {money(Math.abs(difference))}. Review the ledger before issuing reports.</InlineNotice> : <InlineNotice tone="success" title="Trial balance verified">Posted debit and credit totals are balanced.</InlineNotice>}
      <div className="stats-grid stats-grid--four">
        <StatCard label="Assets" value={money(totals.assets)} icon={Landmark} tone="blue" />
        <StatCard label="Liabilities" value={money(totals.liabilities)} icon={WalletCards} tone="amber" />
        <StatCard label="Equity" value={money(totals.equity)} icon={Scale} tone="purple" />
        <StatCard label="Net result" value={money(totals.revenue - totals.expenses)} icon={totals.revenue >= totals.expenses ? TrendingUp : TrendingDown} tone={totals.revenue >= totals.expenses ? 'green' : 'red'} />
      </div>
      <Card>
        <SectionTitle title="Account balances" description="Balances are classified by the chart of accounts, not browser-side name matching." />
        {balances.length ? <TableWrap><table><thead><tr><th>Code</th><th>Account</th><th>Category</th><th className="numeric">Debit</th><th className="numeric">Credit</th><th className="numeric">Balance</th></tr></thead><tbody>
          {balances.map((row, index) => <tr key={row.account_id ?? row.account_code ?? index}><td className="mono">{row.account_code ?? '—'}</td><td><strong>{row.account_name ?? 'Unassigned'}</strong></td><td><Badge>{titleCase(row.category)}</Badge></td><td className="numeric">{money(row.debit_total ?? row.debit ?? 0)}</td><td className="numeric">{money(row.credit_total ?? row.credit ?? 0)}</td><td className="numeric"><strong>{money(row.balance ?? 0)}</strong></td></tr>)}
        </tbody><tfoot><tr><td colSpan={3}>Trial balance</td><td className="numeric">{money(totals.debit)}</td><td className="numeric">{money(totals.credit)}</td><td className="numeric">{money(difference)}</td></tr></tfoot></table></TableWrap> : <EmptyState message="Post a journal to begin the fiscal ledger." />}
      </Card>
    </div>
  )
}

function QuickEntry({ disabled, accounts, mutation }: {
  disabled: boolean
  accounts: AccountBalance[]
  mutation: ReturnType<typeof useMutation<MutationReceipt, Error, JsonRecord>>
}) {
  const form = useForm<QuickValues>({
    resolver: zodResolver(quickSchema),
    defaultValues: { journal_date: localIsoDate(), direction: 'in', method: 'cash', category: 'revenue', account: '', offset_account: '', description: '', base_amount: 0, tax_percent: 0 },
  })
  const watched = form.watch()
  const tax = Math.round(numberValue(watched.base_amount) * numberValue(watched.tax_percent)) / 100
  const total = numberValue(watched.base_amount) + tax

  const submit = form.handleSubmit((values) => {
    const offset = values.offset_account?.trim() || defaultOffset(values.method, values.direction)
    const taxValue = Math.round(values.base_amount * values.tax_percent) / 100
    const gross = values.base_amount + taxValue
    const lines: JournalLine[] = values.direction === 'in'
      ? [
          { account: offset, description: values.description, debit: gross, credit: 0 },
          { account: values.account, description: values.description, debit: 0, credit: values.base_amount },
          ...(taxValue > 0 ? [{ account: 'Output Tax Payable', description: `${values.description} · output tax`, debit: 0, credit: taxValue }] : []),
        ]
      : [
          { account: values.account, description: values.description, debit: values.base_amount, credit: 0 },
          ...(taxValue > 0 ? [{ account: 'Input Tax Recoverable', description: `${values.description} · input tax`, debit: taxValue, credit: 0 }] : []),
          { account: offset, description: values.description, debit: 0, credit: gross },
        ]
    mutation.mutate({ journal_date: values.journal_date, memo: `${values.description} [${titleCase(values.method)}]`, lines }, {
      onSuccess: () => form.reset({ ...form.getValues(), account: '', offset_account: '', description: '', base_amount: 0, tax_percent: 0 }),
    })
  })

  return (
    <Card className="form-card">
      <SectionTitle title="Quick double-entry" description="Create a balanced receipt or payment with optional tax lines." />
      <form onSubmit={(event) => void submit(event)}>
        <div className="form-grid form-grid--three">
          <Field label="Posting date" required error={form.formState.errors.journal_date?.message}><Input type="date" disabled={disabled} {...form.register('journal_date')} /></Field>
          <Field label="Cash direction" required><Select disabled={disabled} {...form.register('direction')}><option value="in">Money in</option><option value="out">Money out</option></Select></Field>
          <Field label="Method" required><Select disabled={disabled} {...form.register('method')}><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="credit_card">Credit card</option><option value="cheque">Cheque</option><option value="accounts_receivable">Accounts receivable</option><option value="accounts_payable">Accounts payable</option><option value="other">Other</option></Select></Field>
          <Field label="Category" required><Select disabled={disabled} {...form.register('category')}>{accountCategories.map((category) => <option key={category}>{category}</option>)}</Select></Field>
          <Field label="Primary account" required error={form.formState.errors.account?.message}><Input list="account-options" disabled={disabled} placeholder="e.g. Sales Revenue" {...form.register('account')} /></Field>
          <Field label="Offset account" hint={`Default: ${defaultOffset(watched.method, watched.direction)}`}><Input list="account-options" disabled={disabled} placeholder="Use payment-method default" {...form.register('offset_account')} /></Field>
          <Field label="Description" required error={form.formState.errors.description?.message} className="field--span-3"><Textarea rows={2} disabled={disabled} {...form.register('description')} /></Field>
          <Field label="Base amount" required error={form.formState.errors.base_amount?.message}><Input type="number" min="0.01" step="0.01" disabled={disabled} {...form.register('base_amount')} /></Field>
          <Field label="Tax %" error={form.formState.errors.tax_percent?.message}><Input type="number" min="0" max="100" step="0.01" disabled={disabled} {...form.register('tax_percent')} /></Field>
          <div className="calculated-field"><span>Total to post</span><strong>{money(total)}</strong><small>Tax: {money(tax)}</small></div>
        </div>
        <datalist id="account-options">{accounts.map((account) => <option key={account.account_code ?? account.account_name} value={account.account_name} />)}</datalist>
        <FormActions><Button type="submit" disabled={disabled} loading={mutation.isPending} icon={BadgeDollarSign}>Post balanced entry</Button></FormActions>
      </form>
    </Card>
  )
}

function JournalWorkspace({ disabled, accounts, mutation, query, page, setPage, onReverse }: {
  disabled: boolean
  accounts: AccountBalance[]
  mutation: ReturnType<typeof useMutation<MutationReceipt, Error, JsonRecord>>
  query: ReturnType<typeof useQuery<Page<Journal>>>
  page: number
  setPage: (page: number) => void
  onReverse: (journal: Journal) => void
}) {
  const [open, setOpen] = useState(false)
  const form = useForm<JournalValues>({
    resolver: zodResolver(journalSchema),
    defaultValues: { journal_date: localIsoDate(), memo: '', lines: [{ account: '', account_code: '', description: '', debit: 0, credit: 0 }, { account: '', account_code: '', description: '', debit: 0, credit: 0 }] },
  })
  const fields = useFieldArray({ control: form.control, name: 'lines' })
  const watchedLines = form.watch('lines')
  const debit = watchedLines.reduce((sum, line) => sum + numberValue(line.debit), 0)
  const credit = watchedLines.reduce((sum, line) => sum + numberValue(line.credit), 0)
  const submit = form.handleSubmit((values) => mutation.mutate(values, { onSuccess: () => { setOpen(false); form.reset() } }))
  const journals = query.data?.items ?? []

  return (
    <div className="page-stack">
      <Card>
        <SectionTitle title="Posted journals" description="Corrections use traceable reversals; posted financial records are never silently overwritten." actions={<Button icon={Plus} disabled={disabled} onClick={() => setOpen(true)}>New journal</Button>} />
        {query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : journals.length ? <>
          <TableWrap><table><thead><tr><th>Date / reference</th><th>Memo</th><th>Source</th><th className="numeric">Debit</th><th className="numeric">Credit</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
            {journals.map((journal) => {
              const lines = rowLines(journal)
              const debitTotal = journal.total_debit ?? lines.reduce((sum, line) => sum + numberValue(line.debit), 0)
              const creditTotal = journal.total_credit ?? lines.reduce((sum, line) => sum + numberValue(line.credit), 0)
              return <tr key={journal.id}><td><strong className="mono">{journal.reference_no ?? 'Pending ref'}</strong><span className="table-subtext">{shortDate(journal.journal_date ?? journal.entry_date ?? journal.date)}</span></td><td>{journal.memo ?? '—'}</td><td><Badge>{titleCase(journal.source_module ?? journal.source_type ?? 'manual')}</Badge></td><td className="numeric">{money(debitTotal)}</td><td className="numeric">{money(creditTotal)}</td><td><Badge tone={journal.status === 'reversed' ? 'danger' : 'success'}>{titleCase(journal.status ?? 'posted')}</Badge></td><td><Button variant="ghost" size="small" icon={RotateCcw} disabled={disabled || journal.status === 'reversed'} onClick={() => onReverse(journal)}>Reverse</Button></td></tr>
            })}
          </tbody></table></TableWrap>
          <Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} />
        </> : <EmptyState message="No journals have been posted for this fiscal year." action={<Button icon={Plus} disabled={disabled} onClick={() => setOpen(true)}>Post first journal</Button>} />}
      </Card>

      <Dialog open={open} onClose={() => setOpen(false)} title="Advanced manual journal" description="Each line must contain either a debit or a credit; the journal must balance." size="wide" closeDisabled={mutation.isPending} footer={<><Button variant="secondary" onClick={() => setOpen(false)} disabled={mutation.isPending}>Cancel</Button><Button loading={mutation.isPending} onClick={() => void submit()} icon={BookOpenCheck}>Post journal</Button></>}>
        <form onSubmit={(event) => void submit(event)} className="form-stack">
          <div className="form-grid form-grid--two"><Field label="Journal date" required error={form.formState.errors.journal_date?.message}><Input type="date" {...form.register('journal_date')} /></Field><Field label="Memo" required error={form.formState.errors.memo?.message}><Input {...form.register('memo')} /></Field></div>
          <TableWrap><table className="entry-table"><thead><tr><th>Account</th><th>Description</th><th className="numeric">Debit</th><th className="numeric">Credit</th><th><span className="sr-only">Remove</span></th></tr></thead><tbody>
            {fields.fields.map((field, index) => <tr key={field.id}><td><Input aria-label={`Line ${index + 1} account`} list="journal-account-options" {...form.register(`lines.${index}.account`)} /></td><td><Input aria-label={`Line ${index + 1} description`} {...form.register(`lines.${index}.description`)} /></td><td><Input aria-label={`Line ${index + 1} debit`} type="number" min="0" step="0.01" {...form.register(`lines.${index}.debit`)} /></td><td><Input aria-label={`Line ${index + 1} credit`} type="number" min="0" step="0.01" {...form.register(`lines.${index}.credit`)} /></td><td><button type="button" className="icon-button icon-button--danger" disabled={fields.fields.length <= 2} onClick={() => fields.remove(index)} aria-label={`Remove line ${index + 1}`}><Trash2 size={16} /></button></td></tr>)}
          </tbody><tfoot><tr><td colSpan={2}>Totals · Difference {money(Math.abs(debit - credit))}</td><td className="numeric">{money(debit)}</td><td className="numeric">{money(credit)}</td><td /></tr></tfoot></table></TableWrap>
          {form.formState.errors.lines?.root?.message ? <span className="field__error">{form.formState.errors.lines.root.message}</span> : null}
          <Button type="button" variant="secondary" icon={Plus} onClick={() => fields.append({ account: '', account_code: '', description: '', debit: 0, credit: 0 })}>Add line</Button>
          <datalist id="journal-account-options">{accounts.map((account) => <option key={account.account_code ?? account.account_name} value={account.account_name} />)}</datalist>
        </form>
      </Dialog>
    </div>
  )
}

function LedgerView({ query, page, setPage, search, setSearch, moduleFilter, setModuleFilter, categoryFilter, setCategoryFilter, monthFilter, setMonthFilter }: {
  query: ReturnType<typeof useQuery<Page<LedgerRow>>>
  page: number
  setPage: (page: number) => void
  search: string
  setSearch: (value: string) => void
  moduleFilter: string
  setModuleFilter: (value: string) => void
  categoryFilter: string
  setCategoryFilter: (value: string) => void
  monthFilter: string
  setMonthFilter: (value: string) => void
}) {
  const rows = query.data?.items ?? []
  const debit = rows.reduce((sum, row) => sum + numberValue(row.debit), 0)
  const credit = rows.reduce((sum, row) => sum + numberValue(row.credit), 0)
  return (
    <Card>
      <SectionTitle title="Master ledger" description="Search posted debit and credit lines across every operational module." />
      <div className="toolbar"><SearchBox value={search} onChange={setSearch} placeholder="Reference, account, or description" /><Select aria-label="Source module" value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)}><option value="">All modules</option>{['sales', 'production', 'conversion', 'rm_purchase', 'payroll', 'inventory', 'journal'].map((module) => <option value={module} key={module}>{titleCase(module)}</option>)}</Select><Select aria-label="Account category" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="">All categories</option>{accountCategories.map((category) => <option key={category}>{titleCase(category)}</option>)}</Select><Input aria-label="Ledger month" type="month" value={monthFilter} onChange={(event) => setMonthFilter(event.target.value)} /></div>
      <div className="integrity-row"><span><Search size={16} /> Visible lines <strong>{rows.length}</strong></span><span>Debit <strong>{money(debit)}</strong></span><span>Credit <strong>{money(credit)}</strong></span><span>Difference <strong>{money(Math.abs(debit - credit))}</strong></span></div>
      {query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : rows.length ? <>
        <TableWrap><table><thead><tr><th>Date / reference</th><th>Module</th><th>Account</th><th>Description</th><th className="numeric">Debit</th><th className="numeric">Credit</th><th className="numeric">Balance</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.id ?? `${row.journal_id}-${index}`}><td><strong className="mono">{row.reference_no ?? '—'}</strong><span className="table-subtext">{shortDate(row.entry_date ?? row.date)}</span></td><td><Badge>{titleCase(row.source_module ?? 'journal')}</Badge></td><td><strong>{row.account_name ?? row.account_code ?? 'Unassigned'}</strong><span className="table-subtext">{row.category ? titleCase(row.category) : ''}</span></td><td>{row.description ?? '—'}</td><td className="numeric">{numberValue(row.debit) ? money(row.debit ?? 0) : '—'}</td><td className="numeric">{numberValue(row.credit) ? money(row.credit ?? 0) : '—'}</td><td className="numeric">{row.balance !== undefined ? money(row.balance) : '—'}</td></tr>)}</tbody></table></TableWrap>
        <Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} />
      </> : <EmptyState message="No ledger lines match the current filters." />}
    </Card>
  )
}
