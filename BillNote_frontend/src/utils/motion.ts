import { useInterfaceStore } from '@/store/interfaceStore'

export function prefersReducedMotion() {
  return useInterfaceStore.getState().reducedMotion
    || (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
}

export function scrollMotion(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}
