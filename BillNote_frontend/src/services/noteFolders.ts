import request from '@/utils/request'

export interface NoteFolder {
  id: string
  name: string
}

export interface NoteFolderState {
  folders: NoteFolder[]
  assignments: Record<string, string>
}

export const getNoteFolders = () => request.get('/note_folders') as unknown as Promise<NoteFolderState>
export const createNoteFolder = (name: string) => request.post('/note_folders', { name }) as unknown as Promise<NoteFolderState>
export const renameNoteFolder = (id: string, name: string) => request.patch(`/note_folders/${encodeURIComponent(id)}`, { name }) as unknown as Promise<NoteFolderState>
export const deleteNoteFolder = (id: string) => request.delete(`/note_folders/${encodeURIComponent(id)}`) as unknown as Promise<NoteFolderState>
export const moveNotesToFolder = (taskIds: string[], folderId: string) => request.post('/note_folders/move', {
  task_ids: taskIds,
  folder_id: folderId,
}) as unknown as Promise<NoteFolderState>
