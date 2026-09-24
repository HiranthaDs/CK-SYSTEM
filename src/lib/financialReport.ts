import type { AccountBalance, JsonRecord } from '../types/api'

export type FinancialReportScalar = string | number | boolean | null
export type FinancialFieldKind = 'money' | 'number' | 'date' | 'datetime' | 'boolean' | 'text'
export type FinancialPathPart = string | number

export interface FinancialReportField {
  id: string
  key: string
  label: string
  path: FinancialPathPart[]
  kind: FinancialFieldKind
  sourceValue: FinancialReportScalar
  value: FinancialReportScalar
  editable: boolean
}

export interface FinancialReportColumn {
  key: string
  label: string
}

export interface FinancialReportTableRow {
  id: string
  fields: FinancialReportField[]
}

export interface FinancialReportTable {
  id: string
  title: string
  columns: FinancialReportColumn[]
  rows: FinancialReportTableRow[]
}

export interface FinancialReportSection {
  id: string
  title: string
  fields: FinancialReportField[]
  tables: FinancialReportTable[]
  sections: FinancialReportSection[]
}

export interface FinancialReportModel {
  title: string
  year: number
  currency: 'LKR'
  generatedAt: string | null
  summarySections: FinancialReportSection[]
  accountBalances: FinancialReportTable
}

export interface FinancialReportIntegrity {
  debitTotal: number
  creditTotal: number
  trialBalanceDifference: number
  trialBalanceOk: boolean
  assets: number
  liabilities: number
  equity: number
  accountRevenue: number
  accountExpenses: number
  currentEarnings: number
  equityAndEarnings: number
  positionDifference: number
  positionOk: boolean
  summaryRevenue: number | null
  summaryExpenses: number | null
  summaryRevenueDifference: number | null
  summaryExpensesDifference: number | null
  summaryReconciled: boolean | null
  invalidNumericFields: number
}

export interface FinancialStatementLine {
  label: string
  value: number
  emphasis?: 'subtotal' | 'total' | undefined
}

export interface FinancialExportCell {
  key: string
  label: string
  kind: FinancialFieldKind
  value: FinancialReportScalar
  sourceValue: FinancialReportScalar
  display: string
  sourceDisplay: string
  changed: boolean
}

export interface FinancialExportRow {
  id: string
  cells: FinancialExportCell[]
  changed: boolean
}

export interface FinancialExportTable {
  id: string
  title: string
  columns: FinancialReportColumn[]
  rows: FinancialExportRow[]
}

export interface FinancialExportDocument {
  title: string
  subtitle: string
  year: number
  currency: 'LKR'
  generatedAt: string | null
  changeCount: number
  integrity: FinancialReportIntegrity
  incomeStatement: FinancialStatementLine[]
  financialPosition: FinancialStatementLine[]
  summaryTables: FinancialExportTable[]
  accountBalances: FinancialExportTable
  disclaimer: string
}

const CURRENCY_KEYS = /(amount|value|cost|cogs|revenue|expense|profit|asset|liabilit|equity|balance|paid|due|gross|net|debit|credit|payable|receivable|cash|wage|salary|rate|income|tax)/i
const TECHNICAL_KEYS = /(^id$|_id$|^uuid$|_uuid$|^created_(at|by)$|^updated_(at|by)$|^deleted_(at|by)$|^request_id$|^fiscal_year$)/i
const SUMMARY_METADATA_KEYS = new Set(['year', 'generated_at'])
const EPSILON = 0.005

function titleCase(value: string) {
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isScalar(value: unknown): value is FinancialReportScalar | undefined {
  return value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)
}

function scalarValue(value: unknown): FinancialReportScalar {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return JSON.stringify(value)
}

function numericValue(value: unknown): number | null {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function pathId(path: readonly FinancialPathPart[]) {
  return path.map((part) => typeof part === 'number' ? `[${part}]` : part.replaceAll('.', '\\u2024')).join('.')
}

function hiddenTechnicalKey(key: string) {
  return TECHNICAL_KEYS.test(key)
}

function inferKind(key: string, value: unknown): FinancialFieldKind {
  if (typeof value === 'boolean') return 'boolean'
  if (/(_at|timestamp|generated_at)$/i.test(key) && typeof value === 'string') return 'datetime'
  if (/(^|_)(date|as_of)$/i.test(key) && typeof value === 'string') return 'date'
  if (CURRENCY_KEYS.test(key) && numericValue(value) !== null) return 'money'
  if (typeof value === 'number' || (typeof value === 'string' && numericValue(value) !== null)) return 'number'
  return 'text'
}

function makeField(
  key: string,
  value: unknown,
  path: FinancialPathPart[],
  options: { label?: string; kind?: FinancialFieldKind; editable?: boolean } = {},
): FinancialReportField {
  const normalized = scalarValue(value)
  return {
    id: pathId(path),
    key,
    label: options.label ?? titleCase(key),
    path,
    kind: options.kind ?? inferKind(key, normalized),
    sourceValue: normalized,
    value: normalized,
    editable: options.editable ?? true,
  }
}

function recordTable(title: string, values: JsonRecord[], path: FinancialPathPart[]): FinancialReportTable {
  const keys = Array.from(new Set(values.flatMap((record) => Object.keys(record))))
    .filter((key) => !hiddenTechnicalKey(key) && values.some((record) => isScalar(record[key])))
  return {
    id: pathId(path),
    title,
    columns: keys.map((key) => ({ key, label: titleCase(key) })),
    rows: values.map((record, rowIndex) => ({
      id: pathId([...path, rowIndex]),
      fields: keys
        .filter((key) => isScalar(record[key]))
        .map((key) => makeField(key, record[key], [...path, rowIndex, key])),
    })),
  }
}

function primitiveTable(title: string, values: unknown[], path: FinancialPathPart[]): FinancialReportTable {
  return {
    id: pathId(path),
    title,
    columns: [{ key: 'value', label: 'Value' }],
    rows: values.map((value, rowIndex) => ({
      id: pathId([...path, rowIndex]),
      fields: [makeField('value', value, [...path, rowIndex])],
    })),
  }
}

function sectionFromRecord(title: string, value: JsonRecord, path: FinancialPathPart[]): FinancialReportSection {
  const entries = Object.entries(value).filter(([key]) => !hiddenTechnicalKey(key))
  const fields = entries
    .filter(([, item]) => isScalar(item))
    .map(([key, item]) => makeField(key, item, [...path, key]))
  const tables: FinancialReportTable[] = []
  const sections: FinancialReportSection[] = []

  entries.forEach(([key, item]) => {
    if (Array.isArray(item)) {
      const records = item.filter(isRecord)
      tables.push(records.length === item.length
        ? recordTable(titleCase(key), records, [...path, key])
        : primitiveTable(titleCase(key), item, [...path, key]))
    } else if (isRecord(item)) {
      sections.push(sectionFromRecord(titleCase(key), item, [...path, key]))
    }
  })

  return { id: pathId(path), title, fields, tables, sections }
}

function summarySections(summary: JsonRecord): FinancialReportSection[] {
  const visible = Object.fromEntries(
    Object.entries(summary).filter(([key]) => !SUMMARY_METADATA_KEYS.has(key) && !hiddenTechnicalKey(key)),
  )
  const overviewValues = Object.fromEntries(Object.entries(visible).filter(([, value]) => isScalar(value)))
  const sections: FinancialReportSection[] = []
  if (Object.keys(overviewValues).length) {
    sections.push(sectionFromRecord('Overview', overviewValues, ['summary', 'overview']))
  }
  Object.entries(visible).forEach(([key, value]) => {
    if (isRecord(value)) sections.push(sectionFromRecord(titleCase(key), value, ['summary', key]))
    else if (Array.isArray(value)) {
      const table = value.every(isRecord)
        ? recordTable(titleCase(key), value, ['summary', key])
        : primitiveTable(titleCase(key), value, ['summary', key])
      sections.push({ id: pathId(['summary', key]), title: titleCase(key), fields: [], tables: [table], sections: [] })
    }
  })
  return sections
}

function accountBalanceTable(rows: readonly AccountBalance[]): FinancialReportTable {
  const columns: FinancialReportColumn[] = [
    { key: 'account_code', label: 'Code' },
    { key: 'account_name', label: 'Account' },
    { key: 'category', label: 'Category' },
    { key: 'debit_total', label: 'Debit' },
    { key: 'credit_total', label: 'Credit' },
    { key: 'balance', label: 'Balance' },
  ]
  return {
    id: 'accountBalances',
    title: 'Account balances',
    columns,
    rows: rows.map((row, rowIndex) => ({
      id: `accountBalances.${rowIndex}`,
      fields: [
        makeField('account_code', row.account_code ?? '', ['accountBalances', rowIndex, 'account_code'], { label: 'Code' }),
        makeField('account_name', row.account_name ?? '', ['accountBalances', rowIndex, 'account_name'], { label: 'Account' }),
        makeField('category', row.category ?? '', ['accountBalances', rowIndex, 'category'], { label: 'Category' }),
        makeField('debit_total', row.debit_total ?? row.debit ?? 0, ['accountBalances', rowIndex, 'debit_total'], { label: 'Debit', kind: 'money' }),
        makeField('credit_total', row.credit_total ?? row.credit ?? 0, ['accountBalances', rowIndex, 'credit_total'], { label: 'Credit', kind: 'money' }),
        makeField('balance', row.balance ?? 0, ['accountBalances', rowIndex, 'balance'], { label: 'Balance', kind: 'money' }),
      ],
    })),
  }
}

export function createFinancialReportModel(
  summary: JsonRecord,
  accountBalances: readonly AccountBalance[],
  year: number,
): FinancialReportModel {
  return {
    title: 'Financial Summary & Account Balances',
    year,
    currency: 'LKR',
    generatedAt: typeof summary.generated_at === 'string' ? summary.generated_at : null,
    summarySections: summarySections(summary),
    accountBalances: accountBalanceTable(accountBalances),
  }
}

export function financialFieldChanged(field: FinancialReportField) {
  if (field.kind === 'money' || field.kind === 'number') {
    const source = numericValue(field.sourceValue)
    const current = numericValue(field.value)
    if (source !== null && current !== null) return Math.abs(source - current) >= Number.EPSILON
  }
  return !Object.is(field.sourceValue, field.value)
}

function mapTableFields(
  table: FinancialReportTable,
  map: (field: FinancialReportField) => FinancialReportField,
): FinancialReportTable {
  return {
    ...table,
    rows: table.rows.map((row) => ({ ...row, fields: row.fields.map(map) })),
  }
}

function mapSectionFields(
  section: FinancialReportSection,
  map: (field: FinancialReportField) => FinancialReportField,
): FinancialReportSection {
  return {
    ...section,
    fields: section.fields.map(map),
    tables: section.tables.map((table) => mapTableFields(table, map)),
    sections: section.sections.map((nested) => mapSectionFields(nested, map)),
  }
}

export function updateFinancialReportField(
  model: FinancialReportModel,
  fieldId: string,
  value: FinancialReportScalar,
): FinancialReportModel {
  const update = (field: FinancialReportField) => field.id === fieldId ? { ...field, value } : field
  return {
    ...model,
    summarySections: model.summarySections.map((section) => mapSectionFields(section, update)),
    accountBalances: mapTableFields(model.accountBalances, update),
  }
}

export function resetFinancialReportModel(model: FinancialReportModel): FinancialReportModel {
  const reset = (field: FinancialReportField) => financialFieldChanged(field)
    ? { ...field, value: field.sourceValue }
    : field
  return {
    ...model,
    summarySections: model.summarySections.map((section) => mapSectionFields(section, reset)),
    accountBalances: mapTableFields(model.accountBalances, reset),
  }
}

function collectSectionFields(section: FinancialReportSection): FinancialReportField[] {
  return [
    ...section.fields,
    ...section.tables.flatMap((table) => table.rows.flatMap((row) => row.fields)),
    ...section.sections.flatMap(collectSectionFields),
  ]
}

export function collectFinancialReportFields(model: FinancialReportModel): FinancialReportField[] {
  return [
    ...model.summarySections.flatMap(collectSectionFields),
    ...model.accountBalances.rows.flatMap((row) => row.fields),
  ]
}

export function countFinancialReportChanges(model: FinancialReportModel) {
  return collectFinancialReportFields(model).filter(financialFieldChanged).length
}

function tableField(row: FinancialReportTableRow, key: string) {
  return row.fields.find((field) => field.key === key)
}

function fieldAmount(field: FinancialReportField | undefined) {
  return numericValue(field?.value) ?? 0
}

function findSummaryField(model: FinancialReportModel, pathSuffix: readonly string[]) {
  return model.summarySections
    .flatMap(collectSectionFields)
    .find((field) => pathSuffix.every((part, index) => field.path.at(index - pathSuffix.length) === part))
}

export function calculateFinancialReportIntegrity(model: FinancialReportModel): FinancialReportIntegrity {
  let debitTotal = 0
  let creditTotal = 0
  let assets = 0
  let liabilities = 0
  let equity = 0
  let accountRevenue = 0
  let accountExpenses = 0

  model.accountBalances.rows.forEach((row) => {
    debitTotal += fieldAmount(tableField(row, 'debit_total'))
    creditTotal += fieldAmount(tableField(row, 'credit_total'))
    const balance = fieldAmount(tableField(row, 'balance'))
    const category = String(tableField(row, 'category')?.value ?? '').trim().toLowerCase()
    if (category === 'asset') assets += balance
    else if (category === 'liability') liabilities += balance
    else if (category === 'equity') equity += balance
    else if (category === 'revenue') accountRevenue += balance
    else if (category === 'expense') accountExpenses += balance
  })

  const currentEarnings = accountRevenue - accountExpenses
  const equityAndEarnings = equity + currentEarnings
  const trialBalanceDifference = debitTotal - creditTotal
  const positionDifference = assets - liabilities - equityAndEarnings
  const revenueField = findSummaryField(model, ['summary', 'finance', 'revenue'])
  const cogsField = findSummaryField(model, ['summary', 'finance', 'cogs'])
  const expensesField = findSummaryField(model, ['summary', 'finance', 'expenses'])
  const summaryRevenue = revenueField ? numericValue(revenueField.value) : null
  const summaryExpenses = cogsField || expensesField
    ? fieldAmount(cogsField) + fieldAmount(expensesField)
    : null
  const summaryRevenueDifference = summaryRevenue === null ? null : summaryRevenue - accountRevenue
  const summaryExpensesDifference = summaryExpenses === null ? null : summaryExpenses - accountExpenses
  const summaryReconciled = summaryRevenueDifference === null || summaryExpensesDifference === null
    ? null
    : Math.abs(summaryRevenueDifference) < EPSILON && Math.abs(summaryExpensesDifference) < EPSILON
  const invalidNumericFields = collectFinancialReportFields(model).filter((field) =>
    (field.kind === 'money' || field.kind === 'number') && numericValue(field.value) === null,
  ).length

  return {
    debitTotal,
    creditTotal,
    trialBalanceDifference,
    trialBalanceOk: Math.abs(trialBalanceDifference) < EPSILON,
    assets,
    liabilities,
    equity,
    accountRevenue,
    accountExpenses,
    currentEarnings,
    equityAndEarnings,
    positionDifference,
    positionOk: Math.abs(positionDifference) < EPSILON,
    summaryRevenue,
    summaryExpenses,
    summaryRevenueDifference,
    summaryExpensesDifference,
    summaryReconciled,
    invalidNumericFields,
  }
}

export function displayFinancialValue(value: FinancialReportScalar, kind: FinancialFieldKind) {
  if (value === null || value === '') return '—'
  if (kind === 'boolean') return value ? 'Yes' : 'No'
  if (kind === 'money') {
    const numeric = numericValue(value)
    return numeric === null
      ? String(value)
      : `LKR ${numeric.toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  if (kind === 'number') {
    const numeric = numericValue(value)
    return numeric === null ? String(value) : numeric.toLocaleString('en-LK', { maximumFractionDigits: 6 })
  }
  if ((kind === 'date' || kind === 'datetime') && typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat('en-LK', kind === 'datetime'
        ? { dateStyle: 'medium', timeStyle: 'short' }
        : { dateStyle: 'medium' }).format(parsed)
    }
  }
  return String(value)
}

function exportCell(field: FinancialReportField): FinancialExportCell {
  return {
    key: field.key,
    label: field.label,
    kind: field.kind,
    value: field.value,
    sourceValue: field.sourceValue,
    display: displayFinancialValue(field.value, field.kind),
    sourceDisplay: displayFinancialValue(field.sourceValue, field.kind),
    changed: financialFieldChanged(field),
  }
}

function exportTable(table: FinancialReportTable, title = table.title): FinancialExportTable {
  return {
    id: table.id,
    title,
    columns: table.columns,
    rows: table.rows.map((row) => {
      const cells = table.columns.map((column) => {
        const field = tableField(row, column.key)
        return field
          ? exportCell(field)
          : {
              key: column.key,
              label: column.label,
              kind: 'text' as const,
              value: null,
              sourceValue: null,
              display: '—',
              sourceDisplay: '—',
              changed: false,
            }
      })
      return { id: row.id, cells, changed: cells.some((cell) => cell.changed) }
    }),
  }
}

function sectionExportTables(section: FinancialReportSection, parentTitle = ''): FinancialExportTable[] {
  const title = parentTitle ? `${parentTitle} / ${section.title}` : section.title
  const result: FinancialExportTable[] = []
  if (section.fields.length) {
    result.push({
      id: `${section.id}.fields`,
      title,
      columns: [
        { key: 'field', label: 'Field' },
        { key: 'value', label: 'Report value' },
      ],
      rows: section.fields.map((field) => ({
        id: field.id,
        changed: financialFieldChanged(field),
        cells: [
          {
            key: 'field', label: 'Field', kind: 'text', value: field.label, sourceValue: field.label,
            display: field.label, sourceDisplay: field.label, changed: false,
          },
          { ...exportCell(field), key: 'value', label: 'Report value' },
        ],
      })),
    })
  }
  section.tables.forEach((table) => result.push(exportTable(table, `${title} / ${table.title}`)))
  section.sections.forEach((nested) => result.push(...sectionExportTables(nested, title)))
  return result
}

export function createFinancialExportDocument(model: FinancialReportModel): FinancialExportDocument {
  const integrity = calculateFinancialReportIntegrity(model)
  const revenue = integrity.summaryRevenue ?? integrity.accountRevenue
  const totalExpenses = integrity.summaryExpenses ?? integrity.accountExpenses
  const cogs = fieldAmount(findSummaryField(model, ['summary', 'finance', 'cogs']))
  const operatingExpenses = Math.max(0, totalExpenses - cogs)
  const grossProfit = revenue - cogs
  const netProfit = revenue - totalExpenses
  const changeCount = countFinancialReportChanges(model)

  return {
    title: model.title,
    subtitle: `Fiscal year ${model.year} · ${changeCount ? `${changeCount} edited field${changeCount === 1 ? '' : 's'}` : 'Unmodified server snapshot'}`,
    year: model.year,
    currency: model.currency,
    generatedAt: model.generatedAt,
    changeCount,
    integrity,
    incomeStatement: [
      { label: 'Revenue', value: revenue },
      { label: 'Less: Cost of goods sold', value: cogs },
      { label: 'Gross profit', value: grossProfit, emphasis: 'subtotal' },
      { label: 'Less: Other expenses', value: operatingExpenses },
      { label: 'Net result', value: netProfit, emphasis: 'total' },
    ],
    financialPosition: [
      { label: 'Assets', value: integrity.assets, emphasis: 'subtotal' },
      { label: 'Liabilities', value: integrity.liabilities },
      { label: 'Posted equity', value: integrity.equity },
      { label: 'Current earnings', value: integrity.currentEarnings },
      { label: 'Equity and liabilities', value: integrity.liabilities + integrity.equityAndEarnings, emphasis: 'subtotal' },
      { label: 'Balance check difference', value: integrity.positionDifference, emphasis: 'total' },
    ],
    summaryTables: model.summarySections.flatMap((section) => sectionExportTables(section)),
    accountBalances: exportTable(model.accountBalances),
    disclaimer: 'INTERNAL USE ONLY · USER-EDITED WHEN MARKED · UNAUDITED. This report is an export-only working draft. Figures must be independently verified and are not approved for statutory, tax, banking, lending, audit, certification, or other official use.',
  }
}
