export function compactCommandQuery(value: string): boolean {
  if (value.includes('\n') || value.includes('\r')) return false
  const query = value.trim().toLowerCase()
  return query.startsWith('/') && '/compact'.startsWith(query)
}
export function compactMenuKey(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; isComposing?: boolean; nativeEvent?: { isComposing?: boolean } }): 'choose' | 'dismiss' | 'navigate' | null {
  if (event.isComposing || event.nativeEvent?.isComposing) return null
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null
  if (event.key === 'Enter') return 'choose'
  if (event.key === 'Escape') return 'dismiss'
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') return 'navigate'
  return null
}
