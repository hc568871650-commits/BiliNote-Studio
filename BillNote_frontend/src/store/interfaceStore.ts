import { create } from 'zustand'
import { persist } from 'zustand/middleware'
export interface InterfacePreferences { fontSize: number; codeSize: number; font: 'system' | 'yahei' | 'segoe'; reducedMotion: boolean; startPage: 'recent' | 'create'; sendKey: 'enter' | 'mod-enter'; streamReading: boolean }
export const interfaceDefaults: InterfacePreferences = { fontSize: 14, codeSize: 13, font: 'system', reducedMotion: false, startPage: 'recent', sendKey: 'enter', streamReading: true }
export const useInterfaceStore = create<InterfacePreferences & { update: (value: Partial<InterfacePreferences>) => void; resetAppearance: () => void }>()(persist(set => ({ ...interfaceDefaults,
  update: value => set(value), resetAppearance: () => set({ fontSize: 14, codeSize: 13, font: 'system', reducedMotion: false }),
}), { name: 'bilinote-interface-v1' }))
