import type { AnnotationKind } from '@/types/structuredNote'

export function AnnotationGlyph({ kind }: { kind: AnnotationKind }) {
  if (kind === 'case') {
    return (
      <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <line x1="6.4" y1="7.6" x2="6.4" y2="12.4" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
        <line x1="10" y1="5.2" x2="10" y2="14.8" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
        <line x1="13.6" y1="7.6" x2="13.6" y2="12.4" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
      </svg>
    )
  }
  if (kind === 'pit') {
    return (
      <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <line x1="10" y1="5.4" x2="10" y2="10.9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="10" cy="14.1" r="1.05" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M10 4.4C10.32 7.52 12.48 9.68 15.6 10C12.48 10.32 10.32 12.48 10 15.6C9.68 12.48 7.52 10.32 4.4 10C7.52 9.68 9.68 7.52 10 4.4Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function HairlineCloseIcon() {
  return (
    <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="0.75" strokeOpacity="0.68" />
      <line x1="7.6" y1="7.6" x2="12.4" y2="12.4" fill="none" stroke="currentColor" strokeWidth="1.18" strokeLinecap="round" />
      <line x1="12.4" y1="7.6" x2="7.6" y2="12.4" fill="none" stroke="currentColor" strokeWidth="1.18" strokeLinecap="round" />
    </svg>
  )
}

export function CheckCircleIcon() {
  return (
    <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="var(--ui-ok)" strokeWidth="0.85" />
      <polyline points="6.5,10.2 9,12.7 13.7,7.6" fill="none" stroke="var(--ui-ok)" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function CrossCircleIcon() {
  return (
    <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="var(--ui-err)" strokeWidth="0.85" />
      <line x1="7.2" y1="7.2" x2="12.8" y2="12.8" fill="none" stroke="var(--ui-err)" strokeWidth="1.45" strokeLinecap="round" />
      <line x1="12.8" y1="7.2" x2="7.2" y2="12.8" fill="none" stroke="var(--ui-err)" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  )
}

export function MiniStatusGlyph({ pass }: { pass: boolean }) {
  return (
    <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {pass ? (
        <polyline points="4.6,8.2 7.0,10.5 11.5,5.7" fill="none" stroke="#ffffff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <>
          <line x1="5.3" y1="5.3" x2="10.7" y2="10.7" fill="none" stroke="#ffffff" strokeWidth="1.55" strokeLinecap="round" />
          <line x1="10.7" y1="5.3" x2="5.3" y2="10.7" fill="none" stroke="#ffffff" strokeWidth="1.55" strokeLinecap="round" />
        </>
      )}
    </svg>
  )
}

export function AskChatIcon() {
  return (
    <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M3 4.8C3 3.86 3.76 3.1 4.7 3.1H11.3C12.24 3.1 13 3.86 13 4.8V9.6C13 10.54 12.24 11.3 11.3 11.3H6.7L3.7 13.3V11.3C3.3 11.02 3 10.35 3 9.6V4.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  )
}
