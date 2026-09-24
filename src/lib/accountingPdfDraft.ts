import type { AccountBalance, JsonRecord } from '../types/api'

export type DraftPathPart = string | number
export type DraftScalar = string | number | boolean | null

export interface AccountingPdfDraft {
  summary: JsonRecord
  accountBalances: AccountBalance[]
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function cloneDraftValue<T>(value: T): T {
  if (Array.isArray(value)) return (value as unknown[]).map((item) => cloneDraftValue(item)) as T
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneDraftValue(item)]),
    ) as T
  }
  return value
}

export function createAccountingPdfDraft(
  summary: JsonRecord,
  accountBalances: readonly AccountBalance[],
): AccountingPdfDraft {
  return {
    summary: cloneDraftValue(summary),
    accountBalances: cloneDraftValue(Array.from(accountBalances)),
  }
}

export function updateDraftScalar<T>(
  value: T,
  path: readonly DraftPathPart[],
  nextValue: DraftScalar,
): T {
  if (!path.length) return nextValue as T

  const [part, ...rest] = path
  if (Array.isArray(value)) {
    if (typeof part !== 'number') throw new TypeError('Array draft paths require a numeric index.')
    const copy: unknown[] = value.slice()
    copy[part] = updateDraftScalar(copy[part], rest, nextValue)
    return copy as T
  }

  if (!isPlainRecord(value) || typeof part !== 'string') {
    throw new TypeError('Draft path does not match the source value.')
  }

  return {
    ...value,
    [part]: updateDraftScalar(value[part], rest, nextValue),
  }
}

function scalarLeafCount(value: unknown): number {
  if (Array.isArray(value)) return (value as unknown[]).reduce<number>((total, item) => total + scalarLeafCount(item), 0)
  if (isPlainRecord(value)) {
    return Object.values(value).reduce<number>((total, item) => total + scalarLeafCount(item), 0)
  }
  return 1
}

export function countDraftChanges(source: unknown, draft: unknown): number {
  if (Array.isArray(source) && Array.isArray(draft)) {
    const length = Math.max(source.length, draft.length)
    let changes = 0
    for (let index = 0; index < length; index += 1) {
      if (index >= source.length) changes += scalarLeafCount(draft[index])
      else if (index >= draft.length) changes += scalarLeafCount(source[index])
      else changes += countDraftChanges(source[index], draft[index])
    }
    return changes
  }

  if (isPlainRecord(source) && isPlainRecord(draft)) {
    const keys = new Set([...Object.keys(source), ...Object.keys(draft)])
    let changes = 0
    keys.forEach((key) => {
      if (!(key in source)) changes += scalarLeafCount(draft[key])
      else if (!(key in draft)) changes += scalarLeafCount(source[key])
      else changes += countDraftChanges(source[key], draft[key])
    })
    return changes
  }

  if (Array.isArray(source) || Array.isArray(draft) || isPlainRecord(source) || isPlainRecord(draft)) {
    return Math.max(scalarLeafCount(source), scalarLeafCount(draft))
  }

  return Object.is(source, draft) ? 0 : 1
}
