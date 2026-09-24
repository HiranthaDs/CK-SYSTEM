import { describe, expect, it } from 'vitest'
import {
  countDraftChanges,
  createAccountingPdfDraft,
  updateDraftScalar,
} from '../lib/accountingPdfDraft'
import type { AccountBalance, JsonRecord } from '../types/api'

const summary: JsonRecord = {
  year: 2026,
  finance: { revenue: '1000.00', expenses: '250.00' },
  flags: { reviewed: false },
  inventory: { bulk: [{ stage: 'bulk', inventory_value: '400.00' }] },
}

const balances: AccountBalance[] = [{
  account_id: 1,
  account_code: 'CASH',
  account_name: 'Cash on Hand',
  category: 'asset',
  debit_total: '1000.00',
  credit_total: '200.00',
  balance: '800.00',
}]

describe('accounting PDF draft helpers', () => {
  it('creates a detached deep clone of the server snapshot', () => {
    const draft = createAccountingPdfDraft(summary, balances)

    expect(draft.summary).toEqual(summary)
    expect(draft.accountBalances).toEqual(balances)
    expect(draft.summary).not.toBe(summary)
    expect(draft.accountBalances).not.toBe(balances)
    expect(draft.summary.finance).not.toBe(summary.finance)

    ;(draft.summary.finance as JsonRecord).revenue = '9999.00'
    draft.accountBalances[0]!.balance = '0.00'

    expect((summary.finance as JsonRecord).revenue).toBe('1000.00')
    expect(balances[0]!.balance).toBe('800.00')
  })

  it('updates a scalar leaf without mutating its source draft', () => {
    const source = createAccountingPdfDraft(summary, balances)
    const updated = updateDraftScalar(source, ['summary', 'inventory', 'bulk', 0, 'inventory_value'], '725.50')

    expect((((updated.summary.inventory as JsonRecord).bulk as JsonRecord[])[0]!).inventory_value).toBe('725.50')
    expect((((source.summary.inventory as JsonRecord).bulk as JsonRecord[])[0]!).inventory_value).toBe('400.00')
    expect(updated).not.toBe(source)
    expect(updated.accountBalances).toBe(source.accountBalances)
  })

  it('counts each changed scalar field and returns to zero for a reset clone', () => {
    const source = createAccountingPdfDraft(summary, balances)
    const withRevenue = updateDraftScalar(source, ['summary', 'finance', 'revenue'], '1200.00')
    const withBalance = updateDraftScalar(withRevenue, ['accountBalances', 0, 'balance'], '950.00')

    expect(countDraftChanges(source, source)).toBe(0)
    expect(countDraftChanges(source, withRevenue)).toBe(1)
    expect(countDraftChanges(source, withBalance)).toBe(2)
    expect(countDraftChanges(source, createAccountingPdfDraft(summary, balances))).toBe(0)
  })
})
