import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { AccountingPdfStudio } from '../components/AccountingPdfStudio'
import { ManualSelect } from '../components/ManualSelect'
import { ToastProvider } from '../components/Toast'
import { createFinancialExportDocument } from '../lib/financialReport'
import { downloadFinancialExcel, downloadFinancialPdf } from '../lib/financialReportExport'

vi.mock('../lib/financialReportExport', () => ({ downloadFinancialExcel: vi.fn(), downloadFinancialPdf: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('staff manual selection', () => {
  it('uses presets and permits custom values without submitting the Manual marker', async () => {
    function Picker() {
      const [value, setValue] = useState('monthly_salary')
      return <><ManualSelect label="Earning type" value={value} onChange={setValue} options={['monthly_salary', 'bonus']} /><output>{value}</output></>
    }
    const user = userEvent.setup()
    render(<Picker />)
    await user.selectOptions(screen.getByRole('combobox'), '__manual__')
    await user.clear(screen.getByRole('textbox'))
    await user.type(screen.getByRole('textbox'), 'Special allowance')
    expect(screen.getByRole('status')).toHaveTextContent('Special allowance')
    await user.selectOptions(screen.getByRole('combobox'), 'bonus')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('bonus')
  })
})

describe('PDF Studio', () => {
  it('exports the same edited values to both formats, preserves source values, and resets', async () => {
    const user = userEvent.setup()
    const summary = { finance: { revenue: '1000.00', cogs: '100.00', expenses: '200.00' } }
    render(<ToastProvider><AccountingPdfStudio summary={summary} accountBalances={[]} year={2026} onExit={vi.fn()} /></ToastProvider>)
    const revenue = screen.getByRole('spinbutton', { name: 'Finance: Revenue' })
    await user.clear(revenue)
    expect(screen.getByRole('button', { name: 'Save PDF' })).toBeDisabled()
    await user.type(revenue, '1500')
    await user.click(screen.getByRole('button', { name: 'Save PDF' }))
    await user.click(screen.getByRole('button', { name: 'Save Excel' }))
    const pdfModel = vi.mocked(downloadFinancialPdf).mock.calls[0]![0]
    expect(vi.mocked(downloadFinancialExcel).mock.calls[0]![0]).toEqual(pdfModel)
    expect(createFinancialExportDocument(pdfModel).incomeStatement[0]?.value).toBe(1500)
    expect(summary.finance.revenue).toBe('1000.00')
    await user.click(screen.getByRole('button', { name: 'Reset Finance: Revenue' }))
    expect(revenue).toHaveValue(1000)
    expect(screen.getByText('Original snapshot')).toBeInTheDocument()
  })

  it('keeps edits available after an export failure', async () => {
    vi.mocked(downloadFinancialPdf).mockRejectedValueOnce(new Error('Download failed'))
    const user = userEvent.setup()
    render(<ToastProvider><AccountingPdfStudio summary={{ finance: { revenue: 100 } }} accountBalances={[]} year={2026} onExit={vi.fn()} /></ToastProvider>)
    await user.click(screen.getByRole('button', { name: 'Save PDF' }))
    expect(await screen.findByText('Download failed')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Finance: Revenue' })).toHaveValue(100)
    expect(screen.getByRole('button', { name: 'Save PDF' })).toBeEnabled()
  })
})
