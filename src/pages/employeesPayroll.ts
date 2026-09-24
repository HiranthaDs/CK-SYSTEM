import { numberValue } from '../lib/format'
import type { Employee, Payroll, PayrollDefaultComponent } from '../types/api'

export interface PayrollEarningDraft {
  type: string
  description: string
  quantity: number
  rate: number
  amount: number
  account_code: string
}

export interface PayrollAdjustmentDraft {
  type: string
  description: string
  amount: number
  account_code: string
}

export interface EmployeePayrollSeed {
  earnings: PayrollEarningDraft[]
  deductions: PayrollAdjustmentDraft[]
  employerContributions: PayrollAdjustmentDraft[]
}

export interface PayrollPreview {
  manualEarnings: number
  claimedEarnings: number
  gross: number
  deductions: number
  employerContributions: number
  net: number
}

export interface AnnualPayrollTotals {
  regularEarnings: number
  dailyWages: number
  pieceworkEarnings: number
  gross: number
  deductions: number
  employerContributions: number
  net: number
  paid: number
  due: number
}

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

const normalizedType = (value: string) => value.trim().toLowerCase().replace(/[\s-]+/g, '_')

function validDefaults(value: PayrollDefaultComponent[] | undefined): PayrollDefaultComponent[] {
  return Array.isArray(value)
    ? value.filter((item) => Boolean(item?.type?.trim()) && numberValue(item.amount) > 0)
    : []
}

function addUnique<T extends { type: string }>(rows: T[], row: T): void {
  const key = normalizedType(row.type)
  if (!rows.some((item) => normalizedType(item.type) === key)) rows.push(row)
}

function adjustmentFromDefault(component: PayrollDefaultComponent): PayrollAdjustmentDraft {
  return {
    type: component.type.trim(),
    description: component.description?.trim() || component.type.trim(),
    amount: roundMoney(numberValue(component.amount)),
    account_code: component.account_code?.trim() || '',
  }
}

/** A planning estimate only; posted payroll remains based on actual work and selected claims. */
export function contractualMonthlyPay(employee: Employee): number {
  const monthly = numberValue(employee.monthly_rate)
  const dailyEstimate = numberValue(employee.daily_rate) * (numberValue(employee.standard_days_per_month) || 26)
  if (employee.pay_model === 'daily') return roundMoney(dailyEstimate)
  if (employee.pay_model === 'hybrid') return roundMoney(monthly + dailyEstimate)
  if (employee.pay_model === 'piecework') return 0
  return roundMoney(monthly)
}

/** Builds one clean payroll seed when an employee is deliberately selected. */
export function seedPayrollForEmployee(employee: Employee): EmployeePayrollSeed {
  const earnings: PayrollEarningDraft[] = []
  const deductions: PayrollAdjustmentDraft[] = []
  const employerContributions: PayrollAdjustmentDraft[] = []
  const monthlyRate = numberValue(employee.monthly_rate)

  if ((employee.pay_model === 'monthly' || employee.pay_model === 'hybrid') && monthlyRate > 0) {
    addUnique(earnings, {
      type: 'monthly_salary',
      description: 'Contractual monthly salary',
      quantity: 1,
      rate: roundMoney(monthlyRate),
      amount: roundMoney(monthlyRate),
      account_code: '',
    })
  }

  for (const component of validDefaults(employee.payroll_defaults?.earnings)) {
    const amount = roundMoney(numberValue(component.amount))
    addUnique(earnings, {
      type: component.type.trim(),
      description: component.description?.trim() || component.type.trim(),
      quantity: 1,
      rate: amount,
      amount,
      account_code: component.account_code?.trim() || '',
    })
  }

  for (const component of validDefaults(employee.payroll_defaults?.deductions)) {
    addUnique(deductions, adjustmentFromDefault(component))
  }
  for (const component of validDefaults(employee.payroll_defaults?.employer_contributions)) {
    addUnique(employerContributions, adjustmentFromDefault(component))
  }

  const statutoryBase = contractualMonthlyPay(employee)
  const employeeEpfRate = numberValue(employee.employee_epf_rate)
  const employerEpfRate = numberValue(employee.employer_epf_rate)
  const employerEtfRate = numberValue(employee.employer_etf_rate)

  if (statutoryBase > 0 && employeeEpfRate > 0) {
    addUnique(deductions, {
      type: 'employee_epf',
      description: `Employee EPF (${employeeEpfRate}%)`,
      amount: roundMoney(statutoryBase * employeeEpfRate / 100),
      account_code: '',
    })
  }
  if (statutoryBase > 0 && employerEpfRate > 0) {
    addUnique(employerContributions, {
      type: 'employer_epf',
      description: `Employer EPF (${employerEpfRate}%)`,
      amount: roundMoney(statutoryBase * employerEpfRate / 100),
      account_code: '',
    })
  }
  if (statutoryBase > 0 && employerEtfRate > 0) {
    addUnique(employerContributions, {
      type: 'employer_etf',
      description: `Employer ETF (${employerEtfRate}%)`,
      amount: roundMoney(statutoryBase * employerEtfRate / 100),
      account_code: '',
    })
  }

  return { earnings, deductions, employerContributions }
}

export function calculatePayrollPreview(
  earnings: Array<{ amount?: unknown }>,
  deductions: Array<{ amount?: unknown }>,
  employerContributions: Array<{ amount?: unknown }>,
  claimedAmounts: unknown[],
): PayrollPreview {
  const manualEarnings = roundMoney(earnings.reduce((sum, row) => sum + numberValue(row.amount), 0))
  const claimedEarnings = roundMoney(claimedAmounts.reduce<number>((sum, amount) => sum + numberValue(amount), 0))
  const deductionTotal = roundMoney(deductions.reduce((sum, row) => sum + numberValue(row.amount), 0))
  const contributionTotal = roundMoney(employerContributions.reduce((sum, row) => sum + numberValue(row.amount), 0))
  const gross = roundMoney(manualEarnings + claimedEarnings)
  return {
    manualEarnings,
    claimedEarnings,
    gross,
    deductions: deductionTotal,
    employerContributions: contributionTotal,
    net: roundMoney(gross - deductionTotal),
  }
}

export function annualPayrollTotals(payrolls: Payroll[]): AnnualPayrollTotals {
  const active = payrolls.filter((payroll) => payroll.status !== 'reversed')
  const sum = (select: (payroll: Payroll) => unknown) => roundMoney(
    active.reduce((total, payroll) => total + numberValue(select(payroll)), 0),
  )
  return {
    regularEarnings: sum((row) => row.regular_earnings),
    dailyWages: sum((row) => row.daily_wages),
    pieceworkEarnings: sum((row) => row.piecework_earnings),
    gross: sum((row) => row.gross_pay),
    deductions: sum((row) => row.deductions_total),
    employerContributions: sum((row) => row.employer_contributions),
    net: sum((row) => row.net_pay),
    paid: sum((row) => row.paid_amount),
    due: sum((row) => row.balance_due),
  }
}

export function payrollEmployeeDisplay(payroll: Payroll): string {
  return payroll.employee?.name || payroll.employee_name || payroll.employee_no || payroll.employee_id
}
