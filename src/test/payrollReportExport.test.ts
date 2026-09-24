import { describe, expect, it } from 'vitest'
import type { Payroll } from '../types/api'
import { buildMonthlyPayrollRows, payrollReportFilename } from '../lib/payrollReportExport'

function payroll(overrides: Partial<Payroll> = {}): Payroll {
  return {
    id: crypto.randomUUID(),
    reference_no: 'PAY-001',
    payroll_date: '2026-09-30',
    salary_month: '2026-09',
    employee_id: '00000000-0000-0000-0000-000000000001',
    regular_earnings: 100_000,
    daily_wages: 4_000,
    piecework_earnings: 1_000,
    gross_pay: 105_000,
    deductions_total: 8_000,
    employer_contributions: 15_000,
    net_pay: 97_000,
    paid_amount: 97_000,
    balance_due: 0,
    payment_status: 'paid',
    status: 'posted',
    employee: {
      id: '00000000-0000-0000-0000-000000000001',
      employee_no: 'EMP-001',
      name: 'Nimali Perera',
      nic: '901234567V',
      epf_no: 'EPF-42',
      etf_ref: 'ETF-42',
      status: 'active',
    },
    payroll_details: [
      { id: crypto.randomUUID(), description: 'Employee EPF', amount: 8_000, earning_type: 'employee_epf', line_kind: 'deduction' },
      { id: crypto.randomUUID(), description: 'Employer EPF', amount: 12_000, earning_type: 'employer_epf', line_kind: 'employer_contribution' },
      { id: crypto.randomUUID(), description: 'Employer ETF', amount: 3_000, earning_type: 'employer_etf', line_kind: 'employer_contribution' },
    ],
    payroll_payments: [{ id: crypto.randomUUID(), reference_no: 'PYP-001', payment_date: '2026-09-30', amount: 97_000, method: 'bank_transfer', status: 'posted' }],
    ...overrides,
  }
}

describe('monthly payroll export', () => {
  it('uses posted payroll detail values for EPF and ETF and excludes reversals', () => {
    const rows = buildMonthlyPayrollRows([
      payroll(),
      payroll({ id: crypto.randomUUID(), reference_no: 'PAY-OLD', status: 'reversed' }),
      payroll({ id: crypto.randomUUID(), reference_no: 'PAY-OCT', salary_month: '2026-10' }),
    ], '2026-09')

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      employeeNo: 'EMP-001',
      employeeEpf: 8_000,
      employerEpf: 12_000,
      totalEpf: 20_000,
      employerEtf: 3_000,
      paidAmount: 97_000,
      paymentMethods: 'bank_transfer',
    })
  })

  it('produces a filesystem-safe month-specific filename', () => {
    expect(payrollReportFilename('2026-09')).toBe('CK_SYS_Payroll_EPF_ETF_2026-09.xlsx')
  })
})
