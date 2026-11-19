import { create } from 'zustand'
import { normalizeHex } from '@/utils/accentColor'

export const accentColors = [
  { id: 'slate', name: '曜石', light: '#1f2328', dark: '#f0f3f6' },
  { id: 'blue', name: '晴空', light: '#1a62d6', dark: '#6cb6ff' },
  { id: 'violet', name: '靛紫', light: '#6344d4', dark: '#b49bff' },
  { id: 'teal', name: '青碧', light: '#0d7480', dark: '#56d4dd' },
  { id: 'green', name: '翠绿', light: '#1b7f4b', dark: '#5cd68d' },
  { id: 'orange', name: '琥珀', light: '#c2500a', dark: '#ff9f43' },
  { id: 'rose', name: '珊瑚', light: '#d12f5d', dark: '#ff7aa2' },
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
    return normalizeHex(localStorage.getItem(CUSTOM_KEY) || '') || '#1a62d6'
  } catch { return '#1a62d6' }
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
