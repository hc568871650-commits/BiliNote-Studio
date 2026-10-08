import request from '@/utils/request'

export type LearningStatus = 'unread' | 'learning' | 'done'

export interface NoteLibraryEntry {
  favorite: boolean
  pinned: boolean
  learning_status: LearningStatus
  tags: string[]
  remark: string
}

export interface NoteLibraryState {
  entries: Record<string, NoteLibraryEntry>
}

export type NoteLibraryChanges = Partial<NoteLibraryEntry>

export const getNoteLibrary = () => request.get('/note_library') as unknown as Promise<NoteLibraryState>

export const updateNoteLibrary = (taskIds: string[], changes: NoteLibraryChanges) =>
  request.post('/note_library/update', { task_ids: taskIds, changes }) as unknown as Promise<NoteLibraryState>
