import type { ReactNode } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
export interface Choice { value: string; label: ReactNode; disabled?: boolean }
export default function ChoiceSelect({ value, onChange, options, label, disabled, className = '', displayValue }: { value: string; onChange: (value: string) => void; options: Choice[]; label: string; disabled?: boolean; className?: string; displayValue?: ReactNode }) {
  return <Select value={value || '__none__'} onValueChange={value => onChange(value === '__none__' ? '' : value)} disabled={disabled}>
    <SelectTrigger className={`choice-trigger ${className}`} aria-label={label}><SelectValue>{displayValue}</SelectValue></SelectTrigger>
    <SelectContent className="choice-menu" align="end" sideOffset={5}>{options.map(option => <SelectItem key={option.value} value={option.value || '__none__'} disabled={option.disabled}>{option.label}</SelectItem>)}</SelectContent>
  </Select>
}
