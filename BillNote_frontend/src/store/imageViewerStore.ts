import { create } from 'zustand'

export const IMAGE_VIEWER_EXIT_GUARD_MS = 800
export const useImageViewerStore = create<{ viewers: number; windowControlsLocked: boolean }>(() => ({
  viewers: 0,
  windowControlsLocked: false,
}))

let unlockTimer: ReturnType<typeof setTimeout> | undefined
function deferUnlock() {
  clearTimeout(unlockTimer)
  unlockTimer = setTimeout(() => {
    if (useImageViewerStore.getState().viewers === 0) useImageViewerStore.setState({ windowControlsLocked: false })
  }, IMAGE_VIEWER_EXIT_GUARD_MS)
}

// Keep the lock across portal removal, rapid clicks, and StrictMode remounts.
export function holdImageViewerWindowControls() {
  clearTimeout(unlockTimer)
  useImageViewerStore.setState(state => ({ viewers: state.viewers + 1, windowControlsLocked: true }))
  let released = false
  return () => {
    if (released) return
    released = true
    useImageViewerStore.setState(state => ({ viewers: Math.max(0, state.viewers - 1) }))
    if (useImageViewerStore.getState().viewers === 0) deferUnlock()
  }
}

export function blockImageViewerWindowControl() {
  const state = useImageViewerStore.getState()
  if (!state.windowControlsLocked) return false
  if (state.viewers === 0) deferUnlock()
  return true
}
