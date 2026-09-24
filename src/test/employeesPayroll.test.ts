import { describe, expect, it } from 'vitest'
import type { Employee, Payroll } from '../types/api'
import {
  annualPayrollTotals,
  calculatePayrollPreview,
  contractualMonthlyPay,
  payrollEmployeeDisplay,
  seedPayrollForEmployee,
} from '../pages/employeesPayroll'

const employee = (overrides: Partial<Employee> = {}): Employee => ({
  id: '00000000-0000-0000-0000-000000000001',
  employee_no: 'EMP-001',
  name: 'Nimali Perera',
  status: 'active',
  pay_model: 'monthly',
  monthly_rate: 100_000,
  daily_rate: 4_000,
  standard_days_per_month: 25,
  employee_epf_rate: 8,
  employer_epf_rate: 12,
  employer_etf_rate: 3,
  ...overrides,
})

const payroll = (overrides: Partial<Payroll> = {}): Payroll => ({
  id: crypto.randomUUID(),
  reference_no: 'PAY-001',
  payroll_date: '2026-01-31',
  salary_month: '2026-01',
  employee_id: '00000000-0000-0000-0000-000000000001',
  regular_earnings: 100_000,
  daily_wages: 0,
  piecework_earnings: 5_000,
  gross_pay: 105_000,
  deductions_total: 8_000,
  employer_contributions: 15_000,
  net_pay: 97_000,
  paid_amount: 90_000,
  balance_due: 7_000,
  status: 'posted',
  payroll_details: [],
  payroll_payments: [],
  ...overrides,
})

describe('employee payroll seeding', () => {
  it('seeds contractual salary, recurring defaults, and statutory percentages once by type', () => {
    const seed = seedPayrollForEmployee(employee({
      payroll_defaults: {
        earnings: [{ type: 'transport', description: 'Transport allowance', amount: 5_000, account_code: '' }],
        deductions: [{ type: 'employee_epf', description: 'Configured EPF', amount: 7_500, account_code: '' }],
        employer_contributions: [],
      },
    }))

    expect(seed.earnings.map((line) => line.type)).toEqual(['monthly_salary', 'transport'])
    expect(seed.deductions).toHaveLength(1)
    expect(seed.deductions[0]?.amount).toBe(7_500)
    expect(seed.employerContributions.map((line) => [line.type, line.amount])).toEqual([
      ['employer_epf', 12_000],
      ['employer_etf', 3_000],
    ])
  })

  it('supports legacy records and daily/hybrid planning estimates', () => {
    expect(contractualMonthlyPay(employee({ pay_model: 'daily', monthly_rate: null }))).toBe(100_000)
    expect(contractualMonthlyPay(employee({ pay_model: 'hybrid' }))).toBe(200_000)
    expect(seedPayrollForEmployee(employee({
      pay_model: 'piecework',
      monthly_rate: null,
      daily_rate: null,
      payroll_defaults: null,
    }))).toEqual({ earnings: [], deductions: [], employerContributions: [] })
  })
})

describe('payroll summaries', () => {
  it('calculates a live preview with open-work claims as additional earnings', () => {
    expect(calculatePayrollPreview(
      [{ amount: '100000' }, { amount: 5_000 }],
      [{ amount: 8_000 }],
      [{ amount: 15_000 }],
      ['2,000'.replace(',', ''), 3_000],
    )).toEqual({
      manualEarnings: 105_000,
      claimedEarnings: 5_000,
      gross: 110_000,
      deductions: 8_000,
      employerContributions: 15_000,
      net: 102_000,
    })
  })

  it('totals active payrolls and ignores reversed replacements', () => {
    const totals = annualPayrollTotals([
      payroll(),
      payroll({ id: crypto.randomUUID(), reference_no: 'PAY-002', salary_month: '2026-02' }),
      payroll({ id: crypto.randomUUID(), reference_no: 'PAY-OLD', status: 'reversed', gross_pay: 999_999 }),
    ])
    expect(totals.gross).toBe(210_000)
    expect(totals.net).toBe(194_000)
    expect(totals.due).toBe(14_000)
  })

  it('prefers the joined employee name without breaking legacy rows', () => {
    expect(payrollEmployeeDisplay(payroll({ employee: { name: 'Nimali Perera', employee_no: 'EMP-001' } }))).toBe('Nimali Perera')
    expect(payrollEmployeeDisplay(payroll({ employee: null, employee_name: 'Legacy Name' }))).toBe('Legacy Name')
  })
})
