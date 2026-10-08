import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ModelPurpose = 'generation' | 'reading' | 'organizer'
export interface PurposeModelSelection { provider_id: string; model_name: string }
interface PurposeModelStore {
  defaults: Record<ModelPurpose, PurposeModelSelection | null>
  setDefault: (purpose: ModelPurpose, selection: PurposeModelSelection | null) => void
  getDefault: (purpose: ModelPurpose) => PurposeModelSelection | null
}

// Only model identities are persisted; credentials remain in existing provider configuration.
export const usePurposeModelStore = create<PurposeModelStore>()(persist((set, get) => ({
  defaults: { generation: null, reading: null, organizer: null },
  setDefault: (purpose, selection) => set(state => ({ defaults: { ...state.defaults, [purpose]: selection } })),
  getDefault: purpose => get().defaults[purpose],
}), { name: 'bilinote-purpose-models-v1', partialize: state => ({ defaults: state.defaults }) }))
