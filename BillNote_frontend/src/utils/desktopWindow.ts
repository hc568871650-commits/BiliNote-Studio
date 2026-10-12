import type { Window } from '@tauri-apps/api/window'

// Serialize decoration changes and retain ownership across React StrictMode's
// overlapping asynchronous effects. An old cleanup must not undo a new setup.
const owners = new Set<symbol>()
let lifecycle: Promise<unknown> = Promise.resolve()

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycle.then(operation, operation)
  lifecycle = result.catch(() => undefined)
  return result
}

async function currentWindow(): Promise<Window> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

/** Call only in Tauri, after the custom title bar has been mounted. */
export function initializeDesktopWindow(
  onMaximized: (maximized: boolean) => void,
): Promise<() => void> {
  const owner = Symbol('desktop-title-bar')
  owners.add(owner)

  return serialize(async () => {
    let desktop: Window | undefined
    let unlisten: (() => void) | undefined
    let active = true
    let stateRequest = 0

    const refreshMaximized = async () => {
      const request = ++stateRequest
      const maximized = await desktop!.isMaximized()
      if (active && request === stateRequest) onMaximized(maximized)
    }

    const restoreDecorations = async () => {
      if (desktop && owners.size === 0) {
        try {
          await desktop.setDecorations(true)
        } catch (error) {
          console.warn('Cannot restore the native window title bar', error)
        }
      }
    }

    const stopListening = () => {
      active = false
      try {
        unlisten?.()
      } catch (error) {
        console.warn('Cannot remove the window resize listener', error)
      }
    }

    try {
      desktop = await currentWindow()
      unlisten = await desktop.onResized(() => {
        void refreshMaximized().catch((error) => {
          if (active) console.warn('Cannot read the maximized window state', error)
        })
      })
      await refreshMaximized()
      await desktop.setDecorations(false)
    } catch (error) {
      stopListening()
      owners.delete(owner)
      await restoreDecorations()
      throw error
    }

    return () => {
      if (!active) return
      stopListening()
      owners.delete(owner)
      void serialize(restoreDecorations)
    }
  })
}

export async function minimizeDesktopWindow(): Promise<void> {
  await (await currentWindow()).minimize()
}

export async function toggleMaximizeDesktopWindow(): Promise<void> {
  await (await currentWindow()).toggleMaximize()
}

export async function closeDesktopWindow(): Promise<void> {
  // close() emits CloseRequested; lib.rs preserves hide-to-tray behavior.
  await (await currentWindow()).close()
}

export async function startDraggingDesktopWindow(): Promise<void> {
  await (await currentWindow()).startDragging()
}
