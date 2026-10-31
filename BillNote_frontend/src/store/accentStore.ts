import { create } from 'zustand'
import { normalizeHex } from '@/utils/accentColor'

export const accentColors = [
  { id: 'blue', name: '雾蓝', light: '#45679e', dark: '#9ab6e4' },
  { id: 'slate', name: 'Codex', light: '#333333', dark: '#ffffff' },
  { id: 'violet', name: '紫罗兰', light: '#7950b0', dark: '#c6a5ed' },
  { id: 'green', name: '森林绿', light: '#34734a', dark: '#99cca7' },
  { id: 'teal', name: '青碧', light: '#247477', dark: '#8fced0' },
  { id: 'orange', name: '琥珀', light: '#9a5b1b', dark: '#e9bd82' },
  { id: 'rose', name: '玫瑰', light: '#a34467', dark: '#e6a1ba' },
] as const
export type AccentColor = typeof accentColors[number]['id'] | 'custom'
const KEY = 'bilinote-accent-v1'
const CUSTOM_KEY = 'bilinote-accent-custom-v1'
function initialAccent(): AccentColor {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored === 'custom' || stored === 'indigo') return 'custom'
    return accentColors.find(color => color.id === stored)?.id || 'slate'
  } catch { return 'slate' }
}
function initialCustom() {
  try {
    if (localStorage.getItem(KEY) === 'indigo') return '#5058b8'
    return normalizeHex(localStorage.getItem(CUSTOM_KEY) || '') || '#45679e'
  } catch { return '#45679e' }
}
export const useAccentStore = create<{ accent: AccentColor; customColor: string; setAccent: (accent: AccentColor) => void; setCustomColor: (hex: string) => void }>((set, get) => ({
  accent: initialAccent(),
  customColor: initialCustom(),
  setAccent: accent => {
    set({ accent })
    try { localStorage.setItem(CUSTOM_KEY, get().customColor); localStorage.setItem(KEY, accent) } catch { /* Keep the choice for this session. */ }
  },
  setCustomColor: value => {
    const hex = normalizeHex(value)
    if (!hex) return
    set({ accent: 'custom', customColor: hex })
    try { localStorage.setItem(CUSTOM_KEY, hex); localStorage.setItem(KEY, 'custom') } catch { /* Keep the choice for this session. */ }
  },
}))
