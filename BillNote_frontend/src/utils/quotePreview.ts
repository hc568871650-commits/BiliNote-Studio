export function quotePreview(text = '', limit = 20) {
  const line = text.trim().split(/\r?\n/).find(value => value.trim()) || ''
  return Array.from(line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^[#>\s-]+/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()).slice(0, limit).join('')
}
