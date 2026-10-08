import { create } from 'zustand'

export const accentColors = [
  { id: 'blue', name: '雾蓝', light: '#45679e', dark: '#9ab6e4' },
  { id: 'slate', name: 'Codex', light: '#333333', dark: '#ffffff' },
  { id: 'indigo', name: '靛青', light: '#5058b8', dark: '#acb2ff' },
  { id: 'violet', name: '紫罗兰', light: '#7950b0', dark: '#c6a5ed' },
  { id: 'green', name: '森林绿', light: '#34734a', dark: '#99cca7' },
  { id: 'teal', name: '青碧', light: '#247477', dark: '#8fced0' },
  { id: 'orange', name: '琥珀', light: '#9a5b1b', dark: '#e9bd82' },
  { id: 'rose', name: '玫瑰', light: '#a34467', dark: '#e6a1ba' },
] as const
export type AccentColor = typeof accentColors[number]['id']
const KEY = 'bilinote-accent-v1'
function initialAccent(): AccentColor {
  try {
    const stored = localStorage.getItem(KEY)
    return accentColors.find(color => color.id === stored)?.id || 'slate'
  } catch { return 'slate' }
}
export const useAccentStore = create<{ accent: AccentColor; setAccent: (accent: AccentColor) => void }>(set => ({
  accent: initialAccent(),
  setAccent: accent => {
    set({ accent })
    try { localStorage.setItem(KEY, accent) } catch { /* Keep the choice for this session. */ }
  },
}))
