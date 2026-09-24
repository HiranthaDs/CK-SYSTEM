import type { Cell, Row, Worksheet } from 'exceljs'
import { numberValue } from './format'
import type { Payroll, PayrollLine } from '../types/api'

export interface MonthlyPayrollExportRow {
  employeeNo: string
  employeeName: string
  nic: string
  epfNo: string
  etfRef: string
  payrollReference: string
  payrollDate: string
  salaryMonth: string
  regularEarnings: number
  dailyWages: number
  pieceworkEarnings: number
  grossPay: number
  employeeEpf: number
  employerEpf: number
  employerEtf: number
  totalEpf: number
  netPay: number
  paidAmount: number
  balanceDue: number
  paymentStatus: string
  paymentDates: string
  paymentMethods: string
}

const NAVY = '172033'
const BLUE = '2457D6'
const PALE_BLUE = 'E9EFFF'
const PALE_GREEN = 'E5F6EF'
const PALE_AMBER = 'FFF3D7'
const PALE_RED = 'FFEAED'
const WHITE = 'FFFFFF'
const MONEY_FORMAT = '"LKR "#,##0.00;[Red]-"LKR "#,##0.00'

function normalizedType(line: PayrollLine): string {
  return (line.earning_type ?? line.type ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function lineTotal(payroll: Payroll, acceptedTypes: string[]): number {
  const accepted = new Set(acceptedTypes)
  return payroll.payroll_details.reduce((total, line) => (
    accepted.has(normalizedType(line)) ? total + numberValue(line.amount) : total
  ), 0)
}

function postedPayments(payroll: Payroll) {
  return payroll.payroll_payments.filter((payment) => payment.status !== 'reversed')
}

/** Creates the auditable, posted values used by the government-facing workbook. */
export function buildMonthlyPayrollRows(
  payrolls: Payroll[],
  salaryMonth: string,
): MonthlyPayrollExportRow[] {
  return payrolls
    .filter((payroll) => payroll.status !== 'reversed' && payroll.salary_month === salaryMonth)
    .map((payroll) => {
      const payments = postedPayments(payroll)
      const employeeEpf = lineTotal(payroll, ['employee_epf', 'epf_employee'])
      const employerEpf = lineTotal(payroll, ['employer_epf', 'epf_employer'])
      const employerEtf = lineTotal(payroll, ['employer_etf', 'etf_employer'])
      return {
        employeeNo: payroll.employee?.employee_no ?? payroll.employee_no ?? '',
        employeeName: payroll.employee?.name ?? payroll.employee_name ?? payroll.employee_id,
        nic: payroll.employee?.nic ?? '',
        epfNo: payroll.employee?.epf_no ?? '',
        etfRef: payroll.employee?.etf_ref ?? '',
        payrollReference: payroll.reference_no,
        payrollDate: payroll.payroll_date,
        salaryMonth: payroll.salary_month,
        regularEarnings: numberValue(payroll.regular_earnings),
        dailyWages: numberValue(payroll.daily_wages),
        pieceworkEarnings: numberValue(payroll.piecework_earnings),
        grossPay: numberValue(payroll.gross_pay),
        employeeEpf,
        employerEpf,
        employerEtf,
        totalEpf: employeeEpf + employerEpf,
        netPay: numberValue(payroll.net_pay),
        paidAmount: numberValue(payroll.paid_amount),
        balanceDue: numberValue(payroll.balance_due),
        paymentStatus: payroll.payment_status ?? (numberValue(payroll.balance_due) > 0 ? 'unpaid' : 'paid'),
        paymentDates: payments.map((payment) => payment.payment_date).filter(Boolean).join(', '),
        paymentMethods: [...new Set(payments.map((payment) => payment.method).filter(Boolean))].join(', '),
      }
    })
    .sort((left, right) => (
      left.employeeNo.localeCompare(right.employeeNo, undefined, { numeric: true })
      || left.employeeName.localeCompare(right.employeeName)
    ))
}

function safeFilenamePart(value: string) {
  return Array.from(value, (character) => character.charCodeAt(0) < 32 ? '-' : character)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '_')
}

export function payrollReportFilename(salaryMonth: string) {
  return `${safeFilenamePart(`CK_SYS_Payroll_EPF_ETF_${salaryMonth}`)}.xlsx`
}

function styleHeader(row: Row, fill = BLUE) {
  row.height = 32
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
    cell.font = { bold: true, color: { argb: WHITE }, size: 9 }
    cell.alignment = { vertical: 'middle', wrapText: true }
  })
}

function styleMoney(cell: Cell) {
  cell.numFmt = MONEY_FORMAT
  cell.alignment = { horizontal: 'right', vertical: 'middle' }
}

function styleTitle(sheet: Worksheet, title: string, columns: number) {
  sheet.mergeCells(1, 1, 1, columns)
  const cell = sheet.getCell(1, 1)
  cell.value = title
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }
  cell.font = { bold: true, color: { argb: WHITE }, size: 16 }
  cell.alignment = { vertical: 'middle' }
  sheet.getRow(1).height = 30
}

export async function createPayrollExcelBlob(
  payrolls: Payroll[],
  salaryMonth: string,
): Promise<Blob> {
  const ExcelJS = await import('exceljs')
  const rows = buildMonthlyPayrollRows(payrolls, salaryMonth)
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'CK SYS'
  workbook.created = new Date()
  workbook.modified = new Date()
  workbook.title = `Monthly payroll and EPF / ETF schedule - ${salaryMonth}`
  workbook.subject = 'Posted employee salary, EPF, and ETF values for statutory reporting preparation'

  const detail = workbook.addWorksheet('Monthly Paid List', { views: [{ state: 'frozen', ySplit: 3 }] })
  const headers = [
    'Employee No.', 'Employee name', 'NIC', 'EPF No.', 'ETF reference',
    'Payroll reference', 'Payroll date', 'Salary month', 'Regular earnings',
    'Daily wages', 'Piecework earnings', 'Gross pay', 'Employee EPF',
    'Employer EPF', 'Total EPF', 'Employer ETF', 'Net salary', 'Paid amount',
    'Balance due', 'Payment status', 'Payment date(s)', 'Payment method(s)',
  ]
  detail.columns = [
    16, 30, 18, 16, 18, 19, 15, 14, 18, 16, 19, 18, 18, 18, 18, 18, 18, 18, 18, 16, 22, 21,
  ].map((width) => ({ width }))
  styleTitle(detail, `Monthly payroll · EPF / ETF schedule · ${salaryMonth}`, headers.length)
  detail.mergeCells(2, 1, 2, headers.length)
  detail.getCell(2, 1).value = 'Posted payroll values only. Reversed payrolls are excluded. Review employee identifiers and statutory treatment before submission.'
  detail.getCell(2, 1).font = { italic: true, color: { argb: '65718A' }, size: 9 }
  detail.getCell(2, 1).alignment = { wrapText: true, vertical: 'middle' }
  detail.getRow(2).height = 29
  detail.addRow(headers)
  styleHeader(detail.getRow(3))

  rows.forEach((item) => {
    const row = detail.addRow([
      item.employeeNo,
      item.employeeName,
      item.nic,
      item.epfNo,
      item.etfRef,
      item.payrollReference,
      item.payrollDate,
      item.salaryMonth,
      item.regularEarnings,
      item.dailyWages,
      item.pieceworkEarnings,
      item.grossPay,
      item.employeeEpf,
      item.employerEpf,
      item.totalEpf,
      item.employerEtf,
      item.netPay,
      item.paidAmount,
      item.balanceDue,
      item.paymentStatus,
      item.paymentDates,
      item.paymentMethods,
    ])
    for (let column = 9; column <= 19; column += 1) styleMoney(row.getCell(column))
    const statusCell = row.getCell(20)
    const status = typeof statusCell.value === 'string' ? statusCell.value.toLowerCase() : ''
    statusCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: status === 'paid' ? PALE_GREEN : status === 'partial' ? PALE_AMBER : PALE_RED },
    }
    statusCell.font = { bold: true }
  })

  const totalRow = detail.addRow([
    '', 'MONTH TOTAL', '', '', '', '', '', '',
    rows.reduce((sum, item) => sum + item.regularEarnings, 0),
    rows.reduce((sum, item) => sum + item.dailyWages, 0),
    rows.reduce((sum, item) => sum + item.pieceworkEarnings, 0),
    rows.reduce((sum, item) => sum + item.grossPay, 0),
    rows.reduce((sum, item) => sum + item.employeeEpf, 0),
    rows.reduce((sum, item) => sum + item.employerEpf, 0),
    rows.reduce((sum, item) => sum + item.totalEpf, 0),
    rows.reduce((sum, item) => sum + item.employerEtf, 0),
    rows.reduce((sum, item) => sum + item.netPay, 0),
    rows.reduce((sum, item) => sum + item.paidAmount, 0),
    rows.reduce((sum, item) => sum + item.balanceDue, 0),
    '', '', '',
  ])
  totalRow.font = { bold: true, color: { argb: NAVY } }
  totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_BLUE } }
  for (let column = 9; column <= 19; column += 1) styleMoney(totalRow.getCell(column))
  detail.autoFilter = { from: 'A3', to: 'V3' }
  detail.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, printTitlesRow: '1:3' }

  const summary = workbook.addWorksheet('EPF ETF Summary', { views: [{ state: 'frozen', ySplit: 3 }] })
  summary.columns = [{ width: 31 }, { width: 22 }]
  styleTitle(summary, `Statutory contribution summary · ${salaryMonth}`, 2)
  summary.mergeCells('A2:B2')
  summary.getCell('A2').value = `${rows.length} posted employee payroll record${rows.length === 1 ? '' : 's'}`
  summary.addRow(['Measure', 'Amount (LKR)'])
  styleHeader(summary.getRow(3), NAVY)
  ;[
    ['Gross payroll', rows.reduce((sum, item) => sum + item.grossPay, 0)],
    ['Employee EPF', rows.reduce((sum, item) => sum + item.employeeEpf, 0)],
    ['Employer EPF', rows.reduce((sum, item) => sum + item.employerEpf, 0)],
    ['Total EPF remittance', rows.reduce((sum, item) => sum + item.totalEpf, 0)],
    ['Employer ETF', rows.reduce((sum, item) => sum + item.employerEtf, 0)],
    ['Net salary', rows.reduce((sum, item) => sum + item.netPay, 0)],
    ['Actually paid', rows.reduce((sum, item) => sum + item.paidAmount, 0)],
    ['Outstanding', rows.reduce((sum, item) => sum + item.balanceDue, 0)],
  ].forEach(([label, amount]) => {
    const row = summary.addRow([label, amount])
    styleMoney(row.getCell(2))
  })

  const notes = workbook.addWorksheet('Read Me')
  notes.columns = [{ width: 27 }, { width: 95 }]
  notes.addRow(['Item', 'Detail'])
  styleHeader(notes.getRow(1), NAVY)
  notes.addRows([
    ['Salary month', salaryMonth],
    ['Generated', new Date().toISOString()],
    ['Source', 'CK SYS posted payroll records and their immutable payroll detail lines.'],
    ['Scope', 'Reversed payroll records are excluded. Paid, partially paid, and unpaid posted payrolls remain visible with their actual paid amount and balance.'],
    ['EPF / ETF values', 'Employee EPF, employer EPF, and employer ETF are copied from the posted payroll detail lines; this export does not recalculate or silently replace them.'],
    ['Before submission', 'Confirm NIC, EPF number, ETF reference, contribution eligibility, and current government submission rules with the responsible payroll officer.'],
  ])
  notes.getColumn(2).alignment = { wrapText: true, vertical: 'top' }

  workbook.eachSheet((sheet) => {
    sheet.properties.defaultRowHeight = 21
    sheet.headerFooter.oddFooter = '&LCK SYS · CONFIDENTIAL PAYROLL&RPage &P of &N'
    sheet.eachRow((row) => row.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', wrapText: true, ...cell.alignment }
    }))
  })

  const buffer = await workbook.xlsx.writeBuffer()
  return new Blob([new Uint8Array(buffer)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

export async function downloadPayrollExcel(payrolls: Payroll[], salaryMonth: string) {
  const blob = await createPayrollExcelBlob(payrolls, salaryMonth)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = payrollReportFilename(salaryMonth)
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
