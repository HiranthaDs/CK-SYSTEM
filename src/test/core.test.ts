import { describe, expect, it } from 'vitest'
import { monthLabel, numberValue, shortDate, titleCase } from '../lib/format'
import { pageItems } from '../lib/api'

describe('format helpers', () => {
  it('normalizes numeric API values without leaking NaN', () => {
    expect(numberValue('12.50')).toBe(12.5)
    expect(numberValue(null)).toBe(0)
    expect(numberValue('not-a-number')).toBe(0)
  })

  it('formats valid dates and safely preserves invalid values', () => {
    expect(shortDate('2026-09-16')).toBe('16 Sep 2026')
    expect(monthLabel('2026-09')).toBe('September 2026')
    expect(shortDate('not-a-date')).toBe('not-a-date')
  })

  it('turns API field names into safe labels', () => {
    expect(titleCase('quantity_on_hand')).toBe('Quantity On Hand')
    expect(titleCase({ unsafe: true })).toBe('')
  })
})

describe('pageItems', () => {
  it('accepts paginated, legacy array, and empty payloads', () => {
    expect(pageItems({ items: [1, 2], total: 2, page: 1, page_size: 25, pages: 1 })).toEqual([1, 2])
    expect(pageItems([3, 4])).toEqual([3, 4])
    expect(pageItems(undefined)).toEqual([])
  })
})
