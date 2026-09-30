import { useMemo, useState } from 'react'
import { Download, FileSpreadsheet, RotateCcw, X } from 'lucide-react'
import type { AccountBalance, JsonRecord } from '../types/api'
import {
  createFinancialReportModel, createFinancialExportDocument, countFinancialReportChanges,
  displayFinancialValue, financialFieldChanged, resetFinancialReportModel, updateFinancialReportField,
  type FinancialReportField, type FinancialReportScalar, type FinancialReportSection,
  type FinancialReportTable, type FinancialExportTable,
} from '../lib/financialReport'
import { downloadFinancialExcel, downloadFinancialPdf } from '../lib/financialReportExport'
import { Badge, Button, Card, EmptyState, InlineNotice, Input, SectionTitle, TableWrap, Tabs } from './UI'
import { useToast } from './Toast'

type UpdateField = (id: string, value: FinancialReportScalar) => void

function FieldEditor({ field, label, update }: { field: FinancialReportField; label: string; update: UpdateField }) {
  const changed = financialFieldChanged(field)
  const numeric = field.kind === 'money' || field.kind === 'number'
  return <div className={`studio-cell${changed ? ' studio-cell--edited' : ''}`}>
    {field.kind === 'boolean'
      ? <input type="checkbox" aria-label={label} checked={Boolean(field.value)} onChange={(event) => update(field.id, event.target.checked)} />
      : <Input aria-label={label} type={numeric ? 'number' : field.kind === 'date' ? 'date' : 'text'}
          step={numeric ? 'any' : undefined} value={field.value === null ? '' : String(field.value)}
          onChange={(event) => update(field.id, event.target.value)} />}
    {changed ? <button type="button" className="icon-button icon-button--small" aria-label={`Reset ${label}`} title="Restore original value" onClick={() => update(field.id, field.sourceValue)}><RotateCcw size={14} /></button> : null}
  </div>
}

function RecordEditor({ table, update }: { table: FinancialReportTable; update: UpdateField }) {
  if (!table.rows.length) return <EmptyState message={`No ${table.title.toLowerCase()} in this snapshot.`} />
  return <TableWrap><table className="studio-edit-table studio-record-table">
    <caption className="sr-only">{table.title}</caption>
    <thead><tr><th scope="col">Row</th>{table.columns.map((column) => <th scope="col" key={column.key}>{column.label}</th>)}</tr></thead>
    <tbody>{table.rows.map((row, index) => <tr key={row.id}>
      <th scope="row">{index + 1}</th>
      {table.columns.map((column) => {
        const field = row.fields.find((candidate) => candidate.key === column.key)
        return <td key={column.key}>{field ? <FieldEditor field={field} label={`${table.title} row ${index + 1}: ${column.label}`} update={update} /> : '—'}</td>
      })}
    </tr>)}</tbody>
  </table></TableWrap>
}

function SectionEditor({ section, update, parent = '' }: { section: FinancialReportSection; update: UpdateField; parent?: string }) {
  const title = parent ? `${parent} / ${section.title}` : section.title
  return <section className="studio-section studio-section--summary">
    <h3>{title}</h3>
    {section.fields.length ? <TableWrap><table className="studio-edit-table studio-summary-table">
      <caption className="sr-only">{title} fields</caption>
      <thead><tr><th scope="col">Financial field</th><th scope="col">Original value</th><th scope="col">Report value · editable</th></tr></thead>
      <tbody>{section.fields.map((field) => <tr key={field.id} className={financialFieldChanged(field) ? 'studio-row--edited' : undefined}>
        <th scope="row">{field.label}<span className="table-subtext">{field.kind === 'money' ? 'LKR' : field.kind === 'number' ? 'Number' : ''}</span></th>
        <td className="studio-source">{displayFinancialValue(field.sourceValue, field.kind)}</td>
        <td><FieldEditor field={field} label={`${title}: ${field.label}`} update={update} /></td>
      </tr>)}</tbody>
    </table></TableWrap> : null}
    {section.tables.map((table) => <div className="studio-section" key={table.id}><h4>{table.title}</h4><RecordEditor table={table} update={update} /></div>)}
    {section.sections.map((nested) => <SectionEditor key={nested.id} section={nested} parent={title} update={update} />)}
  </section>
}

function PreviewTable({ table }: { table: FinancialExportTable }) {
  return <section className="accounting-pdf-section"><h3>{table.title}</h3>
    {table.rows.length ? <TableWrap><table className="accounting-pdf-table">
      <thead><tr>{table.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
      <tbody>{table.rows.map((row) => <tr key={row.id}>{row.cells.map((cell) => <td key={cell.key} className={['money', 'number'].includes(cell.kind) ? 'numeric' : undefined}>{cell.display}</td>)}</tr>)}</tbody>
    </table></TableWrap> : <p>No records</p>}
  </section>
}

export function AccountingPdfStudio({ summary, accountBalances, year, onExit }: {
  summary: JsonRecord; accountBalances: AccountBalance[]; year: number; onExit: () => void
}) {
  const [model, setModel] = useState(() => createFinancialReportModel(summary, accountBalances, year))
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const [exporting, setExporting] = useState<'pdf' | 'xlsx' | null>(null)
  const toast = useToast()
  const changeCount = useMemo(() => countFinancialReportChanges(model), [model])
  const report = useMemo(() => createFinancialExportDocument(model), [model])
  const update: UpdateField = (id, value) => setModel((current) => updateFinancialReportField(current, id, value))
  const save = async (format: 'pdf' | 'xlsx') => {
    setExporting(format)
    try {
      if (format === 'pdf') await downloadFinancialPdf(model)
      else await downloadFinancialExcel(model)
      toast.success(`${format === 'pdf' ? 'PDF' : 'Excel'} download ready`)
    } catch (error) {
      toast.error('Export could not be saved', error instanceof Error ? error.message : 'Please try again.')
    } finally { setExporting(null) }
  }

  return <div className="pdf-studio-page">
    <Card className="pdf-studio-toolbar">
      <SectionTitle title="PDF Studio" description={`Financial summary & account balances · Fiscal year ${model.year} · LKR`}
        actions={<Badge tone={changeCount ? 'warning' : 'success'}>{changeCount ? `${changeCount} edited fields` : 'Original snapshot'}</Badge>} />
      <div className="pdf-studio-actions">
        <Button variant="secondary" icon={RotateCcw} disabled={!changeCount || Boolean(exporting)} onClick={() => setModel(resetFinancialReportModel)}>Reset all edits</Button>
        <Button variant="secondary" icon={X} disabled={Boolean(exporting)} onClick={onExit}>Exit & discard</Button>
        <Button variant="secondary" icon={FileSpreadsheet} disabled={Boolean(exporting) || report.integrity.invalidNumericFields > 0} loading={exporting === 'xlsx'} onClick={() => void save('xlsx')}>Save Excel</Button>
        <Button icon={Download} disabled={Boolean(exporting) || report.integrity.invalidNumericFields > 0} loading={exporting === 'pdf'} onClick={() => void save('pdf')}>Save PDF</Button>
      </div>
    </Card>
    <InlineNotice title="Export-only workspace">Edit the report values below. Original values stay visible for comparison, and edited cells are highlighted. Changes apply to both downloads and are discarded when you exit.</InlineNotice>
    {report.integrity.invalidNumericFields > 0 ? <InlineNotice tone="warning" title="Complete numeric fields">{report.integrity.invalidNumericFields} numeric field(s) are blank or invalid. Enter a number before saving.</InlineNotice> : null}
    <Tabs value={tab} onChange={setTab} ariaLabel="PDF Studio views" items={[{ value: 'edit', label: 'Edit tables' }, { value: 'preview', label: 'Report preview' }]} />
    {tab === 'edit' ? <div className="pdf-studio-editors">
      <Card><SectionTitle title="Financial summary fields" description="Find each field by section. Edit the right-hand column; use the reset arrow to restore an individual value." />
        {model.summarySections.length ? model.summarySections.map((section) => <SectionEditor key={section.id} section={section} update={update} />) : <EmptyState message="No financial summary fields in this snapshot." />}
      </Card>
      <Card><SectionTitle title="Account balances" description="Edit account labels and amounts. All amounts are in LKR." /><RecordEditor table={model.accountBalances} update={update} /></Card>
    </div> : <Card className="studio-full-preview">
      <article className="accounting-pdf-document">
        <header className="accounting-pdf-header"><div><span>CK SYS · Financial report</span><h1>{report.title}</h1><p>Fiscal year {report.year} · {report.currency}</p></div></header>
        <main className="accounting-pdf-body">
          {[{ title: 'Income statement', lines: report.incomeStatement }, { title: 'Statement of financial position', lines: report.financialPosition }].map(({ title, lines }) => <section className="accounting-pdf-section" key={title}><h2>{title}</h2><table className="accounting-pdf-table"><thead><tr><th>Description</th><th className="numeric">Amount (LKR)</th></tr></thead><tbody>{lines.map((line) => <tr key={line.label}><th scope="row">{line.label}</th><td className="numeric">{displayFinancialValue(line.value, 'money')}</td></tr>)}</tbody></table></section>)}
          {report.summaryTables.map((table) => <PreviewTable key={table.id} table={table} />)}
          <PreviewTable table={report.accountBalances} />
        </main>
      </article>
    </Card>}
  </div>
}
