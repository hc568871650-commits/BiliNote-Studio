import { create } from 'zustand'
import {
  getNoteLibrary,
  type LearningStatus,
  type NoteLibraryChanges,
  type NoteLibraryEntry,
  updateNoteLibrary,
} from '@/services/noteLibrary'

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

interface LibraryStore {
  entries: Record<string, NoteLibraryEntry>
  loadState: LoadState
  errorMessage: string | null
  isMutating: boolean
  loadLibrary: () => Promise<void>
  startReading: (taskId: string) => Promise<void>
  updateEntries: (taskIds: string[], changes: NoteLibraryChanges) => Promise<void>
}

let pendingLoad: Promise<void> | null = null
let pendingRequest: Promise<void> = Promise.resolve()

const enqueueRequest = <T>(action: () => Promise<T>): Promise<T> => {
  const result = pendingRequest.then(action, action)
  pendingRequest = result.then(() => undefined, () => undefined)
  return result
}

export const defaultLibraryEntry = (): NoteLibraryEntry => ({
  favorite: false,
  pinned: false,
  learning_status: 'unread',
  tags: [],
  remark: '',
})

export const useLibraryStore = create<LibraryStore>((set, get) => ({
  entries: {},
  loadState: 'idle',
  errorMessage: null,
  isMutating: false,
  loadLibrary: async () => {
    if (pendingLoad) return pendingLoad
    set({ loadState: 'loading', errorMessage: null })
    pendingLoad = enqueueRequest(getNoteLibrary)
      .then(data => set({ entries: data.entries || {}, loadState: 'ready', errorMessage: null }))
      .catch(error => {
        console.error('读取笔记库元数据失败', error)
        set({ loadState: 'error', errorMessage: error?.msg || '无法读取笔记库信息，请重试' })
        throw error
      })
      .finally(() => { pendingLoad = null })
    return pendingLoad
  },
  updateEntries: async (taskIds, changes) => {
    if (!taskIds.length) return
    if (taskIds.length > 500) throw new Error('一次最多更新 500 篇笔记，请缩小筛选范围后重试')
    await enqueueRequest(async () => {
      set({ isMutating: true })
      try {
        const data = await updateNoteLibrary(taskIds, changes)
        set({ entries: data.entries || {} })
      } finally { set({ isMutating: false }) }
    })
  },
  startReading: async taskId => {
    if (!taskId) return
    await enqueueRequest(async () => {
      // Check after earlier writes finish: automatic progress must never overwrite
      // a manual completion or an existing reading state.
      if (get().loadState !== 'ready' || (get().entries[taskId]?.learning_status || 'unread') !== 'unread') return
      set({ isMutating: true })
      try {
        const data = await updateNoteLibrary([taskId], { learning_status: 'learning' })
        set({ entries: data.entries || {} })
      } finally { set({ isMutating: false }) }
    })
  },
}))

export type { LearningStatus }
