import type { ReadingSession } from '@/store/readingAssistantStore'
import { createRecordStorage } from '@/utils/recordStorage'

export function createReadingSessionStorage() {
  return createRecordStorage<{ sessions: Record<string, ReadingSession> }>(state => {
    const records: Record<string, unknown> = {}
    for (const [key, session] of Object.entries(state.sessions)) {
      if (!key.startsWith('note:')) continue
      for (const [field, value] of Object.entries(session)) {
        if (field === 'messages') {
          // Message indices are stable while streaming; only the current turn changes.
          records[JSON.stringify([key, 'message-count'])] = session.messages.length
          session.messages.forEach((message, index) => { records[JSON.stringify([key, 'message', index])] = message })
        } else if (value !== undefined) records[JSON.stringify([key, field])] = value
      }
    }
    return records
  }, records => {
    const sessions: Record<string, ReadingSession> = {}
    for (const [record, value] of Object.entries(records)) {
      const [key, field, index] = JSON.parse(record) as [string, string, number?]
      const session = sessions[key] ??= { messages: [], input: '', attachments: [] }
      if (field === 'message') session.messages[index!] = value as ReadingSession['messages'][number]
      else if (field !== 'message-count') Object.assign(session, { [field]: value })
    }
    return { sessions }
  })
}
