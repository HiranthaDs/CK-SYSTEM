import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, type ApiQuery } from '../lib/api'
import { Field, Input, Select } from './UI'

interface RemoteSelectProps<T> {
  label: string
  endpoint: string
  queryKey: string
  value: string
  onChange: (value: string) => void
  onSelectItem?: (item: T | undefined) => void
  optionValue: (item: T) => string
  optionLabel: (item: T) => string
  query?: ApiQuery | undefined
  required?: boolean | undefined
  disabled?: boolean | undefined
  error?: string | undefined
  selectedLabel?: string | undefined
  placeholder?: string | undefined
  searchPlaceholder?: string | undefined
  compact?: boolean | undefined
}

/** Server-filtered picker that stays responsive even when a master table is large. */
export function RemoteSelect<T>({
  label,
  endpoint,
  queryKey,
  value,
  onChange,
  onSelectItem,
  optionValue,
  optionLabel,
  query,
  required,
  disabled,
  error,
  selectedLabel,
  placeholder = 'Select a record',
  searchPlaceholder = 'Type to filter…',
  compact = false,
}: RemoteSelectProps<T>) {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [search])

  const result = useQuery({
    queryKey: ['lookup', queryKey, query ?? {}, debouncedSearch],
    queryFn: ({ signal }) => api.list<T>(endpoint, {
      ...query,
      q: debouncedSearch,
      page: 1,
      page_size: 50,
      descending: false,
    }, signal),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  const options = result.data?.items ?? []
  const includesValue = options.some((item) => optionValue(item) === value)
  const handleChange = (nextValue: string) => {
    onChange(nextValue)
    onSelectItem?.(options.find((item) => optionValue(item) === nextValue))
  }

  const control = (
    <div className={`remote-select${compact ? ' remote-select--compact' : ''}`}>
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={searchPlaceholder}
        aria-label={`Search ${label}`}
        disabled={disabled}
      />
      <Select
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        aria-label={label}
        required={required}
        disabled={disabled}
        aria-busy={result.isFetching}
        aria-invalid={Boolean(error)}
      >
        <option value="">{result.isLoading ? 'Loading…' : placeholder}</option>
        {value && !includesValue ? <option value={value}>{selectedLabel || `Selected · ${value.slice(0, 8)}`}</option> : null}
        {options.map((item) => {
          const option = optionValue(item)
          return <option value={option} key={option}>{optionLabel(item)}</option>
        })}
      </Select>
      {result.isError ? <span className="field__error">Could not load options. Refine the search or retry.</span> : null}
    </div>
  )

  if (compact) return control

  return (
    <Field label={label} required={required} error={error}>
      {control}
    </Field>
  )
}
