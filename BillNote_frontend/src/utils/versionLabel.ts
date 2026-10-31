export interface VersionInfo {
  ver_id: string
  model_name?: string
  created_at?: string
}

export function formatNoteTime(value?: string | Date) {
  if (!value) return ''
  const date = typeof value === 'string' ? new Date(value) : value
  if (isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return `${sameYear ? '' : `${date.getFullYear()}-`}${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// versions are newest first (index 0 is the latest saved version).
export function formatVersionLabel(version: VersionInfo, index: number, total: number) {
  const time = formatNoteTime(version.created_at)
  const name = index === 0 ? '最新' : `版本 ${total - index}`
  return time ? `${name} · ${time}` : name
}
