import { useState } from 'react'
import { Input, Select } from './UI'
import { titleCase } from '../lib/format'

/** Presets store real values; Manual only controls how the value is entered. */
export function ManualSelect({ label, value, options, onChange, maxLength = 160, placeholder = 'Select an option' }: {
  label: string
  value: string
  options: readonly string[]
  onChange: (value: string) => void
  maxLength?: number
  placeholder?: string
}) {
  const [manual, setManual] = useState(false)
  const custom = manual || Boolean(value && !options.includes(value))
  return <div className="manual-select">
    <Select aria-label={label} value={custom ? '__manual__' : value} onChange={(event) => {
      const next = event.target.value
      setManual(next === '__manual__')
      onChange(next === '__manual__' ? value : next)
    }}>
      <option value="">{placeholder}</option>
      {options.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}
      <option value="__manual__">Manual — type your own</option>
    </Select>
    {custom ? <Input aria-label={`Manual ${label}`} value={value} maxLength={maxLength} placeholder={`Enter ${label.toLowerCase()}`} onChange={(event) => onChange(event.target.value)} /> : null}
  </div>
}
