import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { fetchPurposePreferences, savePurposePreferences } from '@/services/model'

export type ModelPurpose = 'generation' | 'reading' | 'organizer'
export interface PurposeModelSelection { provider_id: string; model_name: string }
interface PurposeModelStore {
  defaults: Record<ModelPurpose, PurposeModelSelection | null>
  synced: boolean
  setDefault: (purpose: ModelPurpose, selection: PurposeModelSelection | null) => void
  getDefault: (purpose: ModelPurpose) => PurposeModelSelection | null
  syncFromServer: () => Promise<void>
}

const normalizeSelection = (value: unknown): PurposeModelSelection | null => {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.provider_id === 'string' && record.provider_id.trim() && typeof record.model_name === 'string' && record.model_name.trim()) {
    return { provider_id: record.provider_id.trim(), model_name: record.model_name.trim() }
  }
  return null
}

// Only model identities are persisted; credentials remain in existing provider configuration.
export const usePurposeModelStore = create<PurposeModelStore>()(persist((set, get) => ({
  defaults: { generation: null, reading: null, organizer: null },
  synced: false,
  setDefault: (purpose, selection) => {
    set(state => ({ defaults: { ...state.defaults, [purpose]: selection } }))
    void savePurposePreferences({ [purpose]: selection }, { silent: true }).catch(() => undefined)
  },
  getDefault: purpose => get().defaults[purpose],
  syncFromServer: async () => {
    try {
      const data = await fetchPurposePreferences({ silent: true }) as unknown as Record<string, unknown> | null
      if (!data || typeof data !== 'object') return
      const current = get().defaults
      const next: Record<ModelPurpose, PurposeModelSelection | null> = {
        generation: 'generation' in data ? normalizeSelection(data.generation) : current.generation,
        reading: 'reading' in data ? normalizeSelection(data.reading) : current.reading,
        organizer: 'organizer' in data ? normalizeSelection(data.organizer) : current.organizer,
      }
      // If server is empty while local already had selections, migrate local once to backend.
      const serverHasAny = Boolean(next.generation || next.reading || next.organizer)
      const localHasAny = Boolean(current.generation || current.reading || current.organizer)
      if (!serverHasAny && localHasAny) {
        void savePurposePreferences(current, { silent: true }).catch(() => undefined)
        set({ synced: true })
        return
      }
      set({ defaults: next, synced: true })
    } catch {
      /* Offline or preview mock falls back to local storage. */
    }
  },
}), { name: 'bilinote-purpose-models-v1', partialize: state => ({ defaults: state.defaults }) }))
