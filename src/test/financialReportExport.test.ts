// @vitest-environment node
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { createFinancialReportModel, updateFinancialReportField } from '../lib/financialReport'
import { createFinancialExcelBlob, createFinancialPdfBlob } from '../lib/financialReportExport'

function fixture() {
  return updateFinancialReportField(createFinancialReportModel({ finance: { revenue: '1000', cogs: '100', expenses: '200' } }, [{
    account_code: 'CASH', account_name: 'Cash on hand', category: 'asset', debit_total: '1000', credit_total: '0', balance: '1000',
  }], 2026), 'summary.finance.revenue', '1500')
}

describe('financial downloads', () => {
  it('creates a real Excel workbook with numeric amounts, source values, and edit audit', async () => {
    const blob = await createFinancialExcelBlob(fixture())
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(await blob.arrayBuffer())
    expect(workbook.worksheets.map((sheet) => sheet.name)).toContain('Account Balances')
    expect(workbook.getWorksheet('Income Statement')?.getCell('B3').value).toBe(1500)
    expect(workbook.getWorksheet('Income Statement')?.getCell('B3').numFmt).toContain('LKR')
    expect(workbook.getWorksheet('Snapshot Details')?.getCell('C3').value).toBe(1000)
    expect(workbook.getWorksheet('Snapshot Details')?.getCell('D3').value).toBe(1500)
    expect(workbook.getWorksheet('Edit Audit')?.getCell('A2').value).toContain('summary.finance.revenue')
  })

  it('creates a multipage PDF for long tables without throwing in cell formatting', async () => {
    const model = fixture()
    model.accountBalances.rows = Array.from({ length: 180 }, (_, index) => ({ ...model.accountBalances.rows[0]!, id: String(index) }))
    const blob = await createFinancialPdfBlob(model)
    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(5000)
    const bytes = await blob.text()
    expect(bytes.startsWith('%PDF-')).toBe(true)
    expect(bytes.match(/\/Type \/Page\b/g)?.length).toBeGreaterThan(2)
  })
})
