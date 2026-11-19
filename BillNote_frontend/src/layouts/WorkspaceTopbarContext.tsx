import { createContext, useContext, useEffect, type RefObject } from 'react'

export interface WorkspaceTopbarContextValue {
  active: boolean
  leftSlot: HTMLElement | null
  rightSlot: HTMLElement | null
  onConfigure?: () => void
  closeSidebar?: () => void
  setHasTopbarOwner: (owned: boolean) => void
}

export interface ReaderToolbarContextValue {
  statusSlot: HTMLElement | null
  toolbarSlot: HTMLElement | null
  setHasReaderToolbar: (owned: boolean) => void
}

export const WorkspaceTopbarContext = createContext<WorkspaceTopbarContextValue | null>(null)
export const ReaderToolbarContext = createContext<ReaderToolbarContextValue | null>(null)

export function useWorkspaceTopbar() {
  return useContext(WorkspaceTopbarContext)
}

export function useReaderToolbar() {
  return useContext(ReaderToolbarContext)
}

const TOOLBAR_ITEM_SELECTOR = 'button:not([disabled]), [data-slot="select-trigger"]:not([disabled]), a[href]'

/**
 * Roving tabindex fallback for role="toolbar" when native focusgroup is unsupported.
 * Native focusgroup browsers handle arrow-key navigation without extra JS listeners.
 */
export function useToolbarFocusGroup(ref: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    const bar = ref.current
    if (!bar || !active || 'focusGroup' in HTMLElement.prototype) return

    const getItems = () =>
      Array.from(bar.querySelectorAll<HTMLElement>(TOOLBAR_ITEM_SELECTOR)).filter(
        el => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden',
      )

    const syncTabStops = (preferred?: HTMLElement | null) => {
      const items = getItems()
      if (!items.length) return
      const activeEl =
        preferred && items.includes(preferred)
          ? preferred
          : items.find(el => el.tabIndex === 0) || items[0]
      items.forEach(item => {
        item.tabIndex = item === activeEl ? 0 : -1
      })
    }

    syncTabStops()
    const observer = new MutationObserver(() => syncTabStops(document.activeElement as HTMLElement | null))
    observer.observe(bar, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled'] })

    const onFocusIn = (event: FocusEvent) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(TOOLBAR_ITEM_SELECTOR)
      if (target && bar.contains(target)) syncTabStops(target)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(TOOLBAR_ITEM_SELECTOR)
      if (!target || !bar.contains(target)) return
      const items = getItems()
      const index = items.indexOf(target)
      if (index < 0) return

      const rtl = getComputedStyle(bar).direction === 'rtl'
      const nextStep = event.key === 'ArrowRight' ? (rtl ? -1 : 1) : event.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0
      let nextIndex = -1
      if (nextStep !== 0) nextIndex = (index + nextStep + items.length) % items.length
      else if (event.key === 'Home') nextIndex = 0
      else if (event.key === 'End') nextIndex = items.length - 1

      if (nextIndex >= 0 && items[nextIndex]) {
        event.preventDefault()
        syncTabStops(items[nextIndex])
        items[nextIndex].focus()
      }
    }

    bar.addEventListener('focusin', onFocusIn)
    bar.addEventListener('keydown', onKeyDown)
    return () => {
      observer.disconnect()
      bar.removeEventListener('focusin', onFocusIn)
      bar.removeEventListener('keydown', onKeyDown)
    }
  }, [ref, active])
}
