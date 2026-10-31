export const READING_CHAT_LAYOUT_KEY = 'bilinote.reading-chat-layout.v1'
export const DEFAULT_READER_PERCENT = 63
export const SPLIT_HANDLE_WIDTH = 8
export const MIN_READER_WIDTH = 360
export const MIN_CHAT_WIDTH = 340

export function readReaderPreference(storage?: Pick<Storage, 'getItem'>): number {
  try {
    const raw = storage?.getItem(READING_CHAT_LAYOUT_KEY)
    if (!raw || raw.length > 80) return DEFAULT_READER_PERCENT
    const value: unknown = JSON.parse(raw)
    return typeof value === 'number' && Number.isFinite(value) && value >= 20 && value <= 80
      ? value : DEFAULT_READER_PERCENT
  } catch {
    return DEFAULT_READER_PERCENT
  }
}

export function saveReaderPreference(value: number, storage?: Pick<Storage, 'setItem'>): void {
  if (!Number.isFinite(value) || value < 20 || value > 80) return
  try { storage?.setItem(READING_CHAT_LAYOUT_KEY, JSON.stringify(Math.round(value * 100) / 100)) } catch { /* Layout remains usable with unavailable storage. */ }
}

export function readingChatConstraints(width: number) {
  const available = Math.max(0, width - SPLIT_HANDLE_WIDTH)
  const narrow = width > 0 && available < MIN_READER_WIDTH + MIN_CHAT_WIDTH
  if (!available || narrow) return { narrow, minReader: 20, maxReader: 80 }
  return {
    narrow,
    minReader: Math.max(20, MIN_READER_WIDTH / available * 100),
    maxReader: Math.min(80, 100 - MIN_CHAT_WIDTH / available * 100),
  }
}

export function constrainedReaderPercent(preferred: number, width: number): number {
  const { minReader, maxReader } = readingChatConstraints(width)
  return Math.min(maxReader, Math.max(minReader, preferred))
}
