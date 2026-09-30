import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'
import { useFieldArray, useForm, useWatch } from 'react-hook-form'
import {
  BadgeDollarSign,
  BookOpenCheck,
  CircleHelp,
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
import {
  accountCodeOf,
  blockedManualAccountCodes,
  buildQuickJournalLines,
  manualPostingAccounts,
  missingAccountCodes,
  normalizeAccountCode,
  postingDateForYear,
  quickJournalAmounts,
  requiredQuickAccountCodes,
  roundCurrency,
  roundedJournalTotals,
  roundManualJournalLines,
} from './accountingJournal'

type AccountingTab = 'overview' | 'quick' | 'journal' | 'ledger' | 'reports' | 'studio'

const accountCategories = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const
const fiscalDate = (year: number) => z.string()
  .date('Select a valid date.')
  .refine((value) => value.startsWith(`${year}-`), `Posting date must be within fiscal year ${year}.`)

function createQuickSchema(year: number) {
  return z.object({
    journal_date: fiscalDate(year),
    direction: z.enum(['in', 'out']),
    method: z.string().trim().min(2, 'Enter the settlement method.').max(80, 'Keep the method under 80 characters.'),
    account_code: z.string().trim().min(1, 'Enter the primary account code.'),
    offset_account_code: z.string().trim().min(1, 'Enter the cash or bank offset account code.'),
    description: z.string().trim().min(3, 'Describe the transaction.').max(500),
    base_amount: z.coerce.number().finite('Enter a valid amount.').positive('Amount must be greater than zero.'),
  }).superRefine((value, context) => {
    const primary = normalizeAccountCode(value.account_code)
    const offset = normalizeAccountCode(value.offset_account_code)
    if (primary && primary === offset) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Primary and offset accounts must be different.',
        path: ['offset_account_code'],
      })
    }
  })
}

const journalLineSchema = z.object({
  account_code: z.string().trim().min(1, 'Select an account.'),
  description: z.string().trim().max(500).optional(),
  debit: z.coerce.number().finite('Enter a valid debit.').min(0),
  credit: z.coerce.number().finite('Enter a valid credit.').min(0),
}).refine((line) => (roundCurrency(line.debit) > 0) !== (roundCurrency(line.credit) > 0), {
  message: 'Enter either a debit or a credit.',
  path: ['debit'],
})

function createJournalSchema(year: number) {
  return z.object({
    journal_date: fiscalDate(year),
    memo: z.string().trim().min(3, 'Memo must contain at least 3 characters.').max(500),
    lines: z.array(journalLineSchema).min(2, 'Add at least two journal lines.').max(500),
  }).refine((value) => roundedJournalTotals(value.lines).difference === 0, {
    message: 'Total debits and credits must match to the cent.',
    path: ['lines'],
  })
}

type QuickValues = z.infer<ReturnType<typeof createQuickSchema>>
type JournalValues = z.infer<ReturnType<typeof createJournalSchema>>

function balanceCategory(rows: AccountBalance[], category: string) {
  return roundCurrency(rows
    .filter((row) => String(row.category ?? '').trim().toLowerCase() === category)
    .reduce((sum, row) => sum + numberValue(row.balance), 0))
}

function rowLines(journal: Journal): JournalLine[] {
  return journal.journal_lines ?? journal.lines ?? []
}

async function loadAccountBalances(year: number, signal: AbortSignal): Promise<AccountBalance[]> {
  const firstPage = await api.list<AccountBalance>(
    '/account-balances',
    { year, page: 1, page_size: 100 },
    signal,
  )
  const balances = [...pageItems(firstPage)]
  const pages = Math.max(1, firstPage.pages ?? 1)
  for (let page = 2; page <= pages; page += 1) {
    const result = await api.list<AccountBalance>(
      '/account-balances',
      { year, page, page_size: 100 },
      signal,
    )
    balances.push(...pageItems(result))
  }
  return balances
}

export function AccountingPage() {
  const { year } = useAppContext()
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

  const effectiveMonthFilter = monthFilter.startsWith(`${year}-`) ? monthFilter : ''

  const balancesQuery = useQuery({
    queryKey: ['account-balances', year],
    queryFn: ({ signal }) => loadAccountBalances(year, signal),
  })
  const ledgerQuery = useQuery({
    queryKey: ['ledger', year, ledgerPage, search, moduleFilter, categoryFilter, effectiveMonthFilter],
    queryFn: ({ signal }) => api.list<LedgerRow>('/ledger', {
      year,
      page: ledgerPage,
      page_size: 50,
      q: search,
      source_type: moduleFilter,
      category: categoryFilter,
      month: effectiveMonthFilter,
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
    enabled: tab === 'reports' || tab === 'studio' || studioDisclaimerOpen,
  })

  const changeTab = (nextTab: AccountingTab) => {
    if (nextTab !== 'studio') {
      setTab(nextTab)
      return
    }
    if (tab === 'studio') return
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

  const balances = useMemo(() => balancesQuery.data ?? [], [balancesQuery.data])
  const totals = useMemo(() => ({
    assets: balanceCategory(balances, 'asset'),
    liabilities: balanceCategory(balances, 'liability'),
    equity: balanceCategory(balances, 'equity'),
    revenue: balanceCategory(balances, 'revenue'),
    expenses: balanceCategory(balances, 'expense'),
    debit: roundCurrency(balances.reduce((sum, row) => sum + numberValue(row.debit_total ?? row.debit), 0)),
    credit: roundCurrency(balances.reduce((sum, row) => sum + numberValue(row.credit_total ?? row.credit), 0)),
  }), [balances])

  return (
    <div className="page-stack">
      <PageHeader eyebrow={`${year} fiscal ledger`} title="Accounting control centre" description="Post balanced journals, inspect the master ledger, and produce server-calculated statements." />
      <Tabs value={tab} onChange={changeTab} ariaLabel="Accounting sections" items={[
        { value: 'overview', label: 'Overview', icon: Scale },
        { value: 'quick', label: 'Quick entry', icon: ReceiptText },
        { value: 'journal', label: 'Journals', icon: ListPlus },
        { value: 'ledger', label: 'Master ledger', icon: BookOpenCheck },
        { value: 'reports', label: 'Statements', icon: FileBarChart },
        { value: 'studio', label: 'PDF Studio', icon: FilePenLine },
      ]} />

      {tab === 'overview' ? <AccountingOverview loading={balancesQuery.isLoading} error={balances.length ? null : balancesQuery.error} refreshError={balancesQuery.isRefetchError ? balancesQuery.error : null} balances={balances} totals={totals} retry={() => void balancesQuery.refetch()} /> : null}
      {tab === 'quick' ? <QuickEntry key={`quick-${year}`} year={year} accounts={balances} accountsLoading={balancesQuery.isLoading} accountsError={balances.length ? null : balancesQuery.error} retryAccounts={() => void balancesQuery.refetch()} mutation={createJournal} /> : null}
      {tab === 'journal' ? (
        <JournalWorkspace
          key={`journal-${year}`}
          year={year}
          accounts={balances}
          accountsLoading={balancesQuery.isLoading}
          accountsError={balances.length ? null : balancesQuery.error}
          retryAccounts={() => void balancesQuery.refetch()}
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
          monthFilter={effectiveMonthFilter}
          setMonthFilter={(value) => { setMonthFilter(value); setLedgerPage(1) }}
          year={year}
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

function AccountingOverview({ loading, error, refreshError, balances, totals, retry }: {
  loading: boolean
  error: unknown
  refreshError: unknown
  balances: AccountBalance[]
  totals: { assets: number; liabilities: number; equity: number; revenue: number; expenses: number; debit: number; credit: number }
  retry: () => void
}) {
  if (loading) return <LoadingState label="Reconciling account balances…" />
  if (error) return <ErrorState error={error} onRetry={retry} />
  const difference = roundCurrency(totals.debit - totals.credit)
  return (
    <div className="page-stack">
      {refreshError ? <InlineNotice tone="warning" title="Latest refresh failed">The last successfully loaded balances remain visible. Retry before relying on this snapshot for a financial decision.</InlineNotice> : null}
      {Math.abs(difference) >= 0.005 ? <InlineNotice tone="danger" title="Trial balance mismatch">Debits and credits differ by {money(Math.abs(difference))}. Review the ledger before issuing reports.</InlineNotice> : <InlineNotice tone="success" title="Trial balance verified">Posted debit and credit totals are balanced.</InlineNotice>}
      <div className="stats-grid stats-grid--four">
        <StatCard label="Assets" value={money(totals.assets)} icon={Landmark} tone="blue" />
        <StatCard label="Liabilities" value={money(totals.liabilities)} icon={WalletCards} tone="amber" />
        <StatCard label="Equity" value={money(totals.equity)} icon={Scale} tone="purple" />
        <StatCard label="Net result" value={money(roundCurrency(totals.revenue - totals.expenses))} icon={totals.revenue >= totals.expenses ? TrendingUp : TrendingDown} tone={totals.revenue >= totals.expenses ? 'green' : 'red'} />
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

function QuickEntry({ year, accounts, accountsLoading, accountsError, retryAccounts, mutation }: {
  year: number
  accounts: AccountBalance[]
  accountsLoading: boolean
  accountsError: unknown
  retryAccounts: () => void
  mutation: ReturnType<typeof useMutation<MutationReceipt, Error, JsonRecord>>
}) {
  const postingDate = postingDateForYear(year, localIsoDate())
  const form = useForm<QuickValues>({
    resolver: zodResolver(createQuickSchema(year)),
    defaultValues: { journal_date: postingDate, direction: 'in', method: 'cash', account_code: '', offset_account_code: '', description: '', base_amount: 0 },
  })
  const watchedAmount = useWatch({ control: form.control, name: 'base_amount' })
  const allowedAccounts = useMemo(() => manualPostingAccounts(accounts), [accounts])
  const { gross: total } = quickJournalAmounts(watchedAmount, 0)
  const formDisabled = accountsLoading || Boolean(accountsError) || allowedAccounts.length < 2 || mutation.isPending

  const submit = form.handleSubmit((values) => {
    form.clearErrors('root')
    const offsetAccountCode = normalizeAccountCode(values.offset_account_code)
    const requiredCodes = requiredQuickAccountCodes({
      primaryAccountCode: values.account_code,
      offsetAccountCode,
      method: values.method,
      direction: values.direction,
      baseAmount: values.base_amount,
      taxPercent: 0,
    })
    const missing = missingAccountCodes(accounts, requiredCodes)
    if (missing.length) {
      form.setError('root', { message: `The following ledger account${missing.length === 1 ? ' is' : 's are'} unavailable: ${missing.join(', ')}.` })
      return
    }
    const blocked = blockedManualAccountCodes(accounts, requiredCodes)
    if (blocked.length) {
      form.setError('root', { message: `Use the related sales, purchasing, inventory, payroll, or tax workflow for protected account${blocked.length === 1 ? '' : 's'}: ${blocked.join(', ')}.` })
      return
    }
    const offsetAccount = accounts.find((account) => accountCodeOf(account) === offsetAccountCode)
    if (String(offsetAccount?.category ?? '').toLowerCase() !== 'asset') {
      form.setError('offset_account_code', { message: 'For a money-in/out entry, the offset must be an asset account such as CASH or BANK.' })
      return
    }
    const lines = buildQuickJournalLines({
      direction: values.direction,
      primaryAccountCode: values.account_code,
      offsetAccountCode,
      description: values.description,
      baseAmount: values.base_amount,
      taxPercent: 0,
    })
    mutation.mutate({ journal_date: values.journal_date, memo: `${values.description} [${titleCase(values.method)}]`, lines }, {
      onSuccess: () => form.reset({
        journal_date: values.journal_date,
        direction: values.direction,
        method: values.method,
        account_code: '',
        offset_account_code: '',
        description: '',
        base_amount: 0,
      }),
    })
  })

  if (accountsLoading) return <LoadingState label="Loading the chart of accounts…" />
  if (accountsError) return <ErrorState error={accountsError} onRetry={retryAccounts} />

  return (
    <Card className="form-card">
      <SectionTitle title="Quick double-entry" description="Create a balanced manual cash or bank receipt/payment using verified ledger accounts." />
      <InlineNotice title="Control accounts stay protected">Customer, supplier, inventory, payroll, and tax control balances must be posted from their related workflow, where the supporting record and ledger entry are created together.</InlineNotice>
      {allowedAccounts.length < 2 ? <InlineNotice tone="danger" title="Chart of accounts is not ready">At least two manual-posting accounts are required before a journal can be posted.</InlineNotice> : null}
      <form onSubmit={(event) => void submit(event)}>
        <div className="form-grid form-grid--three">
          <Field label="Posting date" required error={form.formState.errors.journal_date?.message}><AccountingFieldControl help="Use the real transaction date. The date must be inside the selected fiscal year and an open accounting period."><Input type="date" min={`${year}-01-01`} max={`${year}-12-31`} disabled={formDisabled} aria-invalid={Boolean(form.formState.errors.journal_date)} {...form.register('journal_date')} /></AccountingFieldControl></Field>
          <Field label="Cash direction" required><AccountingFieldControl help="Money in debits the cash/bank offset and credits the primary account. Money out debits the primary account and credits cash/bank."><Select disabled={formDisabled} {...form.register('direction')}><option value="in">Money in</option><option value="out">Money out</option></Select></AccountingFieldControl></Field>
          <Field label="Method" required error={form.formState.errors.method?.message}><AccountingFieldControl help="Type the real settlement channel, for example Cash, Bank transfer - BOC, Cheque 001245, Card settlement, or Owner funds. This text is retained in the journal memo; it never chooses an account silently."><Input list="accounting-method-options" placeholder="Enter method manually" disabled={formDisabled} aria-invalid={Boolean(form.formState.errors.method)} {...form.register('method')} /><datalist id="accounting-method-options"><option value="Cash" /><option value="Bank transfer" /><option value="Cheque" /><option value="Credit card settlement" /><option value="Owner funds" /></datalist></AccountingFieldControl></Field>
          <Field label="Primary account" required error={form.formState.errors.account_code?.message}><AccountingFieldControl help="Type the account affected by the business reason. Money out normally uses an expense/asset here; money in normally uses revenue, liability, equity, or an asset transfer. Use the exact chart code; protected control accounts must use their source workflow."><Input list="manual-ledger-accounts" placeholder="Type account code" disabled={formDisabled} aria-invalid={Boolean(form.formState.errors.account_code)} {...form.register('account_code')} /></AccountingFieldControl></Field>
          <Field label="Offset account" required error={form.formState.errors.offset_account_code?.message}><AccountingFieldControl help="Type the asset account where money actually moved, normally CASH or BANK. It must differ from the primary account. Receivables, payables, inventory, payroll, and tax control accounts cannot be manually posted here."><Input list="manual-ledger-accounts" placeholder="Type cash or bank code" disabled={formDisabled} aria-invalid={Boolean(form.formState.errors.offset_account_code)} {...form.register('offset_account_code')} /></AccountingFieldControl></Field>
          <Field label="Amount" required error={form.formState.errors.base_amount?.message}><AccountingFieldControl help="Enter the gross amount that moved in the settlement account, using two decimal places. Negative and zero amounts are rejected."><Input type="number" min="0.01" step="0.01" disabled={formDisabled} aria-invalid={Boolean(form.formState.errors.base_amount)} {...form.register('base_amount')} /></AccountingFieldControl></Field>
          <Field label="Description" required error={form.formState.errors.description?.message} className="field--span-3"><AccountingFieldControl help="State who was paid or received from, why, and the external reference. A useful example is: Office rent September 2026 - landlord - bank ref 84921."><Textarea rows={2} disabled={formDisabled} aria-invalid={Boolean(form.formState.errors.description)} {...form.register('description')} /></AccountingFieldControl></Field>
          <datalist id="manual-ledger-accounts">{allowedAccounts.map((account) => <option key={account.account_code} value={account.account_code}>{account.account_name} ({titleCase(account.category)})</option>)}</datalist>
          <div className="calculated-field" aria-live="polite"><span>Balanced total</span><strong>{money(total)}</strong><small>Debit and credit will each equal this amount.</small></div>
        </div>
        {form.formState.errors.root?.message ? <p className="field__error" role="alert">{form.formState.errors.root.message}</p> : null}
        <FormActions><Button type="submit" disabled={formDisabled} loading={mutation.isPending} icon={BadgeDollarSign}>Post balanced entry</Button></FormActions>
      </form>
    </Card>
  )
}

function AccountingFieldControl({ help, children }: { help: string; children: ReactNode }) {
  return <div className="accounting-field-control">{children}<details className="field-info"><summary aria-label="Open field guidance"><CircleHelp size={15} aria-hidden="true" /> Info</summary><div className="field-info__popover" role="note"><section><strong>How to use this field</strong><p>{help}</p></section></div></details></div>
}

function JournalWorkspace({ year, accounts, accountsLoading, accountsError, retryAccounts, mutation, query, page, setPage, onReverse }: {
  year: number
  accounts: AccountBalance[]
  accountsLoading: boolean
  accountsError: unknown
  retryAccounts: () => void
  mutation: ReturnType<typeof useMutation<MutationReceipt, Error, JsonRecord>>
  query: ReturnType<typeof useQuery<Page<Journal>>>
  page: number
  setPage: (page: number) => void
  onReverse: (journal: Journal) => void
}) {
  const [open, setOpen] = useState(false)
  const postingDate = postingDateForYear(year, localIsoDate())
  const defaultValues: JournalValues = {
    journal_date: postingDate,
    memo: '',
    lines: [
      { account_code: '', description: '', debit: 0, credit: 0 },
      { account_code: '', description: '', debit: 0, credit: 0 },
    ],
  }
  const form = useForm<JournalValues>({
    resolver: zodResolver(createJournalSchema(year)),
    defaultValues,
  })
  const fields = useFieldArray({ control: form.control, name: 'lines' })
  const watchedLines = useWatch({ control: form.control, name: 'lines' })
  const totals = roundedJournalTotals(watchedLines)
  const allowedAccounts = useMemo(() => manualPostingAccounts(accounts), [accounts])
  const accountSelectionUnavailable = accountsLoading || Boolean(accountsError) || allowedAccounts.length < 2
  const close = () => {
    if (mutation.isPending) return
    setOpen(false)
    form.reset(defaultValues)
  }
  const submit = form.handleSubmit((values) => {
    form.clearErrors('root')
    const requiredCodes = values.lines.map((line) => line.account_code)
    const missing = missingAccountCodes(accounts, requiredCodes)
    if (missing.length) {
      form.setError('root', { message: `The following ledger account${missing.length === 1 ? ' is' : 's are'} unavailable: ${missing.join(', ')}.` })
      return
    }
    const blocked = blockedManualAccountCodes(accounts, requiredCodes)
    if (blocked.length) {
      form.setError('root', { message: `Protected control account${blocked.length === 1 ? '' : 's'} cannot be posted manually: ${blocked.join(', ')}.` })
      return
    }
    mutation.mutate({
      journal_date: values.journal_date,
      memo: values.memo,
      lines: roundManualJournalLines(values.lines),
    }, { onSuccess: () => { setOpen(false); form.reset(defaultValues) } })
  })
  const journals = query.data?.items ?? []

  return (
    <div className="page-stack">
      <Card>
        <SectionTitle title="Posted journals" description="Corrections use traceable reversals; posted financial records are never silently overwritten." actions={<Button icon={Plus} disabled={accountSelectionUnavailable} onClick={() => setOpen(true)}>New journal</Button>} />
        {accountsLoading ? <InlineNotice title="Loading chart of accounts">Journal history remains available while posting accounts are prepared.</InlineNotice> : null}
        {accountsError ? <InlineNotice tone="danger" title="Posting accounts are unavailable">Manual posting is disabled until the chart of accounts reloads. <Button type="button" variant="secondary" size="small" onClick={retryAccounts}>Try again</Button></InlineNotice> : null}
        {!accountsLoading && !accountsError && allowedAccounts.length < 2 ? <InlineNotice tone="danger" title="Chart of accounts is not ready">At least two manual-posting accounts must be configured.</InlineNotice> : null}
        {query.isRefetchError && journals.length ? <InlineNotice tone="warning" title="Latest journal refresh failed">Showing the last successfully loaded journal page.</InlineNotice> : null}
        {query.isLoading ? <LoadingState /> : query.isError && !query.data ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : journals.length ? <>
          <TableWrap><table><thead><tr><th>Date / reference</th><th>Memo</th><th>Source</th><th className="numeric">Debit</th><th className="numeric">Credit</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
            {journals.map((journal) => {
              const lines = rowLines(journal)
              const debitTotal = journal.total_debit ?? lines.reduce((sum, line) => sum + numberValue(line.debit), 0)
              const creditTotal = journal.total_credit ?? lines.reduce((sum, line) => sum + numberValue(line.credit), 0)
              const reversible = !journal.status || journal.status === 'posted'
              return <tr key={journal.id}><td><strong className="mono">{journal.reference_no ?? 'Pending ref'}</strong><span className="table-subtext">{shortDate(journal.journal_date ?? journal.entry_date ?? journal.date)}</span></td><td>{journal.memo ?? '—'}</td><td><Badge>{titleCase(journal.source_module ?? journal.source_type ?? 'manual')}</Badge></td><td className="numeric">{money(debitTotal)}</td><td className="numeric">{money(creditTotal)}</td><td><Badge tone={journal.status === 'reversed' ? 'danger' : 'success'}>{titleCase(journal.status ?? 'posted')}</Badge></td><td><Button variant="ghost" size="small" icon={RotateCcw} disabled={!reversible} onClick={() => onReverse(journal)}>Reverse</Button></td></tr>
            })}
          </tbody></table></TableWrap>
          <Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} />
        </> : <EmptyState message="No journals have been posted for this fiscal year." action={<Button icon={Plus} disabled={accountSelectionUnavailable} onClick={() => setOpen(true)}>Post first journal</Button>} />}
      </Card>

      <Dialog open={open} onClose={close} title="Advanced manual journal" description="Each line must contain either a debit or a credit; the journal must balance to the cent." size="wide" closeDisabled={mutation.isPending} footer={<><Button variant="secondary" onClick={close} disabled={mutation.isPending}>Cancel</Button><Button loading={mutation.isPending} onClick={() => void submit()} icon={BookOpenCheck}>Post journal</Button></>}>
        <form onSubmit={(event) => void submit(event)} className="form-stack">
          <InlineNotice title="Manual journal safeguards">Only non-control accounts are listed. Use operational workflows for customer, supplier, stock, payroll, and tax accounts.</InlineNotice>
          <div className="form-grid form-grid--two"><Field label="Journal date" required error={form.formState.errors.journal_date?.message}><Input type="date" min={`${year}-01-01`} max={`${year}-12-31`} disabled={mutation.isPending} aria-invalid={Boolean(form.formState.errors.journal_date)} {...form.register('journal_date')} /></Field><Field label="Memo" required error={form.formState.errors.memo?.message}><Input disabled={mutation.isPending} aria-invalid={Boolean(form.formState.errors.memo)} {...form.register('memo')} /></Field></div>
          <TableWrap><table className="entry-table"><thead><tr><th>Account</th><th>Description</th><th className="numeric">Debit</th><th className="numeric">Credit</th><th><span className="sr-only">Remove</span></th></tr></thead><tbody>
            {fields.fields.map((field, index) => {
              const errors = form.formState.errors.lines?.[index]
              return <tr key={field.id}><td><Select aria-label={`Line ${index + 1} account`} disabled={mutation.isPending} aria-invalid={Boolean(errors?.account_code)} {...form.register(`lines.${index}.account_code`)}><option value="">Select account</option>{allowedAccounts.map((account) => <option key={account.account_code} value={account.account_code}>{account.account_code} — {account.account_name}</option>)}</Select>{errors?.account_code?.message ? <span className="field__error" role="alert">{errors.account_code.message}</span> : null}</td><td><Input aria-label={`Line ${index + 1} description`} disabled={mutation.isPending} aria-invalid={Boolean(errors?.description)} {...form.register(`lines.${index}.description`)} />{errors?.description?.message ? <span className="field__error" role="alert">{errors.description.message}</span> : null}</td><td><Input aria-label={`Line ${index + 1} debit`} type="number" min="0" step="0.01" disabled={mutation.isPending} aria-invalid={Boolean(errors?.debit)} {...form.register(`lines.${index}.debit`)} />{errors?.debit?.message ? <span className="field__error" role="alert">{errors.debit.message}</span> : null}</td><td><Input aria-label={`Line ${index + 1} credit`} type="number" min="0" step="0.01" disabled={mutation.isPending} aria-invalid={Boolean(errors?.credit)} {...form.register(`lines.${index}.credit`)} />{errors?.credit?.message ? <span className="field__error" role="alert">{errors.credit.message}</span> : null}</td><td><button type="button" className="icon-button icon-button--danger" disabled={mutation.isPending || fields.fields.length <= 2} onClick={() => fields.remove(index)} aria-label={`Remove line ${index + 1}`}><Trash2 size={16} /></button></td></tr>
            })}
          </tbody><tfoot><tr><td colSpan={2}>Totals · Difference {money(totals.difference)}</td><td className="numeric">{money(totals.debit)}</td><td className="numeric">{money(totals.credit)}</td><td /></tr></tfoot></table></TableWrap>
          <div className="integrity-row" role="status" aria-live="polite"><span>{totals.debit > 0 && totals.difference === 0 ? 'Journal is balanced to the cent.' : `Remaining difference: ${money(totals.difference)}`}</span></div>
          {form.formState.errors.lines?.root?.message ? <span className="field__error" role="alert">{form.formState.errors.lines.root.message}</span> : null}
          {form.formState.errors.root?.message ? <span className="field__error" role="alert">{form.formState.errors.root.message}</span> : null}
          <Button type="button" variant="secondary" icon={Plus} disabled={mutation.isPending || fields.fields.length >= 500} onClick={() => fields.append({ account_code: '', description: '', debit: 0, credit: 0 })}>Add line</Button>
        </form>
      </Dialog>
    </div>
  )
}

function LedgerView({ query, page, setPage, search, setSearch, moduleFilter, setModuleFilter, categoryFilter, setCategoryFilter, monthFilter, setMonthFilter, year }: {
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
  year: number
}) {
  const rows = query.data?.items ?? []
  const totals = roundedJournalTotals(rows)
  return (
    <Card>
      <SectionTitle title="Master ledger" description="Search posted debit and credit lines across every operational module. Totals below cover only the visible page and may not balance when filters split a journal." />
      <div className="toolbar"><SearchBox value={search} onChange={setSearch} placeholder="Reference, account, or description" /><Select aria-label="Source module" value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)}><option value="">All modules</option>{['sales', 'production', 'conversion', 'rm_purchase', 'payroll', 'inventory', 'journal'].map((module) => <option value={module} key={module}>{titleCase(module)}</option>)}</Select><Select aria-label="Account category" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="">All categories</option>{accountCategories.map((category) => <option key={category}>{titleCase(category)}</option>)}</Select><Input aria-label="Ledger month" type="month" min={`${year}-01`} max={`${year}-12`} value={monthFilter} onChange={(event) => setMonthFilter(event.target.value)} /></div>
      <div className="integrity-row"><span><Search size={16} /> Visible lines <strong>{rows.length}</strong></span><span>Page debit <strong>{money(totals.debit)}</strong></span><span>Page credit <strong>{money(totals.credit)}</strong></span><span>Page variance <strong>{money(totals.difference)}</strong></span></div>
      {query.isRefetchError && rows.length ? <InlineNotice tone="warning" title="Latest ledger refresh failed">Showing the last successfully loaded ledger page.</InlineNotice> : null}
      {query.isLoading ? <LoadingState /> : query.isError && !query.data ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : rows.length ? <>
        <TableWrap><table><thead><tr><th>Date / reference</th><th>Module</th><th>Account</th><th>Description</th><th className="numeric">Debit</th><th className="numeric">Credit</th><th className="numeric">Balance</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.id ?? `${row.journal_id}-${index}`}><td><strong className="mono">{row.reference_no ?? '—'}</strong><span className="table-subtext">{shortDate(row.entry_date ?? row.date)}</span></td><td><Badge>{titleCase(row.source_module ?? 'journal')}</Badge></td><td><strong>{row.account_name ?? row.account_code ?? 'Unassigned'}</strong><span className="table-subtext">{row.category ? titleCase(row.category) : ''}</span></td><td>{row.description ?? '—'}</td><td className="numeric">{numberValue(row.debit) ? money(row.debit ?? 0) : '—'}</td><td className="numeric">{numberValue(row.credit) ? money(row.credit ?? 0) : '—'}</td><td className="numeric">{row.balance !== undefined ? money(row.balance) : '—'}</td></tr>)}</tbody></table></TableWrap>
        <Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} />
      </> : <EmptyState message="No ledger lines match the current filters." />}
    </Card>
  )
}
