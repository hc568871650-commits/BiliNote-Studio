import { createContext } from 'react'
import type { ReadingAttachment } from '@/store/readingAssistantStore'

export interface NoteImageChatTarget {
  identity: string
  taskId: string
  versionId: string
  title: string
  attach: (attachment: ReadingAttachment) => void
}
export const NoteImageChatContext = createContext<NoteImageChatTarget | null>(null)
