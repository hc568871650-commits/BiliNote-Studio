import type { ReactNode } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
export interface Choice { value: string; label: ReactNode; disabled?: boolean }
export default function ChoiceSelect({ value, onChange, options, label, disabled, className = '', menuClassName = '', displayValue, title }: { value: string; onChange: (value: string) => void; options: Choice[]; label: string; disabled?: boolean; className?: string; menuClassName?: string; displayValue?: ReactNode; title?: string }) {
  return <Select value={value || '__none__'} onValueChange={value => onChange(value === '__none__' ? '' : value)} disabled={disabled}>
    <SelectTrigger className={`choice-trigger ${className}`} aria-label={label} title={title}><SelectValue>{displayValue}</SelectValue></SelectTrigger>
    <SelectContent className={`choice-menu ${menuClassName}`} align="end" sideOffset={5}>{options.map(option => <SelectItem key={option.value} value={option.value || '__none__'} disabled={option.disabled}>{option.label}</SelectItem>)}</SelectContent>
  </Select>
}
