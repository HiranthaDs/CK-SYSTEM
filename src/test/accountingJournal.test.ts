import { describe, expect, it } from 'vitest'
import {
  JOURNAL_ACCOUNT_CODES,
  accountAllowsManualPosting,
  blockedManualAccountCodes,
  buildQuickJournalLines,
  defaultOffsetCode,
  manualPostingAccounts,
  missingAccountCodes,
  postingDateForYear,
  quickJournalAmounts,
  requiredQuickAccountCodes,
  roundCurrency,
  roundedJournalTotals,
  roundManualJournalLines,
} from '../pages/accountingJournal'

describe('accounting journal currency helpers', () => {
  it('rounds positive and negative midpoint values like database numeric currency', () => {
    expect(roundCurrency(1.005)).toBe(1.01)
    expect(roundCurrency(-1.005)).toBe(-1.01)
    expect(roundCurrency('not-a-number')).toBe(0)
  })

  it('calculates and balances tax-inclusive quick journal lines to the cent', () => {
    expect(quickJournalAmounts('19.99', '15')).toEqual({ base: 19.99, tax: 3, gross: 22.99 })
    const lines = buildQuickJournalLines({
      direction: 'in',
      primaryAccountCode: ' sales_revenue ',
      offsetAccountCode: 'cash',
      description: ' Counter sale ',
      baseAmount: '19.99',
      taxPercent: '15',
    })
    expect(lines).toEqual([
      { account_code: 'CASH', description: 'Counter sale', debit: 22.99, credit: 0 },
      { account_code: 'SALES_REVENUE', description: 'Counter sale', debit: 0, credit: 19.99 },
      { account_code: 'OUTPUT_TAX_PAYABLE', description: 'Counter sale - output tax', debit: 0, credit: 3 },
    ])
    expect(roundedJournalTotals(lines)).toEqual({ debit: 22.99, credit: 22.99, difference: 0 })
  })

  it('rounds every manual line before totals are checked or submitted', () => {
    const lines = roundManualJournalLines([
      { account_code: ' cash ', description: ' Debit ', debit: '10.004', credit: 0 },
      { account_code: 'owner_equity', description: '', debit: 0, credit: '10.001' },
    ])
    expect(lines).toEqual([
      { account_code: 'CASH', description: 'Debit', debit: 10, credit: 0 },
      { account_code: 'OWNER_EQUITY', description: null, debit: 0, credit: 10 },
    ])
    expect(roundedJournalTotals(lines).difference).toBe(0)
  })
})

describe('accounting journal account safeguards', () => {
  const accounts = [
    { account_code: 'CASH' },
    { account_code: 'BANK' },
    { account_code: 'SALES_REVENUE' },
    { account_code: 'ACCOUNTS_RECEIVABLE' },
    { account_code: 'CUSTOM_CONTROL', is_control: true, allow_manual_posting: false },
  ]

  it('uses safe cash/bank defaults and reports missing required accounts', () => {
    expect(defaultOffsetCode('cash')).toBe(JOURNAL_ACCOUNT_CODES.cash)
    expect(defaultOffsetCode('cheque')).toBe(JOURNAL_ACCOUNT_CODES.bank)
    expect(defaultOffsetCode('other')).toBe(JOURNAL_ACCOUNT_CODES.cash)
    const required = requiredQuickAccountCodes({
      primaryAccountCode: 'SALES_REVENUE',
      method: 'cash',
      direction: 'in',
      baseAmount: 100,
      taxPercent: 15,
    })
    expect(required).toEqual(['SALES_REVENUE', 'CASH', 'OUTPUT_TAX_PAYABLE'])
    expect(missingAccountCodes(accounts, required)).toEqual(['OUTPUT_TAX_PAYABLE'])
  })

  it('filters database and legacy protected control accounts from manual posting', () => {
    expect(manualPostingAccounts(accounts).map((account) => account.account_code)).toEqual([
      'CASH',
      'BANK',
      'SALES_REVENUE',
    ])
    expect(blockedManualAccountCodes(accounts, ['cash', 'accounts_receivable', 'custom_control'])).toEqual([
      'ACCOUNTS_RECEIVABLE',
      'CUSTOM_CONTROL',
    ])
    expect(accountAllowsManualPosting({
      account_code: 'ACCOUNTS_RECEIVABLE',
      is_control: false,
      allow_manual_posting: true,
    })).toBe(true)
    expect(accountAllowsManualPosting({ code: '', account_code: 'CASH' })).toBe(true)
  })
})

describe('fiscal posting dates', () => {
  it('keeps month/day in the selected year and clamps leap day safely', () => {
    expect(postingDateForYear(2026, '2026-09-29')).toBe('2026-09-29')
    expect(postingDateForYear(2025, '2024-02-29')).toBe('2025-02-28')
    expect(postingDateForYear(2026, 'invalid')).toBe('2026-01-01')
  })
})
