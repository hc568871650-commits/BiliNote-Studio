import { create } from 'zustand'

export const useLibraryViewStore = create<{ archived: boolean; setArchived: (archived: boolean) => void }>(set => ({
  archived: false, setArchived: archived => set({ archived }),
}))
