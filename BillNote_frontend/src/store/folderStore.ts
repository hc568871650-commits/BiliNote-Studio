import { create } from 'zustand'
import {
  createNoteFolder,
  deleteNoteFolder,
  getNoteFolders,
  moveNotesToFolder,
  renameNoteFolder,
  type NoteFolder,
  type NoteFolderState,
} from '@/services/noteFolders'

export const DEFAULT_FOLDER_ID = 'default'
export const ALL_FOLDER_ID = 'all'
const FOLDER_SELECTION_KEY = 'bilinote-selected-folder'

type FolderLoadState = 'idle' | 'loading' | 'ready' | 'error'

interface FolderStore extends NoteFolderState {
  loadState: FolderLoadState
  errorMessage: string | null
  selectedFolderId: string
  loadFolders: () => Promise<void>
  selectFolder: (id: string) => void
  createFolder: (name: string) => Promise<void>
  renameFolder: (id: string, name: string) => Promise<void>
  deleteFolder: (id: string) => Promise<void>
  moveTasks: (taskIds: string[], folderId: string) => Promise<void>
}

let pendingLoad: Promise<void> | null = null
let pendingMutation: Promise<void> = Promise.resolve()

const enqueueMutation = <T>(action: () => Promise<T>): Promise<T> => {
  const result = pendingMutation.then(action, action)
  pendingMutation = result.then(() => undefined, () => undefined)
  return result
}

const storedFolder = () => {
  try {
    return localStorage.getItem(FOLDER_SELECTION_KEY) || DEFAULT_FOLDER_ID
  } catch {
    return DEFAULT_FOLDER_ID
  }
}

const applyFolderState = (data: NoteFolderState) => ({ folders: data.folders, assignments: data.assignments })

export const useFolderStore = create<FolderStore>((set, get) => ({
  folders: [],
  assignments: {},
  loadState: 'idle',
  errorMessage: null,
  selectedFolderId: storedFolder(),
  loadFolders: async () => {
    if (pendingLoad) return pendingLoad
    if (get().loadState === 'ready') return
    set({ loadState: 'loading', errorMessage: null })
    pendingLoad = getNoteFolders()
      .then(data => {
        const available = new Set([ALL_FOLDER_ID, ...data.folders.map(folder => folder.id)])
        const selectedFolderId = available.has(get().selectedFolderId) ? get().selectedFolderId : DEFAULT_FOLDER_ID
        set({ ...applyFolderState(data), loadState: 'ready', errorMessage: null, selectedFolderId })
      })
      .catch(error => {
        console.error('读取笔记文件夹失败', error)
        set({ loadState: 'error', errorMessage: error?.msg || '无法读取文件夹，请重试' })
        throw error
      })
      .finally(() => { pendingLoad = null })
    return pendingLoad
  },
  selectFolder: id => {
    set({ selectedFolderId: id })
    try { localStorage.setItem(FOLDER_SELECTION_KEY, id) } catch { /* storage is optional */ }
  },
  createFolder: async name => {
    await enqueueMutation(async () => {
      const data = await createNoteFolder(name)
      set(applyFolderState(data))
    })
  },
  renameFolder: async (id, name) => {
    await enqueueMutation(async () => {
      const data = await renameNoteFolder(id, name)
      set(applyFolderState(data))
    })
  },
  deleteFolder: async id => {
    await enqueueMutation(async () => {
      const data = await deleteNoteFolder(id)
      const selectedFolderId = get().selectedFolderId === id ? DEFAULT_FOLDER_ID : get().selectedFolderId
      set({ ...applyFolderState(data), selectedFolderId })
      try { localStorage.setItem(FOLDER_SELECTION_KEY, selectedFolderId) } catch { /* storage is optional */ }
    })
  },
  moveTasks: async (taskIds, folderId) => {
    await enqueueMutation(async () => {
      const data = await moveNotesToFolder(taskIds, folderId)
      set(applyFolderState(data))
    })
  },
}))

export const getFolderName = (folders: NoteFolder[], id: string) => folders.find(folder => folder.id === id)?.name || '默认文件夹'
