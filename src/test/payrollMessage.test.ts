import { describe, expect, it } from 'vitest'
import { payrollWhatsAppMessage } from '../lib/payrollMessage'
import { suggestedUnitPrice } from '../lib/salesInvoice'

describe('payroll WhatsApp message', () => {
  it('includes the employee, payroll reference, salary totals, and company sign-off', () => {
    const message = payrollWhatsAppMessage({
      employeeName: 'Nimali Perera',
      companyName: 'CK Industries',
      salaryMonth: '2026-09',
      reference: 'PAY-202609-001',
      gross: 100000,
      deductions: 8000,
      net: 92000,
      paid: 92000,
      due: 0,
    })

    expect(message).toContain('Dear Nimali Perera')
    expect(message).toContain('PAY-202609-001')
    expect(message).toContain('Gross earnings:')
    expect(message).toContain('Net salary:')
    expect(message).toContain('Payment status: Fully paid')
    expect(message).toContain('CK Industries')
  })
})

describe('finished-product selling price', () => {
  it('uses the saved catalogue price before the cost markup fallback', () => {
    expect(suggestedUnitPrice({ selling_price: 2750, average_unit_cost: 1000 })).toBe(2750)
  })

  it('keeps the legacy markup for products without a saved price', () => {
    expect(suggestedUnitPrice({ selling_price: 0, average_unit_cost: 1000 })).toBe(1500)
  })
})
