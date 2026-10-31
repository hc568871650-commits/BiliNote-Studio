import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type WebSearchMode = 'native' | 'external'
export const modelSearchKey = (providerId?: string, modelName?: string) =>
  providerId && modelName ? JSON.stringify([providerId, modelName]) : null

interface ModelWebSearchStore {
  modes: Record<string, WebSearchMode>
  setMode: (providerId: string, modelName: string, mode: WebSearchMode) => void
  initializeMode: (providerId: string, modelName: string, mode: WebSearchMode) => void
}

// A relay can give the same model different search capabilities. Store identities
// and the selected route only; provider credentials stay in their own settings.
export const useModelWebSearchStore = create<ModelWebSearchStore>()(persist(set => ({
  modes: {},
  setMode: (providerId, modelName, mode) => {
    const key = modelSearchKey(providerId, modelName)
    if (key) set(state => ({ modes: { ...state.modes, [key]: mode } }))
  },
  initializeMode: (providerId, modelName, mode) => {
    const key = modelSearchKey(providerId, modelName)
    if (key) set(state => state.modes[key] ? state : { modes: { ...state.modes, [key]: mode } })
  },
}), {
  name: 'bilinote-model-web-search-v1',
  partialize: state => ({ modes: state.modes }),
  merge: (persisted, current) => {
    const modes = (persisted as Partial<ModelWebSearchStore> | undefined)?.modes
    return { ...current, modes: Object.fromEntries(Object.entries(modes || {}).filter(([, mode]) => mode === 'native' || mode === 'external')) }
  },
}))
