export const JOURNAL_ACCOUNT_CODES = {
  cash: 'CASH',
  bank: 'BANK',
  accountsReceivable: 'ACCOUNTS_RECEIVABLE',
  accountsPayable: 'ACCOUNTS_PAYABLE',
  inputTaxRecoverable: 'INPUT_TAX_RECOVERABLE',
  outputTaxPayable: 'OUTPUT_TAX_PAYABLE',
} as const

// The database protects these accounts from direct manual journals because
// their balances must be driven by the related sales, inventory, payroll, or
// tax workflow. Account metadata takes precedence when the API exposes it;
// this list keeps older account-balance payloads safe as well.
export const MANUAL_POSTING_RESTRICTED_ACCOUNT_CODES: ReadonlySet<string> = new Set([
  JOURNAL_ACCOUNT_CODES.accountsReceivable,
  JOURNAL_ACCOUNT_CODES.accountsPayable,
  JOURNAL_ACCOUNT_CODES.inputTaxRecoverable,
  JOURNAL_ACCOUNT_CODES.outputTaxPayable,
  'RAW_MATERIAL_INVENTORY',
  'CHIP_INVENTORY',
  'FINISHED_GOODS_INVENTORY',
  'WAGES_PAYABLE',
  'PAYROLL_DEDUCTIONS_PAYABLE',
  'EMPLOYER_CONTRIBUTION_PAYABLE',
  'OVERHEAD_PAYABLE',
  'INTERCOMPANY_DUE_FROM',
  'INTERCOMPANY_DUE_TO',
  'RETAINED_EARNINGS',
])

export type QuickDirection = 'in' | 'out'
export type QuickMethod = string

export interface AccountCodeSource {
  code?: unknown
  account_code?: unknown
  is_control?: unknown
  allow_manual_posting?: unknown
}

export interface JournalSubmissionLine {
  account_code: string
  description: string | null
  debit: number
  credit: number
}

export interface ManualJournalLineDraft {
  account_code: string
  description?: string | null | undefined
  debit: unknown
  credit: unknown
}

export function normalizeAccountCode(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

export function accountCodeOf(account: AccountCodeSource): string {
  return normalizeAccountCode(account.code) || normalizeAccountCode(account.account_code)
}

export function accountAllowsManualPosting(account: AccountCodeSource): boolean {
  if (account.allow_manual_posting === false || account.is_control === true) return false
  if (account.allow_manual_posting === true && account.is_control === false) return true
  return !MANUAL_POSTING_RESTRICTED_ACCOUNT_CODES.has(accountCodeOf(account))
}

export function manualPostingAccounts<T extends AccountCodeSource>(accounts: readonly T[]): T[] {
  return accounts.filter((account) => accountCodeOf(account) && accountAllowsManualPosting(account))
}

export function roundCurrency(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return 0
  const sign = numeric < 0 ? -1 : 1
  return sign * Math.round((Math.abs(numeric) + Number.EPSILON) * 100) / 100
}

export function postingDateForYear(year: number, todayIso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayIso)
  if (!match) return `${year}-01-01`
  const month = Math.min(12, Math.max(1, Number(match[2])))
  const requestedDay = Math.max(1, Number(match[3]))
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(requestedDay, lastDay)).padStart(2, '0')}`
}

export function defaultOffsetCode(method: QuickMethod): string {
  if (method === 'bank_transfer' || method === 'credit_card' || method === 'cheque') {
    return JOURNAL_ACCOUNT_CODES.bank
  }
  if (method === 'accounts_receivable') return JOURNAL_ACCOUNT_CODES.accountsReceivable
  if (method === 'accounts_payable') return JOURNAL_ACCOUNT_CODES.accountsPayable
  if (method === 'cash') return JOURNAL_ACCOUNT_CODES.cash
  return JOURNAL_ACCOUNT_CODES.cash
}

export function quickJournalAmounts(baseAmount: unknown, taxPercent: unknown) {
  const base = roundCurrency(baseAmount)
  const percent = Number(taxPercent)
  const tax = roundCurrency(base * (Number.isFinite(percent) ? percent : 0) / 100)
  return { base, tax, gross: roundCurrency(base + tax) }
}

export function requiredQuickAccountCodes(values: {
  primaryAccountCode: unknown
  offsetAccountCode?: unknown
  method: QuickMethod
  direction: QuickDirection
  baseAmount: unknown
  taxPercent: unknown
}): string[] {
  const { tax } = quickJournalAmounts(values.baseAmount, values.taxPercent)
  const required = [
    normalizeAccountCode(values.primaryAccountCode),
    normalizeAccountCode(values.offsetAccountCode)
      || defaultOffsetCode(values.method),
  ]
  if (tax > 0) {
    required.push(values.direction === 'in'
      ? JOURNAL_ACCOUNT_CODES.outputTaxPayable
      : JOURNAL_ACCOUNT_CODES.inputTaxRecoverable)
  }
  return [...new Set(required.filter(Boolean))]
}

export function missingAccountCodes(
  accounts: readonly AccountCodeSource[],
  requiredCodes: readonly unknown[],
): string[] {
  const available = new Set(accounts.map(accountCodeOf).filter(Boolean))
  return [...new Set(requiredCodes.map(normalizeAccountCode).filter(Boolean))]
    .filter((code) => !available.has(code))
}

export function blockedManualAccountCodes(
  accounts: readonly AccountCodeSource[],
  requiredCodes: readonly unknown[],
): string[] {
  const accountsByCode = new Map(
    accounts.map((account) => [accountCodeOf(account), account] as const).filter(([code]) => Boolean(code)),
  )
  return [...new Set(requiredCodes.map(normalizeAccountCode).filter(Boolean))]
    .filter((code) => {
      const account = accountsByCode.get(code)
      return account
        ? !accountAllowsManualPosting(account)
        : MANUAL_POSTING_RESTRICTED_ACCOUNT_CODES.has(code)
    })
}

export function buildQuickJournalLines(values: {
  direction: QuickDirection
  primaryAccountCode: unknown
  offsetAccountCode: unknown
  description: string
  baseAmount: unknown
  taxPercent: unknown
}): JournalSubmissionLine[] {
  const primaryAccountCode = normalizeAccountCode(values.primaryAccountCode)
  const offsetAccountCode = normalizeAccountCode(values.offsetAccountCode)
  const description = values.description.trim()
  const { base, tax, gross } = quickJournalAmounts(values.baseAmount, values.taxPercent)

  if (values.direction === 'in') {
    return [
      { account_code: offsetAccountCode, description, debit: gross, credit: 0 },
      { account_code: primaryAccountCode, description, debit: 0, credit: base },
      ...(tax > 0 ? [{
        account_code: JOURNAL_ACCOUNT_CODES.outputTaxPayable,
        description: `${description} - output tax`,
        debit: 0,
        credit: tax,
      }] : []),
    ]
  }

  return [
    { account_code: primaryAccountCode, description, debit: base, credit: 0 },
    ...(tax > 0 ? [{
      account_code: JOURNAL_ACCOUNT_CODES.inputTaxRecoverable,
      description: `${description} - input tax`,
      debit: tax,
      credit: 0,
    }] : []),
    { account_code: offsetAccountCode, description, debit: 0, credit: gross },
  ]
}

export function roundManualJournalLines(
  lines: ManualJournalLineDraft[],
): JournalSubmissionLine[] {
  return lines.map((line) => ({
    account_code: normalizeAccountCode(line.account_code),
    description: line.description?.trim() || null,
    debit: roundCurrency(line.debit),
    credit: roundCurrency(line.credit),
  }))
}

export function roundedJournalTotals(lines: Array<{ debit: unknown; credit: unknown }>) {
  const debit = roundCurrency(lines.reduce<number>(
    (total, line) => total + roundCurrency(line.debit),
    0,
  ))
  const credit = roundCurrency(lines.reduce<number>(
    (total, line) => total + roundCurrency(line.credit),
    0,
  ))
  return { debit, credit, difference: roundCurrency(Math.abs(debit - credit)) }
}
