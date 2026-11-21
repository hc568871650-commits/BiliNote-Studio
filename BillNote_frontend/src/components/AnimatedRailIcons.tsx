import { useId } from 'react'

interface AnimatedCreateNoteIconProps {
  active?: boolean
  size?: number
}

const CREATE_NOTE_PEN_PATH = 'M18.35 3.65a1.85 1.85 0 0 1 2.62 2.62L13.1 14.14l-3.25.78.78-3.25 7.72-8.02Z'

export function AnimatedCreateNoteIcon({ active = false, size = 17 }: AnimatedCreateNoteIconProps) {
  const maskId = `create-note-cutout-${useId().replace(/:/g, '')}`

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`animated-create-note-icon ${active ? 'is-distilling' : ''}`}
    >
      <defs>
        {/* 随动镂空遮罩：与笔完全同步运动，保证笔与外框始终保持恒定间隙 */}
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect x="0" y="0" width="24" height="24" fill="white" stroke="none" />
          <g className="create-note-pen">
            <path
              d={CREATE_NOTE_PEN_PATH}
              fill="black"
              stroke="black"
              strokeWidth={5.2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        </mask>
      </defs>

      {/* 完整圆角便签外框，由随动遮罩实时切出恒定留白间隔 */}
      <rect x="4" y="4" width="16" height="16" rx="2.8" mask={`url(#${maskId})`} />

      {/* 斜放细笔，仅在 activeCount > 0 且允许动效时以笔尖为支点做自然书写动效 */}
      <g className="create-note-pen">
        <path d={CREATE_NOTE_PEN_PATH} />
      </g>
    </svg>
  )
}

interface AnimatedNotebookIconProps {
  open: boolean
  size?: number
}

export function AnimatedNotebookIcon({ open, size = 17 }: AnimatedNotebookIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`animated-notebook-icon ${open ? 'is-open' : ''}`}
    >
      {/* Closed notebook state: bound cover with subtle spine and title mark */}
      <g className="notebook-closed-layer">
        <rect x="5" y="3.5" width="14" height="17" rx="2.2" />
        <path d="M8.5 3.5v17" />
        <path d="M11.5 8.5h4.5" />
        <path d="M11.5 12h3.2" />
      </g>

      {/* Open notebook state: left and right pages unfold symmetrically from the center spine */}
      <g className="notebook-open-layer">
        <path className="notebook-page-left" d="M12 6.5c-1.8-1.5-4.3-2-7.5-2a1.5 1.5 0 0 0-1.5 1.5v11.5A1.5 1.5 0 0 0 4.5 19c3.2 0 5.7.5 7.5 2" />
        <path className="notebook-page-right" d="M12 6.5c1.8-1.5 4.3-2 7.5-2A1.5 1.5 0 0 1 21 6v11.5a1.5 1.5 0 0 1-1.5 1.5c-3.2 0-5.7.5-7.5 2" />
        <path className="notebook-spine" d="M12 6.5V21" />
      </g>
    </svg>
  )
}

interface AnimatedFilterSlidersIconProps {
  open: boolean
  className?: string
}

export function AnimatedFilterSlidersIcon({ open, className }: AnimatedFilterSlidersIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`animated-sliders-icon ${open ? 'is-open' : ''} ${className ?? ''}`}
    >
      <line x1="3.5" y1="6" x2="20.5" y2="6" />
      <line x1="3.5" y1="12" x2="20.5" y2="12" />
      <line x1="3.5" y1="18" x2="20.5" y2="18" />
      <circle className="slider-knob slider-knob--top" cx="9" cy="6" r="2.2" fill="currentColor" stroke="none" />
      <circle className="slider-knob slider-knob--mid" cx="15.5" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <circle className="slider-knob slider-knob--bot" cx="10.5" cy="18" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

interface BackendEngineIconProps {
  health?: 'green' | 'yellow' | 'red' | 'unknown'
  size?: number
  showDot?: boolean
}

export function BackendEngineIcon({ health = 'unknown', size = 17, showDot = true }: BackendEngineIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`backend-engine-icon backend-engine-icon--${health}`}
    >
      {/* Rounded local service chassis with an open top-right shoulder for the status jewel */}
      <path d="M13 4.5H7.2a2.7 2.7 0 0 0-2.7 2.7v9.6a2.7 2.7 0 0 0 2.7 2.7h9.6a2.7 2.7 0 0 0 2.7-2.7V11" />
      {/* Minimal service console prompt mark */}
      <path d="M8.5 10.2 10.9 12.4 8.5 14.6" />
      <path d="M12.6 14.6h3" />
      {showDot && (
        <g className="backend-engine-jewel">
          <circle className="backend-engine-halo" cx="18.3" cy="5.7" r="4.1" stroke="none" />
          <circle className="backend-engine-core" cx="18.3" cy="5.7" r="2.2" stroke="none" />
        </g>
      )}
    </svg>
  )
}
