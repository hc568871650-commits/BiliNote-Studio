import type { ReadingMessage, ReadingSession } from '@/store/readingAssistantStore'

type DeliveryStatus = NonNullable<ReadingMessage['delivery_status']>
export type ReadingRecoveryState = 'ready' | 'restored' | 'draft-conflict' | 'unavailable'

export function beginReadingTurn(session: ReadingSession, question: ReadingMessage, answerId: string): ReadingSession {
  const unchangedDraft = session.input === question.content
    && JSON.stringify(session.attachments) === JSON.stringify(question.attachments || [])
  return { ...session,
    ...(unchangedDraft ? { input: '', attachments: [] } : {}),
    messages: [...session.messages, { ...question, incomplete: true, delivery_status: 'pending' },
      { id: answerId, role: 'assistant', content: '', reply_to: question.id, incomplete: true, request: question.request }],
  }
}

export function updateReadingTurn(session: ReadingSession | undefined, userId: string, answer: Partial<ReadingMessage>, status: DeliveryStatus = 'pending'): ReadingSession | undefined {
  if (!session?.messages.some(message => message.id === userId && message.delivery_status === 'pending')) return undefined
  // Match the original turn even if a later request has started or this chat was cleared.
  if (!session.messages.some(message => message.role === 'assistant' && message.reply_to === userId)) return undefined
  return { ...session, messages: session.messages.map(message => message.id === userId
    ? { ...message, incomplete: status !== 'complete', delivery_status: status }
    : message.role === 'assistant' && message.reply_to === userId
      ? { ...message, ...answer, id: message.id, reply_to: userId, incomplete: status !== 'complete' }
      : message) }
}

export function interruptedQuestion(session: ReadingSession, answerId: string): ReadingMessage | undefined {
  const index = session.messages.findIndex(message => message.id === answerId && message.role === 'assistant' && message.incomplete)
  if (index < 0) return undefined
  const answer = session.messages[index]
  const question = answer.reply_to ? session.messages.find(message => message.id === answer.reply_to) : session.messages[index - 1]
  return question?.role === 'user' && question.delivery_status !== 'pending' ? question : undefined
}

export function readingRecoveryState(session: ReadingSession, answerId: string): ReadingRecoveryState {
  const question = interruptedQuestion(session, answerId)
  if (!question) return 'unavailable'
  if (session.input === question.content && JSON.stringify(session.attachments) === JSON.stringify(question.attachments || [])) return 'restored'
  return session.input.length || session.attachments.length ? 'draft-conflict' : 'ready'
}

export function restoreReadingTurn(session: ReadingSession, answerId: string): ReadingSession {
  if (readingRecoveryState(session, answerId) !== 'ready') return session
  const question = interruptedQuestion(session, answerId)!
  return { ...session, input: question.content, attachments: question.attachments || [] }
}

export function interruptPendingReadingTurns(session: ReadingSession): ReadingSession {
  const interruptedIds = new Set(session.messages.filter(message => message.role === 'user' && message.delivery_status === 'pending').map(message => message.id))
  const legacyIds = new Set(session.messages.flatMap((message, index) => message.role === 'assistant' && message.incomplete && !message.reply_to && session.messages[index - 1]?.role === 'user' ? [session.messages[index - 1].id] : []))
  return { ...session, messages: session.messages.map((message, index) => interruptedIds.has(message.id)
    ? { ...message, incomplete: true, delivery_status: 'interrupted' }
    : legacyIds.has(message.id) ? { ...message, incomplete: true, delivery_status: message.delivery_status || 'interrupted' }
      : message.role === 'assistant' && message.incomplete && !message.reply_to && legacyIds.has(session.messages[index - 1]?.id)
        ? { ...message, reply_to: session.messages[index - 1].id } : message) }
}
