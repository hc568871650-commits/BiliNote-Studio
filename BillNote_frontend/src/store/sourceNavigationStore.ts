import { create } from 'zustand'
import type { ChatSource } from '@/services/chat'
import type { QuotePart } from '@/utils/quoteSource'

export type NavigationSource = ChatSource & { quote_parts?: QuotePart[] }
export const useSourceNavigationStore = create<{ source: NavigationSource | null; open: (source: NavigationSource) => void; clear: () => void }>(set => ({
  source: null,
  open: source => set({ source }),
  clear: () => set({ source: null }),
}))
