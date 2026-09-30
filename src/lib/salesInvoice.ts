import type { InventoryPosition, Sale, SaleLine } from '../types/api'
import { money, numberValue, quantity, shortDate } from './format'

function saleLines(sale: Sale) {
  return sale.sale_items ?? []
}

export function suggestedUnitPrice(item: Pick<InventoryPosition, 'average_unit_cost' | 'selling_price'>) {
  const cataloguePrice = numberValue(item.selling_price)
  if (cataloguePrice > 0) return cataloguePrice
  return Math.round(numberValue(item.average_unit_cost) * 1.5 * 100) / 100
}

export function normalizeWhatsAppPhone(value: string | null | undefined) {
  let digits = String(value ?? '').replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.startsWith('0')) digits = `94${digits.slice(1)}`
  else if (digits.length === 9) digits = `94${digits}`
  return digits.length >= 8 && digits.length <= 15 ? digits : null
}

export function saleLineName(line: SaleLine) {
  return line.item?.name || line.item_name || `Item ${line.item_id.slice(0, 8)}`
}

export function invoiceWhatsAppMessage(sale: Sale) {
  const lines = saleLines(sale).map((line) => (
    `• ${saleLineName(line)} — ${quantity(line.quantity, 3)} × ${money(line.unit_price)} = ${money(line.line_total)}`
  ))
  return [
    `Hello ${sale.customer_name},`,
    `Invoice ${sale.invoice_no} dated ${shortDate(sale.sale_date)}`,
    '',
    ...lines,
    '',
    `Total: ${money(sale.total_amount)}`,
    `Paid: ${money(sale.paid_amount)}`,
    `Balance due: ${money(sale.balance_due)}`,
    '',
    'Thank you.',
  ].join('\n')
}
