import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import { compactCommandQuery, compactMenuKey } from '@/utils/slashCommands'

export function useCompactCommand(value: string, disabled: boolean, onChoose: () => void) {
  const [dismissed, setDismissed] = useState(false)
  const id = useId()
  useEffect(() => { setDismissed(false) }, [value])
  const open = !disabled && !dismissed && compactCommandQuery(value)
  const select = () => { setDismissed(true); onChoose() }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return false
    const action = compactMenuKey(event)
    if (!action) return false
    event.preventDefault(); event.stopPropagation()
    if (action === 'choose') select()
    if (action === 'dismiss') setDismissed(true)
    return true
  }
  return { open, id, select, onKeyDown, dismiss: () => setDismissed(true) }
}
