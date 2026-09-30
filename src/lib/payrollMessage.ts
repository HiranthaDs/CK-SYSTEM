import { money, monthLabel } from './format'

export interface PayrollMessageDetails {
  employeeName: string
  companyName: string
  salaryMonth: string
  reference: string
  gross: number
  deductions: number
  net: number
  paid: number
  due: number
}

export function payrollWhatsAppMessage(details: PayrollMessageDetails) {
  const paymentLine = details.due > 0
    ? `Balance due: ${money(details.due)}`
    : 'Payment status: Fully paid'

  return [
    `Dear ${details.employeeName},`,
    '',
    `Your salary details from *${details.companyName}* are ready.`,
    '',
    `Salary month: *${monthLabel(details.salaryMonth)}*`,
    `Payroll reference: ${details.reference}`,
    `Gross earnings: ${money(details.gross)}`,
    `Total deductions: ${money(details.deductions)}`,
    `Net salary: *${money(details.net)}*`,
    `Amount paid: ${money(details.paid)}`,
    paymentLine,
    '',
    'Please contact the payroll administrator if you need any clarification.',
    '',
    `Regards,\n${details.companyName}`,
  ].join('\n')
}
