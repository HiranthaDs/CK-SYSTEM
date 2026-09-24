import type { Cell, Row, Worksheet } from 'exceljs'
import {
  createFinancialExportDocument,
  type FinancialExportCell,
  type FinancialExportDocument,
  type FinancialExportTable,
  type FinancialReportModel,
  type FinancialStatementLine,
} from './financialReport'

const NAVY = '1D2939'
const BLUE = '175CD3'
const PALE_BLUE = 'EFF8FF'
const GREEN = '027A48'
const PALE_GREEN = 'ECFDF3'
const RED = 'B42318'
const PALE_RED = 'FEF3F2'
const AMBER = 'B54708'
const PALE_AMBER = 'FFFAEB'
const GREY = '667085'
const PALE_GREY = 'F2F4F7'
const WHITE = 'FFFFFF'
const CURRENCY_FORMAT = '"LKR "#,##0.00;[Red]-"LKR "#,##0.00'
const NUMBER_FORMAT = '#,##0.######;[Red]-#,##0.######'

function numeric(value: unknown) {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function safeFilenamePart(value: string) {
  return Array.from(value, (character) => character.charCodeAt(0) < 32 ? '-' : character).join('').replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, '_')
}

function exportDateStamp() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function financialReportFilename(model: FinancialReportModel, extension: 'pdf' | 'xlsx') {
  return `${safeFilenamePart(`CK_SYS_Financial_Summary_Account_Balances_FY${model.year}_${exportDateStamp()}`)}.${extension}`
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function pdfMoney(value: number) {
  return `LKR ${value.toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export async function createFinancialPdfBlob(model: FinancialReportModel): Promise<Blob> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])
  const report = createFinancialExportDocument(model)
  const document = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true })
  const pageWidth = document.internal.pageSize.getWidth()
  const pageHeight = document.internal.pageSize.getHeight()
  const margin = 14
  const contentWidth = pageWidth - margin * 2
  type AutoTableDocument = typeof document & { lastAutoTable?: { finalY: number } }

  document.setProperties({
    title: `${report.title} - FY ${report.year}`,
    subject: 'Internal, unaudited financial summary and account balances',
    author: 'CK SYS',
    creator: 'CK SYS Financial Report Studio',
    keywords: 'financial summary, account balances, internal, unaudited',
  })

  let cursorY = 18
  const addPageIfNeeded = (minimumHeight: number) => {
    if (cursorY + minimumHeight <= pageHeight - 24) return
    document.addPage()
    cursorY = 20
  }
  const sectionTitle = (title: string) => {
    addPageIfNeeded(18)
    document.setFillColor(`#${NAVY}`)
    document.roundedRect(margin, cursorY, contentWidth, 8, 1.5, 1.5, 'F')
    document.setTextColor(255, 255, 255)
    document.setFont('helvetica', 'bold')
    document.setFontSize(10)
    document.text(title.toUpperCase(), margin + 3, cursorY + 5.3)
    cursorY += 11
  }
  const statementTable = (title: string, lines: FinancialStatementLine[]) => {
    addPageIfNeeded(17 + lines.length * 8)
    sectionTitle(title)
    autoTable(document, {
      startY: cursorY,
      margin: { top: 20, bottom: 24, left: margin, right: margin },
      rowPageBreak: 'avoid',
      showHead: 'everyPage',
      head: [['Description', 'Amount (LKR)']],
      body: lines.map((line) => [line.label, pdfMoney(line.value)]),
      theme: 'grid',
      styles: { font: 'helvetica', fontSize: 8.3, cellPadding: 2.2, lineColor: [208, 213, 221], lineWidth: 0.15 },
      headStyles: { fillColor: [242, 244, 247], textColor: [52, 64, 84], fontStyle: 'bold' },
      columnStyles: { 1: { halign: 'right', cellWidth: 48 } },
      didParseCell: ({ row, cell, column, section }) => {
        if (section !== 'body') return
        const line = lines[row.index]
        if (line?.emphasis) {
          cell.styles.fontStyle = 'bold'
          cell.styles.fillColor = line.emphasis === 'total' ? [239, 248, 255] : [249, 250, 251]
        }
        if (column.index === 1 && line && line.value < 0) cell.styles.textColor = [180, 35, 24]
      },
    })
    cursorY = ((document as AutoTableDocument).lastAutoTable?.finalY ?? cursorY) + 7
  }
  const reportTable = (table: FinancialExportTable) => {
    if (!table.columns.length) return
    // Keep short tables together. Long tables may span pages, where autoTable
    // repeats their column headings on every page.
    if (table.rows.length <= 10) addPageIfNeeded(17 + table.rows.length * 8)
    sectionTitle(table.title)
    const numericColumns = new Set<number>()
    table.columns.forEach((column, columnIndex) => {
      if (table.rows.some((row) => ['money', 'number'].includes(row.cells[columnIndex]?.kind ?? ''))) numericColumns.add(columnIndex)
    })
    autoTable(document, {
      startY: cursorY,
      margin: { top: 20, bottom: 24, left: margin, right: margin },
      rowPageBreak: 'avoid',
      showHead: 'everyPage',
      head: [table.columns.map((column) => column.label)],
      body: table.rows.map((row) => row.cells.map((cell) => `${cell.display}${cell.changed ? ' *' : ''}`)),
      theme: 'grid',
      styles: { font: 'helvetica', fontSize: table.columns.length > 5 ? 6.6 : 7.7, cellPadding: 1.8, lineColor: [208, 213, 221], lineWidth: 0.12, overflow: 'linebreak' },
      headStyles: { fillColor: [234, 236, 240], textColor: [29, 41, 57], fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [249, 250, 251] },
      didParseCell: ({ row, cell, column, section }) => {
        if (numericColumns.has(column.index)) cell.styles.halign = 'right'
        if (section === 'body' && table.rows[row.index]?.cells[column.index]?.changed) {
          cell.styles.fillColor = [255, 250, 235]
          cell.styles.textColor = [181, 71, 8]
          cell.styles.fontStyle = 'bold'
        }
      },
    })
    cursorY = ((document as AutoTableDocument).lastAutoTable?.finalY ?? cursorY) + 7
  }

  document.setTextColor(`#${NAVY}`)
  document.setFont('helvetica', 'bold')
  document.setFontSize(18)
  const titleLines = document.splitTextToSize(report.title, contentWidth) as string[]
  document.text(titleLines, margin, cursorY)
  cursorY += titleLines.length * 7
  document.setTextColor(`#${GREY}`)
  document.setFont('helvetica', 'normal')
  document.setFontSize(9)
  document.text(report.subtitle, margin, cursorY)
  cursorY += 5
  document.setFontSize(7.4)
  document.text(`Snapshot generated: ${report.generatedAt ? new Date(report.generatedAt).toLocaleString('en-LK') : 'Not supplied'} · Export generated: ${new Date().toLocaleString('en-LK')} · Currency: ${report.currency}`, margin, cursorY)
  cursorY += 8

  document.setFillColor(254, 243, 242)
  document.setDrawColor(254, 205, 202)
  document.roundedRect(margin, cursorY, contentWidth, 16, 1.5, 1.5, 'FD')
  document.setTextColor(180, 35, 24)
  document.setFont('helvetica', 'bold')
  document.setFontSize(8)
  document.text('INTERNAL USE ONLY · UNAUDITED', margin + 3, cursorY + 5)
  document.setFont('helvetica', 'normal')
  document.setFontSize(6.7)
  document.text(document.splitTextToSize(report.disclaimer, contentWidth - 6) as string[], margin + 3, cursorY + 9)
  cursorY += 21

  autoTable(document, {
    startY: cursorY,
    margin: { top: 20, bottom: 24, left: margin, right: margin },
      rowPageBreak: 'avoid',
      showHead: 'everyPage',
    head: [['Integrity check', 'Status', 'Difference']],
    body: [
      ['Trial balance', report.integrity.trialBalanceOk ? 'Balanced' : 'Review required', pdfMoney(report.integrity.trialBalanceDifference)],
      ['Financial position', report.integrity.positionOk ? 'Balanced' : 'Review required', pdfMoney(report.integrity.positionDifference)],
      ['Summary reconciliation', report.integrity.summaryReconciled === null ? 'Not comparable' : report.integrity.summaryReconciled ? 'Reconciled' : 'Review required', report.integrity.summaryRevenueDifference === null ? '—' : pdfMoney(report.integrity.summaryRevenueDifference)],
      ['Edited fields', report.changeCount ? 'User-edited draft' : 'Live snapshot', String(report.changeCount)],
    ],
    theme: 'grid',
    styles: { fontSize: 7.6, cellPadding: 2, lineColor: [208, 213, 221], lineWidth: 0.15 },
    headStyles: { fillColor: [23, 92, 211], textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: { 2: { halign: 'right' } },
    didParseCell: ({ cell, column, section }) => {
      if (section !== 'body' || column.index !== 1) return
      const value = typeof cell.raw === 'string' ? cell.raw : ''
      if (value === 'Balanced' || value === 'Reconciled' || value === 'Live snapshot') cell.styles.textColor = [2, 122, 72]
      else if (value === 'Review required') cell.styles.textColor = [180, 35, 24]
      else cell.styles.textColor = [181, 71, 8]
      cell.styles.fontStyle = 'bold'
    },
  })
  cursorY = ((document as AutoTableDocument).lastAutoTable?.finalY ?? cursorY) + 8

  statementTable('Income statement', report.incomeStatement)
  statementTable('Statement of financial position', report.financialPosition)
  report.summaryTables.forEach(reportTable)
  reportTable(report.accountBalances)

  const pages = document.getNumberOfPages()
  for (let page = 1; page <= pages; page += 1) {
    document.setPage(page)
    document.setDrawColor(208, 213, 221)
    document.line(margin, pageHeight - 15, pageWidth - margin, pageHeight - 15)
    document.setFont('helvetica', 'bold')
    document.setFontSize(6.5)
    document.setTextColor(180, 35, 24)
    document.text(report.changeCount ? 'INTERNAL · USER-EDITED · UNAUDITED' : 'INTERNAL · UNMODIFIED SNAPSHOT · UNAUDITED', margin, pageHeight - 10)
    document.setFont('helvetica', 'normal')
    document.setTextColor(102, 112, 133)
    document.text(`FY ${report.year} · Page ${page} of ${pages}`, pageWidth - margin, pageHeight - 10, { align: 'right' })
  }

  return document.output('blob')
}

function excelCellValue(cell: FinancialExportCell) {
  if (cell.kind === 'money' || cell.kind === 'number') return numeric(cell.value) ?? cell.display
  if (cell.kind === 'boolean') return Boolean(cell.value)
  return cell.value === null ? '' : cell.value
}

function excelSourceValue(cell: FinancialExportCell) {
  if (cell.kind === 'money' || cell.kind === 'number') return numeric(cell.sourceValue) ?? cell.sourceDisplay
  if (cell.kind === 'boolean') return Boolean(cell.sourceValue)
  return cell.sourceValue === null ? '' : cell.sourceValue
}

function styleTitle(row: Row, columnCount: number) {
  row.height = 27
  row.eachCell({ includeEmpty: true }, (cell, column) => {
    if (column > columnCount) return
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }
    cell.font = { bold: true, size: 16, color: { argb: WHITE } }
    cell.alignment = { vertical: 'middle' }
  })
}

function styleHeader(row: Row, fill = BLUE) {
  row.height = 21
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
    cell.font = { bold: true, color: { argb: WHITE } }
    cell.alignment = { vertical: 'middle', wrapText: true }
    cell.border = { bottom: { style: 'thin', color: { argb: 'D0D5DD' } } }
  })
}

function styleMoney(cell: Cell, value: number) {
  cell.numFmt = CURRENCY_FORMAT
  cell.alignment = { horizontal: 'right' }
  if (value < 0) cell.font = { ...(cell.font ?? {}), color: { argb: RED } }
}

function styleStatementSheet(sheet: Worksheet, report: FinancialExportDocument, title: string, lines: FinancialStatementLine[]) {
  sheet.columns = [{ width: 45 }, { width: 24 }]
  sheet.mergeCells('A1:B1')
  sheet.getCell('A1').value = `${title} · FY ${report.year}`
  styleTitle(sheet.getRow(1), 2)
  sheet.addRow(['Description', 'Amount (LKR)'])
  styleHeader(sheet.getRow(2))
  lines.forEach((line) => {
    const row = sheet.addRow([line.label, line.value])
    styleMoney(row.getCell(2), line.value)
    if (line.emphasis) {
      row.font = { bold: true, color: { argb: line.emphasis === 'total' ? BLUE : NAVY } }
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: line.emphasis === 'total' ? PALE_BLUE : PALE_GREY } }
    }
  })
  sheet.views = [{ state: 'frozen', ySplit: 2 }]
  sheet.autoFilter = { from: 'A2', to: 'B2' }
  sheet.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 }
}

export async function createFinancialExcelBlob(model: FinancialReportModel): Promise<Blob> {
  const ExcelJS = await import('exceljs')
  const report = createFinancialExportDocument(model)
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'CK SYS'
  workbook.lastModifiedBy = 'CK SYS Financial Report Studio'
  workbook.created = new Date()
  workbook.modified = new Date()
  workbook.subject = 'Internal, unaudited financial summary and account balances'
  workbook.title = `${report.title} - FY ${report.year}`
  workbook.description = report.disclaimer
  workbook.calcProperties.fullCalcOnLoad = true

  const summary = workbook.addWorksheet('Executive Summary', { views: [{ state: 'frozen', ySplit: 5 }] })
  summary.columns = [{ width: 37 }, { width: 26 }, { width: 26 }, { width: 26 }]
  summary.mergeCells('A1:D1')
  summary.getCell('A1').value = `${report.title} · FY ${report.year}`
  styleTitle(summary.getRow(1), 4)
  summary.mergeCells('A2:D2')
  summary.getCell('A2').value = report.disclaimer
  summary.getCell('A2').alignment = { wrapText: true, vertical: 'middle' }
  summary.getCell('A2').font = { bold: true, color: { argb: RED }, size: 9 }
  summary.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_RED } }
  summary.getRow(2).height = 46
  summary.addRow(['Report period', `Fiscal year ${report.year}`, 'Currency', report.currency])
  summary.addRow(['Snapshot generated', report.generatedAt ?? 'Not supplied', 'Export generated', new Date().toISOString()])
  summary.addRow(['Edited fields', report.changeCount, 'Draft status', report.changeCount ? 'USER-EDITED' : 'UNMODIFIED SNAPSHOT'])
  summary.addRow([])
  const integrityHeader = summary.addRow(['Integrity check', 'Status', 'Difference', 'Notes'])
  styleHeader(integrityHeader)
  const integrityRows: Array<[string, string, number | string, string]> = [
    ['Trial balance', report.integrity.trialBalanceOk ? 'Balanced' : 'Review required', report.integrity.trialBalanceDifference, 'Debit total must equal credit total'],
    ['Financial position', report.integrity.positionOk ? 'Balanced' : 'Review required', report.integrity.positionDifference, 'Assets must equal liabilities, equity and current earnings'],
    ['Summary reconciliation', report.integrity.summaryReconciled === null ? 'Not comparable' : report.integrity.summaryReconciled ? 'Reconciled' : 'Review required', report.integrity.summaryRevenueDifference ?? '', 'Summary fields compared with account categories'],
    ['Numeric validation', report.integrity.invalidNumericFields ? 'Review required' : 'Valid', report.integrity.invalidNumericFields, 'Blank or invalid numeric cells'],
  ]
  integrityRows.forEach((values) => {
    const row = summary.addRow(values)
    if (typeof values[2] === 'number') styleMoney(row.getCell(3), values[2])
    const ok = ['Balanced', 'Reconciled', 'Valid'].includes(values[1])
    row.getCell(2).font = { bold: true, color: { argb: ok ? GREEN : values[1] === 'Not comparable' ? AMBER : RED } }
    row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ok ? PALE_GREEN : values[1] === 'Not comparable' ? PALE_AMBER : PALE_RED } }
  })
  summary.addRow([])
  const kpiHeader = summary.addRow(['Metric', 'Amount (LKR)'])
  styleHeader(kpiHeader, NAVY)
  ;[
    ['Assets', report.integrity.assets],
    ['Liabilities', report.integrity.liabilities],
    ['Posted equity', report.integrity.equity],
    ['Current earnings', report.integrity.currentEarnings],
    ['Revenue', report.incomeStatement[0]?.value ?? 0],
    ['Net result', report.incomeStatement.at(-1)?.value ?? 0],
  ].forEach(([label, amount]) => {
    const row = summary.addRow([label, amount])
    styleMoney(row.getCell(2), Number(amount))
  })
  summary.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 }

  const income = workbook.addWorksheet('Income Statement')
  styleStatementSheet(income, report, 'Income Statement', report.incomeStatement)
  const position = workbook.addWorksheet('Financial Position')
  styleStatementSheet(position, report, 'Statement of Financial Position', report.financialPosition)

  const accounts = workbook.addWorksheet('Account Balances', { views: [{ state: 'frozen', ySplit: 2 }] })
  const accountHeaders = [
    'Code', 'Account', 'Category',
    'Source Debit', 'Report Debit',
    'Source Credit', 'Report Credit',
    'Source Balance', 'Report Balance', 'Edited',
  ]
  accounts.columns = [
    { width: 18 }, { width: 34 }, { width: 18 },
    { width: 19 }, { width: 19 }, { width: 19 }, { width: 19 }, { width: 19 }, { width: 19 }, { width: 12 },
  ]
  accounts.mergeCells('A1:J1')
  accounts.getCell('A1').value = `Account Balances · FY ${report.year}`
  styleTitle(accounts.getRow(1), 10)
  accounts.addRow(accountHeaders)
  styleHeader(accounts.getRow(2))
  report.accountBalances.rows.forEach((record) => {
    const byKey = new Map(record.cells.map((cell) => [cell.key, cell]))
    const debit = byKey.get('debit_total')
    const credit = byKey.get('credit_total')
    const balance = byKey.get('balance')
    const row = accounts.addRow([
      byKey.get('account_code')?.value ?? '',
      byKey.get('account_name')?.value ?? '',
      byKey.get('category')?.value ?? '',
      debit ? excelSourceValue(debit) : 0,
      debit ? excelCellValue(debit) : 0,
      credit ? excelSourceValue(credit) : 0,
      credit ? excelCellValue(credit) : 0,
      balance ? excelSourceValue(balance) : 0,
      balance ? excelCellValue(balance) : 0,
      record.changed ? 'Yes' : 'No',
    ])
    ;[4, 5, 6, 7, 8, 9].forEach((column) => {
      const cell = row.getCell(column)
      if (typeof cell.value === 'number') styleMoney(cell, cell.value)
    })
    if (record.changed) {
      row.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_AMBER } } })
      row.getCell(10).font = { bold: true, color: { argb: AMBER } }
    }
  })
  const totalRow = accounts.addRow([
    '', 'TRIAL BALANCE TOTAL', '', '', report.integrity.debitTotal, '', report.integrity.creditTotal, '', '', '',
  ])
  totalRow.font = { bold: true, color: { argb: NAVY } }
  totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_BLUE } }
  ;[5, 7].forEach((column) => styleMoney(totalRow.getCell(column), Number(totalRow.getCell(column).value ?? 0)))
  accounts.autoFilter = { from: 'A2', to: 'J2' }
  accounts.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 }

  const details = workbook.addWorksheet('Snapshot Details', { views: [{ state: 'frozen', ySplit: 2 }] })
  details.columns = [{ width: 38 }, { width: 30 }, { width: 28 }, { width: 28 }, { width: 12 }]
  details.mergeCells('A1:E1')
  details.getCell('A1').value = `Financial Summary Field Detail · FY ${report.year}`
  styleTitle(details.getRow(1), 5)
  details.addRow(['Section / table', 'Field', 'Source value', 'Report value', 'Edited'])
  styleHeader(details.getRow(2))
  report.summaryTables.forEach((table) => {
    table.rows.forEach((record) => {
      record.cells.forEach((cell) => {
        if (cell.key === 'field') return
        const fieldCell = record.cells.find((candidate) => candidate.key === 'field')
        const row = details.addRow([
          table.title,
          fieldCell?.display ?? cell.label,
          excelSourceValue(cell),
          excelCellValue(cell),
          cell.changed ? 'Yes' : 'No',
        ])
        if (cell.kind === 'money') {
          if (typeof row.getCell(3).value === 'number') styleMoney(row.getCell(3), Number(row.getCell(3).value))
          if (typeof row.getCell(4).value === 'number') styleMoney(row.getCell(4), Number(row.getCell(4).value))
        } else if (cell.kind === 'number') {
          row.getCell(3).numFmt = NUMBER_FORMAT
          row.getCell(4).numFmt = NUMBER_FORMAT
        }
        if (cell.changed) {
          row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_AMBER } }
          row.getCell(4).font = { bold: true, color: { argb: AMBER } }
          row.getCell(5).font = { bold: true, color: { argb: AMBER } }
        }
      })
    })
  })
  details.autoFilter = { from: 'A2', to: 'E2' }
  details.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 }

  const changes = workbook.addWorksheet('Edit Audit')
  changes.columns = [{ width: 45 }, { width: 28 }, { width: 28 }]
  changes.addRow(['Field path', 'Source value', 'Report value'])
  styleHeader(changes.getRow(1), NAVY)
  const allTables = [...report.summaryTables, report.accountBalances]
  allTables.forEach((table) => table.rows.forEach((record) => record.cells.filter((cell) => cell.changed).forEach((cell) => {
    const row = changes.addRow([`${table.title} / ${record.id} / ${cell.label}`, excelSourceValue(cell), excelCellValue(cell)])
    row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_AMBER } }
    row.getCell(3).font = { bold: true, color: { argb: AMBER } }
  })))
  if (!report.changeCount) changes.addRow(['No export-only edits were made.', '', ''])
  changes.views = [{ state: 'frozen', ySplit: 1 }]

  const notes = workbook.addWorksheet('Notes')
  notes.columns = [{ width: 28 }, { width: 95 }]
  notes.addRow(['Item', 'Value'])
  styleHeader(notes.getRow(1), NAVY)
  notes.addRows([
    ['Status', report.changeCount ? 'Internal, user-edited and unaudited' : 'Internal, unmodified server snapshot and unaudited'],
    ['Fiscal year', report.year],
    ['Currency', report.currency],
    ['Snapshot generated', report.generatedAt ?? 'Not supplied'],
    ['Workbook generated', new Date().toISOString()],
    ['Disclaimer', report.disclaimer],
    ['Interpretation', 'Source values are the server snapshot. Report values include local PDF Studio edits. These edits were not written to the database.'],
  ])
  notes.getColumn(2).alignment = { wrapText: true, vertical: 'top' }

  workbook.eachSheet((sheet) => {
    sheet.properties.defaultRowHeight = 22
    sheet.pageSetup = { ...sheet.pageSetup, fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, printTitlesRow: sheet.name === 'Edit Audit' || sheet.name === 'Notes' ? '1:1' : '1:2' }
    sheet.headerFooter.oddFooter = `&LCK SYS · INTERNAL · UNAUDITED&C${report.changeCount ? 'USER-EDITED' : 'UNMODIFIED SNAPSHOT'}&RPage &P of &N`
    sheet.eachRow((row) => row.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', wrapText: true, ...cell.alignment }
    }))
  })

  const buffer = await workbook.xlsx.writeBuffer()
  return new Blob([new Uint8Array(buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

export async function downloadFinancialPdf(model: FinancialReportModel) {
  downloadBlob(await createFinancialPdfBlob(model), financialReportFilename(model, 'pdf'))
}

export async function downloadFinancialExcel(model: FinancialReportModel) {
  downloadBlob(await createFinancialExcelBlob(model), financialReportFilename(model, 'xlsx'))
}
