import { create } from 'zustand'
import type { Health } from './BackendHealthIndicator'

interface BackendStatusState {
  active: boolean
  health: Health
  label: string
  openPanel: (() => void) | null
  setStatus: (next: { active: boolean; health: Health; label: string; openPanel: (() => void) | null }) => void
  reset: () => void
}

export const useBackendStatusStore = create<BackendStatusState>(set => ({
  active: false,
  health: 'unknown',
  label: '',
  openPanel: null,
  setStatus: next => set(next),
  reset: () => set({ active: false, health: 'unknown', label: '', openPanel: null }),
}))
