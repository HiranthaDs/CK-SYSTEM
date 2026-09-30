import { describe, expect, it } from 'vitest'
import type { AccountBalance } from '../types/api'
import {
  calculateFinancialReportIntegrity,
  collectFinancialReportFields,
  createFinancialExportDocument,
  createFinancialReportModel,
} from '../lib/financialReport'

const balancedAccounts: AccountBalance[] = [
  { account_code: 'CASH', account_name: 'Cash', category: ' Asset ', debit_total: '1100', credit_total: 0, balance: '1100' },
  { account_code: 'AP', account_name: 'Payables', category: 'liability', debit_total: 0, credit_total: '200', balance: 200 },
  { account_code: 'EQUITY', account_name: 'Equity', category: 'equity', debit_total: 0, credit_total: '500', balance: 500 },
  { account_code: 'REVENUE', account_name: 'Revenue', category: 'revenue', debit_total: 0, credit_total: '500', balance: 500 },
  { account_code: 'EXPENSE', account_name: 'Expense', category: 'expense', debit_total: '100', credit_total: 0, balance: 100 },
]

describe('financial report integrity', () => {
  it('reconciles the trial balance, financial position, and server summary', () => {
    const model = createFinancialReportModel({
      finance: { revenue: '500.00', cogs: '40.00', expenses: '60.00' },
    }, balancedAccounts, 2026)
    expect(calculateFinancialReportIntegrity(model)).toMatchObject({
      debitTotal: 1200,
      creditTotal: 1200,
      trialBalanceDifference: 0,
      trialBalanceOk: true,
      assets: 1100,
      liabilities: 200,
      equity: 500,
      currentEarnings: 400,
      positionDifference: 0,
      positionOk: true,
      summaryRevenueDifference: 0,
      summaryExpensesDifference: 0,
      summaryReconciled: true,
      invalidNumericFields: 0,
    })
  })

  it('treats blank currency values as invalid instead of silently converting them to zero', () => {
    const model = createFinancialReportModel({ finance: { revenue: '   ', cogs: 0, expenses: 0 } }, [], 2026)
    const revenue = collectFinancialReportFields(model).find((field) => field.key === 'revenue')
    expect(revenue?.kind).toBe('money')
    expect(calculateFinancialReportIntegrity(model).invalidNumericFields).toBe(1)
  })

  it('rounds accumulated currency and differences to database cents', () => {
    const model = createFinancialReportModel({}, [
      { account_code: 'A', account_name: 'A', category: 'asset', debit_total: 0.1, credit_total: 0, balance: 0.1 },
      { account_code: 'B', account_name: 'B', category: 'asset', debit_total: 0.2, credit_total: 0.3, balance: 0.2 },
    ], 2026)
    const integrity = calculateFinancialReportIntegrity(model)
    expect(integrity.debitTotal).toBe(0.3)
    expect(integrity.creditTotal).toBe(0.3)
    expect(integrity.trialBalanceDifference).toBe(0)
    expect(integrity.trialBalanceOk).toBe(true)
  })
})

describe('financial statement calculations', () => {
  it('keeps the income statement arithmetic consistent when other expenses are negative', () => {
    const report = createFinancialExportDocument(createFinancialReportModel({
      finance: { revenue: 1000, cogs: 600, expenses: -100 },
    }, [], 2026))
    const values = Object.fromEntries(report.incomeStatement.map((line) => [line.label, line.value]))
    expect(values).toMatchObject({
      Revenue: 1000,
      'Less: Cost of goods sold': 600,
      'Gross profit': 400,
      'Less: Other expenses': -100,
      'Net result': 500,
    })
    expect(values['Gross profit']! - values['Less: Other expenses']!).toBe(values['Net result'])
  })

  it('matches only the canonical top-level finance summary path', () => {
    const report = createFinancialExportDocument(createFinancialReportModel({
      other: { finance: { revenue: 9999 } },
      finance: { revenue: 500, cogs: 40, expenses: 60 },
    }, [], 2026))
    expect(report.incomeStatement[0]?.value).toBe(500)
  })
})
