import { format, isValid, parseISO } from 'date-fns'

export function numberValue(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export function money(value: unknown) {
  return new Intl.NumberFormat('en-LK', {
    style: 'currency',
    currency: 'LKR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numberValue(value))
}

export function quantity(value: unknown, digits = 2) {
  return new Intl.NumberFormat('en-LK', {
    maximumFractionDigits: digits,
  }).format(numberValue(value))
}

export function shortDate(value: unknown) {
  if (typeof value !== 'string' || !value) return '—'
  const parsed = parseISO(value)
  return isValid(parsed) ? format(parsed, 'dd MMM yyyy') : value
}

export function monthLabel(value: unknown) {
  if (typeof value !== 'string' || !value) return '—'
  const parsed = parseISO(value.length === 7 ? `${value}-01` : value)
  return isValid(parsed) ? format(parsed, 'MMMM yyyy') : value
}

export const localIsoDate = () => format(new Date(), 'yyyy-MM-dd')
export const localIsoMonth = () => format(new Date(), 'yyyy-MM')

export const titleCase = (value: unknown) => {
  const text = typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : ''
  return text
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function recordValue<T>(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (value !== null && value !== undefined && value !== '') return value as T
  }
  return undefined
}

export function printElement(title: string, html: string) {
  const popup = window.open('', '_blank', 'noopener,noreferrer,width=1000,height=800')
  if (!popup) return false
  popup.document.write(`<!doctype html><html><head><title>${title}</title><style>
    body{font:14px/1.5 system-ui,sans-serif;color:#111827;padding:32px}h1,h2{margin:0 0 16px}
    table{border-collapse:collapse;width:100%;margin-top:20px}th,td{border:1px solid #d1d5db;padding:8px;text-align:left}
    th{background:#f3f4f6}.numeric{text-align:right}.no-print{display:none!important}@media print{button{display:none}}
  </style></head><body>${html}<script>window.addEventListener('load',()=>window.print())</script></body></html>`)
  popup.document.close()
  return true
}
