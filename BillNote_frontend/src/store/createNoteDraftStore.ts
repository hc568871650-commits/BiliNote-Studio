import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FormInput } from '@/pages/HomePage/components/NoteForm'
import type { GenerateNotePayload } from '@/services/note'
import type { GenerationOptions } from '@/services/generationRuns'

interface CreateNoteDraft {
  values: Partial<FormInput>
  providerId: string
  generationOptions: GenerationOptions | null
  fileName: string
  uploadProgress: number | null
  pending: GenerateNotePayload | null
  submitting: boolean
  uploading: boolean
  notice: string
  submittedAt: number
  advancedOpen: boolean
  optionsOpen: boolean
}

const emptyDraft = (): CreateNoteDraft => ({ values: {}, providerId: '', generationOptions: null,
  fileName: '', uploadProgress: null, pending: null, submitting: false, uploading: false, notice: '', submittedAt: 0,
  advancedOpen: false, optionsOpen: false })

/** Creation has its own draft; configuring an existing note must never overwrite it. */
export const useCreateNoteDraftStore = create<CreateNoteDraft & {
  update: (patch: Partial<CreateNoteDraft>) => void
  clearSource: () => void
}>()(persist((set) => ({ ...emptyDraft(),
  update: patch => set(patch),
  clearSource: () => set(state => ({ values: { ...state.values, video_url: '' }, fileName: '', uploadProgress: null,
    pending: null, notice: '', submitting: false })),
}), {
  name: 'bilinote-create-draft-v1',
  // Never restore an in-flight spinner after restarting. Keep an uncertain submission
  // so the user checks its request ID before generating the same video again.
  partialize: state => ({ values: state.values, providerId: state.providerId, generationOptions: state.generationOptions,
    fileName: state.fileName, uploadProgress: state.uploadProgress === 100 ? 100 : null, pending: state.pending,
    advancedOpen: state.advancedOpen, optionsOpen: state.optionsOpen }),
  merge: (persisted, current) => {
    const saved = persisted as Partial<CreateNoteDraft> | undefined
    if (!saved || typeof saved !== 'object') return current
    return { ...current,
      values: saved.values && typeof saved.values === 'object' && !Array.isArray(saved.values) ? saved.values : {},
      providerId: typeof saved.providerId === 'string' ? saved.providerId : '',
      generationOptions: saved.generationOptions || null,
      fileName: typeof saved.fileName === 'string' ? saved.fileName : '',
      uploadProgress: saved.uploadProgress === 100 ? 100 : null,
      pending: saved.pending?.task_id && saved.pending?.request_id ? saved.pending : null,
      advancedOpen: saved.advancedOpen === true, optionsOpen: saved.optionsOpen === true,
    }
  },
}))
