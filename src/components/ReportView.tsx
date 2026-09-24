import { Printer } from 'lucide-react'
import type { JsonRecord } from '../types/api'
import { money, numberValue, titleCase } from '../lib/format'
import { Button, Card, EmptyState, SectionTitle, TableWrap } from './UI'

function isMoneyKey(key: string) {
  return /(amount|value|cost|revenue|expense|profit|asset|liabilit|equity|balance|paid|due|gross|net|debit|credit|payable|receivable|cash)/i.test(key)
}

function printable(value: unknown, key: string) {
  if (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value))) {
    return isMoneyKey(key) ? money(numberValue(value)) : String(value)
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) || '—'
  } catch {
    return '—'
  }
}

function rowKey(row: JsonRecord, index: number) {
  const candidate = row.id ?? row.reference_no
  return typeof candidate === 'string' || typeof candidate === 'number' ? candidate : index
}

export function ReportView({
  title,
  description,
  data,
}: {
  title: string
  description?: string | undefined
  data: JsonRecord | null | undefined
}) {
  if (!data || !Object.keys(data).length) return <EmptyState title="Report is empty" message="No posted records match this report period." />

  const primitive = Object.entries(data).filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
  const arrays = Object.entries(data).filter(([, value]) => Array.isArray(value)) as Array<[string, unknown[]]>
  const groups = Object.entries(data).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value)) as Array<[string, JsonRecord]>

  return (
    <div className="report-view print-area">
      <SectionTitle
        title={title}
        description={description}
        actions={<Button className="no-print" variant="secondary" icon={Printer} onClick={() => window.print()}>Print / save PDF</Button>}
      />

      {primitive.length ? (
        <div className="report-metrics">
          {primitive.map(([key, value]) => <Card key={key}><span>{titleCase(key)}</span><strong>{printable(value, key)}</strong></Card>)}
        </div>
      ) : null}

      {groups.map(([groupName, group]) => (
        <section className="report-section" key={groupName}>
          <h3>{titleCase(groupName)}</h3>
          <dl className="report-definition">
            {Object.entries(group).filter(([, value]) => !Array.isArray(value) && (value === null || typeof value !== 'object')).map(([key, value]) => (
              <div key={key}><dt>{titleCase(key)}</dt><dd>{printable(value, key)}</dd></div>
            ))}
          </dl>
        </section>
      ))}

      {arrays.map(([groupName, rows]) => {
        if (!rows.length || typeof rows[0] !== 'object' || rows[0] === null) return null
        const records = rows as JsonRecord[]
        const columns = Array.from(new Set(records.flatMap((row) => Object.keys(row))))
          .filter((column) => records.some((row) => row[column] === null || ['string', 'number', 'boolean'].includes(typeof row[column])))
          .slice(0, 12)
        return (
          <section className="report-section" key={groupName}>
            <h3>{titleCase(groupName)}</h3>
            <TableWrap>
              <table><thead><tr>{columns.map((column) => <th key={column}>{titleCase(column)}</th>)}</tr></thead>
                <tbody>{records.map((row, index) => <tr key={rowKey(row, index)}>{columns.map((column) => <td className={isMoneyKey(column) ? 'numeric' : undefined} key={column}>{printable(row[column], column)}</td>)}</tr>)}</tbody>
              </table>
            </TableWrap>
          </section>
        )
      })}
    </div>
  )
}
