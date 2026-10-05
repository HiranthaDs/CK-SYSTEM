import type { AuditLogEntry } from '../types/api'

function actorLabel(entry: AuditLogEntry) {
  return entry.actor_display_name || entry.actor_email || entry.actor_user_id
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined
    ? ''
    : typeof value === 'string' ? value : JSON.stringify(value)
  return `"${text.replaceAll('"', '""')}"`
}

export function auditRowsToCsv(entries: AuditLogEntry[]) {
  const headings = [
    'Event ID', 'Date and time', 'User', 'Email', 'User ID', 'Operation', 'Action',
    'Entity', 'Entity ID', 'Request ID', 'Idempotency key', 'Before', 'After / receipt',
  ]
  const rows = entries.map((entry) => [
    entry.id,
    entry.occurred_at,
    actorLabel(entry),
    entry.actor_email,
    entry.actor_user_id,
    entry.operation,
    entry.action,
    entry.entity_table,
    entry.entity_id,
    entry.request_id,
    entry.idempotency_key,
    entry.before_data,
    entry.after_data,
  ])
  return [headings, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
}

export function downloadAuditCsv(filename: string, entries: AuditLogEntry[]) {
  const blob = new Blob([`\uFEFF${auditRowsToCsv(entries)}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
