import type { ReadingMessage, ReadingSession } from '@/store/readingAssistantStore'
import type { CompactionResult } from '@/services/chat'
import { wireAttachment } from '@/utils/readingAttachments'
export const AUTO_COMPACT_THRESHOLD = 217600
export function activeReadingMessages(session: ReadingSession): ReadingMessage[] {
  const index = session.memory ? session.messages.findIndex(m => m.id === session.memory?.through_id) : -1
  return session.messages.slice(index + 1).filter(m => !m.incomplete && (m.content.trim() || m.attachments?.length))
}
export const wireHistory = (messages: ReadingMessage[]) => messages.map(m => ({ role: m.role, content: m.content,
  ...(m.attachments?.length ? { attachments: m.attachments.map(wireAttachment) } : {}) }))
export function compressionPrefix(messages: ReadingMessage[]) {
  const selected: ReadingMessage[] = []
  let bytes = 0
  // The last four messages stay verbatim; only transmit a bounded older prefix.
  for (const item of messages.slice(0, -4).slice(0, 200)) {
    const size = new TextEncoder().encode(JSON.stringify(wireHistory([item]))).length
    if (bytes + size > 9 * 1024 * 1024) break
    selected.push(item); bytes += size
  }
  if (selected.length > 1 && selected.at(-1)?.role === 'user') selected.pop()
  return selected
}
export function compactedMemory(session: ReadingSession, sent: ReadingMessage[], result: CompactionResult): ReadingSession['memory'] {
  const count = result.consumed_messages
  if (!result.compacted) return session.memory
  if (!Number.isInteger(count) || count < 1 || count > sent.length || !result.summary.trim()) throw new Error('压缩结果无效，原上下文已保留')
  const active = activeReadingMessages(session)
  if (sent.slice(0, count).some((m, i) => m.id !== active[i]?.id)) throw new Error('对话已变化，未应用过期压缩结果')
  return { summary: result.summary, through_id: sent[count - 1].id, compacted_messages: (session.memory?.compacted_messages || 0) + count }
}
