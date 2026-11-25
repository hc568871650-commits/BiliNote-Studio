import type { Markdown, Task } from '@/store/taskStore'
import type { LearningStatus } from '@/services/noteLibrary'
import { resolveStructuredNote } from '@/types/structuredNote'

// Keep persisted values compatible with existing library metadata.
export const readingLabels: Record<LearningStatus, string> = {
  unread: '待读', learning: '阅读中', done: '已读完',
}

export interface ReadableVersionLike {
  content?: string | null
  structured?: unknown
}

export function isReadableMarkdownContent(text: string | null | undefined): boolean {
  const trimmed = (text || '').trim()
  return Boolean(trimmed) && trimmed !== 'loading' && trimmed !== 'empty'
}

export function isReadableVersion(version: ReadableVersionLike | null | undefined): boolean {
  if (!version) return false
  return isReadableMarkdownContent(version.content) || Boolean(resolveStructuredNote(version, version.content || ''))
}

export function findPreferredReadableVersion(markdown: Task['markdown'] | null | undefined): Markdown | null {
  if (!Array.isArray(markdown)) return null
  return markdown.find(version => isReadableVersion(version)) || null
}

export function hasReadableContent(
  task: { markdown?: string | readonly ReadableVersionLike[] | null } | null | undefined,
): boolean {
  if (!task) return false
  if (typeof task.markdown === 'string') {
    return isReadableMarkdownContent(task.markdown) || Boolean(resolveStructuredNote(null, task.markdown))
  }
  return Array.isArray(task.markdown) && task.markdown.some(version => isReadableVersion(version))
}

export function hasReadableTranscript(task: Pick<Task, 'transcript'> | null | undefined): boolean {
  return Boolean(task?.transcript?.segments?.some(segment => Boolean(segment?.text?.trim())))
}
