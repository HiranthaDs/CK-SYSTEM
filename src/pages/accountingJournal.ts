export const JOURNAL_ACCOUNT_CODES = {
  cash: 'CASH',
  bank: 'BANK',
  accountsReceivable: 'ACCOUNTS_RECEIVABLE',
  accountsPayable: 'ACCOUNTS_PAYABLE',
  inputTaxRecoverable: 'INPUT_TAX_RECOVERABLE',
  outputTaxPayable: 'OUTPUT_TAX_PAYABLE',
} as const

export type QuickDirection = 'in' | 'out'
export type QuickMethod =
  | 'cash'
  | 'bank_transfer'
  | 'credit_card'
  | 'cheque'
  | 'accounts_receivable'
  | 'accounts_payable'
  | 'other'

export interface AccountCodeSource {
  code?: unknown
  account_code?: unknown
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
  return normalizeAccountCode(account.code ?? account.account_code)
}

export function roundCurrency(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.round((numeric + Number.EPSILON) * 100) / 100
}

export function defaultOffsetCode(method: QuickMethod, direction: QuickDirection): string {
  if (method === 'bank_transfer' || method === 'credit_card' || method === 'cheque') {
    return JOURNAL_ACCOUNT_CODES.bank
  }
  if (method === 'accounts_receivable') return JOURNAL_ACCOUNT_CODES.accountsReceivable
  if (method === 'accounts_payable') return JOURNAL_ACCOUNT_CODES.accountsPayable
  if (method === 'cash') return JOURNAL_ACCOUNT_CODES.cash
  return direction === 'in' ? JOURNAL_ACCOUNT_CODES.cash : JOURNAL_ACCOUNT_CODES.accountsPayable
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
      || defaultOffsetCode(values.method, values.direction),
  ]
  if (tax > 0) {
    required.push(values.direction === 'in'
      ? JOURNAL_ACCOUNT_CODES.outputTaxPayable
      : JOURNAL_ACCOUNT_CODES.inputTaxRecoverable)
  }
  return [...new Set(required.filter(Boolean))]
}

export function missingAccountCodes(
  accounts: AccountCodeSource[],
  requiredCodes: unknown[],
): string[] {
  const available = new Set(accounts.map(accountCodeOf).filter(Boolean))
  return [...new Set(requiredCodes.map(normalizeAccountCode).filter(Boolean))]
    .filter((code) => !available.has(code))
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
